/**
 * Multi-Connector CUA Test Plan Generator.
 *
 * Produces a lean operation manifest that a Computer Use Agent can follow
 * to test multiple Power Platform custom connectors. The CUA's own agent
 * instructions handle portal navigation — this plan only specifies WHAT
 * to test and WITH WHAT data.
 *
 * Key design decisions:
 * - Output is self-contained JSON — no server lookups at CUA runtime.
 * - Write ops include inline JSON bodies (from KNOWN_BODY_TEMPLATES or overrides).
 * - Dynamic value chaining uses {{c<N>.<OperationId>.<captureKey>}} placeholders.
 * - A run nonce is appended to created resources to avoid collisions on repeat runs.
 */

import type {
  MultiConnectorTestInput,
  MultiConnectorTestPlan,
  ConnectorTestPlanEntry,
  ConnectorTestSpec,
  OperationTestStep,
  MultiConnectorSummary,
  SwaggerOperation,
  SwaggerParameter,
} from "./types";

// ─── Known body templates (reused from testPlanGenerator.ts) ────────────────

const KNOWN_BODY_TEMPLATES: Record<string, (nonce: string) => Record<string, unknown>> = {
  users: (nonce) => ({
    accountEnabled: true,
    displayName: `GCF Test User ${nonce}`,
    mailNickname: `gcf-test-user-${nonce}`,
    passwordProfile: {
      forceChangePasswordNextSignIn: true,
      password: "{{testUserPassword}}",
    },
    userPrincipalName: `gcf-test-user-${nonce}@{{tenantDomain}}`,
  }),
  groups: (nonce) => ({
    displayName: `GCF Test Group ${nonce}`,
    mailEnabled: false,
    mailNickname: `gcf-test-group-${nonce}`,
    securityEnabled: true,
  }),
  applications: (nonce) => ({
    displayName: `GCF Test Application ${nonce}`,
  }),
  serviceprincipals: () => ({
    appId: "{{testAppId}}",
  }),
  teams: (nonce) => ({
    "template@odata.bind": "https://graph.microsoft.com/v1.0/teamsTemplates('standard')",
    displayName: `GCF Test Team ${nonce}`,
    description: "Created by GCF test plan",
  }),
  channels: (nonce) => ({
    displayName: `GCF Test Channel ${nonce}`,
    description: "Created by GCF test plan",
  }),
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a multi-connector test plan.
 *
 * @throws {Error} if required inputs are missing or swagger cannot be resolved.
 */
export function generateMultiConnectorTestPlan(
  input: MultiConnectorTestInput,
): MultiConnectorTestPlan {
  if (!input.environmentId) throw new Error("environmentId is required");
  if (!input.connectors || input.connectors.length === 0) {
    throw new Error("At least one connector is required");
  }

  const nonce = generateNonce();
  const connectorEntries: ConnectorTestPlanEntry[] = [];

  for (let ci = 0; ci < input.connectors.length; ci++) {
    const spec = input.connectors[ci]!;
    if (!spec.displayName) throw new Error(`connectors[${ci}].displayName is required`);

    const swagger = resolveSwagger(spec, ci);
    const allOps = parseSwaggerOperations(swagger);

    if (allOps.length === 0) {
      throw new Error(`No operations found in swagger for "${spec.displayName}"`);
    }

    const filteredOps = filterByScope(allOps, spec.scope);
    const orderedOps = orderOperations(filteredOps);
    const connectorPrefix = `c${ci}`;

    const operations = buildOperationSteps(
      orderedOps,
      connectorPrefix,
      nonce,
      spec.bodyOverrides,
    );

    connectorEntries.push({
      displayName: spec.displayName,
      operations,
    });
  }

  const summary = buildSummary(connectorEntries);

  return {
    schemaVersion: "1.0",
    environmentId: input.environmentId,
    generatedAt: new Date().toISOString(),
    connectors: connectorEntries,
    variables: input.variables ?? {},
    summary,
  };
}

// ─── Swagger Resolution ─────────────────────────────────────────────────────

function resolveSwagger(
  spec: ConnectorTestSpec,
  index: number,
): Record<string, unknown> {
  if (spec.swagger) {
    return typeof spec.swagger === "string"
      ? JSON.parse(spec.swagger) as Record<string, unknown>
      : spec.swagger;
  }
  throw new Error(
    `connectors[${index}] ("${spec.displayName}"): no swagger provided. ` +
    `Pass swagger directly or use baseName for server-side cache resolution.`,
  );
}

// ─── Swagger Parsing ────────────────────────────────────────────────────────

function parseSwaggerOperations(swagger: Record<string, unknown>): SwaggerOperation[] {
  const paths = swagger["paths"] as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return [];

  const operations: SwaggerOperation[] = [];

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    // Collect path-level parameters (shared by all methods on this path)
    const pathLevelParams = (pathItem["parameters"] as Array<Record<string, unknown>>) ?? [];

    for (const [method, opObj] of Object.entries(pathItem)) {
      if (method === "parameters" || typeof opObj !== "object" || opObj === null) continue;
      const op = opObj as Record<string, unknown>;
      const operationId = op["operationId"] as string | undefined;
      if (!operationId) continue;

      const opLevelParams = (op["parameters"] as Array<Record<string, unknown>>) ?? [];
      // Merge path-level + operation-level params (operation-level wins on conflict)
      const mergedRaw = mergeParameters(pathLevelParams, opLevelParams);

      const parameters: SwaggerParameter[] = mergedRaw.map((p) => ({
        name: p["name"] as string,
        in: p["in"] as SwaggerParameter["in"],
        required: (p["required"] as boolean) ?? false,
        type: p["type"] as string | undefined,
        description: p["description"] as string | undefined,
        schema: p["schema"] as Record<string, unknown> | undefined,
      }));

      // Extract response schema — check all 2xx codes
      const responses = op["responses"] as Record<string, Record<string, unknown>> | undefined;
      const successResponse = find2xxResponse(responses);
      const responseSchema = successResponse?.["schema"] as Record<string, unknown> | undefined;
      const successCode = findSuccessCode(responses, method);

      operations.push({
        operationId,
        method: method.toUpperCase(),
        path: pathStr,
        summary: (op["summary"] as string) ?? "",
        parameters,
        responseSchema,
        _successCode: successCode,
      } as SwaggerOperation & { _successCode: number });
    }
  }

  return operations;
}

