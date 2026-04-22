/**
 * Connector generator for Power Platform–compatible Swagger 2.0.
 *
 * Takes selected GraphOperationInfo[], builds a minimal Swagger 2.0 document,
 * injects x-ms-* extensions, wires OAuth2 security, validates against
 * Power Platform constraints, and auto-splits if limits are exceeded.
 */

import { GraphOperationInfo, ConnectorAuthConfig, ConnectorFile, ConnectorOutputFormat } from "./types";
import { normalizeDefinitions, SwaggerDefinitions } from "./schemaNormalizer";
import { convertSwagger20ToOpenApi30 } from "./openapi3Converter";
import * as yaml from "js-yaml";

// ─── Known required fields for Graph entity creation ────────────────────────
//
// CSDL Nullable="false" does NOT reliably indicate which fields are required
// for creation — it only means the stored value cannot be null (the server
// often provides defaults). These maps capture the actually-required fields
// from the Graph API documentation for common entity types.
//
// Key = lowercase last path segment (entity set name), e.g. "users", "groups".
// Value = array of property names that Graph API requires for POST creation.

const KNOWN_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  users: ["accountEnabled", "displayName", "mailNickname", "passwordProfile", "userPrincipalName"],
  groups: ["displayName", "mailEnabled", "mailNickname", "securityEnabled"],
  applications: ["displayName"],
  serviceprincipals: ["appId"],
  teams: ["displayName"],
  channels: ["displayName"],
  sites: ["displayName"],
  exportjobs: ["reportName"],
};

/**
 * Derive the entity set name from the operation's path.
 * E.g. "/users" → "users", "/groups/{group-id}/members" → "members"
 */
function entitySetNameFromPath(path: string): string {
  // For create ops the path is typically "/{entitySet}" (no trailing {id}).
  // Strip leading slash and take the last non-parameterised segment.
  const segments = path.split("/").filter((s) => s && !s.startsWith("{"));
  return (segments[segments.length - 1] ?? "").toLowerCase();
}

// ─── Power Platform constraints ─────────────────────────────────────────────

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1 MB
const MAX_OPERATIONS = 256;
const MAX_BODY_SCHEMAS = 512;

// ─── Swagger 2.0 document builder ──────────────────────────────────────────

interface SwaggerDocument {
  swagger: "2.0";
  info: { title: string; description: string; version: string };
  host: string;
  basePath: string;
  schemes: string[];
  consumes: string[];
  produces: string[];
  securityDefinitions: Record<string, unknown>;
  security: Array<Record<string, string[]>>;
  paths: Record<string, Record<string, unknown>>;
  definitions: SwaggerDefinitions;
}

function buildSwaggerDocument(
  operations: readonly GraphOperationInfo[],
  connectorName: string,
  connectorDescription: string,
  version: string,
  authConfig: ConnectorAuthConfig
): SwaggerDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const definitions: SwaggerDefinitions = {};

  for (const op of operations) {
    if (!paths[op.path]) {
      paths[op.path] = {};
    }

    const method = op.method.toLowerCase();
    const operation: Record<string, unknown> = {
      operationId: op.operationId,
      summary: op.summary,
      description: op.description,
      "x-ms-summary": op.summary,
      parameters: buildSwaggerParameters(op),
      responses: buildSwaggerResponses(op, definitions),
    };

    // Add x-ms-visibility for less-common operations
    if (method === "delete") {
      operation["x-ms-visibility"] = "advanced";
    }

    paths[op.path]![method] = operation;
  }

  // Build OAuth2 security definition
  const scopes: Record<string, string> = {};
  for (const op of operations) {
    for (const scope of op.requiredScopes) {
      scopes[scope] = scope;
    }
  }

  const tenantId = authConfig.tenantId ?? "common";

  return {
    swagger: "2.0",
    info: {
      title: connectorName,
      description: connectorDescription,
      version: "1.0.0",
    },
    host: "graph.microsoft.com",
    basePath: `/${version}`,
    schemes: ["https"],
    consumes: ["application/json"],
    produces: ["application/json"],
    securityDefinitions: {
      oauth2_auth: {
        type: "oauth2",
        flow: "accessCode",
        authorizationUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        scopes,
      },
    },
    security: [{ oauth2_auth: Object.keys(scopes) }],
    paths,
    definitions,
  };
}

function buildSwaggerParameters(op: GraphOperationInfo): unknown[] {
  const params: unknown[] = [];

  for (const p of op.parameters) {
    const param: Record<string, unknown> = {
      name: p.name,
      in: p.in,
      required: p.required,
      type: p.type === "integer" ? "integer" : "string",
      description: p.description,
      "x-ms-summary": formatParamSummary(p.name),
    };

    // Add url encoding hint for path params
    if (p.in === "path") {
      param["x-ms-url-encoding"] = "single";
    }

    // Mark OData query params as advanced
    if (p.name.startsWith("$")) {
      param["x-ms-visibility"] = "advanced";
    }

    params.push(param);
  }

  // Add request body as a body parameter if needed
  if (op.requestBodySummary) {
    const bodyDefName = `${op.operationId}_body`;
    params.push({
      name: "body",
      in: "body",
      required: true,
      description: op.requestBodySummary,
      schema: { $ref: `#/definitions/${bodyDefName}` },
    });
  }

  return params;
}

