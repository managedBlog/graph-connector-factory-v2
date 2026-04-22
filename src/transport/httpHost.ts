/**
 * Unified HTTP server for Graph Connector Factory.
 *
 * Single Express instance serving:
 *   POST /mcp          — MCP JSON-RPC 2.0 endpoint (AI chat)
 *   GET  /health       — Health check
 *   REST endpoints     — Connector action endpoints for Copilot Studio topics
 */

import express from "express";
import type { AgentConfig } from "../config/types";
import { runWithRequestContext, validateToken, updateCallerIdentity } from "../auth";
import type { TokenValidationConfig } from "../auth";
import { createMcpTransportAdapter, McpAdapter } from "./mcpAdapter";
import { invokeTool, listAllTools } from "../tools/registry";
import { listPrompts, getPrompt } from "../prompts";
import { log, logError, logDebug } from "../logging/logger";
import { initialisePolicyState } from "../policies";

export interface HttpHostOptions {
  readonly config: AgentConfig;
  readonly port?: number;
}

export function startHttpServer(options: HttpHostOptions): void {
  const { config } = options;
  const port = options.port ?? config.server.port ?? 3001;

  // Initialize policy state
  initialisePolicyState(config.policies);

  // Create MCP adapter with dependency injection
  const adapter: McpAdapter = createMcpTransportAdapter({
    listAvailableTools: listAllTools,
    routeToolInvocationWithConfig: async (toolName: string, input: unknown) => {
      return invokeTool(toolName, input, config);
    },
    listAvailablePrompts: listPrompts,
    getPrompt: async (name: string, args?: Record<string, string>) => getPrompt(name, args),
  });

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // CORS
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Auth middleware
  const authMiddleware = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): Promise<void> => {
    const authHeader = req.headers["authorization"];
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;

    if (config.server.authMode === "authenticated" && config.server.tokenValidation) {
      if (!bearerToken) {
        if (req.path === "/health" && config.server.allowUnauthenticatedHealth) {
          next();
          return;
        }
        res.status(401).json({ error: "Bearer token required." });
        return;
      }

      const tvConfig: TokenValidationConfig = config.server.tokenValidation;
      const result = await validateToken(bearerToken, tvConfig);
      if (!result.valid) {
        res.status(401).json({ error: `Token validation failed: ${result.error}` });
        return;
      }

      // Run in request context with validated identity
      runWithRequestContext({ bearerToken, caller: result.identity }, () => {
        if (result.identity) {
          updateCallerIdentity(result.identity);
        }
        next();
      });
      return;
    }

    // NoAuth mode — still extract token if present (for session keying)
    runWithRequestContext({ bearerToken }, () => {
      next();
    });
  };

  app.use(authMiddleware);

  // ─── Health ────────────────────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "graph-connector-factory",
      version: "1.0.0-alpha.1",
    });
  });

  // ─── MCP JSON-RPC endpoint ─────────────────────────────────────────────

  app.post("/mcp", async (req, res) => {
    try {
      const response = await adapter.handleUnknownRequest(req.body);
      res.json(response);
    } catch (err) {
      logError(`MCP error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal server error." },
      });
    }
  });

  // ─── REST endpoints (for Copilot Studio topic connector actions) ──────

  // TODO: Port REST endpoints from GRS httpHost.ts in Session 2
  // These include:
  //   GET  /api/graph/operations
  //   GET  /api/graph/session/context
  //   GET  /api/graph/session/endpoints
  //   GET  /api/graph/environments
  //   GET  /api/graph/namecheck
  //   POST /api/graph/connector
  //   POST /api/graph/connector/batch
  //   POST /api/graph/deploy
  //   POST /api/graph/deploy/batch
  //   GET  /download/:id/:filename

  // Placeholder for REST endpoints
  app.get("/api/graph/operations", (_req, res) => {
    res.status(501).json({ error: "REST endpoints coming in Session 2." });
  });

  // ─── Start ─────────────────────────────────────────────────────────────

  app.listen(port, () => {
    log(`Graph Connector Factory server listening on port ${port}`);
    log(`  MCP endpoint:  POST http://localhost:${port}/mcp`);
    log(`  Health check:  GET  http://localhost:${port}/health`);
    log(`  Auth mode:     ${config.server.authMode}`);
  });
}
