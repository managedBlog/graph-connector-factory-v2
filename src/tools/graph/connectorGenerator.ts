/**
 * Connector generator for Power Platform–compatible Swagger 2.0.
 *
 * Takes selected GraphOperationInfo[], builds a minimal Swagger 2.0 document,
 * injects x-ms-* extensions, wires OAuth2 security, validates against
 * Power Platform constraints, and auto-splits if limits are exceeded.
 */

import { GraphOperationInfo, ConnectorAuthConfig, ConnectorFile, ConnectorOutputFormat, RequestBodyProperty } from "./types";
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

// ─── Known required sub-properties within complex types (operation-scoped) ──
//
// Key format: "entitySet.METHOD.propertyName" (lowercase entitySet).
// Only applies when the parent property IS in KNOWN_REQUIRED_FIELDS and the
// operation method matches. PATCH operations are intentionally excluded —
// complex type sub-properties are optional on partial updates.

const KNOWN_NESTED_REQUIRED: Record<string, readonly string[]> = {
  "users.POST.passwordProfile": ["password", "forceChangePasswordNextSignIn"],
};

// ─── Known descriptions for complex type sub-properties ─────────────────────
//
// Provides helpful tooltip text on the Power Platform definition page and
// in flow designer inputs. Falls back to formatParamDescription() for unmapped.

