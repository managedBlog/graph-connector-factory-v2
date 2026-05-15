/**
 * Agent Generator — orchestrates Copilot Studio agent creation.
 *
 * Flow:
 *   1. Validate prerequisites (PAC available, connectors deployed)
 *   2. Resolve MCP servers from catalog
 *   3. Build operation groups from deployed connectors
 *   4. Generate agent instructions (or use override)
 *   5. Resolve environment ID
 *   6. Get publisher prefix and build schema name
 *   7. Patch template (YAML + JSON)
 *   8. Run pac copilot create
 *   9. Set agent instructions via Dataverse API
 *  10. Add knowledge sources via Dataverse API
 */

import * as fs from "fs";
import { log, logError } from "../../logging/logger";
import type {
  AgentGenerationInput,
  AgentGenerationResult,
  AgentFactoryContext,
  DeployedConnectorInfo,
  ConnectorOperationGroup,
  PendingConnection,
} from "./types";import { resolveMcpServers } from "./mcpCatalog";
import { generateInstructions, generateStarterPrompts } from "./instructionsGenerator";
import { truncateInstructions } from "./instructionUtils";
import { patchTemplate, cleanupTemplateDir, buildSchemaName } from "./templatePatcher";
import { isPacAvailable, pacCopilotCreate, getPublisherPrefix, resolveEnvironmentId } from "./pacRunner";
import { addKnowledgeSources, setAgentInstructions } from "./dataverseClient";


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
    operations: conn.operations?.length
      ? conn.operations
      : conn.operationIds.map((opId) => ({
          operationId: opId,
          summary: opId,
          method: "GET",
          path: "",
        })),
  }));

  // 4. Generate instructions (or use override), enforce 8K limit
  const rawInstructions = (input.instructionsOverride && input.instructionsOverride !== "auto")
    ? input.instructionsOverride
    : generateInstructions({
        agentName: input.agentName,
        agentPurpose: input.agentPurpose,
        connectorOperations,
        mcpServers,
        knowledgeSources: input.knowledgeSources ?? [],
      });
  const instructions = truncateInstructions(rawInstructions);

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

  // 7. Patch template
  let patchedTemplate;
  try {
    patchedTemplate = patchTemplate({
      agentName: input.agentName,
      agentDescription: input.agentPurpose,
      instructions,
      connectors: deployedConnectors,
      mcpServers,
    });
    log(`[AgentGenerator] Template patched: ${patchedTemplate.componentCount} components`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[AgentGenerator] Template patching failed: ${msg}`);
    return {
      success: false,
      pendingConnections: [],
      starterPrompts,
      warnings: [],
      error: `Template patching failed: ${msg}`,
    };
  }

  // 8. Run pac copilot create
  try {
    if (process.env.MCP_DEBUG === "1") {
      const yamlContent = fs.readFileSync(patchedTemplate.yamlPath, "utf-8");
      log(`[AgentGenerator] YAML template path: ${patchedTemplate.yamlPath}`);
      log(`[AgentGenerator] YAML template content:\n${yamlContent}`);
      const jsonContent = fs.readFileSync(patchedTemplate.jsonPath, "utf-8");
      log(`[AgentGenerator] JSON template content:\n${jsonContent}`);
    }

    const result = await pacCopilotCreate({
      displayName: input.agentName,
      schemaName: agentSchemaName,
      templateFileName: patchedTemplate.yamlPath,
      solution: input.solutionName,
      environmentId: resolvedEnvId,
    });

    if (process.env.MCP_DEBUG === "1") {
      log(`[AgentGenerator] PAC result: success=${result.success}, agentId=${result.agentId}, stdout=${result.stdout}, stderr=${result.stderr}`);
    } else {
      log(`[AgentGenerator] PAC result: success=${result.success}, agentId=${result.agentId}`);
    }

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
    const pendingConnections = buildPendingConnections(deployedConnectors, mcpServers);

    // Derive agent URL if not in output
    const agentUrl = result.agentUrl ??
      (result.agentId
        ? `https://web.powerva.microsoft.com/environments/${resolvedEnvId}/bots/${result.agentId}`
        : undefined);

    log(`[AgentGenerator] Agent created successfully: ${result.agentId}`);

    // Connection binding removed — Copilot Studio handles connections via its own UI
    const warnings: string[] = [];

    // 9. Post-creation: set agent instructions via Dataverse API
    if (result.agentId && instructions) {
      log(`[AgentGenerator] Setting agent instructions...`);
      try {
        await setAgentInstructions(resolvedEnvId, result.agentId, input.agentName, instructions, agentSchemaName);
        log(`[AgentGenerator] Instructions set successfully`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`[AgentGenerator] Failed to set instructions (non-fatal): ${msg}`);
        warnings.push(`Failed to set agent instructions: ${msg}. You can add them manually in Copilot Studio.`);
      }
    }

    // 10. Post-creation: add knowledge sources via Dataverse API
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
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[AgentGenerator] PAC execution error: ${msg}`);
    cleanupTemplateDir(patchedTemplate.yamlPath);
    return {
      success: false,
      pendingConnections: [],
      starterPrompts,
      warnings: [],
      error: `PAC execution error: ${msg}`,
    };
  }
}

/**
 * Build list of connections the user needs to configure post-deploy.
 */
function buildPendingConnections(
  connectors: DeployedConnectorInfo[],
  mcpServers: import("./types").McpServerCatalogEntry[],
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

  return pending;
}
