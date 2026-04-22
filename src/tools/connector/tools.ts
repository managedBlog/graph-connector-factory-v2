/**
 * Tool registry, dispatcher, and all tool implementations for the Connector Deploy Agent.
 *
 * Tools:
 *  1. connector_listEnvironments — list Power Platform environments
 *  2. connector_list — list custom connectors in an environment
 *  3. connector_validate — validate swagger for Power Platform compatibility
 *  4. connector_create — create a new custom connector
 *  5. connector_update — update an existing custom connector
 *  6. connector_delete — delete a custom connector (gated by config)
 *  7. connector_deploy — composite: validate → create-or-update
 *  8. connector_initProperties — generate apiProperties.json template
 */

import * as fs from "fs";
import { AgentConfig } from "../../config/types";
import { createCredentialProvider } from "../../auth";
import { getRequestContext, CallerIdentity } from "../../auth/requestContext";
import { PowerAppsClient } from "./powerAppsClient";
import { ConnectorCreatePayload, ConnectorUpdatePayload } from "./types";
import {
  ConnectorAuthType,
  OAuthAADOptions,
  FederatedIdentityOptions,
  buildApiPropertiesFile,
  generateApiKeySecurityDefinition,
  resolveFederatedResourceUri,
} from "./connectorAuthTemplates";
import { ToolDefinition, ToolRegistry, ToolInvocationResult } from "./types";
import { log, logError } from "../../logging/logger";

/* ── Lazy-initialised shared state ── */

let _client: PowerAppsClient | null = null;

function getClient(config: AgentConfig): PowerAppsClient {
  if (!_client) {
    const credential = createCredentialProvider(config.powerPlatform.auth);
    const isServicePrincipal = config.powerPlatform.auth.method === "appOnly"
      || config.powerPlatform.auth.method === "clientCredential";
    _client = new PowerAppsClient(credential, {
      powerAppsApiUrl: config.powerPlatform.powerAppsApiUrl,
      powerAppsApiVersion: config.powerPlatform.powerAppsApiVersion,
      flowApiUrl: config.powerPlatform.flowApiUrl,
      flowApiVersion: config.powerPlatform.flowApiVersion,
      scope: config.powerPlatform.auth.scope,
      useAdminApi: isServicePrincipal,
    });
  }
  return _client;
}

/* ── Session-scoped autonomy state ── */

let _autonomyMode: "confirm" | "autonomous" = "confirm";

export function getAutonomyMode(): "confirm" | "autonomous" {
  return _autonomyMode;
}

export function setAutonomyMode(mode: "confirm" | "autonomous"): void {
  _autonomyMode = mode;
}

/* ── Helper: extract federated identity fields from a created connector ── */

interface FederatedIdentityInfo {
  readonly federatedIdentitySubject?: string;
  readonly federatedIdentityIssuer?: string;
  readonly federatedIdentityAudience?: string;
  readonly redirectUri?: string;
  readonly clientId?: string;
  readonly resourceUri?: string;
}

function extractFederatedIdentityFields(
  connectorDef: Record<string, unknown>
): FederatedIdentityInfo {
  const props = connectorDef["properties"] as Record<string, unknown> | undefined;
  if (!props) return {};

  const connParams = props["connectionParameters"] as Record<string, unknown> | undefined;
  if (!connParams) return {};

  const token = connParams["token"] as Record<string, unknown> | undefined;
  if (!token) return {};

  const oAuthSettings = token["oAuthSettings"] as Record<string, unknown> | undefined;
  if (!oAuthSettings) return {};

  const result: Record<string, string | undefined> = {};

  // Extract redirectUri
  const redirectUrl = oAuthSettings["redirectUrl"] as string | undefined;
  if (redirectUrl) result["redirectUri"] = redirectUrl;

  // Extract clientId
  const clientId = oAuthSettings["clientId"] as string | undefined;
  if (clientId) result["clientId"] = clientId;

  // Extract resourceUri from customParameters
  const customParams = oAuthSettings["customParameters"] as Record<string, unknown> | undefined;
  if (customParams) {
    const resourceUri = customParams["resourceUri"] as Record<string, unknown> | undefined;
    if (resourceUri) {
      result["resourceUri"] = resourceUri["value"] as string | undefined;
    }
  }

  // Extract FIC fields from properties
  const ficProperties = (oAuthSettings["properties"] as Record<string, unknown>) ?? {};
  const ficBlock = ficProperties["FederatedIdentityCredentials"] as Record<string, unknown> | undefined;
  if (ficBlock) {
    result["federatedIdentitySubject"] = ficBlock["Subject"] as string | undefined;
    result["federatedIdentityIssuer"] = ficBlock["Issuer"] as string | undefined;
    result["federatedIdentityAudience"] = ficBlock["Audience"] as string | undefined;
  }

  return result as FederatedIdentityInfo;
}

/* ── Helper: resolve environment ID ── */

function resolveEnvironmentId(input: Record<string, unknown>, config: AgentConfig): string {
  const envId = (input["environmentId"] as string) ?? config.powerPlatform.defaultEnvironmentId;
  if (!envId) {
    throw new Error(
      "No environmentId provided and no defaultEnvironmentId in config. " +
      "Use connector_listEnvironments to discover available environments."
    );
  }
  return envId;
}

/* ── Helper: load and parse swagger file ── */

function loadSwaggerFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Swagger file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Swagger file is not valid JSON: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

/* ── Helper: resolve swagger from path, inline content, or URL ── */

async function resolveSwagger(
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  // 1. Prefer inline content if provided
  if (input["apiDefinition"]) {
    const content = input["apiDefinition"];
    if (typeof content === "string") {
      try {
        return JSON.parse(content) as Record<string, unknown>;
      } catch {
        throw new Error("apiDefinition string is not valid JSON.");
      }
    }
    if (typeof content === "object" && content !== null) {
      return content as Record<string, unknown>;
    }
    throw new Error("apiDefinition must be a JSON string or object.");
  }

  // 2. Check for explicit URL input
  const url = input["apiDefinitionUrl"] as string | undefined;
  if (url) {
    return fetchSwaggerFromUrl(url);
  }

  // 3. Fall back to file path — but detect if someone passed a URL by mistake
  const filePath = input["apiDefinitionPath"] as string | undefined;
  if (!filePath) {
    throw new Error("Either 'apiDefinition', 'apiDefinitionUrl', or 'apiDefinitionPath' must be provided.");
  }
  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    log(`apiDefinitionPath looks like a URL — fetching: ${filePath}`);
    return fetchSwaggerFromUrl(filePath);
  }
  return loadSwaggerFile(filePath);
}

/* ── Helper: fetch swagger from a URL (Gist, download endpoint, etc.) ── */

