/**
 * Agent instructions generator for Copilot Studio.
 *
 * Produces markdown instructions that tell the generated agent how to use
 * its available tools (custom connectors, MCP servers, knowledge sources).
 * Follows the same instruction patterns used in the GCF agent itself.
 */

import type {
  InstructionsInput,
  ConnectorOperationGroup,
  McpServerCatalogEntry,
  KnowledgeSource,
} from "./types";

/**
 * Generate Copilot Studio agent instructions from agent composition inputs.
 */
export function generateInstructions(input: InstructionsInput): string {
  const sections: string[] = [];

  // Header
  sections.push(`# ${input.agentName}\n`);
  sections.push(`## Purpose\n${input.agentPurpose}\n`);
  sections.push(
    "You have access to the following tools and knowledge sources to accomplish your tasks. " +
    "Use them to help users with their requests.\n",
  );

  // Connector operations
  if (input.connectorOperations.length > 0) {
    sections.push("## Available Connector Operations\n");
    for (const group of input.connectorOperations) {
      sections.push(`### ${group.connectorName}\n`);
      if (group.operations.length > 0) {
        sections.push("| Operation | Method | Description |");
        sections.push("|-----------|--------|-------------|");
        for (const op of group.operations) {
          const summary = op.summary || op.operationId;
          sections.push(`| \`${op.operationId}\` | ${op.method.toUpperCase()} | ${summary} |`);
        }
        sections.push("");
        sections.push(`When using ${group.connectorName}:`);
        sections.push("- Always validate required parameters before calling.");
        sections.push("- Handle errors gracefully and explain what went wrong.");
        sections.push("- Present responses in clear, formatted text.\n");
      }
    }
  }

  // MCP servers
  if (input.mcpServers.length > 0) {
    sections.push("## MCP Servers\n");
    for (const mcp of input.mcpServers) {
      const tags = mcp.relevantFor.slice(0, 3).join(", ");
      sections.push(
        `- **${mcp.displayName}**: ${mcp.description} Use this for queries related to ${tags}.`,
      );
    }
    sections.push("");
  }

  // Knowledge sources
  if (input.knowledgeSources.length > 0) {
    sections.push("## Knowledge Sources\n");
    for (const ks of input.knowledgeSources) {
      const typeLabel = ks.type === "sharepoint" ? "SharePoint" : "Web";
      sections.push(`- **${ks.displayName}** (${typeLabel}): ${ks.description}`);
    }
    sections.push("");
    sections.push(
      "Use knowledge sources to provide context and background information before making API calls. " +
      "When a user's question relates to a topic covered by a knowledge source, search it first.\n",
    );
  }

  // Guidelines
  sections.push("## Guidelines\n");
  sections.push("- Always confirm before performing write operations (POST, PUT, PATCH, DELETE).");
  sections.push("- Present API responses in clear, formatted text.");
  sections.push("- If an operation fails, explain the error and suggest alternatives.");
  if (input.knowledgeSources.length > 0) {
    sections.push("- Use knowledge sources to provide context before making API calls.");
  }
  sections.push("- If you are unsure which tool to use, ask the user for clarification.");
  sections.push("- Summarize results concisely and highlight the most relevant information.\n");

  return sections.join("\n");
}

/**
 * Generate a set of conversation starter prompts based on agent capabilities.
 */
export function generateStarterPrompts(input: InstructionsInput): string[] {
  const starters: string[] = [];

  // Add operation-based starters
  for (const group of input.connectorOperations) {
    const readOps = group.operations.filter((op) =>
      op.method.toLowerCase() === "get",
    );
    if (readOps.length > 0) {
      const firstOp = readOps[0]!;
      const summary = firstOp.summary || firstOp.operationId;
      starters.push(`Can you ${summary.toLowerCase()}?`);
    }
  }

  // Add MCP-based starters
  for (const mcp of input.mcpServers) {
    if (mcp.id === "ms-learn-docs") {
      starters.push("Search Microsoft Learn for documentation on this topic.");
    }
  }

  // Add purpose-based starter
  if (input.agentPurpose) {
    starters.push(`Help me with ${input.agentPurpose.toLowerCase()}.`);
  }

  // Limit to 4 starters
  return starters.slice(0, 4);
}
