/**
 * Tool contract type definitions for the Graph Connector Agent.
 * All tool `run` signatures return Promise<T> (async-first).
 */

// ─── Generic tool infrastructure ────────────────────────────────────────────

export interface ToolExecutionContext {
  readonly configPath?: string;
}

export interface ToolDefinition<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  run: (input: TInput, context?: ToolExecutionContext) => Promise<TOutput>;
}

export type ToolInvocationResult<TName extends string = string> =
  | { ok: true; toolName: TName; result: ToolOutputMap[TName] }
  | { ok: false; toolName: TName; error: string };

// ─── graph_listOperations ───────────────────────────────────────────────────

export interface GraphOperationParameter {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly required: boolean;
  readonly type: string;
  readonly description: string;
}

export interface RequestBodyProperty {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly enum?: readonly string[];
  /** True when the CSDL type is Collection(...) — emit as array in Swagger. */
  readonly isArray?: boolean;
  /** True when the CSDL property has Nullable="false" or is a non-nullable collection. */
  readonly nullable?: boolean;
  /** Nested properties for complex type fields (type: "object"). */
  readonly properties?: readonly RequestBodyProperty[];
}

export interface GraphOperationInfo {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  readonly parameters: readonly GraphOperationParameter[];
  readonly requiredScopes: readonly string[];
  readonly requestBodySummary: string | null;
  readonly responseSummary: string | null;
  readonly requestBodyProperties?: readonly RequestBodyProperty[];
}

export interface GraphListOperationsToolInput {
  /** Single endpoint path (kept for backward compat). */
  readonly endpoint?: string;
  /** Batch mode: query multiple endpoints in one call. */
  readonly endpoints?: readonly string[];
  readonly version?: "v1.0" | "beta";
  readonly forceRefresh?: boolean;
}

export interface GraphListOperationsToolOutput {
  /** Present when a single endpoint was queried. */
  readonly endpoint?: string;
  /** Present when multiple endpoints were queried. */
  readonly endpoints?: readonly string[];
  readonly version: string;
  readonly operations: readonly GraphOperationInfo[];
  readonly cacheAge: string;
  readonly warnings: readonly string[];
}

// ─── graph_generateConnector ────────────────────────────────────────────────

export type ConnectorOutputFormat = "swagger-json" | "swagger-yaml" | "openapi-json" | "all";

export interface ConnectorAuthConfig {
  readonly tenantId?: string;
  readonly clientId?: string;
  readonly scopes?: readonly string[];
}

export interface GraphGenerateConnectorToolInput {
  readonly version?: "v1.0" | "beta";
  readonly operationIds: readonly string[];
  readonly connectorName?: string;
  readonly connectorDescription?: string;
  /**
   * Base name for all created objects in the Connector Factory workflow.
   * Each agent appends a contextual suffix (e.g., "Contoso Users - Connector",
   * "Contoso Users - App Registration"). Takes priority over connectorName.
   * When omitted, connectorName or the default "Graph Connector" is used.
   */
  readonly baseName?: string;
  readonly iconUri?: string;
  readonly authConfig?: ConnectorAuthConfig;
  readonly format?: ConnectorOutputFormat;
  readonly outputDir?: string;
}

export interface ConnectorFile {
  readonly filename: string;
  readonly content: string;
}

export interface GraphGenerateConnectorToolOutput {
  readonly connectorFiles: readonly ConnectorFile[];
  readonly totalOperations: number;
  readonly validationWarnings: readonly string[];
  readonly flatteningLog: readonly string[];
  readonly savedPaths: readonly string[];
  /** GitHub Gist URL if publishing was enabled. */
  readonly gistUrl?: string | undefined;
  /** Raw download URLs per filename from the gist. */
  readonly gistRawUrls?: Record<string, string> | undefined;
  /**
   * The base name used for this connector, if baseName was provided.
   * Downstream agents (Connector Deploy, App Registration) should use
   * this value for consistent naming across all created objects.
   */
  readonly baseName?: string | undefined;
}

// ─── graph_deployPipeline ───────────────────────────────────────────────────

export interface GraphDeployPipelineToolInput {
  /** URL to fetch Swagger 2.0 JSON from (e.g., Gist raw URL or GCA download URL). */
  readonly swaggerUrl?: string;
  /** Inline Swagger 2.0 JSON content. Takes priority over swaggerUrl. */
  readonly swagger?: string;
  /** Base name for consistent naming across connector + app registration. */
  readonly baseName?: string;
  /** Power Platform environment ID. Uses the CDA's configured default if omitted. */
  readonly environmentId?: string;
  /** Power Platform environment display name — passed to test plan for CUA navigation. */
  readonly environmentName?: string;
  /** Auth type for the connector (NoAuth, OAuthAAD, FederatedIdentity, etc.). */
  readonly authType?: string;
  /** OAuth client ID for the connector (required for OAuthAAD/FederatedIdentity). */
  readonly oauthClientId?: string;
  /** OAuth resource URI / audience (required for OAuthAAD/FederatedIdentity). */
  readonly oauthResourceUri?: string;
  /** Entra ID tenant GUID (required for FederatedIdentity, defaults to 'common' for OAuthAAD). */
  readonly oauthTenantId?: string;
  /** Whether to skip app registration configuration after deploy. */
  readonly skipAppRegistration?: boolean;
  /** Email addresses to share the connector with. */
  readonly shareWithEmails?: string[];
}

