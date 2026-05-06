/**
 * Multi-Connector CUA Test Plan Generator.
 *
 * Produces a human-readable markdown test plan that a Computer Use Agent
 * can follow to test Power Platform custom connectors in the portal UI.
 *
 * Key design decisions:
 * - Output is markdown — the CUA reads text, not JSON.
 * - Operations are ordered: LIST → POST → GET-by-id → PATCH → DELETE.
 * - GET-by-id uses the POST-created resource ID when POST exists.
 * - References are natural language ("use the `id` from Step 2").
 * - Template variables in body JSON use angle brackets: <tenantDomain>.
 *   When variables are provided, they are substituted with real values.
 * - Explicit field-by-field instructions are generated above the JSON body.
 * - Parameter descriptions from swagger are surfaced as notes.
 */

import type {
  MultiConnectorTestInput,
  ConnectorTestSpec,
  SwaggerOperation,
  SwaggerParameter,
} from "./types";

import {
  KNOWN_BODY_TEMPLATES,
  generateNonce,
  singularize,
  entitySetNameFromPath,
  isWriteMethod,
  defaultStatusCode,
  buildGraphDocsUrl,
} from "./shared";

// ─── Output Types ───────────────────────────────────────────────────────────

export interface MarkdownTestPlan {
  readonly markdown: string;
  readonly summary: {
    readonly totalConnectors: number;
    readonly totalOperations: number;
    readonly operationsByMethod: Record<string, number>;
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function generateMultiConnectorTestPlan(
  input: MultiConnectorTestInput,
): MarkdownTestPlan {
  if (!input.environmentId) throw new Error("environmentId is required");
  if (!input.connectors || input.connectors.length === 0) {
    throw new Error("At least one connector is required");
  }

  const nonce = generateNonce();
  const lines: string[] = [];
  const methodCounts: Record<string, number> = {};
  let totalOps = 0;
  let globalStep = 0;

  // ── Header ──────────────────────────────────────────────────────────────

  const title = input.connectors.length === 1
    ? `Test Plan: ${input.connectors[0]!.displayName}`
    : `Test Plan: ${input.connectors.length} Connectors`;

  lines.push(`# ${title}`);
  lines.push("");
  if (input.environmentName) {
    lines.push(`**Environment:** ${input.environmentName}`);
  }
  lines.push(`**Generated:** ${new Date().toISOString().split("T")[0]}`);
  lines.push("");

  // ── Pre-flight ──────────────────────────────────────────────────────────

  lines.push("## Pre-flight");
  lines.push("");
  lines.push("1. Open https://make.powerapps.com");
  if (input.environmentName) {
    lines.push(
      `2. Verify the environment name in the top-right shows "${input.environmentName}". If not, click the environment picker and select it by name.`,
    );
  } else {
    lines.push("2. Verify you are in the correct environment by checking the name in the top-right header.");
  }
  lines.push("3. Navigate to Custom connectors (left nav → More → Discover all → Custom connectors)");
  lines.push("");

  // ── Per-connector sections ──────────────────────────────────────────────

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

    lines.push(`## Connector: ${spec.displayName}`);
    lines.push("");
    lines.push(`1. Find **"${spec.displayName}"** in the Custom connectors list`);
    lines.push("2. Click **Edit** on the connector");
    lines.push("3. Go to the **Test** tab");
    lines.push("4. Create a connection if one doesn't exist");
    lines.push("");

    // Track step numbers for cross-references within this connector
    const postStepNum = new Map<string, number>();  // entitySet → step number of POST
    const listStepNum = new Map<string, number>();  // entitySet → step number of LIST

    for (const op of orderedOps) {
      globalStep++;
      totalOps++;
      const method = op.method.toUpperCase();
      methodCounts[method] = (methodCounts[method] ?? 0) + 1;

      const entitySet = entitySetNameFromPath(op.path);
      const hasPathParam = op.parameters.some((p) => p.in === "path");
      const isListOp = method === "GET" && !hasPathParam;
      const successCode = (op as SwaggerOperation & { _successCode?: number })._successCode
        ?? defaultStatusCode(method);
      const docsUrl = entitySet ? buildGraphDocsUrl(entitySet, method, hasPathParam) : undefined;

      // Track step numbers for references
      if (isListOp && entitySet) listStepNum.set(entitySet, globalStep);
      if (method === "POST" && entitySet) postStepNum.set(entitySet, globalStep);

      lines.push(`### Step ${globalStep}: ${op.summary || op.operationId} (${method})`);
      lines.push("");

      // Instruction line
      lines.push(`Select the **${op.operationId}** operation.`);

      // Parameters
      if (isListOp) {
        lines.push("Set `$top` to `5`.");
      }

      for (const param of op.parameters) {
        if (param.in === "header" || param.in === "body") continue;
        if (param.in === "query" && param.name === "$top") continue; // handled above

        if (param.in === "path") {
          const paramNote = buildParamInstruction(
            param, method, entitySet, postStepNum, listStepNum,
          );
          lines.push(paramNote);
        }
      }

      // Body for write operations
      if (method === "POST" || method === "PATCH" || method === "PUT") {
        const body = resolveBody(method, entitySet, nonce, spec.bodyOverrides);
        if (body) {
          // Apply variable substitutions (e.g., <tenantDomain> → real domain)
          const vars = input.variables ?? {};
          const substituted = substituteVariables(body, vars);
          const hasUnresolved = JSON.stringify(substituted).includes("<");

          // Explicit field-by-field instructions
          lines.push("");
          lines.push("Fill in the following fields:");
          lines.push("");
          emitFieldInstructions(substituted, lines, "");

          // JSON body as alternative
          lines.push("");
          lines.push("**Alternatively**, paste this JSON as the request body:");
          lines.push("");
          lines.push("```json");
          lines.push(JSON.stringify(substituted, null, 2));
          lines.push("```");
          if (hasUnresolved) {
            lines.push("");
            lines.push("Replace any angle-bracket values with real values before submitting.");
          }
        }
      }

      lines.push("");
      lines.push("Click **Test Operation** and wait for the response.");
      lines.push("");

      // Expected response
      lines.push(`**Expected:** ${successCode} ${statusText(successCode)}.`);

      // Capture instructions
      if (isListOp) {
        lines.push("");
        lines.push("Note the results returned. If subsequent steps need an ID from this list, use a value from the response.");
      }

      if (method === "POST") {
        lines.push("");
        lines.push("Capture the `id` from the response — you will need it for later steps (Get, Update, Delete).");
      }

      // Parameter description notes
      for (const param of op.parameters) {
        if (param.in === "path" && param.description) {
          lines.push("");
          lines.push(`**Note:** ${param.name} — ${param.description}`);
        }
      }

      // Docs link
      if (docsUrl) {
        lines.push("");
        lines.push(`**Docs:** ${docsUrl}`);
      }

      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  lines.push("## Summary");
  lines.push("");
  lines.push("After completing all steps, provide a summary listing each operation, whether it passed or failed, and any error details.");
  lines.push("");

  return {
    markdown: lines.join("\n"),
    summary: {
      totalConnectors: input.connectors.length,
      totalOperations: totalOps,
      operationsByMethod: methodCounts,
    },
  };
}

// ─── Parameter Instructions ─────────────────────────────────────────────────

function buildParamInstruction(
  param: SwaggerParameter,
  method: string,
  entitySet: string,
  postStepNum: Map<string, number>,
  listStepNum: Map<string, number>,
): string {
  // For non-POST operations, prefer POST-created ID when available
  if (method !== "POST") {
    const postStep = postStepNum.get(entitySet);
    if (postStep !== undefined) {
      return `For \`${param.name}\`, use the \`id\` captured from Step ${postStep}.`;
    }
  }

  // Fallback to list-derived value
  const listStep = listStepNum.get(entitySet);
  if (listStep !== undefined) {
    return `For \`${param.name}\`, use a value from the list in Step ${listStep}. Note: list results may include different object types — verify the item type before using its ID.`;
  }

  return `For \`${param.name}\`, provide an appropriate value. Check the Docs link or Definition page for accepted formats.`;
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
    const pathLevelParams = (pathItem["parameters"] as Array<Record<string, unknown>>) ?? [];

    for (const [method, opObj] of Object.entries(pathItem)) {
      if (method === "parameters" || typeof opObj !== "object" || opObj === null) continue;
      const op = opObj as Record<string, unknown>;
      const operationId = op["operationId"] as string | undefined;
      if (!operationId) continue;

      const opLevelParams = (op["parameters"] as Array<Record<string, unknown>>) ?? [];
      const mergedRaw = mergeParameters(pathLevelParams, opLevelParams);

      const parameters: SwaggerParameter[] = mergedRaw.map((p) => ({
        name: p["name"] as string,
        in: p["in"] as SwaggerParameter["in"],
        required: (p["required"] as boolean) ?? false,
        type: p["type"] as string | undefined,
        description: p["description"] as string | undefined,
        schema: p["schema"] as Record<string, unknown> | undefined,
      }));

      const responses = op["responses"] as Record<string, Record<string, unknown>> | undefined;
      const successCode = findSuccessCode(responses, method);

      operations.push({
        operationId,
        method: method.toUpperCase(),
        path: pathStr,
        summary: (op["summary"] as string) ?? "",
        parameters,
        _successCode: successCode,
      } as SwaggerOperation & { _successCode: number });
    }
  }

  return operations;
}

function mergeParameters(
  pathLevel: Array<Record<string, unknown>>,
  opLevel: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const opKeys = new Set(opLevel.map((p) => `${p["in"]}:${p["name"]}`));
  const fromPath = pathLevel.filter((p) => !opKeys.has(`${p["in"]}:${p["name"]}`));
  return [...fromPath, ...opLevel];
}

function findSuccessCode(
  responses?: Record<string, Record<string, unknown>>,
  method?: string,
): number {
  if (responses) {
    for (const code of ["200", "201", "204"]) {
      if (responses[code]) return parseInt(code, 10);
    }
  }
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

function filterCrudOperations(ops: SwaggerOperation[]): SwaggerOperation[] {
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
    const hasList = entityGroup.some(
      (op) => op.method === "GET" && !op.parameters.some((p) => p.in === "path"),
    );
    if (!hasList) continue;

    const picked = new Map<string, SwaggerOperation>();
    for (const op of entityGroup) {
      const method = op.method.toUpperCase();
      const hasPathParams = op.parameters.some((p) => p.in === "path");

      let key: string;
      if (method === "GET" && !hasPathParams) key = "LIST";
      else if (method === "GET" && hasPathParams) key = "GET";
      else key = method;

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
  if (method === "GET" && !hasPathParams) return 0; // LIST — smoke test
  if (method === "POST") return 1;                   // CREATE — deterministic resource
  if (method === "GET" && hasPathParams) return 2;    // GET — uses POST-created ID
  if (method === "PATCH" || method === "PUT") return 3;
  if (method === "DELETE") return 4;
  return 5;
}

// ─── Body Resolution ────────────────────────────────────────────────────────

function resolveBody(
  method: string,
  entitySet: string,
  nonce: string,
  bodyOverrides?: Record<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (bodyOverrides?.[entitySet]) {
    return bodyOverrides[entitySet];
  }

  if (method === "POST") {
    const templateFn = KNOWN_BODY_TEMPLATES[entitySet];
    if (templateFn) return templateFn(nonce);
    return { "_note": `Provide the required POST body for ${singularize(entitySet)}` };
  }

  if (method === "PATCH" || method === "PUT") {
    return { displayName: `GCF Updated ${nonce}` };
  }

  return undefined;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function statusText(code: number): string {
  switch (code) {
    case 200: return "OK";
    case 201: return "Created";
    case 204: return "No Content";
    default: return "";
  }
}

// ─── Variable Substitution ──────────────────────────────────────────────────

/** Recursively replace <varName> placeholders in string values with resolved variables. */
function substituteVariables(
  obj: Record<string, unknown>,
  vars: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      let resolved = value;
      for (const [varName, varValue] of Object.entries(vars)) {
        resolved = resolved.split(`<${varName}>`).join(varValue);
      }
      result[key] = resolved;
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = substituteVariables(value as Record<string, unknown>, vars);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Emit human-readable field-by-field instructions for a body object. */
function emitFieldInstructions(
  obj: Record<string, unknown>,
  lines: string[],
  prefix: string,
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("_")) continue; // skip internal notes
    const label = prefix ? `${prefix} > ${key}` : key;

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      // Nested object — recurse with indented label
      emitFieldInstructions(value as Record<string, unknown>, lines, label);
    } else if (typeof value === "string" && value.startsWith("<")) {
      // Unresolved placeholder — give contextual instruction
      lines.push(`- **${label}**: ${value.slice(1, -1)}`);
    } else {
      lines.push(`- **${label}**: \`${String(value)}\``);
    }
  }
}
