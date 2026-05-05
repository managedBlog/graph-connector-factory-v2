/**
 * CUA Test Plan Generator.
 *
 * Takes a deployed connector's metadata + swagger and produces a structured
 * test plan that a Computer Use Agent can follow in the Power Platform portal.
 *
 * Key design decisions:
 * - Operations are parsed from swagger JSON (durable artifact), NOT from
 *   the fragile global lastOperationsCache.
 * - Read-only operations auto-generate parameters; write ops require opt-in.
 * - Deploy status gates plan generation (partial → blocked step, failed → reject).
 * - Portal URLs are template-driven with UI fallback navigation.
 */

import type {
  TestPlan,
  TestPlanInput,
  TestStep,
  NavigateStep,
  CreateConnectionStep,
  TestOperationStep,
  ManualInputStep,
  BlockedStep,
  OutputCaptureInstruction,
  SwaggerOperation,
  SwaggerParameter,
  TestPlanSummary,
} from "./types";
import { connectorTestTabNav, newConnectionNav } from "./portalUrls";
import {
  KNOWN_BODY_TEMPLATES,
  KNOWN_REQUIRED_FIELDS,
  generateNonce,
  singularize,
  entitySetNameFromPath,
  isWriteMethod,
} from "./shared";

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a structured test plan for a deployed connector.
 *
 * @throws {Error} if deploy status is "failed" or required inputs are missing.
 */