/** Merge path-level and operation-level parameters. Operation-level wins on name+in conflict. */
function mergeParameters(
  pathLevel: Array<Record<string, unknown>>,
  opLevel: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const opKeys = new Set(opLevel.map((p) => `${p["in"]}:${p["name"]}`));
  const fromPath = pathLevel.filter((p) => !opKeys.has(`${p["in"]}:${p["name"]}`));
  return [...fromPath, ...opLevel];
}

/** Find the first 2xx response entry. */
function find2xxResponse(
  responses?: Record<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (!responses) return undefined;
  for (const code of ["200", "201", "204"]) {
    if (responses[code]) return responses[code];
  }
  return responses["default"];
}

/** Derive expected success HTTP status code from swagger responses + method. */
function findSuccessCode(
  responses?: Record<string, Record<string, unknown>>,
  method?: string,
): number {
  if (responses) {
    for (const code of ["200", "201", "204"]) {
      if (responses[code]) return parseInt(code, 10);
    }
  }
  // Fallback by method
  const m = (method ?? "get").toUpperCase();
  if (m === "POST") return 201;
  if (m === "DELETE" || m === "PATCH" || m === "PUT") return 204;
  return 200;
}

// ─── Scope Filtering ────────────────────────────────────────────────────────

function filterByScope(
  ops: SwaggerOperation[],
  scope: "all" | "crud" | readonly string[],
): SwaggerOperation[] {
  if (scope === "all") return ops;

  if (Array.isArray(scope)) {
    const ids = new Set(scope as string[]);
    const filtered = ops.filter((op) => ids.has(op.operationId));
    if (filtered.length === 0) {
      throw new Error(
        `None of the specified operation IDs [${(scope as string[]).join(", ")}] were found in swagger`,
      );
    }
    return filtered;
  }

  if (scope === "crud") {
    return filterCrudOperations(ops);
  }

  return ops;
}

/**
 * CRUD filter: for each entity set, include list + get + post + patch + delete
 * (if they exist). An entity set is "eligible" if it has at least a list operation.
 */
