/**
 * Template patcher for Copilot Studio agent creation.
 *
 * Loads a clean base template (system topics only) and appends:
 *   - Action components for each connector operation and MCP server (tools)
 *   - connectionReferences (which connectors the agent uses)
 *   - connectorDefinitions (connector metadata)
 *
 * Format is derived directly from extracting a working manually-created agent
 * via `pac copilot extract-template` — we match that format exactly.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import { log } from "../../logging/logger";
import type {
  TemplatePatchConfig,
  PatchedTemplate,
} from "./types";

// ——— Constants ————————————————————————————————————————————————————————

const BASE_TEMPLATE_PATH = path.resolve(__dirname, "./templates/agent-base-template.yaml");
const BASE_JSON = "kickStartTemplate-1.0.0.json";
const PLACEHOLDER_BOT_ID = "00000000-0000-0000-0000-000000000000";

// ——— Schema name helpers —————————————————————————————————————————————

export function sanitizeSchemaName(displayName: string): string {
  return displayName
    .replace(/[^a-zA-Z0-9_]/g, "")
    .replace(/^[0-9]+/, "");
}

export function buildSchemaName(prefix: string, displayName: string): string {
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${prefix}_${sanitizeSchemaName(displayName)}_${suffix}`;
}

// ——— Connection reference key ————————————————————————————————————————
// Just needs to be a short consistent key used across all references to
// the same connector. PAC handles the rest.

function connRefKey(apiName: string): string {
  return apiName.replace(/^shared_/, "").replace(/[^a-z0-9]/g, "").slice(0, 20);
}

function connRefLogicalName(apiName: string): string {
  return `template-content.connectionreference.${connRefKey(apiName)}`;
}

// ——— Base template loader ————————————————————————————————————————————

let _cachedBaseTemplate: string | null = null;
let _baseComponentCount: number = 0;

function loadBaseTemplate(): string {
  if (_cachedBaseTemplate) return _cachedBaseTemplate;

  const candidates = [
    BASE_TEMPLATE_PATH,
    path.resolve(__dirname, "../templates/agent-base-template.yaml"),
    path.resolve(__dirname, "../../tools/agent/templates/agent-base-template.yaml"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      _cachedBaseTemplate = fs.readFileSync(candidate, "utf-8");
      _baseComponentCount = (_cachedBaseTemplate.match(/kind: DialogComponent/g) ?? []).length;
      log(`[TemplatePatcher] Loaded base template from: ${candidate} (${_baseComponentCount} base components)`);
      return _cachedBaseTemplate;
    }
  }

  throw new Error(
    `Base template not found. Searched:\n${candidates.join("\n")}\n` +
    `Ensure agent-base-template.yaml is copied to the build output.`,
  );
}

// ——— Action component generators ————————————————————————————————————

function connectorAction(
  connectorDisplayName: string,
  connectorApiName: string,
  operationId: string,
  opDisplayName: string,
  description: string,
): string {
  const ref = connRefLogicalName(connectorApiName);
  const schemaName = `template-content.action.${sanitizeSchemaName(connectorDisplayName)}${sanitizeSchemaName(opDisplayName)}`;

  return [
    `  - kind: DialogComponent`,
    `    managedProperties:`,
    `      isCustomizable: false`,
    ``,
    `    displayName: ${connectorDisplayName} - ${opDisplayName}`,
    `    parentBotId: ${PLACEHOLDER_BOT_ID}`,
    `    shareContext: {}`,
    `    state: Active`,
    `    status: Active`,
    `    publisherUniqueName: DefaultPublisherorgd8cb0ffa`,
    `    schemaName: ${schemaName}`,
    `    dialog:`,
    `      kind: TaskDialog`,
    `      modelDisplayName: ${opDisplayName}`,
    `      modelDescription: "${description}"`,
    `      outputs:`,
    `        - propertyName: Response`,
    ``,
    `      action:`,
    `        kind: InvokeConnectorTaskAction`,
    `        connectionReference: ${ref}`,
    `        connectionProperties:`,
    `          name: ${ref}`,
    `          mode: Invoker`,
    ``,
    `        operationId: ${operationId}`,
    ``,
    `      outputMode: All`,
  ].join("\n");
}

function mcpAction(
  displayName: string,
  connectorApiName: string,
  operationId: string,
  description: string,
): string {
  const ref = connRefLogicalName(connectorApiName);
  const schemaName = `template-content.action.${sanitizeSchemaName(displayName)}`;

  return [
    `  - kind: DialogComponent`,
    `    managedProperties:`,
    `      isCustomizable: false`,
    ``,
    `    displayName: ${displayName}`,
    `    parentBotId: ${PLACEHOLDER_BOT_ID}`,
    `    shareContext: {}`,
    `    state: Active`,
    `    status: Active`,
    `    publisherUniqueName: DefaultPublisherorgd8cb0ffa`,
    `    schemaName: ${schemaName}`,
    `    dialog:`,
    `      kind: TaskDialog`,
    `      modelDisplayName: ${displayName}`,
    `      modelDescription: ${description}`,
    `      action:`,
    `        kind: InvokeExternalAgentTaskAction`,
    `        connectionReference: ${ref}`,
    `        connectionProperties:`,
    `          name: ${ref}`,
    `          mode: Invoker`,
    ``,
    `        operationDetails:`,
    `          kind: ModelContextProtocolMetadata`,
    `          operationId: ${operationId}`,
  ].join("\n");
}

// ——— Connection references & connector definitions ———————————————————

function generateConnectionReferences(connectorApiNames: string[]): string {
  const entries = connectorApiNames.map((apiName) => {
    const logName = connRefLogicalName(apiName);
    const guid = randomUUID().replace(/-/g, "");
    return [
      `  - connectorId: /providers/Microsoft.PowerApps/apis/${apiName}`,
      `    connectionReferenceLogicalName: ${logName}`,
      `    displayName: ${connRefKey(apiName)}.${apiName}.${guid}`,
    ].join("\n");
  });
  return `connectionReferences:\n${entries.join("\n\n")}`;
}

function generateConnectorDefinitions(connectorApiNames: string[]): string {
  const entries = connectorApiNames.map(
    (apiName) => `  - connectorId: /providers/Microsoft.PowerApps/apis/${apiName}`,
  );
  return `connectorDefinitions:\n${entries.join("\n\n")}`;
}

// ——— Main patcher ————————————————————————————————————————————————————

export function patchTemplate(config: TemplatePatchConfig): PatchedTemplate {
  const allConnectorApiNames = new Set<string>();
  const actions: string[] = [];

  // Generate connector actions
  for (const conn of config.connectors) {
    allConnectorApiNames.add(conn.apiName);
    for (const opId of conn.operationIds) {
      const opDisplay = opId
        .replace(/\./g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
      actions.push(
        connectorAction(
          conn.displayName,
          conn.apiName,
          opId,
          opDisplay,
          `Operation ${opId} from ${conn.displayName}`,
        ),
      );
    }
  }

  // Generate MCP actions
  for (const mcp of config.mcpServers) {
    allConnectorApiNames.add(mcp.connectorApiName);
    actions.push(
      mcpAction(
        mcp.displayName,
        mcp.connectorApiName,
        mcp.operationId ?? mcp.id,
        mcp.description,
      ),
    );
  }

  const connectorApiList = [...allConnectorApiNames];

  // Assemble YAML: base template + actions + connectionReferences + connectorDefinitions
  const baseYaml = loadBaseTemplate();
  const parts = [
    baseYaml.trimEnd(),
    "",
    ...actions,
    "",
    generateConnectionReferences(connectorApiList),
    "",
    generateConnectorDefinitions(connectorApiList),
    "",
  ];
  const yaml = parts.join("\n");

  // Build JSON
  const jsonTemplate = buildJsonTemplate(config, connectorApiList);

  // Write to temp directory
  const tmpDir = path.join(os.tmpdir(), `gcf-agent-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const yamlPath = path.join(tmpDir, "agent-template.yaml");
  const jsonPath = path.join(tmpDir, BASE_JSON);

  fs.writeFileSync(yamlPath, yaml, "utf-8");
  fs.writeFileSync(jsonPath, JSON.stringify(jsonTemplate, null, 2), "utf-8");

  const actionCount = actions.length;
  log(`[TemplatePatcher] Generated template: ${actionCount} tools, ${connectorApiList.length} connectors → ${tmpDir}`);

  return { yamlPath, jsonPath, componentCount: _baseComponentCount + actionCount };
}

// ——— JSON template builder ———————————————————————————————————————————

function buildJsonTemplate(
  config: TemplatePatchConfig,
  connectorApiNames: string[],
): Record<string, unknown> {
  const connectors = connectorApiNames.map((apiName) => ({
    "connectionReference": `connectionreference.${connRefKey(apiName)}`,
    "_connectionReference.comment": "{locked}",
    "connectorId": `/providers/Microsoft.PowerApps/apis/${apiName}`,
    "_connectorId.comment": "{locked}",
  }));

  return {
    "version": "1.0.0",
    "_version.comment": "{locked}",
    "metadata": {
      "templateName": "kickStartTemplate",
      "_templateName.comment": "{locked}",
      "templateVersion": "1.0.0",
      "_templateVersion.comment": "{locked}",
      "name": config.agentName,
      "description": config.agentDescription ?? "A basic agent.",
      "source": "CopilotStudio",
      "_source.comment": "{locked}",
      "quality": "PrivatePreview",
      "_quality.comment": "{locked}",
      "iconBase64": null,
      "_iconBase64.comment": "{locked}",
      "iconAltText": null,
      "isGpt": false,
      "_isGpt.comment": "{locked}",
      "documentationUri": null,
      "_documentationUri.comment": "{locked}",
      "supportedLanguages": [],
      "_supportedLanguages.comment": "{locked}",
      "industries": [],
      "_industries.comment": "{locked}",
      "categories": [],
      "_categories.comment": "{locked}",
    },
    "content": {
      "displayName": config.agentName,
      "description": config.agentDescription ?? "A basic agent.",
      "instructions": config.instructions ?? "",
      "conversationStarters": [],
    },
    "customizations": {
      "schema": {
        "type": "object",
        "_type.comment": "{locked}",
        "properties": {
          "Property1": {
            "type": "string",
            "_type.comment": "{locked}",
            "title": "An overridable property",
            "description": "This is a property that can be added anywhere in the content.yml as {{Property1}}.",
            "default": "Default value.",
            "_default.comment": "{locked}",
          },
        },
      },
    },
    "spec": {
      "connectors": connectors,
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
