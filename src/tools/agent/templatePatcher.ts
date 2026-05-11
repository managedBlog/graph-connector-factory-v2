/**
 * Template patcher for Copilot Studio agent creation.
 *
 * Takes the base template YAML + JSON extracted from the reference agent
 * and patches them with the agent factory's composition decisions:
 *   - Rewrites connection references with publisher prefix
 *   - Strips existing action components
 *   - Adds new action components for each deployed connector operation
 *   - Adds MCP server action components
 *   - Patches JSON with instructions, knowledge sources, connector metadata
 *
 * Critical spike findings applied:
 *   - All `template-content.` refs must be replaced with `{prefix}_` names
 *   - schemaName on `pac copilot create` must start with publisher prefix
 *   - connectionReferenceLogicalName must start with publisher prefix
 *   - New DialogComponent entries ARE accepted by pac copilot create
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import { log } from "../../logging/logger";
import type {
  TemplatePatchConfig,
  PatchedTemplate,
  DeployedConnectorInfo,
  McpServerCatalogEntry,
  KnowledgeSource,
} from "./types";

// ΓöÇΓöÇΓöÇ Constants ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

const BASE_TEMPLATE_DIR = path.resolve(__dirname, "../../../artifacts/agent-template");
const BASE_YAML = "base-template.yaml";
const BASE_JSON = "kickStartTemplate-1.0.0.json";

// Bot ID from the source template ΓÇö PAC replaces this during creation
const SOURCE_BOT_ID = "81e6e367-4e49-f111-bec6-7ced8d6e690c";

// ΓöÇΓöÇΓöÇ Schema name sanitization ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Sanitize a display name into a valid Dataverse schema name.
 * Rules: alphanumeric + underscores only, no leading digits.
 */
export function sanitizeSchemaName(displayName: string): string {
  return displayName
    .replace(/[^a-zA-Z0-9_]/g, "")
    .replace(/^[0-9]+/, "");
}

/**
 * Build the full schema name with publisher prefix.
 */
export function buildSchemaName(prefix: string, displayName: string): string {
  const sanitized = sanitizeSchemaName(displayName);
  return `${prefix}_${sanitized}`;
}

// ΓöÇΓöÇΓöÇ Connection reference naming ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function connRefLogicalName(prefix: string, connectorApiName: string): string {
  // Sanitize the API name: replace hyphens with underscores
  const sanitized = connectorApiName.replace(/-/g, "_");
  return `${prefix}_${sanitized}`;
}

function connRefDisplayName(prefix: string, connectorApiName: string): string {
  const sanitized = connectorApiName.replace(/-/g, "_");
  return `${prefix}_${sanitized}`;
}

// ΓöÇΓöÇΓöÇ Component generators ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function generateConnectorActionComponent(
  prefix: string,
  connectorApiName: string,
  operationId: string,
  displayName: string,
  description: string,
): string {
  const actionSchemaName = `${prefix}_action_${sanitizeSchemaName(operationId)}`;
  const connRef = connRefLogicalName(prefix, connectorApiName);

  return `
  - kind: DialogComponent
    managedProperties:
      isCustomizable: false

    displayName: "${displayName}"
    parentBotId: ${SOURCE_BOT_ID}
    shareContext: {}
    state: Active
    status: Active
    schemaName: ${actionSchemaName}
    dialog:
      kind: TaskDialog
      modelDisplayName: "${displayName}"
      modelDescription: "${description}"
      action:
        kind: InvokeConnectorTaskAction
        connectionReference: ${connRef}
        connectionProperties:
          name: ${connRef}
          mode: Invoker
        operationId: ${operationId}
      outputMode: All
`;
}