function buildSwaggerResponses(
  op: GraphOperationInfo,
  definitions: SwaggerDefinitions
): Record<string, unknown> {
  const responses: Record<string, unknown> = {};

  const isAction = op.method === "POST" && op.responseSummary === null;
  const isDelete = op.method === "DELETE";
  const isItemGet = op.method === "GET" && op.path.includes("{");
  const isCreate = op.method === "POST" && op.responseSummary !== null;
  const isPatch = op.method === "PATCH";

  if (isDelete || isAction) {
    // Fire-and-forget actions and DELETEs return 204 No Content
    responses["204"] = { description: "No content." };
  } else if (isItemGet || isCreate || isPatch) {
    // Single-entity GET, POST create, and PATCH update return a flat object
    const responseDefName = `${op.operationId}_response`;
    const statusCode = isCreate ? "201" : "200";
    responses[statusCode] = {
      description: op.responseSummary ?? "Success",
      schema: { $ref: `#/definitions/${responseDefName}` },
    };
    definitions[responseDefName] = {
      type: "object",
      description: op.responseSummary ?? `${op.operationId} object`,
    };
  } else {
    // Collection GET returns value array wrapper
    const responseDefName = `${op.operationId}_response`;
    responses["200"] = {
      description: op.responseSummary ?? "Success",
      schema: { $ref: `#/definitions/${responseDefName}` },
    };
    definitions[responseDefName] = {
      type: "object",
      description: op.responseSummary ?? `Response for ${op.operationId}`,
      properties: {
        value: {
          type: "array",
          items: { type: "object" },
          description: "Collection of results",
          "x-ms-summary": "Results",
        },
      },
    };
  }

  // Add request body definition with typed properties if available
  if (op.requestBodySummary) {
    const bodyDefName = `${op.operationId}_body`;
    const bodyDef: Record<string, unknown> = {
      type: "object",
      description: op.requestBodySummary,
    };

    // For create operations (POST), add known-required fields.
    const isCreateOp = op.method === "POST" && op.responseSummary !== null;
    if (isCreateOp) {
      const entitySet = entitySetNameFromPath(op.path);
      const knownRequired = KNOWN_REQUIRED_FIELDS[entitySet];
      if (knownRequired && knownRequired.length > 0) {
        // Only include required fields that actually exist in the body properties
        const bodyPropNames = new Set(
          (op.requestBodyProperties ?? []).map((bp) => bp.name)
        );
        const applicableRequired = knownRequired.filter((f) => bodyPropNames.has(f));
        if (applicableRequired.length > 0) {
          bodyDef["required"] = applicableRequired;
        }
      }
    }

    if (op.requestBodyProperties && op.requestBodyProperties.length > 0) {
      const props: Record<string, unknown> = {};
      for (const bp of op.requestBodyProperties) {
        const isNullable = bp.nullable !== false; // default to nullable if not set

        // NOTE: We intentionally do NOT derive "required" from CSDL Nullable.
        // Nullable="false" means the stored value cannot be null, but the server
        // often provides defaults (e.g. deviceEnrollmentLimit=5, birthday=epoch).
        // Truly required creation fields (displayName, accountEnabled, etc.)
        // are documented in Graph API docs, not derivable from CSDL metadata.
        // We use x-ms-visibility to surface non-nullable fields prominently
        // while letting the server validate required fields at runtime.
        const propDef: Record<string, unknown> = bp.isArray
          ? {
              type: "array",
              items: { type: bp.type },
              description: bp.description,
              "x-ms-summary": bp.description,
              "x-ms-visibility": isNullable ? "advanced" : "important",
            }
          : {
              type: bp.type,
              description: bp.description,
              "x-ms-summary": bp.description,
              "x-ms-visibility": isNullable ? "advanced" : "important",
            };

        // Include enum values so connectors show a dropdown picker
        if (bp.enum && bp.enum.length > 0) {
          propDef["enum"] = bp.enum;
          propDef["x-ms-enum-values"] = bp.enum.map((v) => ({
            displayName: v.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c: string) => c.toUpperCase()),
            value: v,
          }));
        }

        props[bp.name] = propDef;
      }
      bodyDef["properties"] = props;
    }

    definitions[bodyDefName] = bodyDef;
  }

  // Error responses
  responses["default"] = {
    description: "Error response",
    schema: {
      $ref: "#/definitions/ODataError",
    },
  };

  // Ensure ODataError definition exists
  if (!definitions["ODataError"]) {
    definitions["ODataError"] = {
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: {
            code: { type: "string", description: "Error code", "x-ms-summary": "Error Code" },
            message: { type: "string", description: "Error message", "x-ms-summary": "Error Message" },
          },
        },
      },
    };
  }

  return responses;
}

