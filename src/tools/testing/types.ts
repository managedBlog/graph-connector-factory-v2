/**
 * CUA Test Plan types.
 *
 * Structured test plan that a Computer Use Agent can follow to validate
 * a deployed Power Platform custom connector in the portal UI.
 *
 * Uses discriminated unions on `action` so each step type carries only
 * the fields it needs — no optional-field soup.
 */

// ─── Multi-Connector Test Plan Input ────────────────────────────────────────

/** Top-level input for generating a test plan across multiple connectors. */
export interface MultiConnectorTestInput {
  /** Power Platform environment ID. */
  readonly environmentId: string;
  /** Power Platform environment display name (for CUA to verify correct environment). */
  readonly environmentName?: string | undefined;
  /** Connectors to include in the test plan. */
  readonly connectors: readonly ConnectorTestSpec[];
  /** Top-level variables the CUA can reference (e.g., tenantDomain). */
  readonly variables?: Record<string, string> | undefined;
}

/** Per-connector specification within a multi-connector test plan. */
export interface ConnectorTestSpec {
  /** Connector display name — CUA opens this connector by name in the portal. */
  readonly displayName: string;
  /** Which operations to test: "all", "crud" (list+get+post+patch+delete per entity), or specific IDs. */
  readonly scope: "all" | "crud" | readonly string[];
  /** Inline swagger JSON for operation resolution. */
  readonly swagger?: string | Record<string, unknown> | undefined;
  /** Cache key to resolve swagger from generatedSwaggerCache (alternative to inline swagger). */
  readonly baseName?: string | undefined;
  /** Override body templates for specific entity sets (keyed by entity set name, e.g., "users"). */
  readonly bodyOverrides?: Record<string, Record<string, unknown>> | undefined;
}

// ─── Multi-Connector Test Plan Output ───────────────────────────────────────
// The multi-connector plan now outputs MarkdownTestPlan (defined in multiConnectorPlan.ts).
// The legacy JSON output types have been removed.

// ─── Single-Connector Test Plan Input (legacy) ─────────────────────────────

export interface TestPlanInput {
  /** Connector ID from deploy result (e.g., "shared_contoso-users_abc123"). */
  readonly connectorId: string;
  /** Power Platform environment ID. */
  readonly environmentId: string;
  /** Power Platform environment display name — used for CUA navigation. If omitted, instructions tell CUA to verify environment manually. */
  readonly environmentName?: string | undefined;
  /** Connector display name — used for UI search fallback. */
  readonly displayName: string;
  /** Deploy pipeline status — gates plan generation. */
  readonly deployStatus: "success" | "partial" | "failed";
  /** Connector auth type (OAuthAAD, NoAuth, etc.). */
  readonly authType: string;
  /** Cache key to retrieve swagger from generatedSwaggerCache. */
  readonly baseName?: string | undefined;
  /** Inline swagger JSON — alternative to baseName cache lookup. */
  readonly swagger?: string | Record<string, unknown> | undefined;
  /** Opt-in for POST/PATCH/DELETE test steps. Default false. */
  readonly includeWriteOps?: boolean | undefined;
  /** Override portal base host. Default: "make.powerapps.com". */
  readonly portalHost?: string | undefined;
}

// ─── Test Step Types (discriminated union on `action`) ──────────────────────

export interface NavigateStep {
  readonly stepNumber: number;
  readonly action: "navigate";
  readonly description: string;
  /** Portal base URL to open. */
  readonly startUrl: string;
  /** Step-by-step UI navigation instructions (the CUA reads the screen). */
  readonly navigation: string;
  /** What to wait for before proceeding. */
  readonly waitFor: string;
}

export interface CreateConnectionStep {
  readonly stepNumber: number;
  readonly action: "createConnection";
  readonly description: string;
  readonly authType: string;
  /** Portal base URL to open. */
  readonly startUrl: string;
  /** Step-by-step UI navigation instructions (the CUA reads the screen). */
  readonly navigation: string;
  readonly expectedPrompt: string;
  readonly successIndicator: string;
}

