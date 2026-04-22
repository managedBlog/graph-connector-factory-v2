/**
 * MCP Prompts for Graph Connector Factory.
 */

import type { AvailablePrompt, PromptResult } from "../transport/mcpAdapter";

const connectorFactorySetupPrompt: AvailablePrompt = {
  name: "connector-factory-setup",
  description:
    "Full end-to-end Copilot Connector Factory workflow. " +
    "Generates swagger from Microsoft Graph, deploys a Power Platform connector, " +
    "and configures the Entra ID app registration.",
  arguments: [
    {
      name: "baseName",
      description:
        "Base name for all created objects. Each step appends a contextual suffix automatically.",
      required: false,
    },
    {
      name: "authType",
      description: "Connector auth type: NoAuth, OAuthAAD, or FederatedIdentity.",
      required: false,
    },
  ],
};

const promptRegistry: ReadonlyArray<AvailablePrompt> = [
  connectorFactorySetupPrompt,
];

export function listPrompts(): AvailablePrompt[] {
  return [...promptRegistry];
}

export function getPrompt(
  name: string,
  args?: Record<string, string>
): PromptResult | null {
  switch (name) {
    case "connector-factory-setup":
      return buildConnectorFactorySetupPrompt(args ?? {});
    default:
      return null;
  }
}

function buildConnectorFactorySetupPrompt(
  args: Record<string, string>
): PromptResult {
  const baseName = args["baseName"];
  const connectorName = baseName ?? "My Connector";
  const authType = args["authType"] ?? "FederatedIdentity";

  return {
    description: `End-to-end setup for connector '${connectorName}'.`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Please set up a complete Graph Connector Factory deployment` +
            (baseName ? ` with base name '${baseName}'` : "") +
            `:\n\n` +
            `1. **Research**: Use graph_listOperations to discover Graph API operations.\n\n` +
            `2. **Generate**: Use graph_generateConnector to create a swagger definition.\n\n` +
            `3. **Deploy**: Use graph_deployPipeline to deploy the connector and configure the app registration.\n\n` +
            `Auth type: ${authType}`,
        },
      },
    ],
  };
}
