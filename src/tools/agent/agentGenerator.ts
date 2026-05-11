/**
 * Agent Generator ΓÇö orchestrates Copilot Studio agent creation.
 *
 * Flow:
 *   1. Validate prerequisites (PAC available, connectors deployed, etc.)
 *   2. Resolve MCP servers from catalog
 *   3. Generate agent instructions
 *   4. Patch template (YAML + JSON)
 *   5. Run pac copilot create
 *   6. Return result with post-deploy guidance
 */

import { log, logError } from "../../logging/logger";
import type {
  AgentGenerationInput,
  AgentGenerationResult,
  AgentFactoryContext,
  DeployedConnectorInfo,
  ConnectorOperationGroup,
  PendingConnection,
} from "./types";
import { resolveMcpServers } from "./mcpCatalog";
import { generateInstructions, generateStarterPrompts } from "./instructionsGenerator";
import { patchTemplate, cleanupTemplateDir, buildSchemaName } from "./templatePatcher";
import { isPacAvailable, pacCopilotCreate, getPublisherPrefix, resolveEnvironmentId } from "./pacRunner";
import { addKnowledgeSources } from "./dataverseClient";

/**
 * Generate and deploy a Copilot Studio agent.
 *
 * This is the main entry point called by the REST endpoint and MCP tool.
 */