function filterCrudOperations(ops: SwaggerOperation[]): SwaggerOperation[] {
  // Group operations by entity set
  const entityOps = new Map<string, SwaggerOperation[]>();
  for (const op of ops) {
    const entity = entitySetNameFromPath(op.path);
    if (!entity) continue;
    const existing = entityOps.get(entity) ?? [];
    existing.push(op);
    entityOps.set(entity, existing);
  }

  const result: SwaggerOperation[] = [];
  for (const [, entityGroup] of entityOps) {
    // Entity set is eligible if it has at least a list (GET without path params)
    const hasList = entityGroup.some(
      (op) => op.method === "GET" && !op.parameters.some((p) => p.in === "path"),
    );
    if (!hasList) continue;

    // Include one of each CRUD method
    const picked = new Map<string, SwaggerOperation>();
    for (const op of entityGroup) {
      const method = op.method.toUpperCase();
      const hasPathParams = op.parameters.some((p) => p.in === "path");

      let key: string;
      if (method === "GET" && !hasPathParams) key = "LIST";
      else if (method === "GET" && hasPathParams) key = "GET";
      else key = method; // POST, PATCH, PUT, DELETE

      if (!picked.has(key)) {
        picked.set(key, op);
      }
    }
    result.push(...picked.values());
  }

  return result;
}

// ─── Operation Ordering ─────────────────────────────────────────────────────

function orderOperations(ops: SwaggerOperation[]): SwaggerOperation[] {
  return [...ops].sort((a, b) => operationPriority(a) - operationPriority(b));
}

function operationPriority(op: SwaggerOperation): number {
  const method = op.method.toUpperCase();
  const hasPathParams = op.parameters.some((p) => p.in === "path");
  if (method === "GET" && !hasPathParams) return 0; // list
  if (method === "GET" && hasPathParams) return 1;  // item
  if (method === "POST") return 2;
  if (method === "PATCH" || method === "PUT") return 3;
  if (method === "DELETE") return 4;
  return 5;
}

// ─── Step Building ──────────────────────────────────────────────────────────

function buildOperationSteps(
  ops: SwaggerOperation[],
  connectorPrefix: string,
  nonce: string,
  bodyOverrides?: Record<string, Record<string, unknown>>,
): OperationTestStep[] {
  const steps: OperationTestStep[] = [];

  // Track list operations for value chaining (entitySet → scoped operationId reference)
  const listOpRefs = new Map<string, string>(); // entitySet → "c0.ListUsers"
  // Track POST operations for write-op lifecycle dependencies
  const postOpRefs = new Map<string, string>();  // entitySet → "c0.CreateUser"

  for (const op of ops) {
    const method = op.method.toUpperCase();
    const entitySet = entitySetNameFromPath(op.path);
    const scopedId = `${connectorPrefix}.${op.operationId}`;
    const successCode = (op as SwaggerOperation & { _successCode?: number })._successCode
      ?? defaultStatusCode(method);
    const isListOp = method === "GET" && !op.parameters.some((p) => p.in === "path");

    // Track references
    if (isListOp && entitySet) {
      listOpRefs.set(entitySet, scopedId);
    }
    if (method === "POST" && entitySet) {
      postOpRefs.set(entitySet, scopedId);
    }

    const step = buildSingleStep(
      op, method, entitySet, scopedId, successCode, isListOp,
      nonce, listOpRefs, postOpRefs, bodyOverrides,
    );
    steps.push(step);
  }

  return steps;
}

