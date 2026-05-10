/**
 * Agent Factory module ΓÇö public API.
 */

export { listMcpServers, getMcpServer, getStableMcpServers, resolveMcpServers } from "./mcpCatalog";
export { generateInstructions, generateStarterPrompts } from "./instructionsGenerator";
export { patchTemplate, cleanupTemplateDir, sanitizeSchemaName, buildSchemaName } from "./templatePatcher";
export { runPac, isPacAvailable, getPacAuthInfo, pacCopilotCreate, getPublisherPrefix, resolveEnvironmentId } from "./pacRunner";
export { generateAgent } from "./agentGenerator";

export type {
  McpServerCatalogEntry,
  KnowledgeSource,
  DeployedConnectorInfo,
  OperationRef,
  AgentFactoryContext,
  AgentGenerationInput,
  AgentGenerationResult,
  PendingConnection,
  InstructionsInput,
  ConnectorOperationGroup,
  TemplatePatchConfig,
  PatchedTemplate,
} from "./types";