export interface GraphDeployPipelineToolOutput {
  /** Overall status: success (both steps), partial (connector ok, app reg failed), failed. */
  readonly status: "success" | "partial" | "failed";
  /** Connector deployment result from CDA. */
  readonly connector: {
    readonly connectorId: string;
    readonly displayName: string;
    readonly environmentId: string;
    readonly status: string;
    readonly authType?: string;
    readonly redirectUri?: string;
    readonly graphApiScopes?: readonly string[];
    readonly sharedWith?: readonly string[];
  } | null;
  /** App registration result from ARA. */
  readonly appRegistration: {
    readonly configured: boolean;
    readonly appId?: string;
    readonly objectId?: string;
    readonly displayName?: string;
    readonly skipped?: boolean;
    readonly skipReason?: string;
  } | null;
  /** Errors encountered during the pipeline. */
  readonly errors: readonly string[];
  /** Human-readable summary of what was done. */
  readonly summary: string;
}

// ─── graph_setDesignContext ────────────────────────────────────────────────

/** Lightweight operation summary returned in session context for card display. */
export interface EnrichedOperation {
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly method: string;
  readonly path: string;
  readonly scope: string;
  readonly params: string;
  readonly returns: string;
}

export interface ConnectorGroupInput {
  /** Stable identifier for this connector (e.g. "conn1", "conn2"). Used to correlate
   *  endpoint assignments across adaptive card interactions. Future: drives multi-connector
   *  adaptive card sections. */
  readonly id?: string;
  /** Human-readable name for this connector group (e.g. "Read Operations"). */
  readonly name?: string;
  /** Per-connector base name override (e.g. "Contoso HR Read"). Defaults to session baseName. */
  readonly baseName?: string;
  /** Graph API endpoint paths belonging to this connector. */
  readonly endpoints: readonly string[];
  /** Operation pattern hint for suffix derivation (e.g. "CRUD", "Read", "Actions"). */
  readonly operationPattern?: string;
}

/**
 * Input for graph_setDesignContext — called by the AI during the research phase
 * to persist design decisions server-side so the OperationSelection topic can
 * retrieve them at build time via GET /api/graph/session/context.
 * All fields are optional; the server merges partial updates into existing context.
 */
export interface GraphSetDesignContextToolInput {
  /** All Graph API endpoint paths researched in this session (e.g. ["/users", "/groups"]). */
  readonly endpoints?: readonly string[];
  /** Auth type for the connectors. */
  readonly authType?: "NoAuth" | "OAuthAAD" | "FederatedIdentity";
  /** Number of connectors to create. */
  readonly connectorCount?: number;
  /** How endpoints are grouped per connector (for multi-connector scenarios). */
  readonly connectorGroups?: readonly ConnectorGroupInput[];
  /** App registration strategy: single shared app reg vs one per connector. */
  readonly appRegistrationStrategy?: "single" | "separate";
  /** Target Power Platform environment ID (GUID or 'default'). */
  readonly environmentId?: string;
  /** Display name of the target Power Platform environment. */
  readonly environmentName?: string;
  /** Suggested base name for connector naming. */
  readonly baseName?: string;
  /** Target Graph API version. */
  readonly targetVersion?: "v1.0" | "beta";
  /** AI-authored notes summarizing the design rationale. */
  readonly notes?: string;
}

export interface GraphSetDesignContextToolOutput {
  /** Whether the context was saved successfully. */
  readonly saved: boolean;
  /** Echo of the context that was saved (for AI confirmation). */
  readonly context: GraphSetDesignContextToolInput;
  /** Human-readable confirmation message. */
  readonly message: string;
}

// ─── Tool maps for typed dispatch ───────────────────────────────────────────

export interface ToolInputMap {
  "graph_listOperations": GraphListOperationsToolInput;
  "graph_generateConnector": GraphGenerateConnectorToolInput;
  "graph_deployPipeline": GraphDeployPipelineToolInput;
  "graph_setDesignContext": GraphSetDesignContextToolInput;
  [key: string]: unknown;
}

export interface ToolOutputMap {
  "graph_listOperations": GraphListOperationsToolOutput;
  "graph_generateConnector": GraphGenerateConnectorToolOutput;
  "graph_deployPipeline": GraphDeployPipelineToolOutput;
  "graph_setDesignContext": GraphSetDesignContextToolOutput;
  [key: string]: unknown;
}