function generateMcpActionComponent(
  prefix: string,
  mcp: McpServerCatalogEntry,
): string {
  const actionSchemaName = `${prefix}_action_${sanitizeSchemaName(mcp.id)}`;
  const connRef = connRefLogicalName(prefix, mcp.connectorApiName);
  const opId = mcp.operationId ?? mcp.id;

  return `
  - kind: DialogComponent
    managedProperties:
      isCustomizable: false

    displayName: "${mcp.displayName}"
    parentBotId: ${SOURCE_BOT_ID}
    shareContext: {}
    state: Active
    status: Active
    schemaName: ${actionSchemaName}
    dialog:
      kind: TaskDialog
      modelDisplayName: "${mcp.displayName}"
      modelDescription: "${mcp.description}"
      action:
        kind: InvokeExternalAgentTaskAction
        connectionReference: ${connRef}
        connectionProperties:
          name: ${connRef}
          mode: Invoker
        operationDetails:
          kind: ModelContextProtocolMetadata
          operationId: ${opId}
`;
}

// CUA connector API name — globally stable across Power Platform environments
const CUA_CONNECTOR_API_NAME = "shared_computeroperator";

function generateCuaActionComponent(prefix: string): string {
  const actionSchemaName = `${prefix}_action_ComputeruseComputeruse`;
  const connRef = connRefLogicalName(prefix, CUA_CONNECTOR_API_NAME);

  return `
  - kind: DialogComponent
    managedProperties:
      isCustomizable: false

    displayName: "Computer use - Computer use"
    parentBotId: ${SOURCE_BOT_ID}
    shareContext: {}
    state: Active
    status: Active
    schemaName: ${actionSchemaName}
    dialog:
      kind: TaskDialog
      modelDisplayName: "Computer use"
      modelDescription: "Use a computer to navigate websites or operate desktop apps to complete tasks."
      action:
        kind: InvokeComputerUsingAgentTaskAction
        connectionReference: ${connRef}
        connectionProperties:
          name: ${connRef}
          mode: Invoker
        operationId: ComputerOperatorInvokeMcpCua
        instructions: "Perform the task you are asked to do using the computer. Follow instructions carefully and report results."
        model:
          modelNameHint: sonnet4-5
        initializeContext:
          enforceHttps: true
          requestForInformationInput:
            timeToCompleteInMinutes: 60
            version: 2
`;
}

