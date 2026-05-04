/**
 * CUA Instruction Renderer.
 *
 * Converts a structured TestPlan (JSON) into natural-language instructions
 * that a Copilot Studio Computer Use Agent can execute directly.
 *
 * The CUA tool in Copilot Studio accepts:
 *  - instructions: numbered natural-language steps
 *  - inputs: dynamic values injected at runtime
 *
 * This renderer bridges the gap between our machine-readable test plan
 * and the CUA's human-readable instruction format.
 */

import type {
  TestPlan,
  TestStep,
  NavigateStep,
  CreateConnectionStep,
  TestOperationStep,
  ManualInputStep,
  BlockedStep,
} from "./types";

// ─── Output Types ───────────────────────────────────────────────────────────

/** A dynamic value the CUA tool accepts at runtime. */
export interface CUAInput {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

/** Captures a value from a step's response for use in later steps. */
export interface CUACapture {
  readonly name: string;
  readonly fromStep: number;
  readonly fromOperation: string;
  readonly responsePath: string;
}

/** Binds a captured value to a parameter in a later step. */
export interface CUABinding {
  readonly step: number;
  readonly field: string;
  readonly variable: string;
}

/** Complete CUA-ready output. */
export interface CUAInstructions {
  /** Numbered natural-language instructions (one string, newline-separated). */
  readonly instructions: string;
  /** Dynamic inputs the CUA tool should declare. */
  readonly inputs: readonly CUAInput[];
  /** Structured capture/binding info for agent-to-agent handoff. */
  readonly captures: readonly CUACapture[];
  readonly bindings: readonly CUABinding[];
  /** Summary metadata. */
  readonly metadata: {
    readonly connectorName: string;
    readonly operationCount: number;
    readonly hasWriteOps: boolean;
    readonly totalInstructionSteps: number;
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Render a TestPlan into CUA-compatible natural-language instructions.
 *
 * The output can be directly configured as a CUA tool's instruction set
 * in Copilot Studio, with `inputs` as the tool's input definitions.
 */
export function renderForCUA(testPlan: TestPlan): CUAInstructions {
  const lines: string[] = [];
  const inputs: CUAInput[] = [];
  const captures: CUACapture[] = [];
  const bindings: CUABinding[] = [];
  let instrStep = 0;
  let hasWriteOps = false;

  // Collect dynamic inputs needed by body templates
  const templateInputs = new Set<string>();

  // ── Preamble ──────────────────────────────────────────────────────────────

  lines.push("=== SETUP ===");
  lines.push("");

  for (const note of testPlan.notes) {
    lines.push(`NOTE: ${note}`);
  }
  if (testPlan.notes.length > 0) lines.push("");

  // ── Render each step ──────────────────────────────────────────────────────

  let currentPhase = "";

  for (const step of testPlan.steps) {
    const phase = phaseForStep(step);
    if (phase !== currentPhase) {
      currentPhase = phase;
      lines.push("");
      lines.push(`=== ${phase.toUpperCase()} ===`);
      lines.push("");
    }

    switch (step.action) {
      case "navigate":
        instrStep = renderNavigate(step, instrStep, lines);
        break;
      case "createConnection":
        instrStep = renderCreateConnection(step, instrStep, lines);
        break;
      case "testOperation":
        instrStep = renderTestOperation(step, instrStep, lines, captures, bindings);
        break;
      case "manualInput":
        hasWriteOps = true;
        instrStep = renderManualInput(step, instrStep, lines, templateInputs, captures, bindings);
        break;
      case "blocked":
        instrStep = renderBlocked(step, instrStep, lines);
        break;
    }
  }

  // ── Build inputs list ─────────────────────────────────────────────────────

  // Template inputs from body templates (e.g., tenantDomain, testUserPassword)
  for (const inputName of templateInputs) {
    inputs.push({
      name: inputName,
      description: inputDescriptionFor(inputName),
      required: true,
    });
  }

  return {
    instructions: lines.join("\n"),
    inputs,
    captures,
    bindings,
    metadata: {
      connectorName: testPlan.connectorName,
      operationCount: testPlan.summary.operationsTested,
      hasWriteOps,
      totalInstructionSteps: instrStep,
    },
  };
}

// ─── Step Renderers ─────────────────────────────────────────────────────────

function renderNavigate(
  step: NavigateStep,
  instrStep: number,
  lines: string[],
): number {
  instrStep++;
  lines.push(`${instrStep}. Open ${step.url} in the browser.`);
  instrStep++;
  lines.push(`${instrStep}. Wait for the page to load: ${step.waitFor}`);
  instrStep++;
  lines.push(
    `${instrStep}. If the page doesn't load correctly, use this fallback: ${step.fallback.searchPath}`,
  );
  return instrStep;
}

function renderCreateConnection(
  step: CreateConnectionStep,
  instrStep: number,
  lines: string[],
): number {
  instrStep++;
  lines.push(`${instrStep}. Navigate to ${step.url} to create a new connection.`);
  instrStep++;
  lines.push(
    `${instrStep}. If the direct link doesn't work: ${step.fallback.searchPath}`,
  );
  instrStep++;
  lines.push(`${instrStep}. Click 'Create' or '+ New connection'.`);
  instrStep++;
  lines.push(`${instrStep}. ${step.expectedPrompt}. Complete the authentication flow.`);
  instrStep++;
  lines.push(`${instrStep}. Wait until: ${step.successIndicator}.`);
  instrStep++;
  lines.push(
    `${instrStep}. Return to the connector test page to begin testing operations.`,
  );
  return instrStep;
}

function renderTestOperation(
  step: TestOperationStep,
  instrStep: number,
  lines: string[],
  captures: CUACapture[],
  bindings: CUABinding[],
): number {
  instrStep++;
  lines.push(
    `${instrStep}. In the operations panel, select '${step.operationId}'.`,
  );

  // Fill parameters
  const paramEntries = Object.entries(step.parameters);
  if (paramEntries.length > 0) {
    for (const [paramName, paramValue] of paramEntries) {
      instrStep++;
      if (paramValue.startsWith("[From ")) {
        // Dependency reference — instruct CUA to copy from prior response
        lines.push(`${instrStep}. For the '${paramName}' field: ${paramValue}.`);
        // Record binding
        const match = paramValue.match(/\[From (\S+) response\]/);
        if (match) {
          bindings.push({
            step: instrStep,
            field: paramName,
            variable: `${match[1]}_id`,
          });
        }
      } else if (paramValue.startsWith("<provide-")) {
        lines.push(
          `${instrStep}. For the '${paramName}' field: provide an appropriate value manually.`,
        );
      } else {
        lines.push(`${instrStep}. Set '${paramName}' to '${paramValue}'.`);
      }
    }
  }

  instrStep++;
  lines.push(`${instrStep}. Click 'Test operation'.`);

  // Verify response
  instrStep++;
  const resp = step.expectedResponse;
  let verifyText = `Verify the response shows status ${resp.statusCode}`;
  if (resp.valueIsArray) {
    verifyText += ` and contains a 'value' array`;
    if (resp.itemFields && resp.itemFields.length > 0) {
      verifyText += ` with items containing: ${resp.itemFields.join(", ")}`;
    }
  } else if (resp.requiredFields && resp.requiredFields.length > 0) {
    verifyText += ` with fields: ${resp.requiredFields.join(", ")}`;
  }
  lines.push(`${instrStep}. ${verifyText}.`);

  // Output capture instructions
  if (step.outputCapture && step.outputCapture.length > 0) {
    for (const capture of step.outputCapture) {
      instrStep++;
      lines.push(`${instrStep}. ${capture.instruction}`);
      captures.push({
        name: capture.label,
        fromStep: step.stepNumber,
        fromOperation: step.operationId,
        responsePath: capture.responsePath,
      });
    }
  }

  return instrStep;
}

function renderManualInput(
  step: ManualInputStep,
  instrStep: number,
  lines: string[],
  templateInputs: Set<string>,
  captures: CUACapture[],
  bindings: CUABinding[],
): number {
  instrStep++;
  lines.push(
    `${instrStep}. In the operations panel, select '${step.operationId}'.`,
  );

  if (step.lifecycleHint) {
    instrStep++;
    lines.push(`${instrStep}. NOTE — ${step.lifecycleHint}.`);
  }

  const method = step.httpMethod.toUpperCase();

  // For DELETE — fill path params from prior POST response
  if (method === "DELETE" && step.dependsOn && step.dependsOn.length > 0) {
    const postOp = step.dependsOn[0]!;
    if (step.requiredFields) {
      for (const field of step.requiredFields) {
        instrStep++;
        lines.push(
          `${instrStep}. For the '${field}' field: paste the 'id' value from the ${postOp} response — ` +
          `this is the test object you created earlier.`,
        );
        bindings.push({ step: instrStep, field, variable: `${postOp}_id` });
      }
    }
  }
  // For PATCH — fill path params from POST, then switch to JSON input for body
  else if ((method === "PATCH" || method === "PUT") && step.dependsOn && step.dependsOn.length > 0) {
    const postOp = step.dependsOn[0]!;
    instrStep++;
    lines.push(
      `${instrStep}. For path parameters (e.g., resource ID): paste the 'id' from the ${postOp} response.`,
    );
    bindings.push({ step: instrStep, field: "id", variable: `${postOp}_id` });

    if (step.requiredFields && step.requiredFields.length > 0) {
      instrStep++;
      lines.push(
        `${instrStep}. Switch to JSON input view for the request body, then provide values for: ${step.requiredFields.join(", ")}.`,
      );
    }
  }
  // For POST — render body template or list required fields
  else if (method === "POST") {
    if (step.bodyTemplate) {
      // Collect template placeholders
      const templateJson = JSON.stringify(step.bodyTemplate, null, 2);
      const placeholders = templateJson.match(/\{\{(\w+)\}\}/g) ?? [];
      for (const ph of placeholders) {
        templateInputs.add(ph.replace(/\{\{|\}\}/g, ""));
      }

      instrStep++;
      lines.push(
        `${instrStep}. Switch to the JSON input view for the request body (look for a toggle or 'Raw' mode).`,
      );
      instrStep++;
      lines.push(`${instrStep}. Paste the following JSON body:`);
      lines.push("```json");
      lines.push(templateJson);
      lines.push("```");
      instrStep++;
      if (placeholders.length > 0) {
        const inputNames = placeholders.map((p) => p.replace(/\{\{|\}\}/g, ""));
        lines.push(
          `${instrStep}. Replace the placeholder values: ${inputNames.map((n) => `{{${n}}}`).join(", ")} — ` +
          `these will be provided as inputs to this tool.`,
        );
      }
    } else if (step.requiredFields && step.requiredFields.length > 0) {
      instrStep++;
      lines.push(
        `${instrStep}. This operation requires a request body. Switch to JSON input view and provide values for: ${step.requiredFields.join(", ")}.`,
      );
    }

    // POST captures the created resource ID
    instrStep++;
    lines.push(
      `${instrStep}. After a successful response, note the 'id' value from the response — ` +
      `you will need it for subsequent PATCH and DELETE operations.`,
    );
    captures.push({
      name: `${step.operationId}_id`,
      fromStep: step.stepNumber,
      fromOperation: step.operationId,
      responsePath: "id",
    });
  }

  instrStep++;
  lines.push(`${instrStep}. Click 'Test operation'.`);
  instrStep++;
  lines.push(`${instrStep}. Verify the operation completes successfully.`);

  return instrStep;
}

function renderBlocked(
  step: BlockedStep,
  instrStep: number,
  lines: string[],
): number {
  instrStep++;
  lines.push(
    `${instrStep}. ⚠️ BLOCKED: ${step.description}`,
  );
  instrStep++;
  lines.push(`${instrStep}. Reason: ${step.reason}`);
  instrStep++;
  lines.push(`${instrStep}. To resolve: ${step.resolution}`);
  instrStep++;
  lines.push(
    `${instrStep}. Do NOT proceed with further testing until this blocker is resolved.`,
  );
  return instrStep;
}

// ─── Phase Grouping ─────────────────────────────────────────────────────────

function phaseForStep(step: TestStep): string {
  switch (step.action) {
    case "navigate":
      return "Navigation";
    case "createConnection":
      return "Connection Setup";
    case "testOperation":
      return step.httpMethod.toUpperCase() === "GET" ? "Read Operations" : "Write Operations";
    case "manualInput": {
      const m = step.httpMethod.toUpperCase();
      if (m === "POST") return "Write Operations — Create";
      if (m === "PATCH" || m === "PUT") return "Write Operations — Update";
      if (m === "DELETE") return "Cleanup";
      return "Write Operations";
    }
    case "blocked":
      return "Blockers";
  }
}

// ─── Input Descriptions ─────────────────────────────────────────────────────

function inputDescriptionFor(name: string): string {
  switch (name) {
    case "tenantDomain":
      return "Your Microsoft 365 tenant domain (e.g., contoso.onmicrosoft.com)";
    case "testUserPassword":
      return "A password that meets your tenant's password policy for the test user";
    case "testAppId":
      return "Application (client) ID of an existing app registration to use for testing";
    default:
      return `Value for ${name}`;
  }
}