async function fetchSwaggerFromUrl(url: string): Promise<Record<string, unknown>> {
  // Convert GitHub Gist HTML URLs to raw content URLs.
  // HTML page: https://gist.github.com/<user>/<id>
  // API URL:   https://api.github.com/gists/<id>
  const gistMatch = url.match(/^https:\/\/gist\.github\.com\/[^/]+\/([a-f0-9]+)$/i);
  if (gistMatch) {
    const gistId = gistMatch[1];
    log(`Detected gist HTML URL — resolving raw content via API for gist ${gistId}`);
    const apiUrl = `https://api.github.com/gists/${gistId}`;
    const apiResp = await fetch(apiUrl, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "connector-deploy-agent" },
    });
    if (!apiResp.ok) {
      throw new Error(`Failed to fetch gist metadata (${apiResp.status}): ${apiUrl}`);
    }
    const gistData = await apiResp.json() as { files: Record<string, { raw_url: string; content: string }> };
    const files = Object.values(gistData.files);
    if (files.length === 0) {
      throw new Error(`Gist ${gistId} has no files.`);
    }
    // Use the first file's content directly (avoids a second fetch)
    const firstFile = files[0]!;
    try {
      return JSON.parse(firstFile.content) as Record<string, unknown>;
    } catch {
      throw new Error(`Gist file content is not valid JSON.`);
    }
  }

  log(`Fetching swagger from URL: ${url}`);
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch swagger from URL (${response.status}): ${url}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Response from ${url} is not valid JSON.`);
  }
}

/* ── Helper: extract Graph API scopes from swagger securityDefinitions ── */

/**
 * Extracts unique scope names from the swagger's securityDefinitions.
 * Looks for OAuth 2.0 security definitions and returns the scope keys.
 *
 * Example swagger fragment:
 *   securityDefinitions:
 *     oauth2_auth:
 *       type: oauth2
 *       scopes:
 *         CloudPC.Read.All: CloudPC.Read.All
 *         CloudPC.ReadWrite.All: CloudPC.ReadWrite.All
 *
 * Returns: ["CloudPC.Read.All", "CloudPC.ReadWrite.All"]
 */
function extractScopesFromSwagger(swagger: Record<string, unknown>): string[] {
  const securityDefs = swagger["securityDefinitions"] as Record<string, unknown> | undefined;
  if (!securityDefs) return [];

  const allScopes = new Set<string>();
  for (const defName of Object.keys(securityDefs)) {
    const def = securityDefs[defName] as Record<string, unknown>;
    if (def["type"] !== "oauth2") continue;
    const scopes = def["scopes"] as Record<string, unknown> | undefined;
    if (!scopes) continue;
    for (const scopeName of Object.keys(scopes)) {
      if (scopeName && scopeName.length > 0) {
        allScopes.add(scopeName);
      }
    }
  }
  return [...allScopes];
}

/* ── Helper: sanitise Swagger 2.0 for Power Platform compatibility ── */

/**
 * Ensures body parameters conform to Swagger 2.0 spec.
 *
 * In Swagger 2.0, parameter objects are validated against a `oneOf`:
 *   • Body Parameter — requires `in: "body"` + `schema`; MUST NOT have `type`.
 *   • Non-body Parameter — requires `type`; MUST NOT have `schema`.
 *
 * When an LLM relays the swagger between agents it sometimes injects extra
 * properties (e.g. `"type": "object"` on body params) which violates the
 * oneOf and causes:
 *   "JSON is valid against no schemas from 'oneOf'. Path '…parameters[N]'"
 *
 * This function strips the forbidden keys defensively so the swagger is
 * always valid regardless of how it was generated or modified in transit.
 */
function sanitiseSwaggerForPowerPlatform(
  swagger: Record<string, unknown>
): { swagger: Record<string, unknown>; fixes: string[] } {
  const fixes: string[] = [];
  const paths = swagger["paths"] as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return { swagger, fixes };

  // Keys that MUST NOT appear on a body parameter
  const BODY_PARAM_FORBIDDEN_KEYS = ["type", "format", "items", "collectionFormat",
    "maximum", "minimum", "maxLength", "minLength", "pattern", "maxItems", "minItems",
    "uniqueItems", "multipleOf"];

  for (const [pathKey, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (typeof operation !== "object" || operation === null) continue;
      const op = operation as Record<string, unknown>;
      const params = op["parameters"] as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(params)) continue;

      for (let i = 0; i < params.length; i++) {
        const param = params[i];
        if (!param || typeof param !== "object") continue;

        if (param["in"] === "body") {
          // Body parameter: ensure schema exists, strip forbidden keys
          for (const forbiddenKey of BODY_PARAM_FORBIDDEN_KEYS) {
            if (forbiddenKey in param) {
              // If param has `type` but no `schema`, promote it to a schema
              if (forbiddenKey === "type" && !param["schema"]) {
                const schema: Record<string, unknown> = { type: param["type"] };
                if (param["properties"]) schema["properties"] = param["properties"];
                if (param["required"] && Array.isArray(param["required"])) {
                  schema["required"] = param["required"];
                }
                param["schema"] = schema;
                fixes.push(
                  `${method.toUpperCase()} ${pathKey} params[${i}]: promoted type/properties to schema`
                );
              } else {
                fixes.push(
                  `${method.toUpperCase()} ${pathKey} params[${i}]: removed forbidden '${forbiddenKey}' from body param`
                );
              }
              delete param[forbiddenKey];
            }
          }
          // Also remove `properties` from body param level (must be inside schema)
          if ("properties" in param) {
            if (param["schema"] && typeof param["schema"] === "object") {
              const schema = param["schema"] as Record<string, unknown>;
              if (!schema["properties"]) {
                schema["properties"] = param["properties"];
                fixes.push(
                  `${method.toUpperCase()} ${pathKey} params[${i}]: moved properties into schema`
                );
              }
            }
            delete param["properties"];
          }
          // Ensure schema exists (fallback to generic object)
          if (!param["schema"]) {
            param["schema"] = { type: "object" };
            fixes.push(
              `${method.toUpperCase()} ${pathKey} params[${i}]: added missing schema to body param`
            );
          }
        } else {
          // Non-body parameter: must NOT have schema
          if ("schema" in param) {
            // Promote schema.type to param.type
            const schema = param["schema"] as Record<string, unknown>;
            if (schema && typeof schema === "object" && schema["type"] && !param["type"]) {
              param["type"] = schema["type"];
              fixes.push(
                `${method.toUpperCase()} ${pathKey} params[${i}]: promoted schema.type to param.type`
              );
            }
            delete param["schema"];
          }
          // Ensure type exists
          if (!param["type"]) {
            param["type"] = "string";
            fixes.push(
              `${method.toUpperCase()} ${pathKey} params[${i}]: added missing type to non-body param`
            );
          }
        }
      }
    }
  }

  return { swagger, fixes };
}

/* ── Helper: resolve apiProperties from path or inline content ── */

function resolveApiProperties(
  input: Record<string, unknown>
): Record<string, unknown> | undefined {
  // Prefer inline content if provided
  if (input["apiProperties"]) {
    const content = input["apiProperties"];
    if (typeof content === "string") {
      try {
        return JSON.parse(content) as Record<string, unknown>;
      } catch {
        throw new Error("apiProperties string is not valid JSON.");
      }
    }
    if (typeof content === "object" && content !== null) {
      return content as Record<string, unknown>;
    }
    throw new Error("apiProperties must be a JSON string or object.");
  }
  // Fall back to file path
  const filePath = input["apiPropertiesPath"] as string | undefined;
  if (filePath) {
    return loadApiPropertiesFile(filePath);
  }
  return undefined;
}

/* ── Helper: extract backend service URL from swagger ── */

/**
 * Derive a contextual suffix for the connector display name when using baseName mode.
 *
 * Inspects the swagger title for clues about the connector's purpose.
 * Falls back to "Connector" if nothing useful is found.
 *
 * Examples:
 *   "Graph Users - CRUD Connector" → "CRUD Connector"
 *   "Intune Device Management Actions" → "Device Management Actions"
 *   "Graph Connector" → "Connector" (generic, use default)
 */
function deriveConnectorDisplaySuffix(swaggerTitle: string): string {
  if (!swaggerTitle || swaggerTitle === "Custom Connector" || swaggerTitle === "Graph Connector") {
    return "";
  }

  // If the swagger title already contains " - ", use the part after the last " - "
  const dashIdx = swaggerTitle.lastIndexOf(" - ");
  if (dashIdx >= 0) {
    const after = swaggerTitle.slice(dashIdx + 3).trim();
    if (after.length > 0) return after;
  }

  // Otherwise use the full swagger title as the suffix
  return swaggerTitle;
}

function extractBackendServiceUrl(swagger: Record<string, unknown>): string {
  const schemes = (swagger["schemes"] as string[]) ?? ["https"];
  const host = swagger["host"] as string;
  const basePath = (swagger["basePath"] as string) ?? "";

  if (!host) {
    throw new Error("Swagger definition must include a 'host' property.");
  }

  return `${schemes[0]}://${host}${basePath}`;
}