const KNOWN_DESCRIPTIONS: Record<string, string> = {
  "passwordProfile.password": "The password for the user. Must meet tenant password complexity requirements.",
  "passwordProfile.forceChangePasswordNextSignIn": "If true, the user must change their password at next login.",
  "passwordProfile.forceChangePasswordNextSignInWithMfa": "If true, the user must perform MFA then change their password at next login.",
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

// ─── Graph docs URL helper ─────────────────────────────────────────────────

function singularizeEntity(name: string): string {
  if (name.endsWith("ies")) return name.slice(0, -3) + "y";
  if (name.endsWith("ses") || name.endsWith("xes") || name.endsWith("zes")) return name.slice(0, -2);
  if (name.endsWith("s") && !name.endsWith("ss")) return name.slice(0, -1);
  return name;
}

/**
 * Generate a Microsoft Learn docs URL for a Graph API operation.
 * Works for any Graph endpoint — no curated map needed.
 */
function buildGraphDocsUrl(entitySet: string, method: string, hasPathParam: boolean, version: string): string {
  const entity = singularizeEntity(entitySet);
  let verb: string;
  switch (method.toUpperCase()) {
    case "GET": verb = hasPathParam ? "get" : "list"; break;
    case "POST": verb = "create"; break;
    case "PATCH": case "PUT": verb = "update"; break;
    case "DELETE": verb = "delete"; break;
    default: verb = method.toLowerCase();
  }
  const versionTag = version === "beta" ? "graph-rest-beta" : "graph-rest-1.0";
  return `https://learn.microsoft.com/en-us/graph/api/${entity}-${verb}?view=${versionTag}`;
}

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
    const hasPathParam = op.parameters.some((p) => p.in === "path");
    const entitySet = entitySetNameFromPath(op.path);
    const docsUrl = entitySet ? buildGraphDocsUrl(entitySet, op.method, hasPathParam, version) : "";
    const descriptionWithDocs = docsUrl
      ? `${op.description} Docs: ${docsUrl}`
      : op.description;

    const operation: Record<string, unknown> = {
      operationId: op.operationId,
      summary: op.summary,
      description: descriptionWithDocs,
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

/**
 * Context passed to toSwaggerPropertyDef for operation-aware visibility and required.
 */
interface PropertyEmitContext {
  /** The entity set name (lowercase), e.g. "users" */
  readonly entitySet?: string | undefined;
  /** The HTTP method, e.g. "POST", "PATCH" */
  readonly operationMethod?: string | undefined;
  /** The parent property name (for nested required/description lookups) */
  readonly parentName?: string | undefined;
  /** Whether this property is a known-required field on the current operation */
  readonly isRequired?: boolean | undefined;
}

/**
 * Recursively convert a RequestBodyProperty into a Swagger 2.0 property definition.
 * Handles nested objects, arrays of objects, enums, and primitives.
 * Uses operation context for visibility, required arrays, and descriptions.
 */
function toSwaggerPropertyDef(bp: RequestBodyProperty, ctx: PropertyEmitContext = {}): Record<string, unknown> {
  const isNullable = bp.nullable !== false;

  // Determine visibility: required fields get "important", others follow nullable
  const visibility = ctx.isRequired ? "important" : (isNullable ? "advanced" : "important");

  // Look up known description override (parentName.childName)
  const descKey = ctx.parentName ? `${ctx.parentName}.${bp.name}` : "";
  const description = (descKey && KNOWN_DESCRIPTIONS[descKey]) || bp.description;
  const summary = bp.description; // x-ms-summary stays as the formatted property name

  // Nested object with sub-properties
  if (bp.type === "object" && bp.properties && bp.properties.length > 0) {
    // Look up nested required fields (operation-scoped)
    const nestedReqKey = ctx.entitySet && ctx.operationMethod
      ? `${ctx.entitySet}.${ctx.operationMethod}.${bp.name}`
      : "";
    const nestedRequired = nestedReqKey ? (KNOWN_NESTED_REQUIRED[nestedReqKey] ?? []) : [];
    const nestedRequiredSet = new Set(nestedRequired);

    const nestedProps: Record<string, unknown> = {};
    for (const child of bp.properties) {
      nestedProps[child.name] = toSwaggerPropertyDef(child, {
        entitySet: ctx.entitySet,
        operationMethod: ctx.operationMethod,
        parentName: bp.name,
        isRequired: nestedRequiredSet.has(child.name),
      });
    }

    const objectDef: Record<string, unknown> = {
      type: "object",
      properties: nestedProps,
      description,
      "x-ms-summary": summary,
      "x-ms-visibility": visibility,
    };

    // Add required array for nested object if we have known-required sub-properties
    if (nestedRequired.length > 0) {
      // Only include required fields that actually exist in the emitted properties
      const applicable = nestedRequired.filter((f) => nestedProps[f] !== undefined);
      if (applicable.length > 0) {
        objectDef["required"] = applicable;
      }
    }

    if (bp.isArray) {
      return {
        type: "array",
        items: objectDef,
        description,
        "x-ms-summary": summary,
        "x-ms-visibility": visibility,
      };
    }

    return objectDef;
  }

  // Array of primitives/enums
  if (bp.isArray) {
    const itemDef: Record<string, unknown> = { type: bp.type };
    if (bp.enum && bp.enum.length > 0) {
      itemDef["enum"] = bp.enum;
    }
    return {
      type: "array",
      items: itemDef,
      description,
      "x-ms-summary": summary,
      "x-ms-visibility": visibility,
    };
  }

  // Scalar (primitive or enum)
  const propDef: Record<string, unknown> = {
    type: bp.type,
    description,
    "x-ms-summary": summary,
    "x-ms-visibility": visibility,
  };

  if (bp.enum && bp.enum.length > 0) {
    propDef["enum"] = bp.enum;
    propDef["x-ms-enum-values"] = bp.enum.map((v) => ({
      displayName: v.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c: string) => c.toUpperCase()),
      value: v,
    }));
  }

  return propDef;
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
      const entitySet = entitySetNameFromPath(op.path);
      const requiredSet = new Set(
        isCreateOp && KNOWN_REQUIRED_FIELDS[entitySet]
          ? KNOWN_REQUIRED_FIELDS[entitySet]
          : []
      );
      const props: Record<string, unknown> = {};
      for (const bp of op.requestBodyProperties) {
        props[bp.name] = toSwaggerPropertyDef(bp, {
          entitySet,
          operationMethod: op.method,
          isRequired: requiredSet.has(bp.name),
        });
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
