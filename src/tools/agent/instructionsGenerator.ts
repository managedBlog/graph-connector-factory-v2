/**
 * Agent instructions generator for Copilot Studio.
 *
 * Produces markdown instructions that tell the generated agent how to use
 * its available tools (custom connectors, MCP servers, knowledge sources).
 * Follows the same instruction patterns used in the GCF agent itself.
 *
 * Copilot Studio enforces an 8,000 character limit on agent instructions.
 */

import { log } from "../../logging/logger";
import type {
  InstructionsInput,
  ConnectorOperationGroup,
  McpServerCatalogEntry,
  KnowledgeSource,
} from "./types";

const INSTRUCTION_CHAR_LIMIT = 8_000;

/**
 * Generate Copilot Studio agent instructions from agent composition inputs.
 * Automatically truncates to stay within the 8,000 character limit.
 */
export function generateInstructions(input: InstructionsInput): string {
  // Build sections in priority order (header/purpose first, guidelines last)
  const header = buildHeader(input);
  const connectorSection = buildConnectorSection(input.connectorOperations);
  const mcpSection = buildMcpSection(input.mcpServers);
  const ksSection = buildKnowledgeSourceSection(input.knowledgeSources);
  const guidelines = buildGuidelines(input.knowledgeSources.length > 0);

  // Assemble full instructions
  let result = [header, connectorSection, mcpSection, ksSection, guidelines]
    .filter(Boolean)
    .join("\n");

  // If within limit, return as-is
  if (result.length <= INSTRUCTION_CHAR_LIMIT) {
    return result;
  }

  // Truncation strategy: drop guidelines first, then per-connector usage tips,
  // then operation tables, preserving header/purpose always
  log(`[Instructions] Generated ${result.length} chars, exceeds ${INSTRUCTION_CHAR_LIMIT} limit — truncating`);

  // Try without guidelines
  result = [header, connectorSection, mcpSection, ksSection].filter(Boolean).join("\n");
  if (result.length <= INSTRUCTION_CHAR_LIMIT) {
    log(`[Instructions] Truncated guidelines section, now ${result.length} chars`);
    return result;
  }

  // Try with compact connector section (no per-connector tips, just table)
  const compactConnectors = buildConnectorSectionCompact(input.connectorOperations);
  result = [header, compactConnectors, mcpSection, ksSection].filter(Boolean).join("\n");
  if (result.length <= INSTRUCTION_CHAR_LIMIT) {
    log(`[Instructions] Truncated connector tips, now ${result.length} chars`);
    return result;
  }

  // Try with just operation lists (no tables)
  const minimalConnectors = buildConnectorSectionMinimal(input.connectorOperations);
  result = [header, minimalConnectors, mcpSection, ksSection].filter(Boolean).join("\n");
  if (result.length <= INSTRUCTION_CHAR_LIMIT) {
    log(`[Instructions] Truncated to minimal connector list, now ${result.length} chars`);
    return result;
  }

  // Last resort: hard truncate
  result = result.slice(0, INSTRUCTION_CHAR_LIMIT - 50) +
    "\n\n*(Instructions truncated due to length limit)*";
  log(`[Instructions] Hard truncated to ${result.length} chars`);
  return result;
}

// ——— Section builders ————————————————————————————————————————————————

function buildHeader(input: InstructionsInput): string {
  return [
    `# ${input.agentName}\n`,
    `## Purpose\n${input.agentPurpose}\n`,
    "You have access to the following tools and knowledge sources to accomplish your tasks. " +
    "Use them to help users with their requests.\n",
  ].join("\n");
}

function buildConnectorSection(groups: ConnectorOperationGroup[]): string {
  if (groups.length === 0) return "";
  const lines: string[] = ["## Available Connector Operations\n"];
  for (const group of groups) {
    lines.push(`### ${group.connectorName}\n`);
    if (group.operations.length > 0) {
      lines.push("| Operation | Method | Description |");
      lines.push("|-----------|--------|-------------|");
      for (const op of group.operations) {
        const summary = op.summary || op.operationId;
        lines.push(`| \`${op.operationId}\` | ${op.method.toUpperCase()} | ${summary} |`);
      }
      lines.push("");
      lines.push(`When using ${group.connectorName}:`);
      lines.push("- Always validate required parameters before calling.");
      lines.push("- Handle errors gracefully and explain what went wrong.");
      lines.push("- Present responses in clear, formatted text.\n");
    }
  }
  return lines.join("\n");
}

function buildConnectorSectionCompact(groups: ConnectorOperationGroup[]): string {
  if (groups.length === 0) return "";
  const lines: string[] = ["## Available Connector Operations\n"];
  for (const group of groups) {
    lines.push(`### ${group.connectorName}\n`);
    if (group.operations.length > 0) {
      lines.push("| Operation | Method | Description |");
      lines.push("|-----------|--------|-------------|");
      for (const op of group.operations) {
        const summary = op.summary || op.operationId;
        lines.push(`| \`${op.operationId}\` | ${op.method.toUpperCase()} | ${summary} |`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function buildConnectorSectionMinimal(groups: ConnectorOperationGroup[]): string {
  if (groups.length === 0) return "";
  const lines: string[] = ["## Available Connector Operations\n"];
  for (const group of groups) {
    lines.push(`### ${group.connectorName}`);
    for (const op of group.operations) {
      lines.push(`- \`${op.operationId}\` (${op.method.toUpperCase()}): ${op.summary || op.operationId}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildMcpSection(mcpServers: McpServerCatalogEntry[]): string {
  if (mcpServers.length === 0) return "";
  const lines: string[] = ["## MCP Servers\n"];
  for (const mcp of mcpServers) {
    const tags = mcp.relevantFor.slice(0, 3).join(", ");
    lines.push(`- **${mcp.displayName}**: ${mcp.description} Use this for queries related to ${tags}.`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildKnowledgeSourceSection(knowledgeSources: KnowledgeSource[]): string {
  if (knowledgeSources.length === 0) return "";
  const lines: string[] = ["## Knowledge Sources\n"];
  for (const ks of knowledgeSources) {
    const typeLabel = ks.type === "sharepoint" ? "SharePoint" : "Web";
    lines.push(`- **${ks.displayName}** (${typeLabel}): ${ks.description}`);
  }
  lines.push("");
  lines.push(
    "Use knowledge sources to provide context and background information before making API calls. " +
    "When a user's question relates to a topic covered by a knowledge source, search it first.\n",
  );
  return lines.join("\n");
}

function buildGuidelines(hasKnowledgeSources: boolean): string {
  const lines: string[] = ["## Guidelines\n"];
  lines.push("- Always confirm before performing write operations (POST, PUT, PATCH, DELETE).");
  lines.push("- Present API responses in clear, formatted text.");
  lines.push("- If an operation fails, explain the error and suggest alternatives.");
  if (hasKnowledgeSources) {
    lines.push("- Use knowledge sources to provide context before making API calls.");
  }
  lines.push("- If you are unsure which tool to use, ask the user for clarification.");
  lines.push("- Summarize results concisely and highlight the most relevant information.\n");
  return lines.join("\n");
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