function formatParamSummary(name: string): string {
  // Remove $ prefix for OData params, then Title Case
  const clean = name.replace(/^\$/, "");
  return clean
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/-/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

// ─── Validation ─────────────────────────────────────────────────────────────

interface ValidationResult {
  readonly valid: boolean;
  readonly warnings: string[];
}

function validateSwaggerForPowerPlatform(doc: SwaggerDocument): ValidationResult {
  const warnings: string[] = [];

  // Check operation count
  let opCount = 0;
  for (const methods of Object.values(doc.paths)) {
    opCount += Object.keys(methods).length;
  }
  if (opCount > MAX_OPERATIONS) {
    warnings.push(`Operation count (${opCount}) exceeds Power Platform limit of ${MAX_OPERATIONS}.`);
  }

  // Check definitions count (body schemas)
  const defCount = Object.keys(doc.definitions).length;
  if (defCount > MAX_BODY_SCHEMAS) {
    warnings.push(`Schema definition count (${defCount}) exceeds Power Platform limit of ${MAX_BODY_SCHEMAS}.`);
  }

  // Check file size
  const json = JSON.stringify(doc, null, 2);
  if (json.length > MAX_FILE_SIZE_BYTES) {
    warnings.push(`File size (${(json.length / 1024).toFixed(0)} KB) exceeds Power Platform limit of 1 MB.`);
  }

  return { valid: warnings.length === 0, warnings };
}

// ─── Auto-split ─────────────────────────────────────────────────────────────

function splitOperations(
  operations: readonly GraphOperationInfo[],
  maxPerFile: number
): GraphOperationInfo[][] {
  const chunks: GraphOperationInfo[][] = [];
  for (let i = 0; i < operations.length; i += maxPerFile) {
    chunks.push(operations.slice(i, i + maxPerFile));
  }
  return chunks;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface GenerateConnectorOptions {
  readonly version: string;
  readonly operations: readonly GraphOperationInfo[];
  readonly connectorName: string;
  readonly connectorDescription: string;
  readonly authConfig: ConnectorAuthConfig;
  readonly maxOperationsPerConnector: number;
  readonly autoFlatten: boolean;
  readonly format: ConnectorOutputFormat;
}

export interface GenerateConnectorResult {
  readonly connectorFiles: ConnectorFile[];
  readonly totalOperations: number;
  readonly validationWarnings: string[];
  readonly flatteningLog: string[];
}

export function generateConnector(options: GenerateConnectorOptions): GenerateConnectorResult {
  const {
    version,
    operations,
    connectorName,
    connectorDescription,
    authConfig,
    maxOperationsPerConnector,
    autoFlatten,
    format,
  } = options;

  const allWarnings: string[] = [];
  const allFlatteningLog: string[] = [];
  const connectorFiles: ConnectorFile[] = [];

  // Split if needed
  const chunks = splitOperations(operations, maxOperationsPerConnector);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const suffix = chunks.length > 1 ? `-part${i + 1}` : "";
    const name = `${connectorName}${suffix}`;
    const baseFilename = `${connectorName.toLowerCase().replace(/\s+/g, "-")}${suffix}`;

    // Build the Swagger document
    let doc = buildSwaggerDocument(chunk, name, connectorDescription, version, authConfig);

    // Normalize definitions if auto-flatten is enabled
    if (autoFlatten) {
      const { definitions: normalizedDefs, log } = normalizeDefinitions(doc.definitions);
      doc = { ...doc, definitions: normalizedDefs };
      allFlatteningLog.push(...log);
    }

    // Validate (always validate the Swagger 2.0 form)
    const validation = validateSwaggerForPowerPlatform(doc);
    allWarnings.push(...validation.warnings.map((w) => `[${baseFilename}] ${w}`));

    // Emit requested format(s)
    const emitSwaggerJson = format === "swagger-json" || format === "all";
    const emitSwaggerYaml = format === "swagger-yaml" || format === "all";
    const emitOpenApiJson = format === "openapi-json" || format === "all";

    if (emitSwaggerJson) {
      connectorFiles.push({
        filename: `${baseFilename}.swagger.json`,
        content: JSON.stringify(doc, null, 2),
      });
    }

    if (emitSwaggerYaml) {
      connectorFiles.push({
        filename: `${baseFilename}.swagger.yaml`,
        content: yaml.dump(JSON.parse(JSON.stringify(doc)), {
          indent: 2,
          lineWidth: 120,
          noRefs: true,
          quotingType: "\"",
          forceQuotes: false,
        }),
      });
    }

    if (emitOpenApiJson) {
      const openapi3 = convertSwagger20ToOpenApi30(JSON.parse(JSON.stringify(doc)));
      connectorFiles.push({
        filename: `${baseFilename}.openapi.json`,
        content: JSON.stringify(openapi3, null, 2),
      });
    }
  }

  return {
    connectorFiles,
    totalOperations: operations.length,
    validationWarnings: allWarnings,
    flatteningLog: allFlatteningLog,
  };
}