// ΓöÇΓöÇΓöÇ System topic components (from base template) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function generateSystemTopics(prefix: string): string {
  return `
  - kind: DialogComponent
    managedProperties:
      isCustomizable: false

    displayName: Reset Conversation
    parentBotId: ${SOURCE_BOT_ID}
    shareContext: {}
    state: Active
    status: Active
    schemaName: ${prefix}_topic_ResetConversation
    dialog:
      startBehavior: UseLatestPublishedContentAndCancelOtherTopics
      beginDialog:
        kind: OnSystemRedirect
        id: main
        actions:
          - kind: SendActivity
            id: sendMessage_reset
            activity: What can I help you with?

          - kind: ClearAllVariables
            id: clearAllVariables_reset
            variables: ConversationScopedVariables

          - kind: CancelAllDialogs
            id: cancelAllDialogs_reset

  - kind: DialogComponent
    managedProperties:
      isCustomizable: false

    displayName: Conversation Start
    parentBotId: ${SOURCE_BOT_ID}
    shareContext: {}
    state: Active
    status: Active
    schemaName: ${prefix}_topic_ConversationStart
    dialog:
      startBehavior: UseLatestPublishedContentAndCancelOtherTopics
      beginDialog:
        kind: OnConversationStart
        id: main
        actions:
          - kind: SendActivity
            id: sendMessage_start
            activity: Hello! I'm here to help. What can I do for you?

  - kind: DialogComponent
    managedProperties:
      isCustomizable: false

    displayName: End of Conversation
    parentBotId: ${SOURCE_BOT_ID}
    shareContext: {}
    state: Active
    status: Active
    schemaName: ${prefix}_topic_EndofConversation
    dialog:
      startBehavior: UseLatestPublishedContentAndCancelOtherTopics
      beginDialog:
        kind: OnSystemMessage
        condition: =Topic.EndConversation
        id: main
        actions:
          - kind: SendActivity
            id: sendMessage_end
            activity: Thank you! Have a great day.

  - kind: DialogComponent
    managedProperties:
      isCustomizable: false

    displayName: Fallback
    parentBotId: ${SOURCE_BOT_ID}
    shareContext: {}
    state: Active
    status: Active
    schemaName: ${prefix}_topic_Fallback
    dialog:
      startBehavior: UseLatestPublishedContentAndCancelOtherTopics
      beginDialog:
        kind: OnUnknownIntent
        id: main
        actions:
          - kind: SendActivity
            id: sendMessage_fallback
            activity: I'm not sure I understand. Could you rephrase your request?

  - kind: DialogComponent
    managedProperties:
      isCustomizable: false

    displayName: On Error
    parentBotId: ${SOURCE_BOT_ID}
    shareContext: {}
    state: Active
    status: Active
    schemaName: ${prefix}_topic_OnError
    dialog:
      startBehavior: UseLatestPublishedContentAndCancelOtherTopics
      beginDialog:
        kind: OnError
        id: main
        actions:
          - kind: SendActivity
            id: sendMessage_error
            activity: I encountered an error. Please try again or rephrase your request.

  - kind: DialogComponent
    managedProperties:
      isCustomizable: false

    displayName: Sign In
    parentBotId: ${SOURCE_BOT_ID}
    shareContext: {}
    state: Active
    status: Active
    schemaName: ${prefix}_topic_SignIn
    dialog:
      startBehavior: UseLatestPublishedContentAndCancelOtherTopics
      beginDialog:
        kind: OnSignIn
        id: main
        actions:
          - kind: SignInCard
            id: signInCard_main
            title: Login
            text: To continue, please login

  - kind: DialogComponent
    managedProperties:
      isCustomizable: false

    displayName: Generative Answers
    parentBotId: ${SOURCE_BOT_ID}
    shareContext: {}
    state: Active
    status: Active
    schemaName: ${prefix}_gpt_default
    dialog:
      kind: Gpt
`;
}

// ΓöÇΓöÇΓöÇ Connection references section ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function generateConnectionReferences(
  prefix: string,
  connectorApiNames: string[],
): string {
  const refs = connectorApiNames.map((apiName) => {
    const logicalName = connRefLogicalName(prefix, apiName);
    const display = connRefDisplayName(prefix, apiName);
    return `
  - managedProperties:
      isCustomizable: false

    connectorId: /providers/Microsoft.PowerApps/apis/${apiName}
    connectionReferenceLogicalName: ${logicalName}
    displayName: ${display}`;
  });

  return `connectionReferences:${refs.join("\n")}`;
}

function generateConnectorDefinitions(connectorApiNames: string[]): string {
  const defs = connectorApiNames.map(
    (apiName) => `\n  - connectorId: /providers/Microsoft.PowerApps/apis/${apiName}`,
  );
  return `connectorDefinitions:${defs.join("")}`;
}

// ΓöÇΓöÇΓöÇ Main patcher ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Patch the base template with agent factory composition.
 * Produces a YAML + JSON pair ready for `pac copilot create`.
 */