function buildSingleStep(
  op: SwaggerOperation,
  method: string,
  entitySet: string,
  scopedId: string,
  successCode: number,
  isListOp: boolean,
  nonce: string,
  listOpRefs: Map<string, string>,
  postOpRefs: Map<string, string>,
  bodyOverrides?: Record<string, Record<string, unknown>>,
): OperationTestStep {
  const params: Record<string, string> = {};
  const dependsOn: string[] = [];
  let capture: Record<string, string> | undefined;
  let body: Record<string, unknown> | undefined;

  // Build parameters
  for (const param of op.parameters) {
    if (param.in === "header" || param.in === "body") continue;

    if (param.in === "path") {
      // For write ops (PATCH/DELETE), prefer the POST-created resource ID
      if (isWriteMethod(method) && method !== "POST") {
        const postRef = postOpRefs.get(entitySet);
        if (postRef) {
          params[param.name] = `{{${postRef}.newId}}`;
          if (!dependsOn.includes(postRef)) dependsOn.push(postRef);
          continue;
        }
      }
      // For GET-by-id, reference the list operation's captured ID
      const listRef = listOpRefs.get(entitySet);
      if (listRef) {
        const singular = singularize(entitySet);
        params[param.name] = `{{${listRef}.${singular}Id}}`;
        if (!dependsOn.includes(listRef)) dependsOn.push(listRef);
      } else {
        params[param.name] = `<provide-${param.name}>`;
      }
    } else if (param.in === "query") {
      if (param.name === "$top") {
        params[param.name] = "5";
      }
    }
  }

  // Add $top for list operations even if not explicit in params
  if (isListOp && !params["$top"]) {
    params["$top"] = "5";
  }

  // Capture for list operations
  if (isListOp) {
    const singular = singularize(entitySet);
    capture = { [`${singular}Id`]: "value[0].id" };
  }

  // Capture for POST operations
  if (method === "POST") {
    capture = { newId: "id" };
  }

  // Body for write operations
  if (method === "POST" || method === "PATCH" || method === "PUT") {
    body = resolveBody(method, entitySet, nonce, bodyOverrides);

    // PATCH/DELETE depend on POST
    if (method !== "POST") {
      const postRef = postOpRefs.get(entitySet);
      if (postRef && !dependsOn.includes(postRef)) {
        dependsOn.push(postRef);
      }
    }
  }

  // DELETE depends on the update step (or POST if no update)
  if (method === "DELETE") {
    const postRef = postOpRefs.get(entitySet);
    if (postRef && !dependsOn.includes(postRef)) {
      dependsOn.push(postRef);
    }
  }

  const isCollection = isListOp || hasValueArray(op.responseSchema);

  return {
    operationId: op.operationId,
    method,
    description: op.summary || `${method} ${op.path}`,
    ...(Object.keys(params).length > 0 ? { parameters: params } : {}),
    ...(body ? { body } : {}),
    ...(capture ? { capture } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    expectedResponse: {
      statusCode: successCode,
      ...(isCollection ? { valueIsArray: true } : {}),
    },
  };
}

// ─── Body Resolution ────────────────────────────────────────────────────────

function resolveBody(
  method: string,
  entitySet: string,
  nonce: string,
  bodyOverrides?: Record<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  // Check overrides first
  if (bodyOverrides?.[entitySet]) {
    return bodyOverrides[entitySet];
  }

  if (method === "POST") {
    const templateFn = KNOWN_BODY_TEMPLATES[entitySet];
    if (templateFn) return templateFn(nonce);
    // No template — return a placeholder
    return { "{{note}}": `Provide POST body for ${entitySet}` };
  }

  if (method === "PATCH" || method === "PUT") {
    // Minimal update body
    return { displayName: `GCF Updated ${nonce}` };
  }

  return undefined;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function entitySetNameFromPath(pathStr: string): string {
  const segments = pathStr.split("/").filter((s) => s && !s.startsWith("{"));
  return (segments[segments.length - 1] ?? "").toLowerCase();
}

function singularize(plural: string): string {
  if (plural.endsWith("ies")) return plural.slice(0, -3) + "y";
  if (plural.endsWith("ses") || plural.endsWith("xes")) return plural.slice(0, -2);
  if (plural.endsWith("s")) return plural.slice(0, -1);
  return plural;
}

function isWriteMethod(method: string): boolean {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
}

function defaultStatusCode(method: string): number {
  if (method === "POST") return 201;
  if (method === "DELETE" || method === "PATCH" || method === "PUT") return 204;
  return 200;
}

function hasValueArray(schema?: Record<string, unknown>): boolean {
  if (!schema) return false;
  const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
  if (!properties?.["value"]) return false;
  return properties["value"]["type"] === "array";
}

function generateNonce(): string {
  return Math.random().toString(36).substring(2, 6);
}

// ─── Summary ────────────────────────────────────────────────────────────────

function buildSummary(connectors: readonly ConnectorTestPlanEntry[]): MultiConnectorSummary {
  const methodCounts: Record<string, number> = {};
  let total = 0;

  for (const c of connectors) {
    for (const op of c.operations) {
      total++;
      methodCounts[op.method] = (methodCounts[op.method] ?? 0) + 1;
    }
  }

  return {
    totalConnectors: connectors.length,
    totalOperations: total,
    operationsByMethod: methodCounts,
  };
}