/* ── Helper: load apiProperties file ── */

function loadApiPropertiesFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`API properties file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`API properties file is not valid JSON: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

/* ── Tool: connector_listEnvironments ── */

const listEnvironmentsTool: ToolDefinition = {
  name: "connector_listEnvironments",
  description: "List available Power Platform environments for the authenticated tenant.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  handler: async (_input: unknown, config: unknown) => {
    const client = getClient(config as AgentConfig);
    const result = await client.listEnvironments();

    const environments = result.value.map((env) => ({
      id: env.name,
      displayName: env.properties.displayName,
      location: env.location,
      isDefault: env.properties.isDefault ?? false,
      type: env.properties.environmentSku ?? "unknown",
    }));

    return { environments, count: environments.length };
  },
};

/* ── Tool: connector_list ── */

const listConnectorsTool: ToolDefinition = {
  name: "connector_list",
  description: "List custom connectors in a Power Platform environment.",
  inputSchema: {
    type: "object",
    properties: {
      environmentId: {
        type: "string",
        description: "Power Platform environment ID. Uses default from config if omitted.",
      },
    },
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = (input ?? {}) as Record<string, unknown>;
    const environmentId = resolveEnvironmentId(inp, cfg);
    const client = getClient(cfg);
    const result = await client.listConnectors(environmentId);

    const connectors = result.value.map((c) => ({
      id: c.name,
      displayName: c.properties.displayName,
      description: c.properties.description ?? "",
      createdTime: c.properties.createdTime ?? "",
      modifiedTime: c.properties.changedTime ?? "",
    }));

    return { connectors, count: connectors.length, environmentId };
  },
};

/* ── Tool: connector_validate ── */