export function patchTemplate(config: TemplatePatchConfig): PatchedTemplate {
  const prefix = config.publisherPrefix;
  const allConnectorApiNames = new Set<string>();
  const actionComponents: string[] = [];
  let componentCount = 0;

  // 1. Generate action components for each deployed connector's operations
  for (const conn of config.connectors) {
    allConnectorApiNames.add(conn.apiName);
    for (const opId of conn.operationIds) {
      actionComponents.push(
        generateConnectorActionComponent(
          prefix,
          conn.apiName,
          opId,
          `${conn.displayName} - ${opId}`,
          `Operation ${opId} from ${conn.displayName}`,
        ),
      );
      componentCount++;
    }
  }

  // 2. Generate MCP server action components
  for (const mcp of config.mcpServers) {
    allConnectorApiNames.add(mcp.connectorApiName);
    actionComponents.push(generateMcpActionComponent(prefix, mcp));
    componentCount++;
  }

  // 2b. Generate CUA component if requested
  if (config.includeCua) {
    allConnectorApiNames.add(CUA_CONNECTOR_API_NAME);
    actionComponents.push(generateCuaActionComponent(prefix));
    componentCount++;
    log(`[TemplatePatcher] Added CUA component (Computer Operator connector)`);
  }

  // 3. Generate system topics
  const systemTopics = generateSystemTopics(prefix);
  // Count system topic components (8 topics)
  componentCount += 8;

  // 4. Build full YAML
  const connectorApiList = [...allConnectorApiNames];
  const connectionRefs = generateConnectionReferences(prefix, connectorApiList);
  const connectorDefs = generateConnectorDefinitions(connectorApiList);

  const yaml = `kind: BotDefinition
entity:
  accessControlPolicy: GroupMembership
  authenticationMode: Integrated
  authenticationTrigger: Always
  configuration:
    settings:
      GenerativeActionsEnabled: true

  template: kickStartTemplate-1.0.0

components:
${systemTopics}
${actionComponents.join("\n")}

${connectionRefs}

${connectorDefs}
`;

  // 5. Patch JSON template
  const jsonTemplate = buildJsonTemplate(config);

  // 6. Write to temp directory
  const tmpDir = path.join(os.tmpdir(), `gcf-agent-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const yamlPath = path.join(tmpDir, "agent-template.yaml");
  const jsonPath = path.join(tmpDir, BASE_JSON);

  fs.writeFileSync(yamlPath, yaml, "utf-8");
  fs.writeFileSync(jsonPath, JSON.stringify(jsonTemplate, null, 2), "utf-8");

  log(`[TemplatePatcher] Generated template: ${componentCount} components ΓåÆ ${tmpDir}`);

  return { yamlPath, jsonPath, componentCount };
}

// ΓöÇΓöÇΓöÇ JSON template builder ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function buildJsonTemplate(config: TemplatePatchConfig): Record<string, unknown> {
  const prefix = config.publisherPrefix;

  // Build connector references for JSON spec
  const allConnectorApiNames = new Set<string>();
  for (const conn of config.connectors) allConnectorApiNames.add(conn.apiName);
  for (const mcp of config.mcpServers) allConnectorApiNames.add(mcp.connectorApiName);

  const connectors = [...allConnectorApiNames].map((apiName) => ({
    connectionReference: connRefLogicalName(prefix, apiName),
    connectorId: `/providers/Microsoft.PowerApps/apis/${apiName}`,
  }));

  // Build SharePoint knowledge sources
  const sharepointSites = config.knowledgeSources
    .filter((ks) => ks.type === "sharepoint")
    .map((ks) => ({
      name: ks.displayName,
      description: ks.description,
      site: ks.url,
    }));

  return {
    "$schema": "https://schema.mp.microsoft.com/schema/copilot-kickstart-template/1.0",
    "schemaVersion": "1.0.0",
    "metadata": {
      name: "kickStartTemplate",
      version: "1.0.0",
    },
    "content": {
      displayName: config.agentName,
      description: config.agentDescription,
      instructions: config.instructions,
      conversationStarters: [],
    },
    "spec": {
      connectors,
      knowledgeSources: {
        sharepointSites: sharepointSites.length > 0 ? sharepointSites : undefined,
      },
    },
  };
}

/**
 * Clean up temporary template files.
 */
export function cleanupTemplateDir(yamlPath: string): void {
  try {
    const dir = path.dirname(yamlPath);
    fs.rmSync(dir, { recursive: true, force: true });
    log(`[TemplatePatcher] Cleaned up temp dir: ${dir}`);
  } catch {
    // Best-effort cleanup
  }
}