export function generateTestPlan(input: TestPlanInput): TestPlan {
  // Validate required inputs
  if (!input.connectorId) throw new Error("connectorId is required");
  if (!input.environmentId) throw new Error("environmentId is required");
  if (!input.displayName) throw new Error("displayName is required");

  if (input.deployStatus === "failed") {
    throw new Error("Cannot generate test plan for a failed deployment");
  }

  const portalHost = input.portalHost ?? "make.powerapps.com";
  const includeWriteOps = input.includeWriteOps ?? false;

  // Parse swagger to extract operations
  const swagger = resolveSwagger(input);
  const operations = parseSwaggerOperations(swagger);

  if (operations.length === 0) {
    throw new Error("No operations found in swagger — cannot generate test plan");
  }

  // Order operations by dependency (list → item GET → write)
  const ordered = orderOperations(operations);

  // Build steps
  const steps: TestStep[] = [];
  let stepNumber = 1;
  const envDisplayName = input.environmentName ?? "your target environment";

  // Step 1: Navigate to connector test tab
  const testTab = connectorTestTabNav(
    envDisplayName,
    input.displayName,
    portalHost,
  );
  steps.push({
    stepNumber: stepNumber++,
    action: "navigate",
    description: `Open the test page for '${input.displayName}'`,
    startUrl: testTab.startUrl,
    navigation: testTab.navigation,
    waitFor: "Connector test page loaded with operation list",
  } satisfies NavigateStep);

  // Step 2: Create connection (unless NoAuth or deploy is partial with app-reg failure)
  if (input.deployStatus === "partial") {
    steps.push({
      stepNumber: stepNumber++,
      action: "blocked",
      description: "Connection creation blocked — app registration incomplete",
      reason: "Deploy completed with partial status: app registration was not fully configured",
      resolution:
        "Run graph_completeAppRegistration to finish app registration, then retry test plan generation",
    } satisfies BlockedStep);
  } else if (input.authType && input.authType.toLowerCase() !== "noauth") {
    const connNav = newConnectionNav(
      envDisplayName,
      input.displayName,
      portalHost,
    );
    steps.push({
      stepNumber: stepNumber++,
      action: "createConnection",
      description: `Create a new connection for '${input.displayName}'`,
      authType: input.authType,
      startUrl: connNav.startUrl,
      navigation: connNav.navigation,
      expectedPrompt: authPromptForType(input.authType),
      successIndicator: "Connection status shows 'Connected'",
    } satisfies CreateConnectionStep);
  }

  // Build a map of resource paths → list operation IDs for variable resolution
  const listOpsByResource = buildListOperationMap(ordered);

  // Track POST operation IDs by entity set for write-op lifecycle dependencies
  const postOpsByEntity = new Map<string, string>();

  // Step 3+: Per-operation test steps
  const hasWriteOps = ordered.some((op) => isWriteMethod(op.method));

  for (const op of ordered) {
    const isWrite = isWriteMethod(op.method);

    if (isWrite && !includeWriteOps) {
      // Emit manual-input step for write operations
      const method = op.method.toUpperCase();
      const entitySet = entitySetNameFromPath(op.path);

      // DELETE doesn't need body fields; PATCH/PUT use schema fields;
      // POST uses KNOWN_REQUIRED_FIELDS or schema
      let requiredFields: readonly string[] | undefined;
      let bodyTemplate: Record<string, unknown> | undefined;
      let dependsOnWrite: string[] | undefined;

      if (method === "DELETE") {
        // DELETE only needs path params — no body fields
        const pathParams = op.parameters.filter((p) => p.in === "path").map((p) => p.name);
        requiredFields = pathParams.length > 0 ? pathParams : undefined;
        // DELETE depends on the POST that created the resource
        const postOp = postOpsByEntity.get(entitySet);
        if (postOp) dependsOnWrite = [postOp];
      } else if (method === "POST") {
        requiredFields = KNOWN_REQUIRED_FIELDS[entitySet] ?? extractRequiredFieldsFromSchema(op);
        if (requiredFields.length === 0) requiredFields = undefined;
        bodyTemplate = KNOWN_BODY_TEMPLATES[entitySet]?.(generateNonce());
        // Track this POST for PATCH/DELETE dependency resolution
        postOpsByEntity.set(entitySet, op.operationId);
      } else {
        // PATCH/PUT — depends on POST for the created resource ID
        requiredFields = extractRequiredFieldsFromSchema(op);
        if (requiredFields.length === 0) requiredFields = undefined;
        const postOp = postOpsByEntity.get(entitySet);
        if (postOp) dependsOnWrite = [postOp];
      }

      steps.push({
        stepNumber: stepNumber++,
        action: "manualInput",
        operationId: op.operationId,
        httpMethod: method,
        description: `${method} operation '${op.operationId}' requires manual test data`,
        reason: method === "DELETE"
          ? "Delete operations permanently remove resources — use only on test objects you created"
          : "Write operations require explicit test data to avoid unintended changes",
        ...(requiredFields ? { requiredFields } : {}),
        ...(bodyTemplate ? { bodyTemplate } : {}),
        lifecycleHint: lifecycleHintForMethod(op.method),
        ...(dependsOnWrite ? { dependsOn: dependsOnWrite } : {}),
        skippable: true,
      } satisfies ManualInputStep);
      continue;
    }

    // For included write ops, also track POST and build proper dependencies
    if (isWrite && includeWriteOps) {
      const method = op.method.toUpperCase();
      const entitySet = entitySetNameFromPath(op.path);
      if (method === "POST") postOpsByEntity.set(entitySet, op.operationId);
    }

    // Build test parameters and dependencies
    // For GET-by-id, PATCH, and DELETE: prefer the POST-created resource over list results
    const entitySet = entitySetNameFromPath(op.path);
    const isItemGet = op.method.toUpperCase() === "GET" && op.parameters.some((p) => p.in === "path");
    const postDep = (isWrite || isItemGet) ? postOpsByEntity.get(entitySet) : undefined;
    const { params, outputCapture, dependsOn } = buildTestParams(op, listOpsByResource, postDep);

    const expectedResponse = buildExpectedResponse(op);

    steps.push({
      stepNumber: stepNumber++,
      action: "testOperation",
      operationId: op.operationId,
      httpMethod: op.method.toUpperCase(),
      description: `Test '${op.operationId}' — ${op.summary || op.method.toUpperCase() + " " + op.path}`,
      parameters: params,
      ...(outputCapture.length > 0 ? { outputCapture } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      expectedResponse,
      successIndicator: `Response shows status ${expectedResponse.statusCode}${expectedResponse.valueIsArray ? " with array of records" : ""}`,
    } satisfies TestOperationStep);
  }

  // Summary
  const summary = buildSummary(steps);

  // Build general notes for the CUA
  const notes = buildNotes(hasWriteOps, includeWriteOps, input.authType);

  return {
    connectorName: input.displayName,
    connectorId: input.connectorId,
    environmentId: input.environmentId,
    generatedAt: new Date().toISOString(),
    portalHost,
    variables: {},
    notes,
    steps,
    summary,
  };
}

// ─── Swagger Parsing ────────────────────────────────────────────────────────

function resolveSwagger(input: TestPlanInput): Record<string, unknown> {
  if (input.swagger) {
    return typeof input.swagger === "string"
      ? JSON.parse(input.swagger) as Record<string, unknown>
      : input.swagger;
  }
  throw new Error(
    "No swagger provided. Pass swagger directly or use baseName to resolve from cache at the tool layer.",
  );
}

function parseSwaggerOperations(swagger: Record<string, unknown>): SwaggerOperation[] {
  const paths = swagger["paths"] as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return [];

  const operations: SwaggerOperation[] = [];

  for (const [pathStr, methods] of Object.entries(paths)) {
    for (const [method, opObj] of Object.entries(methods)) {
      if (typeof opObj !== "object" || opObj === null) continue;
      const op = opObj as Record<string, unknown>;
      const operationId = op["operationId"] as string | undefined;
      if (!operationId) continue;

      const rawParams = (op["parameters"] as Array<Record<string, unknown>>) ?? [];
      const parameters: SwaggerParameter[] = rawParams.map((p) => ({
        name: p["name"] as string,
        in: p["in"] as SwaggerParameter["in"],
        required: (p["required"] as boolean) ?? false,
        type: p["type"] as string | undefined,
        description: p["description"] as string | undefined,
        schema: p["schema"] as Record<string, unknown> | undefined,
      }));

      // Extract response schema from 200/default
      const responses = op["responses"] as Record<string, Record<string, unknown>> | undefined;
      const successResponse = responses?.["200"] ?? responses?.["201"] ?? responses?.["default"];
      const responseSchema = successResponse?.["schema"] as Record<string, unknown> | undefined;

      operations.push({
        operationId,
        method: method.toUpperCase(),
        path: pathStr,
        summary: (op["summary"] as string) ?? "",
        parameters,
        responseSchema,
      });
    }
  }

  return operations;
}

// ─── Operation Ordering ─────────────────────────────────────────────────────

/**
 * Priority-based ordering:
 * 1. Collection GETs (list endpoints — no path params or only non-entity params)
 * 2. POST (create) — before GET-by-id so the created resource ID is available
 * 3. Item GETs (have path params like {user-id})
 * 4. PATCH (update)
 * 5. DELETE
 */
function orderOperations(ops: SwaggerOperation[]): SwaggerOperation[] {
  return [...ops].sort((a, b) => operationPriority(a) - operationPriority(b));
}

function operationPriority(op: SwaggerOperation): number {
  const method = op.method.toUpperCase();
  const hasPathParams = op.parameters.some((p) => p.in === "path");

  if (method === "GET" && !hasPathParams) return 0; // list
  if (method === "POST") return 1;                   // create (before GET-by-id)
  if (method === "GET" && hasPathParams) return 2;   // item GET
  if (method === "PATCH" || method === "PUT") return 3;
  if (method === "DELETE") return 4;
  return 5;
}

// isWriteMethod, entitySetNameFromPath, and singularize are imported from shared.ts

// ─── Resource / Dependency Mapping ──────────────────────────────────────────

/**
 * Build a map from resource path prefix → list operation ID.
 * E.g., "/users" → "ListUsers", so that GetUser can reference it.
 */
function buildListOperationMap(ops: SwaggerOperation[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const op of ops) {
    if (op.method.toUpperCase() === "GET" && !op.parameters.some((p) => p.in === "path")) {
      // This is a list/collection endpoint — also index by entity set name
      map.set(normalizeResourcePath(op.path), op.operationId);
      const entitySet = entitySetNameFromPath(op.path);
      if (entitySet) {
        map.set(entitySet, op.operationId);
      }
    }
  }
  return map;
}

/**
 * Normalize a path for resource matching.
 * "/users/{user-id}" → "/users"
 * "/groups/{group-id}/members/{member-id}" → "/groups/{group-id}/members"
 */
function normalizeResourcePath(pathStr: string): string {
  const segments = pathStr.split("/");
  // Remove trailing parameterized segment(s)
  while (segments.length > 0 && segments[segments.length - 1]!.startsWith("{")) {
    segments.pop();
  }
  return segments.join("/") || "/";
}

// entitySetNameFromPath is imported from shared.ts

// ─── Parameter Generation ───────────────────────────────────────────────────

interface TestParamResult {
  params: Record<string, string>;
  outputCapture: OutputCaptureInstruction[];
  dependsOn: string[];
}

function buildTestParams(
  op: SwaggerOperation,
  listOpsByResource: Map<string, string>,
  writePostDep?: string | undefined,
): TestParamResult {
  const params: Record<string, string> = {};
  const outputCapture: OutputCaptureInstruction[] = [];
  const dependsOn: string[] = [];

  const isListOp =
    op.method.toUpperCase() === "GET" &&
    !op.parameters.some((p) => p.in === "path");

  for (const param of op.parameters) {
    if (param.in === "header") continue;

    if (param.in === "path") {
      // Prefer the POST-created resource ID for GET-by-id, PATCH, and DELETE
      if (writePostDep) {
        params[param.name] =
          `[From ${writePostDep} response] Copy the 'id' value from the resource you just created`;
        if (!dependsOn.includes(writePostDep)) dependsOn.push(writePostDep);
      } else {
        // Try to find a list operation for the parent resource
        const parentPath = normalizeResourcePath(op.path);
        let listOpId = listOpsByResource.get(parentPath);

        // Fallback: try matching by entity set name extracted from the param
        if (!listOpId) {
          const paramEntity = param.name.replace(/-id$/i, "");
          const pluralGuess = paramEntity + "s";
          listOpId = listOpsByResource.get(pluralGuess);
        }

        if (listOpId) {
          params[param.name] =
            `[From ${listOpId} response] Copy the 'id' value of the first item in the response`;
          if (!dependsOn.includes(listOpId)) dependsOn.push(listOpId);
        } else {
          params[param.name] = `<provide-${param.name}>`;
        }
      }
    } else if (param.in === "query") {
      if (param.name === "$top") {
        params[param.name] = "5";
      }
    } else if (param.in === "body") {
      // Body params handled separately for write ops
    }
  }

  // For list operations without explicit $top param, suggest it anyway
  if (isListOp && !params["$top"] && op.parameters.some((p) => p.name === "$top")) {
    params["$top"] = "5";
  }

  // Capture instructions for list operations — CUA reads the response console
  if (isListOp) {
    const entityName = entitySetNameFromPath(op.path);
    const singular = singularize(entityName);
    outputCapture.push({
      label: `${singular}Id`,
      responsePath: "value[0].id",
      instruction:
        `In the response console, find the first item in the 'value' array and note its 'id' field. ` +
        `You will use this value as '${singular}-id' in subsequent operations.`,
    });
  }

  return { params, outputCapture, dependsOn };
}

// singularize is imported from shared.ts

// ─── Expected Response ──────────────────────────────────────────────────────

function buildExpectedResponse(op: SwaggerOperation): TestOperationStep["expectedResponse"] {
  const isListOp =
    op.method.toUpperCase() === "GET" &&
    !op.parameters.some((p) => p.in === "path");

  // Check if response schema indicates a collection (has "value" array property)
  const isCollection = isListOp || hasValueArrayInSchema(op.responseSchema);

  if (isCollection) {
    const itemFields = extractItemFields(op.responseSchema);
    return {
      statusCode: 200,
      requiredFields: ["value"],
      valueIsArray: true,
      ...(itemFields.length > 0 ? { itemFields } : {}),
    };
  }

  // Item response
  const requiredFields = extractTopLevelFields(op.responseSchema);
  return {
    statusCode: op.method.toUpperCase() === "POST" ? 201 : 200,
    ...(requiredFields.length > 0 ? { requiredFields } : {}),
  };
}

function hasValueArrayInSchema(schema?: Record<string, unknown>): boolean {
  if (!schema) return false;
  const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
  if (!properties?.["value"]) return false;
  const valueProp = properties["value"];
  return valueProp["type"] === "array";
}

function extractItemFields(schema?: Record<string, unknown>): string[] {
  if (!schema) return [];
  const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
  const valueProp = properties?.["value"];
  if (!valueProp) return [];

  const items = valueProp["items"] as Record<string, unknown> | undefined;
  if (!items) return [];

  // If items has a $ref, we can't resolve it without the full swagger definitions
  // Return empty — the CUA will still get the collection check
  const itemProps = items["properties"] as Record<string, unknown> | undefined;
  if (!itemProps) return [];

  // Return first few field names as expected fields
  return Object.keys(itemProps).slice(0, 5);
}

function extractTopLevelFields(schema?: Record<string, unknown>): string[] {
  if (!schema) return [];
  const properties = schema["properties"] as Record<string, unknown> | undefined;
  if (!properties) return [];
  return Object.keys(properties).slice(0, 5);
}

function extractRequiredFieldsFromSchema(op: SwaggerOperation): string[] {
  const bodyParam = op.parameters.find((p) => p.in === "body");
  if (!bodyParam?.schema) return [];

  const properties = bodyParam.schema["properties"] as Record<string, unknown> | undefined;
  const required = bodyParam.schema["required"] as string[] | undefined;

  if (required && required.length > 0) return required;
  if (properties) return Object.keys(properties).slice(0, 5);
  return [];
}

// ─── Auth Helpers ───────────────────────────────────────────────────────────

function authPromptForType(authType: string): string {
  const lower = authType.toLowerCase();
  if (lower === "oauthaad" || lower === "oauth2") {
    return "Sign in with your Microsoft Entra ID account";
  }
  if (lower === "federatedidentity" || lower === "fic") {
    return "Authorize via federated identity credential flow";
  }
  if (lower === "apikey") {
    return "Enter the API key";
  }
  return "Complete the authentication prompt";
}

// ─── Summary ────────────────────────────────────────────────────────────────

function buildSummary(steps: readonly TestStep[]): TestPlanSummary {
  let autoTestable = 0;
  let manualInputRequired = 0;
  let blocked = 0;
  const operationIds = new Set<string>();

  for (const step of steps) {
    switch (step.action) {
      case "testOperation":
        autoTestable++;
        operationIds.add(step.operationId);
        break;
      case "manualInput":
        manualInputRequired++;
        operationIds.add(step.operationId);
        break;
      case "blocked":
        blocked++;
        break;
    }
  }

  return {
    totalSteps: steps.length,
    autoTestable,
    manualInputRequired,
    blocked,
    operationsTested: operationIds.size,
  };
}

// ─── Notes & Lifecycle ──────────────────────────────────────────────────────

function buildNotes(
  hasWriteOps: boolean,
  includeWriteOps: boolean,
  authType: string,
): string[] {
  const notes: string[] = [];

  notes.push(
    "Each test step shows a response in the console panel. " +
    "Read values from the response console when later steps reference them.",
  );

  if (hasWriteOps && includeWriteOps) {
    notes.push(
      "This plan includes write operations (POST, PATCH, DELETE). " +
      "When testing these methods: create a new test object first (POST), " +
      "make changes to that object (PATCH), and delete it as the last action (DELETE). " +
      "This keeps the environment clean and avoids modifying production data.",
    );
  } else if (hasWriteOps && !includeWriteOps) {
    notes.push(
      "This connector includes write operations (POST, PATCH, DELETE) that are " +
      "marked as manual-input steps. If you choose to test them, follow this pattern: " +
      "create a new test object first, make changes to it, then delete it when done. " +
      "Never modify or delete existing production data.",
    );
  }

  if (authType.toLowerCase() !== "noauth") {
    notes.push(
      "A connection must be created before testing operations. " +
      "The sign-in prompt will appear in a popup — complete authentication and " +
      "wait for the connection status to show 'Connected' before proceeding.",
    );
  }

  notes.push(
    "If a test step fails, check the response console for error details. " +
    "Common issues: expired connection (re-authenticate), missing required parameters, " +
    "or insufficient permissions for the signed-in account.",
  );

  return notes;
}

function lifecycleHintForMethod(method: string): string | undefined {
  const upper = method.toUpperCase();
  if (upper === "POST") return "create — creates a new resource; note the returned 'id' for PATCH/DELETE steps";
  if (upper === "PATCH" || upper === "PUT") return "update — modify the object created by the POST step above";
  if (upper === "DELETE") return "cleanup — delete the test object created earlier to leave the environment clean";
  return undefined;
}
