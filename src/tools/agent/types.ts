/**
 * Type definitions for the Agent Factory module.
 *
 * The Agent Factory extends GCF to generate complete Copilot Studio agents
 * from deployed custom connectors, MCP servers, and knowledge sources.
 */

// ΓöÇΓöÇΓöÇ MCP Server Catalog ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface McpServerCatalogEntry {
  /** Unique catalog identifier, e.g. "ms-learn-docs" */
  id: string;
  /** Human-readable name shown in the adaptive card */
  displayName: string;
  /** What this MCP server provides */
  description: string;
  /** Categorization for filtering */
  category: "graph" | "azure" | "data" | "devtools" | "m365" | "security";
  /** Power Platform connector API name (globally stable for first-party) */
  connectorApiName: string;
  /** Full connector ID path */
  connectorId: string;
  /** MCP operation ID used in InvokeExternalAgentTaskAction */
  operationId?: string;
  /** Whether OAuth is required for this connector */
  requiresOAuth: boolean;
  /** Tags for matching during research (e.g. "docs", "search", "code") */
  relevantFor: string[];
  /** Source repo URL */
  repoUrl?: string;
  /**
   * true = connector API name is globally stable across tenants.
   * false = may require custom setup or have tenant-specific names.
   */
  stable: boolean;
}

// ΓöÇΓöÇΓöÇ Knowledge Sources ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface KnowledgeSource {
  type: "sharepoint" | "url";
  /** Full URL (SharePoint site/folder/list, or web URL) */
  url: string;
  /** Display name ΓÇö auto-derived from URL if not provided */
  displayName: string;
  /** Description ΓÇö auto-generated if not provided */
  description: string;
}

// ΓöÇΓöÇΓöÇ Deployed Connector Info ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface DeployedConnectorInfo {
  /** Timestamp when deploy completed */
  timestamp: number;
  /** Full Power Platform connector ID */
  connectorId: string;
  /** API name extracted from connectorId (e.g. shared_myconnector) */
  apiName: string;
  /** Human-readable connector name */
  displayName: string;
  /** Base name used during generation */
  baseName: string;
  /** Target environment */
  environmentId: string;
  /** Auth type configured */
  authType: string;
  /** App registration app ID (if OAuth) */
  appRegistrationAppId?: string;
  /** Exact operation IDs from design context */
  operationIds: string[];
}

export interface OperationRef {
  operationId: string;
  summary: string;
  method: string;
  path: string;
}

// ΓöÇΓöÇΓöÇ Agent Factory Context ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface AgentFactoryContext {
  /** Display name for the generated agent */
  agentName?: string;
  /** What the agent should help users do */
  agentPurpose?: string;
  /** MCP server catalog IDs selected by the user */
  selectedMcpServers?: string[];
  /** Knowledge sources (SharePoint sites, URLs) */
  knowledgeSources?: KnowledgeSource[];
  /** Whether to include CUA capability */
  includeCua?: boolean;
  /** User-provided instructions override (replaces auto-generated) */
  instructionsOverride?: string;
}

// ΓöÇΓöÇΓöÇ Agent Generation ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface AgentGenerationInput {
  agentName: string;
  agentPurpose: string;
  mcpServerIds?: string[];
  knowledgeSources?: KnowledgeSource[];
  includeCua?: boolean;
  instructionsOverride?: string;
  /** Target environment for pac copilot create */
  environmentId: string;
  /** Solution name (must have matching publisher prefix) */
  solutionName: string;
}

export interface AgentGenerationResult {
  success: boolean;
  agentId?: string;
  agentUrl?: string;
  displayName?: string;
  componentCount?: number;
  /** Connections that need manual configuration */
  pendingConnections: PendingConnection[];
  /** Suggested starter prompts */
  starterPrompts: string[];
  error?: string;
  /** PAC CLI output for debugging */
  pacOutput?: string;
}

export interface PendingConnection {
  connectorApiName: string;
  displayName: string;
  requiresOAuth: boolean;
  instructions: string;
}

// ΓöÇΓöÇΓöÇ Instructions Generation ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface InstructionsInput {
  agentName: string;
  agentPurpose: string;
  connectorOperations: ConnectorOperationGroup[];
  mcpServers: McpServerCatalogEntry[];
  knowledgeSources: KnowledgeSource[];
}

export interface ConnectorOperationGroup {
  connectorName: string;
  apiName: string;
  operations: OperationRef[];
}

// ΓöÇΓöÇΓöÇ Template Patching ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface TemplatePatchConfig {
  agentName: string;
  /** Sanitized schema name with publisher prefix (e.g. mme_MyAgent) */
  agentSchemaName: string;
  agentDescription: string;
  instructions: string;
  /** Publisher customization prefix (e.g. "mme") */
  publisherPrefix: string;
  connectors: DeployedConnectorInfo[];
  mcpServers: McpServerCatalogEntry[];
  knowledgeSources: KnowledgeSource[];
  /** Whether to include CUA component */
  includeCua?: boolean;
}

export interface PatchedTemplate {
  yamlPath: string;
  jsonPath: string;
  componentCount: number;
}