export async function generateAgent(
  input: AgentGenerationInput,
  deployedConnectors: DeployedConnectorInfo[],
): Promise<AgentGenerationResult> {
  log(`[AgentGenerator] Starting agent creation: "${input.agentName}"`);

  // 1. Validate prerequisites
  const pacAvailable = await isPacAvailable();
  if (!pacAvailable) {
    return {
      success: false,
      pendingConnections: [],
      starterPrompts: [],
      warnings: [],
      error:
        "PAC CLI is not available. Install the Power Platform CLI and run 'pac auth create' to authenticate. " +
        "See: https://learn.microsoft.com/power-platform/developer/cli/introduction",
    };
  }

  if (deployedConnectors.length === 0) {
    return {
      success: false,
      pendingConnections: [],
      starterPrompts: [],
      warnings: [],
      error: "No deployed connectors found. Deploy at least one connector before creating an agent.",
    };
  }

  // 2. Resolve MCP servers
  const mcpServers = input.mcpServerIds
    ? resolveMcpServers(input.mcpServerIds)
    : [];
  log(`[AgentGenerator] Resolved ${mcpServers.length} MCP servers`);

  // 3. Build operation groups from deployed connectors
  const connectorOperations: ConnectorOperationGroup[] = deployedConnectors.map((conn) => ({
    connectorName: conn.displayName,
    apiName: conn.apiName,
    operations: conn.operationIds.map((opId) => ({
      operationId: opId,
      summary: opId, // Operation summaries not available at this point
      method: "GET", // Default; actual method not stored in deploy results
      path: "",
    })),
  }));

  // 4. Generate instructions (or use override)
  const instructions = input.instructionsOverride ??
    generateInstructions({
      agentName: input.agentName,
      agentPurpose: input.agentPurpose,
      connectorOperations,
      mcpServers,
      knowledgeSources: input.knowledgeSources ?? [],
    });

  const starterPrompts = generateStarterPrompts({
    agentName: input.agentName,
    agentPurpose: input.agentPurpose,
    connectorOperations,
    mcpServers,
    knowledgeSources: input.knowledgeSources ?? [],
  });

  // 5. Resolve environment ID (Dataverse org ID → PAC environment GUID)
  const resolvedEnvId = await resolveEnvironmentId(input.environmentId);
  log(`[AgentGenerator] Environment: ${input.environmentId} → ${resolvedEnvId}`);

  // 6. Get publisher prefix for the target solution
  const publisherPrefix = await getPublisherPrefix(resolvedEnvId, input.solutionName);
  const agentSchemaName = buildSchemaName(publisherPrefix, input.agentName);
  log(`[AgentGenerator] Schema name: ${agentSchemaName}`);

  // 6. Patch template
  let patchedTemplate;
  try {
    patchedTemplate = patchTemplate({
      agentName: input.agentName,
      agentSchemaName,
      agentDescription: input.agentPurpose,
      instructions,
      publisherPrefix,
      connectors: deployedConnectors,
      mcpServers,
      knowledgeSources: input.knowledgeSources ?? [],
      includeCua: input.includeCua ?? false,
    });
    log(`[AgentGenerator] Template patched: ${patchedTemplate.componentCount} components`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[AgentGenerator] Template patching failed: ${message}`);
    return {
      success: false,
      pendingConnections: [],
      starterPrompts,
      warnings: [],
      error: `Template patching failed: ${message}`,
    };
  }

  // 7. Run pac copilot create
  try {
    const result = await pacCopilotCreate({
      displayName: input.agentName,
      schemaName: agentSchemaName,
      templateFileName: patchedTemplate.yamlPath,
      solution: input.solutionName,
      environmentId: resolvedEnvId,
    });

    // Clean up temp files
    cleanupTemplateDir(patchedTemplate.yamlPath);

    if (!result.success && !result.agentId) {
      return {
        success: false,
        pendingConnections: [],
        starterPrompts,
        warnings: [],
        error: `PAC copilot create failed: ${result.stderr || result.stdout}`,
        pacOutput: result.stdout + "\n" + result.stderr,
      };
    }

    // Build pending connections list
    const pendingConnections = buildPendingConnections(deployedConnectors, mcpServers, input.includeCua);

    // Derive agent URL if not in output
    const agentUrl = result.agentUrl ??
      (result.agentId
        ? `https://web.powerva.microsoft.com/environments/${resolvedEnvId}/bots/${result.agentId}`
        : undefined);

    log(`[AgentGenerator] Agent created successfully: ${result.agentId}`);

    // 8. Post-creation: add knowledge sources via Dataverse API
    const warnings: string[] = [];
    const knowledgeSources = input.knowledgeSources ?? [];
    if (knowledgeSources.length > 0 && result.agentId) {
      log(`[AgentGenerator] Adding ${knowledgeSources.length} knowledge source(s) post-creation...`);
      const ksWarnings = await addKnowledgeSources(
        resolvedEnvId,
        result.agentId,
        knowledgeSources,
        publisherPrefix,
        agentSchemaName,
      );
      warnings.push(...ksWarnings);
    }

    return {
      success: true,
      agentId: result.agentId,
      agentUrl,
      displayName: input.agentName,
      componentCount: patchedTemplate.componentCount,
      pendingConnections,
      starterPrompts,
      warnings,
      pacOutput: result.stdout,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[AgentGenerator] PAC execution error: ${message}`);
    cleanupTemplateDir(patchedTemplate.yamlPath);
    return {
      success: false,
      pendingConnections: [],
      starterPrompts,
      warnings: [],
      error: `PAC execution error: ${message}`,
    };
  }
}

/**
 * Build list of connections the user needs to configure post-deploy.
 */
function buildPendingConnections(
  connectors: DeployedConnectorInfo[],
  mcpServers: import("./types").McpServerCatalogEntry[],
  includeCua?: boolean,
): PendingConnection[] {
  const pending: PendingConnection[] = [];

  for (const conn of connectors) {
    pending.push({
      connectorApiName: conn.apiName,
      displayName: conn.displayName,
      requiresOAuth: conn.authType !== "NoAuth",
      instructions: conn.authType === "NoAuth"
        ? "No authentication required."
        : `Sign in with your ${conn.authType === "OAuthAAD" ? "Microsoft Entra ID" : conn.authType} credentials.`,
    });
  }

  for (const mcp of mcpServers) {
    pending.push({
      connectorApiName: mcp.connectorApiName,
      displayName: mcp.displayName,
      requiresOAuth: mcp.requiresOAuth,
      instructions: mcp.requiresOAuth
        ? "Configure the MCP server connection and sign in."
        : "Add the MCP server connection (no credentials required).",
    });
  }

  if (includeCua) {
    pending.push({
      connectorApiName: "shared_computeroperator",
      displayName: "Computer Use Agent (CUA)",
      requiresOAuth: true,
      instructions: "Configure the Computer Operator connection. This enables the agent to use a browser to perform tasks on behalf of the user.",
    });
  }

  return pending;
}
