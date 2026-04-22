/**
 * Async MCP transport adapter for JSON-RPC 2.0 with prompts support.
 * Pure function factory — no I/O, no imports from transport or tools.
 * Dependency-injected via McpAdapterDependencies.
 */

export interface AvailableTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Record<string, unknown>;
}

export interface AvailablePrompt {
  readonly name: string;
  readonly description: string;
  readonly arguments?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }>;
}

export interface McpAdapterDependencies {
  listAvailableTools: () => AvailableTool[];
  routeToolInvocationWithConfig: (
    toolName: string,
    input: unknown
  ) => Promise<ToolInvocationResult>;
  listAvailablePrompts?: () => AvailablePrompt[];
  getPrompt?: (name: string, args?: Record<string, string>) => Promise<PromptResult | null>;
}

export interface ToolInvocationResult {
  readonly ok: boolean;
  readonly toolName: string;
  readonly result?: unknown;
  readonly error?: string;
}

export interface PromptResult {
  readonly description?: string;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: { readonly type: "text"; readonly text: string };
  }>;
}

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

const SERVER_INFO = {
  name: "graph-connector-agent",
  version: "0.1.0",
};

const SERVER_CAPABILITIES = {
  tools: {},
  prompts: {},
};

function makeErrorResponse(
  id: string | number | null,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function makeSuccessResponse(
  id: string | number | null,
  result: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export interface McpAdapter {
  handleUnknownRequest: (rawRequest: unknown) => Promise<JsonRpcResponse>;
}

export function createMcpTransportAdapter(
  deps: McpAdapterDependencies
): McpAdapter {

  // ─── Human-readable text formatters ─────────────────────────────────────

  function formatToolResult(toolName: string, result: unknown): string {
    if (!result || typeof result !== "object") {
      return JSON.stringify(result, null, 2);
    }
    const r = result as Record<string, unknown>;

    if (toolName === "graph_listOperations") {
      const ops = Array.isArray(r["operations"]) ? r["operations"] as Array<Record<string, unknown>> : [];
      const version = String(r["version"] ?? "v1.0");
      const warnings = Array.isArray(r["warnings"]) && (r["warnings"] as unknown[]).length > 0
        ? `\n⚠️  Warnings:\n${(r["warnings"] as string[]).map(w => `  - ${w}`).join("\n")}`
        : "";

      if (ops.length === 0) {
        return `No operations found for the requested endpoint(s) (Graph API ${version}).${warnings}`;
      }

      // Group by endpoint path prefix for readability
      const lines: string[] = [
        `Found ${ops.length} operation${ops.length !== 1 ? "s" : ""} (Graph API ${version}):`,
        "",
      ];

      ops.forEach((op, idx) => {
        const method = String(op["method"] ?? "").padEnd(6);
        const operationId = String(op["operationId"] ?? "");
        const summary = String(op["summary"] ?? "");
        const scopes = Array.isArray(op["requiredScopes"])
          ? (op["requiredScopes"] as string[]).join(", ")
          : "";
        lines.push(`${idx + 1}. ${method} ${operationId} — ${summary}`);
        if (scopes) {
          lines.push(`   Scopes: ${scopes}`);
        }
      });

      lines.push("");
      lines.push(`Reply with the numbers of the operations to include (e.g. "1,3,5" or "all").`);
      if (warnings) lines.push(warnings);

      // Append cache age as metadata
      if (r["cacheAge"]) {
        lines.push(`\nMetadata cache age: ${r["cacheAge"]}`);
      }

      return lines.join("\n");
    }

    if (toolName === "graph_generateConnector") {
      const files = Array.isArray(r["connectorFiles"])
        ? (r["connectorFiles"] as Array<Record<string, unknown>>)
        : [];
      const opsCount = Number(r["totalOperations"] ?? 0);
      const baseName = r["baseName"] ? String(r["baseName"]) : null;
      const gistUrl = r["gistUrl"] ? String(r["gistUrl"]) : null;
      const gistRawUrls = r["gistRawUrls"] as Record<string, string> | undefined;
      const warnings = Array.isArray(r["validationWarnings"])
        ? r["validationWarnings"] as string[]
        : [];
      const savedPaths = Array.isArray(r["savedPaths"]) ? r["savedPaths"] as string[] : [];

      const lines: string[] = [];
      lines.push(`✅ Connector generated successfully!`);
      if (baseName) lines.push(`Name: ${baseName}`);
      lines.push(`Operations included: ${opsCount}`);
      lines.push(`Files generated: ${files.map(f => String(f["filename"] ?? "")).join(", ")}`);

      if (gistUrl) {
        lines.push(`\nGist URL: ${gistUrl}`);
        if (gistRawUrls) {
          const firstKey = Object.keys(gistRawUrls)[0];
          if (firstKey) {
            lines.push(`Download (Swagger JSON): ${gistRawUrls[firstKey]}`);
          }
        }
      }

      if (savedPaths.length > 0) {
        lines.push(`\nSaved to:`);
        savedPaths.forEach(p => lines.push(`  ${p}`));
      }

      if (warnings.length > 0) {
        lines.push(`\n⚠️  Validation warnings (${warnings.length}):`);
        warnings.slice(0, 5).forEach(w => lines.push(`  - ${w}`));
        if (warnings.length > 5) lines.push(`  ... and ${warnings.length - 5} more.`);
      }

      lines.push(`\nTo deploy this connector to Power Platform, use graph_deployPipeline or connector_deploy with the Gist URL above.`);

      return lines.join("\n");
    }

    if (toolName === "graph_deployPipeline") {
      const status = String(r["status"] ?? "unknown");
      const summary = String(r["summary"] ?? "");
      const connector = r["connector"] as Record<string, unknown> | null;
      const appReg = r["appRegistration"] as Record<string, unknown> | null;
      const errors = Array.isArray(r["errors"]) ? r["errors"] as string[] : [];

      const lines: string[] = [];

      if (status === "success") {
        lines.push("✅ Deploy pipeline completed successfully!");
      } else if (status === "partial") {
        lines.push("⚠️  Deploy pipeline partially completed.");
      } else {
        lines.push("❌ Deploy pipeline failed.");
      }
      lines.push("");

      if (connector) {
        lines.push("**Connector:**");
        lines.push(`  Name: ${String(connector["displayName"] ?? "")}`);
        lines.push(`  ID: ${String(connector["connectorId"] ?? "")}`);
        lines.push(`  Environment: ${String(connector["environmentId"] ?? "")}`);
        lines.push(`  Auth: ${String(connector["authType"] ?? "N/A")}`);
        const shared = connector["sharedWith"];
        if (Array.isArray(shared) && shared.length > 0) {
          lines.push(`  Shared with: ${(shared as string[]).join(", ")}`);
        }
        const scopes = connector["graphApiScopes"];
        if (Array.isArray(scopes) && scopes.length > 0) {
          lines.push(`  Scopes: ${(scopes as string[]).join(", ")}`);
        }
        lines.push("");
      }

      if (appReg) {
        if (appReg["configured"]) {
          lines.push("**App Registration:**");
          lines.push(`  Name: ${String(appReg["displayName"] ?? "")}`);
          lines.push(`  App ID: ${String(appReg["appId"] ?? "")}`);
          lines.push(`  Object ID: ${String(appReg["objectId"] ?? "")}`);
        } else if (appReg["skipped"]) {
          lines.push(`**App Registration:** Skipped — ${String(appReg["skipReason"] ?? "")}`);
        } else {
          lines.push("**App Registration:** Configuration failed.");
        }
        lines.push("");
      }

      if (errors.length > 0) {
        lines.push("**Errors:**");
        errors.forEach(e => lines.push(`  - ${e}`));
        lines.push("");
      }

      lines.push(summary);

      return lines.join("\n");
    }

    // Default: JSON for all other tools
    return JSON.stringify(result, null, 2);
  }

  // ────────────────────────────────────────────────────────────────────────
  async function handleUnknownRequest(
    rawRequest: unknown
  ): Promise<JsonRpcResponse> {
    // Validate JSON-RPC envelope
    if (
      typeof rawRequest !== "object" ||
      rawRequest === null ||
      (rawRequest as Record<string, unknown>)["jsonrpc"] !== "2.0"
    ) {
      return makeErrorResponse(null, -32600, "Invalid JSON-RPC 2.0 request.");
    }

    const req = rawRequest as JsonRpcRequest;
    const id = req.id ?? null;

    switch (req.method) {
      case "initialize": {
        return makeSuccessResponse(id, {
          protocolVersion: "2025-03-26",
          serverInfo: SERVER_INFO,
          capabilities: SERVER_CAPABILITIES,
        });
      }

      /* Notifications (no response expected per JSON-RPC 2.0) */
      case "notifications/initialized":
      case "notifications/cancelled": {
        return makeSuccessResponse(id, {});
      }

      case "tools/list": {
        const tools = deps.listAvailableTools().map((t) => ({
          name: t.name,
          description: t.description,
          ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
        }));
        return makeSuccessResponse(id, { tools });
      }

      case "prompts/list": {
        const prompts = (deps.listAvailablePrompts?.() ?? []).map((p) => ({
          name: p.name,
          description: p.description,
          ...(p.arguments ? { arguments: p.arguments } : {}),
        }));
        return makeSuccessResponse(id, { prompts });
      }

      case "prompts/get": {
        if (!deps.getPrompt) {
          return makeErrorResponse(id, -32601, "Prompts not supported.");
        }
        const pParams = (req.params ?? {}) as Record<string, unknown>;
        const promptName = pParams["name"] as string | undefined;
        if (!promptName) {
          return makeErrorResponse(id, -32602, "Invalid params: 'name' is required.");
        }
        const promptArgs = pParams["arguments"] as Record<string, string> | undefined;
        const promptResult = await deps.getPrompt(promptName, promptArgs);
        if (!promptResult) {
          return makeErrorResponse(id, -32602, `Prompt not found: ${promptName}`);
        }
        return makeSuccessResponse(id, promptResult);
      }

      case "tools/call": {
        if (
          typeof req.params !== "object" ||
          req.params === null
        ) {
          return makeErrorResponse(id, -32602, "Invalid params: expected object with 'name' and 'arguments'.");
        }

        const params = req.params as Record<string, unknown>;
        const toolName = params["name"];
        const toolArgs = params["arguments"] ?? {};

        if (typeof toolName !== "string") {
          return makeErrorResponse(id, -32602, "Invalid params: 'name' must be a string.");
        }

        try {
          const invocationResult = await deps.routeToolInvocationWithConfig(
            toolName,
            toolArgs
          );

          if (invocationResult.ok) {
            const textSummary = formatToolResult(invocationResult.toolName, invocationResult.result);

            return makeSuccessResponse(id, {
              content: [
                {
                  type: "text",
                  text: textSummary,
                },
              ],
            });
          } else {
            return makeSuccessResponse(id, {
              content: [
                {
                  type: "text",
                  text: invocationResult.error ?? "Tool invocation failed.",
                },
              ],
              isError: true,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return makeSuccessResponse(id, {
            content: [{ type: "text", text: message }],
            isError: true,
          });
        }
      }

      default: {
        return makeErrorResponse(id, -32601, `Method not found: ${req.method}`);
      }
    }
  }

  return { handleUnknownRequest };
}
