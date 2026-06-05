/**
 * Agent Factory module ΓÇö public API.
 */

export { listMcpServers, getMcpServer, resolveMcpServers } from "./mcpCatalog";
export { generateInstructions, generateStarterPrompts } from "./instructionsGenerator";
export { patchTemplate, cleanupTemplateDir, sanitizeSchemaName, buildSchemaName } from "./templatePatcher";
export {
  runPac,
  isPacAvailable,
  pacCopilotCreate,
  getPublisherPrefix,
  resolveEnvironmentId,
  listSolutions,
  preflightSolutionName,
  ensureSolutionExists,
} from "./pacRunner";
export {
  addKnowledgeSources,
  resolveOrgUrl,
  getDataverseToken,
  setAgentInstructions,
  hasAgentInstructions,
  setAgentDescription,
} from "./dataverseClient";
export { generateAgent } from "./agentGenerator";
export { truncateInstructions } from "./instructionUtils";

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