const validateTool: ToolDefinition = {
  name: "connector_validate",
  description:
    "Validate an OpenAPI definition for Power Platform custom connector compatibility. " +
    "Checks: Swagger 2.0 format, file size < 1MB, required extensions, and optionally " +
    "validates with the Power Platform API.",
  inputSchema: {
    type: "object",
    properties: {
      apiDefinitionPath: {
        type: "string",
        description: "Path to the Swagger 2.0 JSON definition file.",
      },
      apiDefinition: {
        description: "Inline Swagger 2.0 definition as a JSON object or string.",
      },
      apiDefinitionUrl: {
        type: "string",
        description: "URL to fetch Swagger 2.0 JSON from (e.g. GitHub Gist raw URL).",
      },
      serverValidation: {
        type: "boolean",
        description: "Also validate with the Power Platform API (requires auth). Defaults to false.",
      },
    },
  },
  handler: async (input: unknown, config: unknown) => {
    const inp = input as Record<string, unknown>;
    const serverValidation = inp["serverValidation"] as boolean ?? false;

    const errors: string[] = [];
    const warnings: string[] = [];

    // Resolve swagger from any supported source (inline, URL, or file path)
    let rawSwagger: Record<string, unknown>;
    let fileSize: string | undefined;

    try {
      rawSwagger = await resolveSwagger(inp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, errors: [msg], warnings: [] };
    }

    // Check file size if path-based
    const filePath = inp["apiDefinitionPath"] as string | undefined;
    if (filePath && !filePath.startsWith("http") && fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.size > 1_000_000) {
        errors.push(`File size ${(stat.size / 1024 / 1024).toFixed(2)} MB exceeds the 1 MB limit.`);
      }
      fileSize = `${(stat.size / 1024).toFixed(1)} KB`;
    } else {
      // Estimate inline/URL content size
      const jsonStr = JSON.stringify(rawSwagger);
      const size = Buffer.byteLength(jsonStr, "utf-8");
      if (size > 1_000_000) {
        errors.push(`Definition size ${(size / 1024 / 1024).toFixed(2)} MB exceeds the 1 MB limit.`);
      }
      fileSize = `${(size / 1024).toFixed(1)} KB`;
    }

    // Sanitise for Swagger 2.0 compliance and report fixes
    const { swagger, fixes: sanitiseFixes } = sanitiseSwaggerForPowerPlatform(rawSwagger);
    if (sanitiseFixes.length > 0) {
      warnings.push(
        `Swagger required ${sanitiseFixes.length} fix(es) for Swagger 2.0 compliance: ${sanitiseFixes.join("; ")}`
      );
    }

    // Must be Swagger 2.0
    if (swagger["swagger"] !== "2.0") {
      errors.push(
        `Expected Swagger 2.0 (swagger: "2.0"), found: ${swagger["swagger"] ?? swagger["openapi"] ?? "unknown"}. ` +
        "Power Platform only supports Swagger 2.0 definitions."
      );
    }

    // Must have host
    if (!swagger["host"]) {
      errors.push("Missing required 'host' property.");
    }

    // Must have info.title
    const info = swagger["info"] as Record<string, unknown> | undefined;
    if (!info?.["title"]) {
      errors.push("Missing required 'info.title' property.");
    }

    // Check for paths
    const paths = swagger["paths"] as Record<string, unknown> | undefined;
    if (!paths || Object.keys(paths).length === 0) {
      warnings.push("No paths defined — connector will have no operations.");
    }

    // Check operation count
    if (paths) {
      let opCount = 0;
      for (const pathDef of Object.values(paths)) {
        if (typeof pathDef === "object" && pathDef !== null) {
          opCount += Object.keys(pathDef).filter((k) =>
            ["get", "post", "put", "patch", "delete"].includes(k)
          ).length;
        }
      }
      if (opCount > 256) {
        errors.push(`${opCount} operations exceeds the 256 operation limit.`);
      }
    }

    // Server-side validation (optional)
    let serverResult: unknown = null;
    if (serverValidation && errors.length === 0) {
      try {
        const cfg = config as AgentConfig;
        const client = getClient(cfg);
        serverResult = await client.validateSwagger(swagger);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`Server-side validation failed: ${message}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      fileSize,
      ...(serverResult ? { serverValidation: serverResult } : {}),
    };
  },
};

/* ── Tool: connector_create ── */

const createTool: ToolDefinition = {
  name: "connector_create",
  description:
    "Create a new custom connector in a Power Platform environment from a Swagger 2.0 definition. " +
    "Authentication defaults to NoAuth. Use apiPropertiesPath/apiProperties or authType to configure OAuth/ApiKey/Basic. " +
    "For cross-agent workflows: accepts inline apiDefinition and apiProperties objects. " +
    "When authType is FederatedIdentity or OAuthAAD, the output includes machine-readable fields " +
    "(redirectUri, federatedIdentitySubject, clientId, resourceUri) that can be passed directly " +
    "to the App Registration Agent's appreg_configureForConnector tool.",
  inputSchema: {
    type: "object",
    properties: {
      environmentId: {
        type: "string",
        description: "Power Platform environment ID.",
      },
      apiDefinitionPath: {
        type: "string",
        description: "Path to Swagger 2.0 JSON file. Alternative: use 'apiDefinition' or 'apiDefinitionUrl'.",
      },
      apiDefinition: {
        description: "Inline Swagger 2.0 definition as a JSON object or string. Preferred for cross-agent workflows.",
      },
      apiDefinitionUrl: {
        type: "string",
        description: "URL to fetch Swagger 2.0 JSON from (e.g. GitHub Gist raw URL or Graph Connector Agent download URL).",
      },
      displayName: {
        type: "string",
        description:
          "Explicit display name for the connector. Overrides the name from swagger info.title. " +
          "Use this when the user wants a specific custom name. Overridden by baseName if both are provided.",
      },
      baseName: {
        type: "string",
        description:
          "Base name for all objects in the Connector Factory workflow. " +
          "A contextual suffix is appended automatically (e.g., 'Contoso Users' → 'Contoso Users - Connector'). " +
          "Takes priority over displayName and swagger info.title. " +
          "Passed through in the output for downstream agents (App Registration).",
      },
      apiPropertiesPath: {
        type: "string",
        description: "Path to apiProperties.json file. Alternative: use 'apiProperties' for inline content.",
      },
      apiProperties: {
        description: "Inline apiProperties as a JSON object or string. Alternative to apiPropertiesPath.",
      },
      authType: {
        type: "string",
        enum: ["NoAuth", "BasicAuth", "ApiKey", "OAuthAAD", "OAuthGeneric", "FederatedIdentity"],
        description: "Auth type to generate if apiPropertiesPath is not provided. Defaults to NoAuth. " +
          "FederatedIdentity uses Managed Identity via Federated Identity Credentials (PREVIEW).",
      },
      oauthClientId: {
        type: "string",
        description: "OAuth/Federated client ID (required if authType is OAuthAAD, OAuthGeneric, or FederatedIdentity).",
      },
      oauthResourceUri: {
        type: "string",
        description:
          "OAuth resource URI (required if authType is OAuthAAD). " +
          "For FederatedIdentity, defaults to https://graph.microsoft.com when omitted.",
      },
      oauthTenantId: {
        type: "string",
        description: "Tenant ID — defaults to 'common' for OAuthAAD, required for FederatedIdentity.",
      },
      oauthScopes: {
        type: "string",
        description: "OAuth scopes (space-separated).",
      },
      oauthSecret: {
        type: "string",
        description: "OAuth client secret for the connector. Will be injected at deploy time only.",
      },
      iconPath: {
        type: "string",
        description: "Path to connector icon PNG file (optional).",
      },
      shareWithEmails: {
        type: "array",
        items: { type: "string" },
        description:
          "Email addresses of users to share the connector with after creation. " +
          "Each email is resolved to an Entra ID OID via Microsoft Graph (requires User.Read.All). " +
          "SP-created connectors are invisible to users unless explicitly shared.",
      },
    },
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = input as Record<string, unknown>;
    const environmentId = resolveEnvironmentId(inp, cfg);
    const client = getClient(cfg);

    // Load swagger (path, inline, or URL) and sanitise for Swagger 2.0 compliance
    const rawSwagger = await resolveSwagger(inp);
    const { swagger, fixes: sanitiseFixes } = sanitiseSwaggerForPowerPlatform(rawSwagger);
    if (sanitiseFixes.length > 0) {
      log(`Swagger sanitised (${sanitiseFixes.length} fix(es) applied): ${sanitiseFixes.join("; ")}`);
    }
    const info = swagger["info"] as Record<string, unknown>;
    const swaggerTitle = (info?.["title"] as string) ?? "Custom Connector";
    const description = (info?.["description"] as string) ?? "";
    const backendServiceUrl = extractBackendServiceUrl(swagger);

    // Resolve display name: validated baseName is used as-is (L61: no suffix
    // derivation — namecheck already validated this name). Suffix logic only
    // applies as a fallback when no baseName is provided (backward compat).
    const baseName = inp["baseName"] as string | undefined;
    const explicitDisplayName = inp["displayName"] as string | undefined;
    let displayName: string;
    if (baseName) {
      // L61: Validated baseName is the final display name — no transformation.
      displayName = baseName;
    } else if (explicitDisplayName) {
      displayName = explicitDisplayName;
    } else {
      displayName = swaggerTitle;
    }

    // Ensure swagger info.title matches the resolved displayName so
    // Power Platform's conflict check uses the correct name (L62).
    if (info) {
      info["title"] = displayName;
    }

    // Build connection parameters
    let connectionParameters: Record<string, unknown> = {};
    const authType = (inp["authType"] as ConnectorAuthType) ?? "NoAuth";
    const guardrailWarnings: string[] = [];

    const resolvedApiProps = resolveApiProperties(inp);
    if (resolvedApiProps) {
      const propsInner = resolvedApiProps["properties"] as Record<string, unknown> | undefined;
      connectionParameters = (propsInner?.["connectionParameters"] as Record<string, unknown>) ?? {};
    } else {
      let apiProps: Record<string, unknown>;
      if (authType === "OAuthAAD") {
        const opts: Record<string, unknown> = {
          clientId: inp["oauthClientId"] as string,
          resourceUri: inp["oauthResourceUri"] as string,
        };
        if (inp["oauthTenantId"]) opts["tenantId"] = inp["oauthTenantId"];
        if (inp["oauthScopes"]) opts["scopes"] = (inp["oauthScopes"] as string).split(" ");
        apiProps = buildApiPropertiesFile(authType, { oauthAAD: opts as unknown as OAuthAADOptions });
      } else if (authType === "OAuthGeneric") {
        apiProps = buildApiPropertiesFile(authType, {
          oauthGeneric: {
            clientId: inp["oauthClientId"] as string,
            authorizationUrl: inp["oauthResourceUri"] as string,
            tokenUrl: inp["oauthResourceUri"] as string,
          },
        });
      } else if (authType === "FederatedIdentity") {
        const fedTenantId = inp["oauthTenantId"] as string;
        if (!fedTenantId) {
          throw new Error(
            "FederatedIdentity requires oauthTenantId (tenant GUID). " +
            "Unlike OAuthAAD, 'common' is not supported."
          );
        }

        const guardedResource = resolveFederatedResourceUri(
          inp["oauthResourceUri"] as string | undefined
        );
        guardrailWarnings.push(...guardedResource.warnings);
        for (const warning of guardedResource.warnings) {
          log(`[FederatedIdentity Guardrail] ${warning}`);
        }

        const fedOpts: FederatedIdentityOptions = {
          clientId: inp["oauthClientId"] as string,
          resourceUri: guardedResource.resourceUri,
          tenantId: fedTenantId,
          scopes: inp["oauthScopes"] ? (inp["oauthScopes"] as string).split(" ") : undefined,
        };
        apiProps = buildApiPropertiesFile(authType, { federatedIdentity: fedOpts });
      } else if (authType === "ApiKey") {
        apiProps = buildApiPropertiesFile(authType, {
          apiKey: {
            keyName: "Ocp-Apim-Subscription-Key",
            location: "header",
          },
        });
      } else {
        apiProps = buildApiPropertiesFile(authType);
      }
      const propsInner = apiProps["properties"] as Record<string, unknown>;
      connectionParameters = (propsInner["connectionParameters"] as Record<string, unknown>) ?? {};
    }

    // Inject OAuth secret if provided
    if (inp["oauthSecret"] && connectionParameters["token"]) {
      const token = connectionParameters["token"] as Record<string, unknown>;
      const oAuthSettings = token["oAuthSettings"] as Record<string, unknown>;
      if (oAuthSettings) {
        (oAuthSettings as Record<string, unknown>)["clientSecret"] = inp["oauthSecret"];
      }
    }

    // Build payload
    const payload: ConnectorCreatePayload = {
      properties: {
        displayName,
        description,
        openApiDefinition: swagger,
        backendService: { serviceUrl: backendServiceUrl },
        environment: { name: environmentId },
        connectionParameters,
        iconBrandColor: "#007ee5",
      },
    };

    // Upload icon if provided
    if (inp["iconPath"]) {
      const iconPath = inp["iconPath"] as string;
      if (fs.existsSync(iconPath)) {
        const iconBuffer = fs.readFileSync(iconPath);
        const iconUrl = await client.uploadFileToStorage(
          environmentId,
          "icon.png",
          iconBuffer,
          "image/png"
        );
        (payload.properties as Record<string, unknown>)["iconUri"] = iconUrl;
      }
    }

    const result = await client.createConnector(environmentId, payload);

    // Enrich output with machine-readable FIC / OAuth fields for cross-agent handoff
    let crossAgentFields: FederatedIdentityInfo = {};
    if (authType === "FederatedIdentity" || authType === "OAuthAAD" || authType === "OAuthGeneric") {
      try {
        const fullDef = await client.getConnector(result.name, environmentId);
        crossAgentFields = extractFederatedIdentityFields(
          fullDef as unknown as Record<string, unknown>
        );
      } catch {
        log("Warning: Could not retrieve connector details for cross-agent enrichment.");
      }
    }

    // Auto-share connector with calling user when using SP auth.
    // SP-created connectors are invisible to users in the Power Platform
    // maker portal unless explicitly shared.
    const sharedWithList: string[] = [];
    const ctx = getRequestContext();
    const callerOid = ctx?.caller?.oid;
    if (callerOid) {
      try {
        await client.shareConnectorWithUser(result.name, environmentId, callerOid, "CanEdit");
        const callerLabel = ctx.caller?.upn ?? callerOid;
        sharedWithList.push(callerLabel);
        log(`Connector shared with caller: ${callerLabel}`);
      } catch (shareErr) {
        const shareMsg = shareErr instanceof Error ? shareErr.message : String(shareErr);
        log(`Warning: Could not auto-share connector with caller (${callerOid}): ${shareMsg}`);
      }
    }

    // Fallback: share with users configured in shareWithUsers.
    // This ensures SP-created connectors are visible even when Copilot Studio
    // connects without OAuth (no caller identity available).
    const configuredUsers = cfg.powerPlatform.shareWithUsers ?? [];
    for (const userOid of configuredUsers) {
      // Skip if already shared with this user as the caller
      if (userOid === callerOid) continue;
      try {
        await client.shareConnectorWithUser(result.name, environmentId, userOid, "CanEdit");
        sharedWithList.push(userOid);
        log(`Connector shared with configured user: ${userOid}`);
      } catch (shareErr) {
        const shareMsg = shareErr instanceof Error ? shareErr.message : String(shareErr);
        log(`Warning: Could not auto-share connector with configured user (${userOid}): ${shareMsg}`);
      }
    }

    // Share with the defaultShareUser (by email → OID resolution).
    const defaultShareUser = cfg.powerPlatform.defaultShareUser;
    if (defaultShareUser) {
      try {
        const resolvedOid = await client.resolveUserByEmail(defaultShareUser);
        if (resolvedOid && resolvedOid !== callerOid && !configuredUsers.includes(resolvedOid)) {
          await client.shareConnectorWithUser(result.name, environmentId, resolvedOid, "CanEdit");
          sharedWithList.push(defaultShareUser);
          log(`Connector shared with default user: ${defaultShareUser} (${resolvedOid})`);
        }
      } catch (shareErr) {
        const shareMsg = shareErr instanceof Error ? shareErr.message : String(shareErr);
        log(`Warning: Could not share connector with default user '${defaultShareUser}': ${shareMsg}`);
      }
    }

    // Share with emails provided via the shareWithEmails tool parameter.
    const shareWithEmails = inp["shareWithEmails"] as string[] | undefined;
    if (shareWithEmails && shareWithEmails.length > 0) {
      const alreadyShared = new Set(sharedWithList);
      for (const email of shareWithEmails) {
        if (alreadyShared.has(email)) continue;
        try {
          const resolvedOid = await client.resolveUserByEmail(email);
          if (resolvedOid) {
            await client.shareConnectorWithUser(result.name, environmentId, resolvedOid, "CanEdit");
            sharedWithList.push(email);
            alreadyShared.add(email);
            log(`Connector shared with user: ${email} (${resolvedOid})`);
          } else {
            log(`Warning: Could not resolve user '${email}' — skipping.`);
          }
        } catch (shareErr) {
          const shareMsg = shareErr instanceof Error ? shareErr.message : String(shareErr);
          log(`Warning: Could not share connector with '${email}': ${shareMsg}`);
        }
      }
    }

    // Share with groups configured in shareWithGroups.
    const configuredGroups = cfg.powerPlatform.shareWithGroups ?? [];
    const sharedGroupsList: string[] = [];
    for (const groupOid of configuredGroups) {
      try {
        await client.shareConnectorWithGroup(result.name, environmentId, groupOid, "CanEdit");
        sharedGroupsList.push(groupOid);
        log(`Connector shared with group: ${groupOid}`);
      } catch (shareErr) {
        const shareMsg = shareErr instanceof Error ? shareErr.message : String(shareErr);
        log(`Warning: Could not share connector with group (${groupOid}): ${shareMsg}`);
      }
    }

    // Extract Graph API scopes from the swagger for cross-agent handoff.
    // These scopes are passed to the App Registration Agent so it can automatically
    // add the correct API permissions and grant admin consent.
    const graphApiScopes = extractScopesFromSwagger(swagger);

    return {
      connectorId: result.name,
      displayName: result.properties.displayName,
      status: "created",
      environmentId,
      authType,
      // Base name for downstream agents (App Registration) — enables consistent naming
      ...(baseName ? { baseName } : {}),
      // Graph API scopes extracted from swagger — for App Registration Agent
      ...(graphApiScopes.length > 0 ? { graphApiScopes } : {}),
      ...(guardrailWarnings.length > 0 ? { warnings: guardrailWarnings } : {}),
      // Swagger sanitisation info (useful for debugging cross-agent issues)
      ...(sanitiseFixes.length > 0 ? { swaggerFixes: sanitiseFixes } : {}),
      // Sharing info
      ...(sharedWithList.length > 0 ? { sharedWith: sharedWithList } : {}),
      ...(sharedGroupsList.length > 0 ? { sharedWithGroups: sharedGroupsList } : {}),
      // Machine-readable fields for cross-agent workflows (App Registration Agent)
      ...crossAgentFields,
      note: authType === "FederatedIdentity"
        ? "⚠️ PREVIEW: Federated Identity Credentials is in preview. " +
          "Pass this output to the App Registration Agent's appreg_configureForConnector tool " +
          "to automatically register the Federated Identity Credential, redirect URI, and API permissions."
        : authType !== "NoAuth" && authType.startsWith("OAuth")
          ? "Pass this output to the App Registration Agent's appreg_configureForConnector tool " +
            "to automatically add the redirect URI and Graph API permissions to the app registration."
          : undefined,
    };
  },
};

/* ── Tool: connector_update ── */

const updateTool: ToolDefinition = {
  name: "connector_update",
  description:
    "Update an existing custom connector's definition. " +
    "Accepts file paths or inline content via apiDefinition/apiProperties.",
  inputSchema: {
    type: "object",
    properties: {
      environmentId: {
        type: "string",
        description: "Power Platform environment ID.",
      },
      connectorId: {
        type: "string",
        description: "The custom connector ID to update.",
      },
      apiDefinitionPath: {
        type: "string",
        description: "Path to the updated Swagger 2.0 JSON file. Alternative: use 'apiDefinition' or 'apiDefinitionUrl'.",
      },
      apiDefinition: {
        description: "Inline Swagger 2.0 definition as a JSON object or string. Preferred for cross-agent workflows.",
      },
      apiDefinitionUrl: {
        type: "string",
        description: "URL to fetch Swagger 2.0 JSON from (e.g. GitHub Gist raw URL).",
      },
      apiPropertiesPath: {
        type: "string",
        description: "Path to updated apiProperties.json (optional). Alternative: use 'apiProperties'.",
      },
      apiProperties: {
        description: "Inline apiProperties as a JSON object or string. Alternative to apiPropertiesPath.",
      },
      oauthSecret: {
        type: "string",
        description: "Updated OAuth client secret (optional).",
      },
    },
    required: ["connectorId"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = input as Record<string, unknown>;
    const environmentId = resolveEnvironmentId(inp, cfg);
    const connectorId = inp["connectorId"] as string;
    const client = getClient(cfg);

    const rawSwagger = await resolveSwagger(inp);
    const { swagger, fixes: sanitiseFixes } = sanitiseSwaggerForPowerPlatform(rawSwagger);
    if (sanitiseFixes.length > 0) {
      log(`Swagger sanitised (${sanitiseFixes.length} fix(es) applied): ${sanitiseFixes.join("; ")}`);
    }
    const backendServiceUrl = extractBackendServiceUrl(swagger);

    const payload: ConnectorUpdatePayload = {
      properties: {
        openApiDefinition: swagger,
        backendService: { serviceUrl: backendServiceUrl },
        environment: { name: environmentId },
      },
    };

    // Apply API properties if provided (path or inline)
    const resolvedProps = resolveApiProperties(inp);
    if (resolvedProps) {
      const propsInner = resolvedProps["properties"] as Record<string, unknown> | undefined;
      if (propsInner?.["connectionParameters"]) {
        (payload.properties as Record<string, unknown>)["connectionParameters"] =
          propsInner["connectionParameters"];
      }
    }

    await client.updateConnector(connectorId, environmentId, payload);

    return {
      connectorId,
      status: "updated",
      environmentId,
    };
  },
};

/* ── Tool: connector_delete ── */

const deleteTool: ToolDefinition = {
  name: "connector_delete",
  description:
    "Delete a custom connector from a Power Platform environment. " +
    "This action is irreversible. Requires 'allowDelete: true' in agent config.",
  inputSchema: {
    type: "object",
    properties: {
      environmentId: {
        type: "string",
        description: "Power Platform environment ID.",
      },
      connectorId: {
        type: "string",
        description: "The custom connector ID to delete.",
      },
      confirm: {
        type: "boolean",
        description: "Must be true to confirm deletion.",
      },
    },
    required: ["connectorId", "confirm"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = input as Record<string, unknown>;

    // Gate on config
    if (!cfg.policies.allowDelete) {
      return {
        status: "denied",
        error:
          "Connector deletion is disabled. Set 'policies.allowDelete: true' in agent config to enable.",
      };
    }

    // In autonomous mode, auto-approve (but log at warn level)
    const autonomy = getAutonomyMode();
    if (autonomy === "autonomous") {
      log("⚠️ [AUTO-APPROVE] connector_delete auto-approved in autonomous mode.");
    } else {
      // Require explicit confirmation in confirm mode
      if (inp["confirm"] !== true) {
        return {
          status: "denied",
          error: "Deletion requires 'confirm: true'. This action is irreversible.",
        };
      }
    }

    const environmentId = resolveEnvironmentId(inp, cfg);
    const connectorId = inp["connectorId"] as string;
    const client = getClient(cfg);

    await client.deleteConnector(connectorId, environmentId);

    return {
      connectorId,
      status: "deleted",
      environmentId,
    };
  },
};

/* ── Tool: connector_deploy ── */

const deployTool: ToolDefinition = {
  name: "connector_deploy",
  description:
    "End-to-end deploy: validate → create-or-update a custom connector. " +
    "Automatically determines whether to create or update based on connectorId. " +
    "Accepts file paths or inline content (apiDefinition/apiProperties). " +
    "When creating with FederatedIdentity or OAuth, the output includes machine-readable " +
    "fields for cross-agent handoff to the App Registration Agent.",
  inputSchema: {
    type: "object",
    properties: {
      environmentId: {
        type: "string",
        description: "Power Platform environment ID.",
      },
      connectorId: {
        type: "string",
        description: "If provided, update this connector. If omitted, create new.",
      },
      apiDefinitionPath: {
        type: "string",
        description: "Path to Swagger 2.0 JSON file. Alternative: use 'apiDefinition' or 'apiDefinitionUrl'.",
      },
      apiDefinition: {
        description: "Inline Swagger 2.0 definition as a JSON object or string. Preferred for cross-agent workflows.",
      },
      apiDefinitionUrl: {
        type: "string",
        description: "URL to fetch Swagger 2.0 JSON from (e.g. GitHub Gist raw URL).",
      },
      displayName: {
        type: "string",
        description:
          "Explicit display name for the connector. Overrides swagger info.title. " +
          "Overridden by baseName if both are provided.",
      },
      baseName: {
        type: "string",
        description:
          "Base name for all objects in the Connector Factory workflow. " +
          "A contextual suffix is appended automatically. " +
          "Takes priority over displayName. Passed through to downstream agents.",
      },
      apiPropertiesPath: {
        type: "string",
        description: "Path to apiProperties.json. Alternative: use 'apiProperties'.",
      },
      apiProperties: {
        description: "Inline apiProperties as a JSON object or string. Alternative to apiPropertiesPath.",
      },
      authType: {
        type: "string",
        enum: ["NoAuth", "BasicAuth", "ApiKey", "OAuthAAD", "OAuthGeneric", "FederatedIdentity"],
        description: "Auth type for new connectors. Defaults to NoAuth. " +
          "FederatedIdentity uses Managed Identity via Federated Identity Credentials (PREVIEW).",
      },
      oauthClientId: { type: "string" },
      oauthResourceUri: { type: "string" },
      oauthTenantId: { type: "string" },
      oauthScopes: { type: "string" },
      oauthSecret: { type: "string" },
      dryRun: {
        type: "boolean",
        description: "If true, validate only without deploying. Defaults to false.",
      },
      shareWithEmails: {
        type: "array",
        items: { type: "string" },
        description:
          "Email addresses of users to share the connector with after creation. " +
          "Passed through to connector_create. Requires User.Read.All on the SP.",
      },
    },
  },
  handler: async (input: unknown, config: unknown) => {
    const inp = input as Record<string, unknown>;
    const dryRun = inp["dryRun"] as boolean ?? false;

    // Step 1: Validate
    log("Deploy step 1/2: Validating…");
    const validateInput: Record<string, unknown> = { serverValidation: !dryRun };
    if (inp["apiDefinition"]) validateInput["apiDefinition"] = inp["apiDefinition"];
    else if (inp["apiDefinitionUrl"]) validateInput["apiDefinitionUrl"] = inp["apiDefinitionUrl"];
    else if (inp["apiDefinitionPath"]) validateInput["apiDefinitionPath"] = inp["apiDefinitionPath"];
    const validationResult = await validateTool.handler(
      validateInput,
      config
    ) as { valid: boolean; errors: string[]; warnings: string[] };

    if (!validationResult.valid) {
      return {
        action: "validation_failed",
        validation: validationResult,
      };
    }

    if (dryRun) {
      return {
        action: "validated",
        validation: validationResult,
        note: "Dry run — no deployment performed.",
      };
    }

    // Step 2: Create or update
    const connectorId = inp["connectorId"] as string | undefined;

    if (connectorId) {
      log("Deploy step 2/2: Updating existing connector…");
      const result = await updateTool.handler(input, config);
      return {
        action: "updated",
        validation: validationResult,
        deploy: result,
      };
    } else {
      log("Deploy step 2/2: Creating new connector…");
      const result = await createTool.handler(input, config);
      return {
        action: "created",
        validation: validationResult,
        deploy: result,
      };
    }
  },
};

/* ── Tool: connector_initProperties ── */

const initPropertiesTool: ToolDefinition = {
  name: "connector_initProperties",
  description:
    "Generate an apiProperties.json file from a connection parameter template. " +
    "Supported templates: NoAuth, BasicAuth, ApiKey, OAuthAAD, OAuthGeneric.",
  inputSchema: {
    type: "object",
    properties: {
      connectionTemplate: {
        type: "string",
        enum: ["NoAuth", "BasicAuth", "ApiKey", "OAuthAAD", "OAuthGeneric", "FederatedIdentity"],
        description: "Authentication template to use. " +
          "FederatedIdentity uses Managed Identity via Federated Identity Credentials (PREVIEW).",
      },
      oauthClientId: {
        type: "string",
        description: "OAuth client ID (required for OAuthAAD/OAuthGeneric).",
      },
      oauthResourceUri: {
        type: "string",
        description:
          "OAuth resource URI (required for OAuthAAD). " +
          "For FederatedIdentity, defaults to https://graph.microsoft.com when omitted.",
      },
      oauthTenantId: {
        type: "string",
        description: "OAuth tenant ID (OAuthAAD only, defaults to 'common').",
      },
      oauthScopes: {
        type: "string",
        description: "OAuth scopes (space-separated).",
      },
      apiKeyName: {
        type: "string",
        description: "API Key header/query parameter name (for ApiKey template).",
      },
      apiKeyLocation: {
        type: "string",
        enum: ["header", "query"],
        description: "Where to send the API key. Defaults to 'header'.",
      },
      iconBrandColor: {
        type: "string",
        description: "HTML hex color (e.g., '#007EE6'). Defaults to '#007ee5'.",
      },
      publisher: {
        type: "string",
        description: "Publisher name.",
      },
      outputPath: {
        type: "string",
        description: "File path to write apiProperties.json. If omitted, returns the content.",
      },
    },
    required: ["connectionTemplate"],
  },
  handler: async (input: unknown, _config: unknown) => {
    const inp = input as Record<string, unknown>;
    const template = inp["connectionTemplate"] as ConnectorAuthType;
    const guardrailWarnings: string[] = [];

    let properties: Record<string, unknown>;
    if (template === "OAuthAAD") {
      const opts: Record<string, unknown> = {
        clientId: (inp["oauthClientId"] as string) ?? "",
        resourceUri: (inp["oauthResourceUri"] as string) ?? "",
      };
      if (inp["oauthTenantId"]) opts["tenantId"] = inp["oauthTenantId"];
      if (inp["oauthScopes"]) opts["scopes"] = (inp["oauthScopes"] as string).split(" ");
      properties = buildApiPropertiesFile(template, {
        oauthAAD: opts as unknown as OAuthAADOptions,
        iconBrandColor: inp["iconBrandColor"] as string | undefined,
        publisher: inp["publisher"] as string | undefined,
      });
    } else if (template === "OAuthGeneric") {
      properties = buildApiPropertiesFile(template, {
        oauthGeneric: {
          clientId: (inp["oauthClientId"] as string) ?? "",
          authorizationUrl: (inp["oauthResourceUri"] as string) ?? "",
          tokenUrl: (inp["oauthResourceUri"] as string) ?? "",
        },
        iconBrandColor: inp["iconBrandColor"] as string | undefined,
        publisher: inp["publisher"] as string | undefined,
      });
    } else if (template === "FederatedIdentity") {
      const fedTenantId = (inp["oauthTenantId"] as string) ?? "";

      const guardedResource = resolveFederatedResourceUri(
        inp["oauthResourceUri"] as string | undefined
      );
      guardrailWarnings.push(...guardedResource.warnings);

      properties = buildApiPropertiesFile(template, {
        federatedIdentity: {
          clientId: (inp["oauthClientId"] as string) ?? "",
          resourceUri: guardedResource.resourceUri,
          tenantId: fedTenantId,
          scopes: inp["oauthScopes"] ? (inp["oauthScopes"] as string).split(" ") : undefined,
          connectorId: inp["connectorId"] as string | undefined,
        },
        iconBrandColor: inp["iconBrandColor"] as string | undefined,
        publisher: inp["publisher"] as string | undefined,
      });
    } else if (template === "ApiKey") {
      properties = buildApiPropertiesFile(template, {
        apiKey: {
          keyName: (inp["apiKeyName"] as string) ?? "Ocp-Apim-Subscription-Key",
          location: (inp["apiKeyLocation"] as "header" | "query") ?? "header",
        },
        iconBrandColor: inp["iconBrandColor"] as string | undefined,
        publisher: inp["publisher"] as string | undefined,
      });
    } else {
      properties = buildApiPropertiesFile(template, {
        iconBrandColor: inp["iconBrandColor"] as string | undefined,
        publisher: inp["publisher"] as string | undefined,
      });
    }

    const content = JSON.stringify(properties, null, 2);

    const previewWarning = template === "FederatedIdentity"
      ? "⚠️ PREVIEW FEATURE: Federated Identity Credentials for custom connectors is currently " +
        "in preview. Microsoft may change the API contract or behavior without notice. " +
        "After deployment: (1) Retrieve the connector to get the auto-generated Subject value. " +
        "(2) Register that Subject as a Federated Identity Credential in your Entra ID app registration. " +
        "(3) Add the redirect URI to the app registration's Authentication → Web platform."
      : undefined;

    // Write to file if outputPath provided
    if (inp["outputPath"]) {
      const outputPath = inp["outputPath"] as string;
      fs.writeFileSync(outputPath, content, "utf-8");
      return {
        template,
        filePath: outputPath,
        status: "written",
        ...(guardrailWarnings.length > 0 ? { warnings: guardrailWarnings } : {}),
        ...(previewWarning ? { warning: previewWarning } : {}),
      };
    }

    return {
      template,
      content: properties,
      status: "generated",
      ...(guardrailWarnings.length > 0 ? { warnings: guardrailWarnings } : {}),
      ...(previewWarning ? { warning: previewWarning } : {}),
    };
  },
};

/* ── Tool Registry ── */

/* ── Tool: setAutonomyMode ── */

const setAutonomyModeTool: ToolDefinition = {
  name: "setAutonomyMode",
  description:
    "Set the session-scoped autonomy mode. In 'autonomous' mode, tools that normally require " +
    "explicit confirmation (e.g., connector_delete) will auto-approve if the admin-level " +
    "'policies.autonomy.allowAutoApprove' config flag is true. Mode resets to 'confirm' each session. " +
    "All auto-approved actions are logged at warn level.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["confirm", "autonomous"],
        description: "The autonomy mode to set for this session.",
      },
    },
    required: ["mode"],
  },
  handler: async (input: unknown, config: unknown) => {
    const cfg = config as AgentConfig;
    const inp = input as Record<string, unknown>;
    const requestedMode = inp["mode"] as "confirm" | "autonomous";

    if (requestedMode === "autonomous") {
      const allowed = cfg.policies.autonomy?.allowAutoApprove ?? false;
      if (!allowed) {
        return {
          status: "denied",
          currentMode: getAutonomyMode(),
          error:
            "Autonomous mode is not allowed. Set 'policies.autonomy.allowAutoApprove: true' " +
            "in the agent config to enable.",
        };
      }
      log("⚠️ Autonomy mode set to 'autonomous'. Auto-approved actions will be logged at warn level.");
    }

    setAutonomyMode(requestedMode);

    return {
      status: "ok",
      currentMode: requestedMode,
      note: requestedMode === "autonomous"
        ? "Autonomous mode active. Confirmation prompts are suppressed for this session. " +
          "All auto-approved actions are logged. Use setAutonomyMode('confirm') to re-enable prompts."
        : "Confirm mode active. Tools will prompt for confirmation on destructive actions.",
    };
  },
};

/* ── Tool Registry (final) ── */

export const toolRegistry: ToolRegistry = {
  connector_listEnvironments: listEnvironmentsTool,
  connector_list: listConnectorsTool,
  connector_validate: validateTool,
  connector_create: createTool,
  connector_update: updateTool,
  connector_delete: deleteTool,
  connector_deploy: deployTool,
  connector_initProperties: initPropertiesTool,
  setAutonomyMode: setAutonomyModeTool,
};

/* ── Tool Invocation ── */

export async function invokeTool(
  toolName: string,
  input: unknown,
  config: AgentConfig
): Promise<ToolInvocationResult> {
  const tool = toolRegistry[toolName];
  if (!tool) {
    return { ok: false, toolName, error: `Unknown tool: ${toolName}` };
  }

  try {
    const result = await tool.handler(input, config);
    return { ok: true, toolName, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Tool '${toolName}' failed: ${message}`);
    return { ok: false, toolName, error: message };
  }
}