export interface TestOperationStep {
  readonly stepNumber: number;
  readonly action: "testOperation";
  readonly operationId: string;
  readonly httpMethod: string;
  readonly description: string;
  /** Parameters to fill in the test UI. */
  readonly parameters: Record<string, string>;
  /** Instructions for the CUA to capture values from the response console. */
  readonly outputCapture?: readonly OutputCaptureInstruction[];
  /** Operation IDs this step depends on (for ordering). */
  readonly dependsOn?: readonly string[];
  readonly expectedResponse: {
    readonly statusCode: number;
    readonly requiredFields?: readonly string[];
    readonly valueIsArray?: boolean;
    readonly itemFields?: readonly string[];
  };
  readonly successIndicator: string;
}

/** Tells the CUA to read a value from the response console for use in later steps. */
export interface OutputCaptureInstruction {
  /** Human-readable name for the captured value (e.g., "userId"). */
  readonly label: string;
  /** JSONPath-like location in the response (e.g., "value[0].id"). */
  readonly responsePath: string;
  /** Plain-language instruction for the CUA. */
  readonly instruction: string;
}

export interface ManualInputStep {
  readonly stepNumber: number;
  readonly action: "manualInput";
  readonly operationId: string;
  readonly httpMethod: string;
  readonly description: string;
  /** Why this step requires manual input. */
  readonly reason: string;
  /** Known required fields from schema/KNOWN_REQUIRED_FIELDS. */
  readonly requiredFields?: readonly string[];
  /** Pre-built JSON body template for the CUA to paste (switch to JSON input view). */
  readonly bodyTemplate?: Record<string, unknown> | undefined;
  /** Lifecycle hint for the CUA (e.g., "create", "update", "cleanup"). */
  readonly lifecycleHint?: string | undefined;
  /** Operation IDs this step depends on (e.g., DELETE depends on POST's created ID). */
  readonly dependsOn?: readonly string[] | undefined;
  /** Whether the CUA can skip this step. */
  readonly skippable: boolean;
}

export interface BlockedStep {
  readonly stepNumber: number;
  readonly action: "blocked";
  readonly description: string;
  /** What precondition is not met. */
  readonly reason: string;
  /** Guidance on how to unblock. */
  readonly resolution: string;
}

export type TestStep =
  | NavigateStep
  | CreateConnectionStep
  | TestOperationStep
  | ManualInputStep
  | BlockedStep;

// ─── Test Plan Envelope ─────────────────────────────────────────────────────

export interface TestPlanSummary {
  readonly totalSteps: number;
  /** Operations with auto-generated parameters. */
  readonly autoTestable: number;
  /** Operations requiring manual parameter entry. */
  readonly manualInputRequired: number;
  /** Operations skipped (e.g., blocked preconditions). */
  readonly blocked: number;
  /** Total distinct operations covered. */
  readonly operationsTested: number;
}

export interface TestPlan {
  readonly connectorName: string;
  readonly connectorId: string;
  readonly environmentId: string;
  readonly generatedAt: string;
  readonly portalHost: string;
  /** Variables captured during test execution (populated by CUA at runtime). */
  readonly variables: Record<string, string>;
  /** General instructions for the CUA agent. */
  readonly notes: readonly string[];
  readonly steps: readonly TestStep[];
  readonly summary: TestPlanSummary;
}

// ─── Swagger Parsing Types (internal) ───────────────────────────────────────

/** Minimal operation metadata extracted from Swagger 2.0 JSON. */
export interface SwaggerOperation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly parameters: readonly SwaggerParameter[];
  readonly responseSchema?: Record<string, unknown> | undefined;
}

export interface SwaggerParameter {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "body";
  readonly required: boolean;
  readonly type?: string | undefined;
  readonly description?: string | undefined;
  readonly schema?: Record<string, unknown> | undefined;
}
