/**
 * Stdio MCP transport — newline-delimited JSON-RPC 2.0 over stdin/stdout.
 *
 * Reads one JSON-RPC message per line from stdin, routes through the MCP
 * adapter, and writes the response as a single JSON line to stdout.
 * Notifications (adapter returns null) produce no output.
 */

import * as readline from "readline";
import { log, logError } from "../logging/logger";
import { loadConfig } from "../config";
import { listMcpTools, invokeTool } from "../tools/registry";
import { listPrompts, getPrompt } from "../prompts";
import { createMcpTransportAdapter } from "./mcpAdapter";
import type { McpAdapter } from "./mcpAdapter";

/**
 * Process a single line of stdin input.
 * Returns the JSON string to write to stdout, or null for notifications/empty lines.
 */
export async function processStdioLine(
  adapter: McpAdapter,
  line: string
): Promise<string | null> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const errorResponse = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error: invalid JSON." },
    };
    return JSON.stringify(errorResponse);
  }

  const response = await adapter.handleUnknownRequest(parsed);
  if (response === null) return null;
  return JSON.stringify(response);
}

/**
 * Start the stdio MCP host. Reads from stdin, writes to stdout.
 */
export function startStdioServer(): void {
  const config = loadConfig();

  const adapter = createMcpTransportAdapter({
    listAvailableTools: () => listMcpTools(),
    routeToolInvocationWithConfig: (toolName, input) => invokeTool(toolName, input, config),
    listAvailablePrompts: () => listPrompts(),
    getPrompt: async (name, args) => getPrompt(name, args),
  });

  log("Stdio MCP transport ready — reading from stdin.");

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", async (line: string) => {
    try {
      const response = await processStdioLine(adapter, line);
      if (response !== null) {
        process.stdout.write(response + "\n");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Stdio processing error: ${message}`);
    }
  });

  rl.on("close", () => {
    log("Stdio host: stdin closed.");
  });
}
