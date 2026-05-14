/**
 * Unified HTTP server for Graph Connector Factory.
 *
 * Single Express instance serving:
 *   POST /mcp                    — MCP JSON-RPC 2.0 endpoint (AI chat)
 *   DELETE /mcp                  — Session termination
 *   GET  /health                 — Health check
 *   GET  /                       — Discovery / landing page
 *   GET  /api/graph/operations   — List operations with session tracking
 *   GET  /api/graph/session/endpoints — Explored endpoints
 *   GET  /api/graph/session/context   — Design context (complex hydration)
 *   GET  /api/graph/environments — List Power Platform environments
 *   GET  /api/graph/namecheck    — Pre-flight name collision check
 *   POST /api/graph/connector    — Generate connector + gist publish
 *   POST /api/graph/connector/batch — Batch generate
 *   POST /api/graph/deploy       — Deploy with response flattening
 *   POST /api/graph/deploy/batch — Batch deploy
 *   GET  /api/graph/deploy/status — Deploy status (long-poll)
 *   POST /api/graph/test-plan    — Generate CUA test plan
 *   POST /api/testing/multi-plan — Generate multi-connector CUA test plan
 *   GET  /download/:id/:filename — Serve generated files
 *   POST /api/graph/test/batch-echo — Test endpoint
 *   GET  /api/agent/mcp-servers     — List MCP servers for agent composition
 *   GET  /api/agent/context         — Agent factory context + deploy results
 *   POST /api/agent/generate        — Generate Copilot Studio agent (async)
 *   GET  /api/agent/generate/status — Poll agent generation status
 */

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import express from "express";
import type { AgentConfig } from "../config/types";
import { runWithRequestContext, getRequestContext, validateToken, updateCallerIdentity } from "../auth";
import type { TokenValidationConfig } from "../auth";
import { createMcpTransportAdapter, McpAdapter } from "./mcpAdapter";
import { invokeTool, listAllTools, listMcpTools, stripHashSuffix, appendHashSuffix } from "../tools/registry";
import { listPrompts, getPrompt } from "../prompts";
import { log, logError } from "../logging/logger";
import { initialisePolicyState } from "../policies";
import { publishToGist, getGitHubToken } from "../output/gistPublisher";
import { invokeTool as invokeConnectorTool } from "../tools/connector/tools";
import { invokeTool as invokeAppregTool } from "../tools/appreg/tools";
import { executeDeployPipeline } from "../tools/deploy/pipeline";
import type { DeployPipelineInput } from "../tools/deploy/pipeline";
import type { EnrichedOperation } from "../tools/graph/types";
import { listMcpServers as agentListMcpServers, generateAgent } from "../tools/agent";
import type { DeployedConnectorInfo, AgentGenerationInput, KnowledgeSource } from "../tools/agent";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Content-Type mapping for generated connector files. */
function contentTypeForFile(filename: string): string {
  if (filename.endsWith(".yaml") || filename.endsWith(".yml")) return "text/yaml";
  return "application/json";
}

/** Delete a directory and its contents (sync). */
function rmDirSync(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/** Sweep the output root and delete folders older than the TTL. */
function sweepExpiredOutputs(outputRoot: string, ttlMs: number): void {
  if (!fs.existsSync(outputRoot)) return;
  const now = Date.now();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(outputRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".gitkeep") continue;
    const folderPath = path.join(outputRoot, entry.name);
    try {
      const stat = fs.statSync(folderPath);
      if (now - stat.mtimeMs > ttlMs) {
        rmDirSync(folderPath);
        log(`Cleanup: removed expired output ${entry.name}`);
      }
    } catch {
      // skip entries that can't be stat'd
    }
  }
}

/**
 * Generate a human-readable fallback baseName from endpoint paths.
 * Examples:
 *   ["/users"] → "Users Connector"
 *   ["/users", "/groups"] → "Users and Groups Connector"
 */
function generateFallbackBaseName(endpoints: string[]): string | null {
  if (!endpoints.length) return null;
  const segments = endpoints.map((ep) => {
    const parts = ep.replace(/^\/+/, "").split("/").filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    return last
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }).filter(Boolean);
  if (!segments.length) return null;
  const unique = [...new Set(segments)];

  const parents = endpoints.map((ep) => {
    const parts = ep.replace(/^\/+/, "").split("/").filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : null;
  }).filter((p): p is string => p !== null);
  const uniqueParents = [...new Set(parents)];

  let name: string;
  if (unique.length === 1) {
    name = `${unique[0]!} Connector`;
  } else if (unique.length === 2) {
    name = `${unique[0]!} and ${unique[1]!} Connector`;
  } else if (uniqueParents.length === 1 && uniqueParents[0]) {
    const parentName = uniqueParents[0]
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    name = `${parentName} Connector`;
  } else {
    name = `${unique.slice(0, 3).join(", ")} Connector`;
  }
  return name;
}

/** Match operationIds to a connector group's baseName. */
function matchGroupBaseName(
  groups: Array<Record<string, unknown>>,
  operationIds: string[],
): string | null {
  if (groups.length === 0 || operationIds.length === 0) return null;
  const incomingSet = new Set(operationIds);
  for (const group of groups) {
    const ops = Array.isArray(group["operations"])
      ? group["operations"] as Array<Record<string, unknown>>
      : [];
    const groupOpIds = ops.map((op) => String(op["operationId"] ?? "")).filter(Boolean);
    if (groupOpIds.length === 0) continue;
    const overlap = groupOpIds.filter((id) => incomingSet.has(id));
    if (overlap.length > 0) {
      const name = typeof group["baseName"] === "string" ? (group["baseName"] as string).trim() : "";
      if (name) return name;
    }
  }
  return null;
}

/** 403 response for deploy-related endpoints in noauth mode. */
function writeDeployProfileRequired(
  res: express.Response,
): void {
  res.status(403).json({
    error: "Deploy operations require authenticated mode.",
    code: "DEPLOY_AUTH_PROFILE_REQUIRED",
    remediation: [
      "Switch Graph Connector Factory profile to auth.mode=authenticated.",
      "Use research-only endpoints in noauth mode: /api/graph/operations and /api/graph/connector.",
    ],
  });
}

// ─── Deploy job types ─────────────────────────────────────────────────────────

type DeployJobStatus = "accepted" | "running" | "success" | "partial" | "failed";

interface DeployJob {
  readonly id: string;
  readonly jobType: "deploy" | "batchDeploy" | "agent-generate";
  status: DeployJobStatus;
  readonly createdAt: number;
  completedAt?: number | undefined;
  readonly ownerKey: string | undefined;
  result?: Record<string, unknown> | undefined;
  batchProgress?: { total: number; completed: number; succeeded: number; currentBaseName?: string | undefined } | undefined;
  error?: string | undefined;
}

/** Long-poll max wait (ms). Leaves 5s buffer for Copilot Studio's 30s limit. */
const DEPLOY_STATUS_POLL_MAX_MS = 25_000;
/** Interval between checks inside the long-poll loop. */
const DEPLOY_STATUS_POLL_INTERVAL_MS = 1_000;
/** How long completed jobs stay in memory before sweep (ms). */
const DEPLOY_JOB_TTL_MS = 60 * 60 * 1_000;

// ─── Session types ────────────────────────────────────────────────────────────

interface SessionContextEntry {
  endpoints: string[];
  lastActivity: number;
  designContext?: Record<string, unknown>;
  agentContext?: Record<string, unknown>;
  deployResults?: Array<Record<string, unknown>>;
}

type SessionKeySource = "oid" | "sub" | "userObjectId" | "conversation" | "mcpSessionId" | "none";

interface SessionKeyResolution {
  key: string | undefined;
  source: SessionKeySource;
  oidKey: string | undefined;
  subKey: string | undefined;
  userObjectId: string | undefined;
  conversationKey: string | undefined;
  mcpSessionId: string | undefined;
}

interface DecodedTokenClaims {
  oidKey: string | undefined;
  subKey: string | undefined;
  upn: string | undefined;
}

// ─── Options ──────────────────────────────────────────────────────────────────

export interface HttpHostOptions {
  readonly config: AgentConfig;
  readonly port?: number;
  /** Output TTL in minutes (default: 15). */
  readonly outputTtlMinutes?: number;
}

// ─── Server entry point ──────────────────────────────────────────────────────

export function startHttpServer(options: HttpHostOptions): void {
  const { config } = options;
  const port = options.port ?? (parseInt(process.env["GCF_PORT"] ?? "", 10) || (config.server.port ?? 3001));
  const outputRoot = path.resolve(config.output?.dir ?? path.join(process.cwd(), "output"));
  const ttlMinutes = options.outputTtlMinutes ?? config.output?.ttlMinutes ?? 15;
  const ttlMs = ttlMinutes * 60 * 1000;

  // Ensure output root exists
  fs.mkdirSync(outputRoot, { recursive: true });

  // Initialize policy state
  initialisePolicyState(config.policies);

  // Create MCP adapter with dependency injection
  const adapter: McpAdapter = createMcpTransportAdapter({
    listAvailableTools: listMcpTools,
    routeToolInvocationWithConfig: async (toolName: string, input: unknown) => {
      return invokeTool(toolName, input, config);
    },
    listAvailablePrompts: listPrompts,
    getPrompt: async (name: string, args?: Record<string, string>) => getPrompt(name, args),
  });

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // ─── CORS ─────────────────────────────────────────────────────────────

  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Mcp-Session-Id, Authorization, " +
      "x-ms-conversation-id, x-ms-conversationid, x-ms-client-session-id, " +
      "x-conversation-id, conversationid",
    );
    res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ─── Auth middleware ───────────────────────────────────────────────────

  const authMiddleware = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> => {
    const authHeader = req.headers["authorization"];
    const bearerToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
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

  // ─── Deploy job store ─────────────────────────────────────────────────

  const deployJobs = new Map<string, DeployJob>();

  function sweepExpiredJobs(): void {
    const now = Date.now();
    for (const [id, job] of deployJobs) {
      if (job.status === "accepted" || job.status === "running") continue;
      if (job.completedAt && now - job.completedAt > DEPLOY_JOB_TTL_MS) {
        deployJobs.delete(id);
        log(`[DeployJob] Expired job ${id} (completed ${Math.round((now - job.completedAt) / 60_000)}m ago)`);
      }
    }
  }

  function flattenDeployJob(job: DeployJob): Record<string, unknown> {
    const r = job.result ?? {};
    return {
      jobId: job.id,
      jobType: job.jobType,
      status: job.status,
      retryAfter: (job.status === "accepted" || job.status === "running") ? 5 : null,
      createdAt: job.createdAt,
      completedAt: job.completedAt ?? null,
      summary: (r["summary"] as string | undefined) ?? null,
      connectorId: (r["connectorId"] as string | undefined) ?? null,
      connectorDisplayName: (r["connectorDisplayName"] as string | undefined) ?? null,
      connectorEnvironmentId: (r["connectorEnvironmentId"] as string | undefined) ?? null,
      connectorStatus: (r["connectorStatus"] as string | undefined) ?? null,
      connectorAuthType: (r["connectorAuthType"] as string | undefined) ?? null,
      connectorRedirectUri: (r["connectorRedirectUri"] as string | undefined) ?? null,
      appRegistrationConfigured: (r["appRegistrationConfigured"] as boolean | undefined) ?? null,
      appRegistrationAppId: (r["appRegistrationAppId"] as string | undefined) ?? null,
      appRegistrationObjectId: (r["appRegistrationObjectId"] as string | undefined) ?? null,
      appRegistrationDisplayName: (r["appRegistrationDisplayName"] as string | undefined) ?? null,
      appRegistrationSkipped: (r["appRegistrationSkipped"] as boolean | undefined) ?? null,
      appRegistrationSkipReason: (r["appRegistrationSkipReason"] as string | undefined) ?? null,
      errors: (r["errors"] as string[] | undefined) ?? [],
      batchTotal: job.batchProgress?.total ?? null,
      batchCompleted: job.batchProgress?.completed ?? null,
      batchSucceeded: job.batchProgress?.succeeded ?? null,
      batchCurrentBaseName: job.batchProgress?.currentBaseName ?? null,
      batchResultsJson: (r["resultsJson"] as string | undefined) ?? null,
      error: job.error ?? null,
    };
  }

  // ─── Session management ────────────────────────────────────────────────

  const sessions = new Map<string, { id: string; createdAt: number }>();
  const SESSION_TTL_MS = 30 * 60 * 1000;
  const sessionContext = new Map<string, SessionContextEntry>();
  const sessionAliases = new Map<string, string>();

  function normalizeSessionKey(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  function looksLikeUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function extractTokenClaims(authHeader: string | undefined): DecodedTokenClaims | undefined {
    if (!authHeader?.startsWith("Bearer ")) return undefined;
    try {
      const parts = authHeader.slice(7).split(".");
      const payload = parts[1];
      if (!payload) return undefined;
      const decoded = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      const oidRaw = decoded["oid"];
      const subRaw = decoded["sub"];
      const oidKey = typeof oidRaw === "string" && oidRaw.trim().length > 0 ? oidRaw.trim() : undefined;
      const subKey = typeof subRaw === "string" && subRaw.trim().length > 0 ? subRaw.trim() : undefined;
      const upnRaw = decoded["upn"] ?? decoded["preferred_username"];
      const upn = typeof upnRaw === "string" && upnRaw.includes("@") ? upnRaw.trim() : undefined;
      if (!oidKey && !subKey) return undefined;
      return { oidKey, subKey, upn };
    } catch {
      return undefined;
    }
  }

  function extractConversationSessionKey(
    req: { get: (name: string) => string | undefined },
  ): string | undefined {
    const candidates = [
      "x-ms-conversation-id",
      "x-ms-conversationid",
      "x-ms-client-session-id",
      "x-conversation-id",
      "conversationid",
    ];
    for (const header of candidates) {
      const value = req.get(header)?.trim();
      if (value) return `conv:${value}`;
    }
    return undefined;
  }

  function resolveSessionKeyForRequest(
    req: { get: (name: string) => string | undefined },
    opts?: { userObjectId?: unknown; mcpSessionId?: string | undefined },
  ): SessionKeyResolution {
    const tokenClaims = extractTokenClaims(req.get("authorization"));
    const oidKey = tokenClaims?.oidKey;
    const subKey = tokenClaims?.subKey;
    const userObjectId = normalizeSessionKey(opts?.userObjectId);
    const conversationKey = extractConversationSessionKey(req);
    const mcpSessionId = normalizeSessionKey(opts?.mcpSessionId ?? req.get("Mcp-Session-Id"));

    if (oidKey) return { key: oidKey, source: "oid", oidKey, subKey, userObjectId, conversationKey, mcpSessionId };
    if (subKey) return { key: subKey, source: "sub", oidKey, subKey, userObjectId, conversationKey, mcpSessionId };
    if (userObjectId) return { key: userObjectId, source: "userObjectId", oidKey, subKey, userObjectId, conversationKey, mcpSessionId };
    if (conversationKey) return { key: conversationKey, source: "conversation", oidKey, subKey, userObjectId, conversationKey, mcpSessionId };
    if (mcpSessionId) return { key: mcpSessionId, source: "mcpSessionId", oidKey, subKey, userObjectId, conversationKey, mcpSessionId };
    return { key: undefined, source: "none", oidKey, subKey, userObjectId, conversationKey, mcpSessionId };
  }

  function resolveContextKey(sessionKey: string): { key: string; ctx: SessionContextEntry } | undefined {
    const direct = sessionContext.get(sessionKey);
    if (direct) return { key: sessionKey, ctx: direct };
    const alias = sessionAliases.get(sessionKey);
    if (!alias) return undefined;
    const aliased = sessionContext.get(alias);
    if (!aliased) return undefined;
    return { key: alias, ctx: aliased };
  }

  function trackEndpointForSession(sessionId: string, endpoint: string): void {
    const ctx = sessionContext.get(sessionId);
    if (ctx) {
      if (!ctx.endpoints.includes(endpoint)) {
        ctx.endpoints.push(endpoint);
      }
      ctx.lastActivity = Date.now();
    } else {
      sessionContext.set(sessionId, { endpoints: [endpoint], lastActivity: Date.now() });
    }
    const total = sessionContext.get(sessionId)!.endpoints.length;
    log(`[Session ${sessionId.slice(0, 8)}] Tracked endpoint: ${endpoint} (total: ${total})`);
  }

  function registerAliases(
    tracking: SessionKeyResolution,
    canonicalKey: string,
    mcpSessionId?: string,
  ): void {
    if (mcpSessionId && mcpSessionId !== canonicalKey) {
      sessionAliases.set(mcpSessionId, canonicalKey);
    }
    if (tracking.conversationKey && tracking.conversationKey !== canonicalKey) {
      sessionAliases.set(tracking.conversationKey, canonicalKey);
    }
    if (tracking.mcpSessionId && tracking.mcpSessionId !== canonicalKey) {
      sessionAliases.set(tracking.mcpSessionId, canonicalKey);
    }
  }

  function updateDesignContextForSession(sessionId: string, partial: Record<string, unknown>): void {
    const mergeConnectorGroups = (
      existingGroups: Array<Record<string, unknown>>,
      incomingGroups: Array<Record<string, unknown>>,
    ): Array<Record<string, unknown>> => {
      return incomingGroups.map((incoming, index) => {
        const incomingId = typeof incoming["id"] === "string" ? incoming["id"] : null;
        const existing = incomingId
          ? existingGroups.find((g) => g["id"] === incomingId)
          : existingGroups[index];
        if (!existing) return incoming;
        const merged: Record<string, unknown> = { ...existing, ...incoming };
        const incomingEndpoints = incoming["endpoints"];
        if (!Array.isArray(incomingEndpoints) || incomingEndpoints.length === 0) {
          const existingEndpoints = existing["endpoints"];
          if (Array.isArray(existingEndpoints) && existingEndpoints.length > 0) {
            merged["endpoints"] = existingEndpoints;
          }
        }
        // Clear stale operationIds when endpoints change without new operationIds
        const endpointsChanged = Array.isArray(incomingEndpoints) && incomingEndpoints.length > 0;
        const hasIncomingOpIds = "operationIds" in incoming || "operations" in incoming;
        if (endpointsChanged && !hasIncomingOpIds) {
          delete merged["operationIds"];
          // Also clear legacy operations field if it was a string-array (not hydrated objects)
          const existingOps = merged["operations"];
          if (Array.isArray(existingOps) && existingOps.length > 0 && typeof existingOps[0] === "string") {
            delete merged["operations"];
          }
        }
        return merged;
      });
    };

    const ctx = sessionContext.get(sessionId);
    if (ctx) {
      const next = { ...(ctx.designContext ?? {}), ...partial };
      const incomingGroups = partial["connectorGroups"];
      const existingGroups = ctx.designContext?.["connectorGroups"];
      if (Array.isArray(incomingGroups) && Array.isArray(existingGroups)) {
        next["connectorGroups"] = mergeConnectorGroups(
          existingGroups as Array<Record<string, unknown>>,
          incomingGroups as Array<Record<string, unknown>>,
        );
      }
      // Keep environmentId and environmentName as an atomic pair:
      // if environmentId changes without environmentName, clear the stale name.
      if ("environmentId" in partial && !("environmentName" in partial)) {
        delete next["environmentName"];
      }
      ctx.designContext = next;
      ctx.lastActivity = Date.now();
    } else {
      sessionContext.set(sessionId, { endpoints: [], lastActivity: Date.now(), designContext: partial });
    }
    log(`[Session ${sessionId.slice(0, 8)}] Design context updated: ${Object.keys(partial).join(", ")}`);
  }

  function updateAgentContextForSession(sessionId: string, partial: Record<string, unknown>): void {
    const ctx = sessionContext.get(sessionId);
    if (ctx) {
      ctx.agentContext = { ...(ctx.agentContext ?? {}), ...partial };
      ctx.lastActivity = Date.now();
    } else {
      sessionContext.set(sessionId, { endpoints: [], lastActivity: Date.now(), agentContext: partial });
    }
    log(`[Session ${sessionId.slice(0, 8)}] Agent context updated: ${Object.keys(partial).join(", ")}`);
  }

  function appendDeployResult(sessionId: string, result: Record<string, unknown>): void {
    const ctx = sessionContext.get(sessionId);
    if (ctx) {
      if (!ctx.deployResults) ctx.deployResults = [];
      ctx.deployResults.push(result);
      ctx.lastActivity = Date.now();
      log(`[Session ${sessionId.slice(0, 8)}] Deploy result persisted (total: ${ctx.deployResults.length})`);
    }
  }

  function createSession(): { id: string; createdAt: number } {
    const session = { id: randomUUID(), createdAt: Date.now() };
    sessions.set(session.id, session);
    return session;
  }

  function sweepExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        sessions.delete(id);
        sessionContext.delete(id);
        log(`Session expired: ${id}`);
      }
    }
    for (const [id, ctx] of sessionContext) {
      if (now - ctx.lastActivity > SESSION_TTL_MS) {
        sessionContext.delete(id);
        log(`Session context expired (sliding TTL): ${id}`);
      }
    }
    for (const [aliasKey, canonicalKey] of sessionAliases) {
      const aliasIsMcpSession = looksLikeUuid(aliasKey);
      if ((aliasIsMcpSession && !sessions.has(aliasKey)) || !sessionContext.has(canonicalKey)) {
        sessionAliases.delete(aliasKey);
      }
    }
  }

  // ─── Root — discovery / landing page ──────────────────────────────────

  app.get("/", (_req, res) => {
    res.json({
      server: "graph-connector-factory",
      version: "1.0.0-alpha.1",
      transport: "streamable-http",
      endpoints: {
        mcp: "POST /mcp",
        health: "GET /health",
        listOperations: "GET /api/graph/operations?endpoint=/users",
        sessionEndpoints: "GET /api/graph/session/endpoints",
        sessionContext: "GET /api/graph/session/context",
        generateConnector: "POST /api/graph/connector",
        batchGenerate: "POST /api/graph/connector/batch",
        deployPipeline: "POST /api/graph/deploy",
        batchDeploy: "POST /api/graph/deploy/batch",
        environments: "GET /api/graph/environments",
        namecheck: "GET /api/graph/namecheck?names=MyConnector&environmentId=...",
        batchEcho: "POST /api/graph/test/batch-echo",
        download: "GET /download/:id/:filename",
      },
    });
  });

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
      const rpcReq = req.body as Record<string, unknown> | undefined;
      const method = rpcReq?.["method"] as string | undefined;

      // Session handling: initialize creates a new session
      let sessionId: string | undefined;
      if (method === "initialize") {
        const session = createSession();
        sessionId = session.id;
        log(`New MCP session: ${session.id}`);
      } else {
        sessionId = req.get("Mcp-Session-Id") ?? undefined;
        if (sessionId && !sessions.has(sessionId)) {
          res.status(404).json({
            jsonrpc: "2.0",
            id: rpcReq?.["id"] ?? null,
            error: { code: -32600, message: "Session not found. Send an 'initialize' request first." },
          });
          return;
        }
      }

      const response = await adapter.handleUnknownRequest(req.body);

      // Notifications return null — acknowledge with 204 No Content
      if (response === null) {
        res.status(204).end();
        return;
      }

      // Post-processing interceptors for tools/call
      if (
        rpcReq?.["method"] === "tools/call" &&
        typeof response === "object" &&
        response !== null
      ) {
        const rpcRes = response as {
          result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
        };
        const params = rpcReq["params"] as Record<string, unknown> | undefined;
        const toolName = params?.["name"] as string | undefined;

        // ── graph_generateConnector interceptor: write files + publish gist ──
        if (
          toolName === "graph_generateConnector" &&
          rpcRes.result?.content?.[0]?.type === "text" &&
          !rpcRes.result.isError
        ) {
          try {
            const toolResult = JSON.parse(rpcRes.result.content[0].text) as Record<string, unknown>;
            const connectorFiles = toolResult["connectorFiles"] as
              ReadonlyArray<{ filename: string; content: string }> | undefined;

            if (connectorFiles && connectorFiles.length > 0) {
              const generationId = randomUUID();
              const genDir = path.join(outputRoot, generationId);
              fs.mkdirSync(genDir, { recursive: true });

              const protocol = req.get("x-forwarded-proto") ?? req.protocol;
              const host = req.get("x-forwarded-host") ?? req.get("host") ?? `localhost:${port}`;
              const baseUrl = `${protocol}://${host}`;

              const downloadUrls: string[] = [];
              for (const file of connectorFiles) {
                const filePath = path.join(genDir, file.filename);
                fs.writeFileSync(filePath, file.content, "utf-8");
                downloadUrls.push(`${baseUrl}/download/${generationId}/${file.filename}`);
              }

              log(`[MCP] Generated ${connectorFiles.length} file(s) → output/${generationId}/ (TTL: ${ttlMinutes}m)`);

              let gistUrl: string | undefined;
              let gistRawUrls: Record<string, string> | undefined;
              const ghToken = getGitHubToken();
              if (ghToken) {
                const args = params?.["arguments"] as Record<string, unknown> | undefined;
                const connectorName = (args?.["connectorName"] ?? args?.["baseName"] ?? "Graph Connector") as string;
                const version = (args?.["version"] ?? "v1.0") as string;
                const gistResult = await publishToGist(
                  connectorFiles,
                  `${connectorName} — Power Platform custom connector (${version})`,
                  false,
                  ghToken,
                );
                if (gistResult) {
                  gistUrl = gistResult.gistUrl;
                  gistRawUrls = gistResult.rawUrls;
                }
              }

              toolResult["downloadUrls"] = downloadUrls;
              if (gistUrl) toolResult["gistUrl"] = gistUrl;
              if (gistRawUrls) toolResult["gistRawUrls"] = gistRawUrls;

              rpcRes.result.content[0] = {
                type: "text",
                text: JSON.stringify(toolResult, null, 2),
              };
            }
          } catch (parseErr) {
            logError(`[MCP] Failed to augment connector response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
          }
        }

        // ── graph_listOperations interceptor: track endpoints ──
        if (toolName === "graph_listOperations" && !rpcRes.result?.isError) {
          const args = params?.["arguments"] as Record<string, unknown> | undefined;
          const tracking = resolveSessionKeyForRequest(req, {
            userObjectId: args?.["userObjectId"],
            mcpSessionId: sessionId,
          });
          const trackingKey = tracking.key;
          const singleEndpoint = args?.["endpoint"] as string | undefined;
          const multiEndpoints = args?.["endpoints"] as string[] | undefined;
          const allEndpoints = multiEndpoints ?? (singleEndpoint ? [singleEndpoint] : []);
          if (allEndpoints.length > 0 && trackingKey) {
            registerAliases(tracking, trackingKey, sessionId);
            for (const ep of allEndpoints) {
              trackEndpointForSession(trackingKey, ep);
            }
          } else if (allEndpoints.length > 0) {
            log(`[WARN] [Session tracking] graph_listOperations could not resolve stable key; endpoints not tracked`);
          }
        }

        // ── graph_setDesignContext interceptor: persist context ──
        if (toolName === "graph_setDesignContext" && !rpcRes.result?.isError) {
          const args = (params?.["arguments"] as Record<string, unknown>) ?? {};
          const tracking = resolveSessionKeyForRequest(req, {
            userObjectId: args["userObjectId"],
            mcpSessionId: sessionId,
          });
          if (!tracking.key) {
            log(`[WARN] [Session context] graph_setDesignContext succeeded but no stable session key resolved`);
          } else {
            registerAliases(tracking, tracking.key, sessionId);
            updateDesignContextForSession(tracking.key, args);
          }
        }

        // ── agent_setDesignContext interceptor: persist agent factory context ──
        if (toolName === "agent_setDesignContext" && !rpcRes.result?.isError) {
          const args = (params?.["arguments"] as Record<string, unknown>) ?? {};
          const tracking = resolveSessionKeyForRequest(req, {
            mcpSessionId: sessionId,
          });
          if (!tracking.key) {
            log(`[WARN] [Session context] agent_setDesignContext succeeded but no stable session key resolved`);
          } else {
            registerAliases(tracking, tracking.key, sessionId);
            updateAgentContextForSession(tracking.key, args);
          }
        }
      } // end tools/call intercept

      if (sessionId) {
        res.setHeader("Mcp-Session-Id", sessionId);
      }
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

  // ─── DELETE /mcp — Session termination ─────────────────────────────────

  app.delete("/mcp", (req, res) => {
    const sessionId = req.get("Mcp-Session-Id");
    if (!sessionId) {
      res.status(400).json({ error: "Mcp-Session-Id header is required." });
      return;
    }
    if (sessions.delete(sessionId)) {
      sessionContext.delete(sessionId);
      log(`Session terminated: ${sessionId}`);
      res.status(204).end();
    } else {
      res.status(404).json({ error: "Session not found." });
    }
  });

  // ─── REST: List operations ─────────────────────────────────────────────

  app.get("/api/graph/operations", async (req, res) => {
    try {
      const endpointParam = req.query["endpoint"] as string | undefined;
      const version = (req.query["version"] as string | undefined) ?? "v1.0";
      if (!endpointParam) {
        res.status(400).json({ error: "Missing required query parameter: endpoint" });
        return;
      }

      const endpoints = endpointParam.split(",").map((e) => e.trim()).filter(Boolean);

      // Track endpoints in session context
      const userObjectIdParam = req.query["userObjectId"] as string | undefined;
      const tracking = resolveSessionKeyForRequest(req, { userObjectId: userObjectIdParam });
      const restSessionId = tracking.key;
      if (restSessionId) {
        registerAliases(tracking, restSessionId);
        for (const ep of endpoints) {
          trackEndpointForSession(restSessionId, ep);
        }
      } else {
        log(`[WARN] [Session tracking] Skipped endpoint tracking (no stable key). Endpoints=${JSON.stringify(endpoints)}`);
      }

      // Use the unified invokeTool from registry (preserves operations cache)
      const toolInput = endpoints.length === 1
        ? { endpoint: endpoints[0]!, version }
        : { endpoints, version };
      const toolResult = await invokeTool("graph_listOperations", toolInput, config);

      if (!toolResult.ok) {
        res.status(500).json({ error: toolResult.error ?? "graph_listOperations failed" });
        return;
      }

      const resultData = toolResult.result as Record<string, unknown>;
      const allOperations = Array.isArray(resultData["operations"]) ? resultData["operations"] : [];
      const warnings = Array.isArray(resultData["warnings"]) ? resultData["warnings"] : [];

      res.json({
        endpoint: endpointParam,
        version,
        operations: allOperations,
        totalEndpoints: endpoints.length,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── REST: Session endpoints ───────────────────────────────────────────

  app.get("/api/graph/session/endpoints", (req, res) => {
    const userObjectIdParam = req.query["userObjectId"] as string | undefined;
    const tracking = resolveSessionKeyForRequest(req, { userObjectId: userObjectIdParam });
    const sessionId = tracking.key;

    if (sessionId) {
      registerAliases(tracking, sessionId);
      const resolved = resolveContextKey(sessionId);
      const endpoints = resolved?.ctx.endpoints ?? [];
      const latestEndpoint = endpoints.length > 0 ? endpoints[endpoints.length - 1]! : null;
      const endpointPath = endpoints.length > 1 ? endpoints.join(",") : (latestEndpoint ?? null);
      const resolvedKey = resolved?.key ?? sessionId;
      log(`[${tracking.source}:${sessionId.slice(0, 8)}] GET session/endpoints (resolved=${resolvedKey.slice(0, 8)}) → [${endpoints.join(", ")}]`);
      res.json({ endpoints, endpointCount: endpoints.length, latestEndpoint, endpointPath });
      return;
    }

    log(`GET session/endpoints — no session key available`);
    res.json({ endpoints: [], endpointCount: 0, latestEndpoint: null, endpointPath: null });
  });

  // ─── REST: Session context (most complex endpoint) ─────────────────────

  app.get("/api/graph/session/context", async (req, res) => {
    log(`[Session context] GET /api/graph/session/context — userObjectId=${req.query["userObjectId"] ?? "(none)"}`);
    const userObjectIdParam = req.query["userObjectId"] as string | undefined;
    const tracking = resolveSessionKeyForRequest(req, { userObjectId: userObjectIdParam });
    const sessionId = tracking.key;

    let ctx: SessionContextEntry | undefined;

    if (sessionId) {
      registerAliases(tracking, sessionId);
      const resolved = resolveContextKey(sessionId);
      ctx = resolved?.ctx;
      if (!ctx) {
        log(`[Session context] Key "${sessionId.slice(0, 8)}" not found — returning empty context`);
      } else if (resolved?.key && resolved.key !== sessionId) {
        log(`[Session context] Alias resolved "${sessionId.slice(0, 8)}" -> "${resolved.key.slice(0, 8)}"`);
      }
    } else {
      log(`[WARN] [Session context] No session key available — returning empty context`);
    }

    const legacyEndpoints = ctx?.endpoints ?? [];
    const designContext = ctx?.designContext ?? {};
    const hasDesignContext = Object.keys(designContext).length > 0;

    // Prefer endpoints from designContext, fall back to connectorGroups, then legacy tracking
    const topLevelDesignEndpoints = Array.isArray(designContext["endpoints"])
      ? (designContext["endpoints"] as string[])
      : [];
    const groupedDesignEndpoints = Array.isArray(designContext["connectorGroups"])
      ? (designContext["connectorGroups"] as Array<Record<string, unknown>>)
          .flatMap((group) => (Array.isArray(group["endpoints"]) ? group["endpoints"] as string[] : []))
      : [];
    const designEndpoints = topLevelDesignEndpoints.length > 0
      ? topLevelDesignEndpoints
      : [...new Set(groupedDesignEndpoints.filter((ep) => typeof ep === "string" && ep.trim().length > 0))];
    const endpoints = designEndpoints.length > 0 ? designEndpoints : legacyEndpoints;
    const latestEndpoint = endpoints.length > 0 ? endpoints[endpoints.length - 1]! : null;
    const endpointPath = endpoints.length > 1 ? endpoints.join(",") : (latestEndpoint ?? null);

    // baseName: prefer AI-provided, else generate fallback
    const aiBaseName = typeof designContext["baseName"] === "string" && (designContext["baseName"] as string).trim()
      ? designContext["baseName"] as string
      : null;
    let baseName = aiBaseName ?? generateFallbackBaseName(endpoints);
    const baseNameSource: "ai" | "generated" | null = aiBaseName ? "ai" : (baseName ? "generated" : null);

    // Apply naming prefix (dedup if already present)
    const namingPrefix = config.deploy?.namingPrefix?.trim();
    if (namingPrefix && baseName && !baseName.toLowerCase().startsWith(namingPrefix.toLowerCase())) {
      baseName = `${namingPrefix} ${baseName}`;
    }

    // Inject default environmentId from config if not set during research
    const environmentId = (typeof designContext["environmentId"] === "string" && (designContext["environmentId"] as string).trim())
      ? designContext["environmentId"] as string
      : config.powerPlatform.defaultEnvironmentId ?? null;

    // Extract environmentName from design context
    const environmentName = (typeof designContext["environmentName"] === "string" && (designContext["environmentName"] as string).trim())
      ? designContext["environmentName"] as string
      : null;

    // Serialize connectorGroups
    const connectorGroups = Array.isArray(designContext["connectorGroups"])
      ? designContext["connectorGroups"] as Array<Record<string, unknown>>
      : [];

    // Apply naming prefix to each group's baseName
    if (namingPrefix && connectorGroups.length > 0) {
      for (const group of connectorGroups) {
        const gName = typeof group["baseName"] === "string" ? (group["baseName"] as string).trim() : "";
        if (gName && !gName.toLowerCase().startsWith(namingPrefix.toLowerCase())) {
          group["baseName"] = `${namingPrefix} ${gName}`;
        }
      }
    }

    log(`[Session context] connectorGroups length=${connectorGroups.length}`);

    // ── Hydrate connector groups with enriched operations ──
    const targetVersion = (typeof designContext["targetVersion"] === "string" && (designContext["targetVersion"] as string).trim())
      ? designContext["targetVersion"] as string
      : "v1.0";

    if (connectorGroups.length > 0) {
      const allGroupEndpoints = [...new Set(
        connectorGroups.flatMap((g) => Array.isArray(g["endpoints"]) ? g["endpoints"] as string[] : []),
      )];
      const hydrationEndpoints = allGroupEndpoints.length > 0 ? allGroupEndpoints : designEndpoints;

      if (hydrationEndpoints.length > 0) {
        try {
          const batchResult = await invokeTool(
            "graph_listOperations",
            { endpoints: hydrationEndpoints, version: targetVersion },
            config,
          );
          const batchData = (batchResult.ok ? batchResult.result : {}) as Record<string, unknown>;
          const allOps = Array.isArray(batchData["operations"])
            ? batchData["operations"] as Array<Record<string, unknown>>
            : [];

          // Build lookup: path → EnrichedOperation[]
          const opsByPath = new Map<string, EnrichedOperation[]>();
          for (const op of allOps) {
            const opPath = typeof op["path"] === "string" ? op["path"] : "";
            if (!opPath) continue;
            const enriched: EnrichedOperation = {
              operationId: String(op["operationId"] ?? ""),
              summary: String(op["summary"] ?? ""),
              description: String(op["description"] ?? ""),
              method: String(op["method"] ?? ""),
              path: opPath,
              scope: Array.isArray(op["requiredScopes"]) && (op["requiredScopes"] as string[]).length > 0
                ? String((op["requiredScopes"] as string[])[0])
                : "",
              params: Array.isArray(op["parameters"])
                ? (op["parameters"] as Array<Record<string, unknown>>)
                    .filter((p) => p["in"] === "query")
                    .map((p) => String(p["name"] ?? ""))
                    .join(", ")
                : "",
              returns: typeof op["responseSummary"] === "string" ? op["responseSummary"] as string : "",
            };
            const existing = opsByPath.get(opPath);
            if (existing) existing.push(enriched);
            else opsByPath.set(opPath, [enriched]);
          }

          // Attach operations to each connector group
          for (const group of connectorGroups) {
            const groupEndpoints = Array.isArray(group["endpoints"]) && (group["endpoints"] as string[]).length > 0
              ? group["endpoints"] as string[]
              : designEndpoints;
            const groupOpsRaw: EnrichedOperation[] = [];
            for (const ep of groupEndpoints) {
              for (const [opPath, ops] of opsByPath) {
                if (opPath === ep || opPath.startsWith(ep + "/") || opPath.startsWith(ep + "/{")) {
                  groupOpsRaw.push(...ops);
                }
              }
            }
            // Deduplicate by operationId
            const seenOps = new Set<string>();
            const groupOps = groupOpsRaw.filter((op) => {
              if (seenOps.has(op.operationId)) return false;
              seenOps.add(op.operationId);
              return true;
            });

            // Resolve operationIds: prefer operationIds, then legacy operations (string array only)
            const rawOpIds = group["operationIds"];
            const rawLegacyOps = group["operations"];
            const resolvedIds: string[] | undefined =
              Array.isArray(rawOpIds) ? (rawOpIds as unknown[]).filter((v): v is string => typeof v === "string") :
              (Array.isArray(rawLegacyOps) && rawLegacyOps.length > 0 && typeof rawLegacyOps[0] === "string")
                ? (rawLegacyOps as unknown[]).filter((v): v is string => typeof v === "string")
                : undefined;

            if (resolvedIds !== undefined) {
              // Filter by explicit operationIds (even if empty = no operations)
              const idSet = new Set(resolvedIds);
              group["operations"] = groupOps.filter((op) => idSet.has(op.operationId));
              // Log mismatches
              const matchedIds = new Set((group["operations"] as EnrichedOperation[]).map((op) => op.operationId));
              const missingIds = resolvedIds.filter((id) => !matchedIds.has(id));
              if (missingIds.length > 0) {
                log(`[Session context] WARN: operationIds not found in hydrated ops for group "${group["baseName"] ?? "?"}: ${missingIds.join(", ")}`);
              }
            } else {
              // Fallback: filter by operationPattern (existing behavior)
              const pattern = typeof group["operationPattern"] === "string"
                ? (group["operationPattern"] as string).toLowerCase()
                : "";
              if (pattern.includes("read")) {
                group["operations"] = groupOps.filter((op) => op.method.toUpperCase() === "GET");
              } else if (pattern === "actions") {
                group["operations"] = groupOps.filter((op) => op.method.toUpperCase() === "POST");
              } else if (pattern === "crud") {
                group["operations"] = groupOps.filter((op) => {
                  for (const ep of groupEndpoints) {
                    if (op.path === ep) return true;
                    if (op.path.startsWith(ep + "/")) {
                      const remainder = op.path.slice(ep.length + 1);
                      if (!remainder.includes("/")) return true;
                    }
                  }
                  return false;
                });
              } else {
                group["operations"] = groupOps;
              }
            }
          }
          log(`[Session context] Hydrated ${allOps.length} operations across ${connectorGroups.length} groups`);
        } catch (hydrateErr) {
          logError(`[Session context] Operation hydration failed: ${hydrateErr instanceof Error ? hydrateErr.message : String(hydrateErr)}`);
        }
      }
    }

    // Split connector groups into per-group JSON strings (max 3)
    const stripGroup = (g: Record<string, unknown>) => ({
      baseName: g["baseName"] ?? "",
      operations: Array.isArray(g["operations"])
        ? (g["operations"] as Array<Record<string, unknown>>).map((op) => ({
            operationId: op["operationId"],
            method: op["method"],
            summary: op["summary"],
            description: op["description"] ?? "",
            path: op["path"] ?? "",
            scope: op["scope"] ?? "",
            params: op["params"] ?? "",
            returns: op["returns"] ?? "",
          }))
        : [],
    });
    const group1Json = connectorGroups.length >= 1 ? JSON.stringify(stripGroup(connectorGroups[0]!)) : "";
    const group2Json = connectorGroups.length >= 2 ? JSON.stringify(stripGroup(connectorGroups[1]!)) : "";
    const group3Json = connectorGroups.length >= 3 ? JSON.stringify(stripGroup(connectorGroups[2]!)) : "";

    const connectorCount = typeof designContext["connectorCount"] === "number"
      ? designContext["connectorCount"] as number
      : 0;

    const authType = typeof designContext["authType"] === "string" ? designContext["authType"] as string : null;
    const appRegistrationStrategy = typeof designContext["appRegistrationStrategy"] === "string"
      ? designContext["appRegistrationStrategy"] as string : null;
    const notes = typeof designContext["notes"] === "string" ? designContext["notes"] as string : null;

    const responsePayload = {
      endpoints,
      endpointCount: endpoints.length,
      latestEndpoint,
      endpointPath,
      hasDesignContext,
      baseName,
      baseNameSource,
      environmentId,
      environmentName,
      authType,
      connectorCount,
      appRegistrationStrategy,
      targetVersion,
      notes,
      connectorGroupsJson: "",
      group1Json,
      group2Json,
      group3Json,
      maxOperations: config.graphResearch.maxOperationsPerConnector ?? 256,
    };
    log(`[Session context] Response: hasDesignContext=${responsePayload.hasDesignContext}, connectorCount=${responsePayload.connectorCount}, g1Len=${group1Json.length}`);
    res.json(responsePayload);
  });

  // ─── REST: List environments (direct function call) ────────────────────

  app.get("/api/graph/environments", async (_req, res) => {
    try {
      if (config.server.authMode === "noauth") {
        writeDeployProfileRequired(res);
        return;
      }

      const result = await invokeConnectorTool("connector_listEnvironments", {}, config);
      if (!result.ok) {
        const errMsg = result.error ?? "connector_listEnvironments failed";
        const credentialIssue = /(clientsecret|client_secret|key vault|managed identity|execution\.?method|apponly)/i.test(errMsg);
        const errorCode = credentialIssue ? "CDA_CREDENTIAL_PREREQUISITE" : "ENVIRONMENT_LIST_FAILED";
        logError(`[Environments REST] ${errorCode}: ${errMsg}`);
        res.status(credentialIssue ? 424 : 500).json({
          error: credentialIssue
            ? "Environment listing failed: appOnly credential prerequisites are not configured."
            : "Environment listing failed.",
          code: errorCode,
          details: errMsg,
        });
        return;
      }

      res.json(result.result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`[Environments REST] Transport failure: ${message}`);
      res.status(500).json({
        error: "Environment listing failed.",
        code: "ENVIRONMENT_LIST_ERROR",
        details: message,
      });
    }
  });

  // ─── REST: Name check (direct function calls) ─────────────────────────

  app.get("/api/graph/namecheck", async (req, res) => {
    try {
      if (config.server.authMode === "noauth") {
        writeDeployProfileRequired(res);
        return;
      }

      const environmentId = (req.query["environmentId"] as string | undefined)?.trim() || undefined;
      const namesParam = req.query["names"] as string | undefined;
      if (!namesParam) {
        res.status(400).json({ error: "The 'names' query parameter is required." });
        return;
      }
      const names = namesParam.split(",").map((n: string) => n.trim()).filter(Boolean);
      if (names.length === 0) {
        res.json({ results: [] });
        return;
      }
      if (!environmentId) {
        res.status(400).json({ error: "The 'environmentId' query parameter is required." });
        return;
      }

      // ── Connector name check via direct CDA call ──
      let existingConnectors: Array<Record<string, unknown>> = [];
      try {
        const listResult = await invokeConnectorTool("connector_list", { environmentId }, config);
        if (listResult.ok && listResult.result) {
          const parsed = listResult.result as Record<string, unknown>;
          existingConnectors = (parsed["connectors"] ?? []) as Array<Record<string, unknown>>;
        }
      } catch (err) {
        logError(`[Namecheck] connector_list failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }

      // ── App registration name check via direct ARA call ──
      const appRegMatches = new Map<string, string>();
      for (const name of names) {
        const appRegName = `${stripHashSuffix(name)} - Connector`;
        try {
          const araResult = await invokeAppregTool("appreg_get", { displayName: appRegName }, config);
          if (araResult.ok && araResult.result) {
            const araData = araResult.result as Record<string, unknown>;
            const count = (araData["count"] as number) ?? 0;
            if (count > 0) {
              appRegMatches.set(name, appRegName);
            }
          }
        } catch {
          // Non-fatal: skip app reg check for this name
        }
      }

      // ── Build results with cross-collision check ──
      const usedNames = new Set<string>();
      const results = names.map((name) => {
        const baseForCheck = stripHashSuffix(name).toLowerCase();

        const wouldProduceNames = new Set<string>();
        wouldProduceNames.add(baseForCheck);
        wouldProduceNames.add(`${baseForCheck} - connector`);
        for (const sfx of ["read", "write", "crud", "actions", "management"]) {
          wouldProduceNames.add(`${baseForCheck} - ${sfx} connector`);
          wouldProduceNames.add(`${baseForCheck} - ${sfx}`);
        }

        const connectorMatch = existingConnectors.find((c) => {
          const dn = ((c["displayName"] as string | undefined) ?? "").toLowerCase();
          if (wouldProduceNames.has(dn)) return true;
          if (dn.startsWith(baseForCheck + "_")) return true;
          return false;
        });
        const connectorConflict = !!connectorMatch;
        const crossCollision = usedNames.has(baseForCheck);
        usedNames.add(baseForCheck);

        const appRegConflict = appRegMatches.has(name);
        const needsSuggestion = connectorConflict || crossCollision;
        const suggestedName = needsSuggestion ? appendHashSuffix(name) : undefined;

        return {
          name,
          connectorConflict,
          connectorMatch: connectorConflict ? (connectorMatch?.["displayName"] as string ?? null) : null,
          crossCollision,
          appRegConflict,
          appRegMatch: appRegConflict ? (appRegMatches.get(name) ?? null) : null,
          suggestedName: suggestedName ?? null,
          suggestedAppRegName: suggestedName ? `${suggestedName} - Connector` : null,
        };
      });

      const conflictCount = results.filter((r) => r.connectorConflict || r.crossCollision).length;
      res.json({
        resultsJson: JSON.stringify(results),
        hasConflicts: conflictCount > 0,
        conflictCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`[Namecheck] Failed: ${message}`);
      res.status(500).json({ error: message, results: [] });
    }
  });

  // ─── REST: Generate connector ──────────────────────────────────────────

  app.post("/api/graph/connector", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      log(
        `[Generate REST] Incoming: baseName="${String(body["baseName"] ?? "(none)")}", ` +
        `operationIdsType=${Array.isArray(body["operationIds"]) ? "array" : typeof body["operationIds"]}`,
      );

      // Normalise operationIds: accept comma-separated string
      if (typeof body["operationIds"] === "string") {
        body["operationIds"] = (body["operationIds"] as string)
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
      }

      if (!body["baseName"]) {
        log(`[Generate REST] [WARN] No baseName in request body — connector will use default name`);
      }

      const result = await invokeTool("graph_generateConnector", body, config);
      if (!result.ok) {
        res.status(500).json({ error: result.error ?? "graph_generateConnector failed" });
        return;
      }

      const resultData = result.result as Record<string, unknown>;
      const connectorFiles = resultData["connectorFiles"] as
        ReadonlyArray<{ filename: string; content: string }> | undefined;

      const downloadUrls: string[] = [];
      if (connectorFiles && connectorFiles.length > 0) {
        const generationId = randomUUID();
        const genDir = path.join(outputRoot, generationId);
        fs.mkdirSync(genDir, { recursive: true });

        const protocol = req.get("x-forwarded-proto") ?? req.protocol;
        const host = req.get("x-forwarded-host") ?? req.get("host") ?? `localhost:${port}`;
        const baseUrl = `${protocol}://${host}`;

        for (const file of connectorFiles) {
          const filePath = path.join(genDir, file.filename);
          fs.writeFileSync(filePath, file.content, "utf-8");
          downloadUrls.push(`${baseUrl}/download/${generationId}/${file.filename}`);
        }
        log(`Generated ${connectorFiles.length} file(s) → output/${generationId}/ (TTL: ${ttlMinutes}m)`);
      }

      // Publish to GitHub Gist
      let gistUrl: string | undefined;
      let gistRawUrls: Record<string, string> | undefined;
      const ghToken = getGitHubToken();
      if (ghToken && connectorFiles && connectorFiles.length > 0) {
        const connectorName = (body["connectorName"] ?? body["baseName"] ?? "Generated Connector") as string;
        const version = (body["version"] ?? "v1.0") as string;
        const gistResult = await publishToGist(
          connectorFiles,
          `${connectorName} — Power Platform custom connector (${version})`,
          false,
          ghToken,
        );
        if (gistResult) {
          gistUrl = gistResult.gistUrl;
          gistRawUrls = gistResult.rawUrls;
        }
      }

      let swaggerRawUrl: string | undefined;
      if (gistRawUrls) {
        const rawUrlValues = Object.values(gistRawUrls);
        if (rawUrlValues.length > 0) swaggerRawUrl = rawUrlValues[0];
      }

      res.json({ ...resultData, downloadUrls, gistUrl, gistRawUrls, swaggerRawUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── REST: Batch generate ──────────────────────────────────────────────

  app.post("/api/graph/connector/batch", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const groupsJson = body["groupsJson"] as string | undefined;
      const version = (body["version"] as string) ?? "v1.0";

      log(`[BatchGenerate] groupsJson type=${typeof groupsJson}, version=${version}`);

      if (!groupsJson || typeof groupsJson !== "string") {
        res.status(400).json({ error: "groupsJson is required and must be a JSON string." });
        return;
      }

      let groups: Array<{ baseName: string; ops: string }>;
      try {
        groups = JSON.parse(groupsJson) as Array<{ baseName: string; ops: string }>;
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        res.status(400).json({ error: `Failed to parse groupsJson: ${msg}` });
        return;
      }

      if (!Array.isArray(groups) || groups.length === 0) {
        res.status(400).json({ error: "groupsJson must be a non-empty array of {baseName, ops} objects." });
        return;
      }

      log(`[BatchGenerate] Parsed ${groups.length} group(s)`);

      const results: Array<{
        baseName: string;
        gistUrl: string;
        swaggerRawUrl: string;
        totalOperations: number;
        status: string;
        warnings: string[];
        error?: string;
      }> = [];

      for (const group of groups) {
        const groupBaseName = group.baseName?.trim();
        const operationIds = group.ops
          ? group.ops.split(",").map((s: string) => s.trim()).filter(Boolean)
          : [];

        if (!groupBaseName) {
          results.push({
            baseName: "(unnamed)", gistUrl: "", swaggerRawUrl: "",
            totalOperations: 0, status: "error", warnings: [],
            error: "baseName is required for each group",
          });
          continue;
        }

        if (operationIds.length === 0) {
          results.push({
            baseName: groupBaseName, gistUrl: "", swaggerRawUrl: "",
            totalOperations: 0, status: "error", warnings: [],
            error: "ops (comma-separated operation IDs) is required",
          });
          continue;
        }

        log(`[BatchGenerate] Generating group "${groupBaseName}": ${operationIds.length} ops`);

        try {
          const genResult = await invokeTool(
            "graph_generateConnector",
            { baseName: groupBaseName, operationIds, version },
            config,
          );

          if (!genResult.ok) {
            results.push({
              baseName: groupBaseName, gistUrl: "", swaggerRawUrl: "",
              totalOperations: 0, status: "error", warnings: [],
              error: genResult.error ?? "generation failed",
            });
            continue;
          }

          const genData = genResult.result as Record<string, unknown>;
          const connectorFiles = genData["connectorFiles"] as
            ReadonlyArray<{ filename: string; content: string }> | undefined;

          let gistUrl = "";
          let swaggerRawUrl = "";
          const ghToken = getGitHubToken();
          if (ghToken && connectorFiles && connectorFiles.length > 0) {
            const gistResult = await publishToGist(
              connectorFiles,
              `${groupBaseName} — Power Platform custom connector (${version})`,
              false,
              ghToken,
            );
            if (gistResult) {
              gistUrl = gistResult.gistUrl;
              const rawUrlValues = Object.values(gistResult.rawUrls) as string[];
              if (rawUrlValues.length > 0) swaggerRawUrl = String(rawUrlValues[0] ?? "");
            }
          }

          results.push({
            baseName: groupBaseName,
            gistUrl,
            swaggerRawUrl,
            totalOperations: (genData["totalOperations"] as number) ?? 0,
            status: "success",
            warnings: (genData["validationWarnings"] as string[]) ?? [],
          });
          log(`[BatchGenerate] Group "${groupBaseName}" succeeded: ${genData["totalOperations"]} ops`);
        } catch (groupErr) {
          const msg = groupErr instanceof Error ? groupErr.message : String(groupErr);
          log(`[BatchGenerate] Group "${groupBaseName}" FAILED: ${msg}`);
          results.push({
            baseName: groupBaseName, gistUrl: "", swaggerRawUrl: "",
            totalOperations: 0, status: "error", warnings: [],
            error: msg,
          });
        }
      }

      const successCount = results.filter((r) => r.status === "success").length;
      log(`[BatchGenerate] Complete: ${successCount}/${results.length} succeeded`);

      // Sync session context baseNames with actual names used during generation
      if (successCount > 0) {
        try {
          const tracking = resolveSessionKeyForRequest(req, {});
          if (tracking.key) {
            const resolved = resolveContextKey(tracking.key);
            if (resolved) {
              const dc = resolved.ctx.designContext;
              const cGroups = dc && Array.isArray(dc["connectorGroups"])
                ? dc["connectorGroups"] as Array<Record<string, unknown>>
                : [];
              if (cGroups.length > 0 && cGroups.length === groups.length) {
                for (let i = 0; i < groups.length; i++) {
                  const newName = groups[i]!.baseName?.trim();
                  if (newName) cGroups[i]!["baseName"] = newName;
                }
                log(`[BatchGenerate] Updated session context baseNames: ${cGroups.map((g) => g["baseName"]).join(", ")}`);
              }
            }
          }
        } catch (syncErr) {
          log(`[BatchGenerate] [WARN] Failed to sync session baseNames: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`);
        }
      }

      res.json({
        groupCount: results.length,
        successCount,
        resultsJson: JSON.stringify(results),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── REST: Deploy pipeline ─────────────────────────────────────────────

  app.post("/api/graph/deploy", async (req, res) => {
    try {
      if (config.server.authMode === "noauth") {
        writeDeployProfileRequired(res);
        return;
      }

      const body = req.body as Record<string, unknown>;
      log(
        `[Deploy REST] Incoming: baseName="${String(body["baseName"] ?? "(none)")}", ` +
        `environmentId="${String(body["environmentId"] ?? "(none)")}", authType=${String(body["authType"] ?? "(none)")}`,
      );

      // Map REST property name (apiDefinition → swagger)
      if (body["apiDefinition"] && !body["swagger"]) {
        body["swagger"] = body["apiDefinition"];
        delete body["apiDefinition"];
      }

      if (!body["baseName"]) {
        log(`[Deploy REST] [WARN] baseName not provided — deploy will use swagger title or fail`);
      }

      const pipelineInput: DeployPipelineInput = {
        swaggerUrl: body["swaggerUrl"] as string | undefined,
        swagger: body["swagger"] as string | Record<string, unknown> | undefined,
        baseName: body["baseName"] as string | undefined,
        environmentId: body["environmentId"] as string | undefined,
        authType: body["authType"] as string | undefined,
        oauthClientId: body["oauthClientId"] as string | undefined,
        oauthResourceUri: body["oauthResourceUri"] as string | undefined,
        oauthTenantId: body["oauthTenantId"] as string | undefined,
        skipAppRegistration: body["skipAppRegistration"] as boolean | undefined,
        confirmed: body["confirmed"] as boolean | undefined,
        shareWithEmails: body["shareWithEmails"] as string[] | undefined,
      };

      // Capture request context for background execution
      const reqCtx = getRequestContext();
      const capturedCtx = {
        bearerToken: reqCtx?.bearerToken,
        caller: reqCtx?.caller ? { ...reqCtx.caller } : undefined,
      };

      // Derive owner key from session header or token claims
      const sessionKey = normalizeSessionKey(
        req.headers["x-session-id"] ?? req.headers["x-ms-conversation-id"],
      );
      const claims = extractTokenClaims(req.headers["authorization"] as string | undefined);
      const ownerKey = sessionKey ?? claims?.oidKey ?? claims?.subKey ?? undefined;

      const jobId = randomUUID();
      const job: DeployJob = {
        id: jobId,
        jobType: "deploy",
        status: "accepted",
        createdAt: Date.now(),
        ownerKey,
      };
      deployJobs.set(jobId, job);

      log(`[Deploy REST] Created job ${jobId} (owner=${ownerKey ?? "anonymous"})`);

      // Fire-and-forget: run pipeline in background with captured auth context
      void (async () => {
        try {
          job.status = "running";
          const result = await runWithRequestContext(capturedCtx, () =>
            executeDeployPipeline(pipelineInput, config),
          ) as Awaited<ReturnType<typeof executeDeployPipeline>>;

          const connector = result.connector;
          const appReg = result.appRegistration;
          job.result = {
            status: result.status,
            summary: result.summary,
            connectorId: connector?.connectorId ?? null,
            connectorDisplayName: connector?.displayName ?? null,
            connectorEnvironmentId: connector?.environmentId ?? null,
            connectorStatus: connector?.status ?? null,
            connectorAuthType: connector?.authType ?? null,
            connectorRedirectUri: connector?.redirectUri ?? null,
            appRegistrationConfigured: appReg?.configured ?? false,
            appRegistrationAppId: appReg?.appId ?? null,
            appRegistrationObjectId: appReg?.objectId ?? null,
            appRegistrationDisplayName: appReg?.displayName ?? null,
            appRegistrationSkipped: appReg?.skipped ?? false,
            appRegistrationSkipReason: appReg?.skipReason ?? null,
            errors: result.errors,
          };
          job.status = result.status === "success" ? "success" : result.errors?.length ? "partial" : "success";
          job.completedAt = Date.now();
          log(`[Deploy REST] Job ${jobId} completed: status=${job.status}`);

          // Persist deploy result to session context for agent factory
          if (connector?.connectorId && ownerKey) {
            const designCtx = sessionContext.get(ownerKey)?.designContext;
            const connectorGroups = designCtx?.["connectorGroups"] as Array<Record<string, unknown>> | undefined;
            const matchingGroup = connectorGroups?.find((g) =>
              g["baseName"] === pipelineInput.baseName || g["name"] === pipelineInput.baseName,
            );
            const groupOps = matchingGroup?.["operations"] as Array<Record<string, unknown>> | undefined;
            const operations = groupOps?.map((op) => ({
              operationId: String(op["operationId"] ?? ""),
              summary: String(op["summary"] ?? op["operationId"] ?? ""),
              method: String(op["method"] ?? "GET").toUpperCase(),
              path: String(op["path"] ?? ""),
            })).filter((o) => o.operationId) ?? [];
            appendDeployResult(ownerKey, {
              timestamp: Date.now(),
              connectorId: connector.connectorId,
              apiName: connector.connectorId.split("/").pop() ?? "",
              displayName: connector.displayName,
              baseName: pipelineInput.baseName ?? "",
              environmentId: connector.environmentId,
              authType: connector.authType ?? "Unknown",
              appRegistrationAppId: appReg?.appId ?? undefined,
              operationIds: (matchingGroup?.["operationIds"] as string[]) ?? [],
              operations,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          job.status = "failed";
          job.error = message;
          job.completedAt = Date.now();
          log(`[Deploy REST] Job ${jobId} FAILED: ${message}`);
        }
      })();

      res.status(202).json(flattenDeployJob(job));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── REST: Batch deploy ────────────────────────────────────────────────

  app.post("/api/graph/deploy/batch", async (req, res) => {
    try {
      if (config.server.authMode === "noauth") {
        writeDeployProfileRequired(res);
        return;
      }

      const body = req.body as Record<string, unknown>;
      const groupsJson = body["groupsJson"] as string | undefined;
      const environmentId = (body["environmentId"] as string) ?? "";
      const authType = (body["authType"] as string) ?? "NoAuth";

      log(`[BatchDeploy] groupsJson type=${typeof groupsJson}, environmentId=${environmentId}, authType=${authType}`);

      if (!groupsJson || typeof groupsJson !== "string") {
        res.status(400).json({ error: "groupsJson is required and must be a JSON string." });
        return;
      }

      let groups: Array<{ baseName: string; swaggerUrl: string }>;
      try {
        groups = JSON.parse(groupsJson) as Array<{ baseName: string; swaggerUrl: string }>;
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        res.status(400).json({ error: `Failed to parse groupsJson: ${msg}` });
        return;
      }

      if (!Array.isArray(groups) || groups.length === 0) {
        res.status(400).json({ error: "groupsJson must be a non-empty array of {baseName, swaggerUrl} objects." });
        return;
      }

      log(`[BatchDeploy] Parsed ${groups.length} group(s)`);

      // Capture request context for background execution
      const reqCtx = getRequestContext();
      const capturedCtx = {
        bearerToken: reqCtx?.bearerToken,
        caller: reqCtx?.caller ? { ...reqCtx.caller } : undefined,
      };

      const sessionKey = normalizeSessionKey(
        req.headers["x-session-id"] ?? req.headers["x-ms-conversation-id"],
      );
      const claims = extractTokenClaims(req.headers["authorization"] as string | undefined);
      const ownerKey = sessionKey ?? claims?.oidKey ?? claims?.subKey ?? undefined;

      const jobId = randomUUID();
      const job: DeployJob = {
        id: jobId,
        jobType: "batchDeploy",
        status: "accepted",
        createdAt: Date.now(),
        ownerKey,
        batchProgress: { total: groups.length, completed: 0, succeeded: 0 },
      };
      deployJobs.set(jobId, job);

      log(`[BatchDeploy] Created job ${jobId} for ${groups.length} group(s) (owner=${ownerKey ?? "anonymous"})`);

      // Fire-and-forget: run batch pipeline in background
      void (async () => {
        try {
          job.status = "running";
          const results: Array<{
            baseName: string; status: string;
            connectorId: string; connectorDisplayName: string;
            appRegistrationAppId: string; error?: string;
          }> = [];

          for (const group of groups) {
            const groupBaseName = group.baseName?.trim();
            const swaggerUrl = group.swaggerUrl?.trim();

            if (!groupBaseName) {
              results.push({
                baseName: "(unnamed)", status: "error",
                connectorId: "", connectorDisplayName: "", appRegistrationAppId: "",
                error: "baseName is required for each group",
              });
              job.batchProgress!.completed++;
              continue;
            }

            if (!swaggerUrl) {
              results.push({
                baseName: groupBaseName, status: "error",
                connectorId: "", connectorDisplayName: "", appRegistrationAppId: "",
                error: "swaggerUrl is required for each group",
              });
              job.batchProgress!.completed++;
              continue;
            }

            job.batchProgress!.currentBaseName = groupBaseName;
            log(`[BatchDeploy] Job ${jobId}: deploying "${groupBaseName}"`);

            try {
              const deployInput: DeployPipelineInput = {
                baseName: groupBaseName,
                swaggerUrl,
                environmentId,
                authType,
              };

              const result = await runWithRequestContext(capturedCtx, () =>
                executeDeployPipeline(deployInput, config),
              ) as Awaited<ReturnType<typeof executeDeployPipeline>>;

              const connector = result.connector;
              const appReg = result.appRegistration;
              results.push({
                baseName: groupBaseName,
                status: result.status,
                connectorId: String(connector?.connectorId ?? ""),
                connectorDisplayName: String(connector?.displayName ?? ""),
                appRegistrationAppId: String(appReg?.appId ?? ""),
              });
              job.batchProgress!.succeeded++;
              log(`[BatchDeploy] Job ${jobId}: "${groupBaseName}" succeeded`);
            } catch (groupErr) {
              const msg = groupErr instanceof Error ? groupErr.message : String(groupErr);
              log(`[BatchDeploy] Job ${jobId}: "${groupBaseName}" FAILED: ${msg}`);
              results.push({
                baseName: groupBaseName, status: "error",
                connectorId: "", connectorDisplayName: "", appRegistrationAppId: "",
                error: msg,
              });
            }
            job.batchProgress!.completed++;
          }

          const successCount = results.filter((r) => r.status !== "error").length;
          job.result = {
            groupCount: results.length,
            successCount,
            resultsJson: JSON.stringify(results),
            summary: `Batch deploy: ${successCount}/${results.length} succeeded`,
          };
          job.status = successCount === results.length ? "success" : successCount > 0 ? "partial" : "failed";
          job.completedAt = Date.now();
          delete job.batchProgress!.currentBaseName;
          log(`[BatchDeploy] Job ${jobId} complete: ${successCount}/${results.length} succeeded`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          job.status = "failed";
          job.error = message;
          job.completedAt = Date.now();
          log(`[BatchDeploy] Job ${jobId} FAILED: ${message}`);
        }
      })();

      res.status(202).json(flattenDeployJob(job));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── REST: Generate CUA test plan ───────────────────────────────────────

  app.post("/api/graph/test-plan", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      log(`[TestPlan REST] connectorId="${String(body["connectorId"] ?? "")}", displayName="${String(body["displayName"] ?? "")}"`);

      if (!body["connectorId"] || !body["environmentId"] || !body["displayName"]) {
        res.status(400).json({ error: "connectorId, environmentId, and displayName are required." });
        return;
      }

      const result = await invokeTool(
        "graph_generateTestPlan",
        {
          connectorId: body["connectorId"],
          environmentId: body["environmentId"],
          displayName: body["displayName"],
          deployStatus: body["deployStatus"] ?? "success",
          authType: body["authType"] ?? "OAuthAAD",
          baseName: body["baseName"],
          swagger: body["swagger"],
          includeWriteOps: body["includeWriteOps"],
          portalHost: body["portalHost"],
        },
        config,
      );

      if (!result.ok) {
        res.status(400).json({ error: result.error ?? "Test plan generation failed" });
        return;
      }

      res.json(result.result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── REST: Multi-connector test plan ───────────────────────────────────

  app.post("/api/testing/multi-plan", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      log(`[MultiPlan REST] connectors=${JSON.stringify((body["connectors"] as unknown[])?.map((c: any) => c?.displayName) ?? [])}`);

      if (!body["environmentId"] || !body["connectors"]) {
        res.status(400).json({ error: "environmentId and connectors are required." });
        return;
      }

      const result = await invokeTool(
        "testing_generateMultiPlan",
        {
          environmentId: body["environmentId"],
          connectors: body["connectors"],
          variables: body["variables"],
        },
        config,
      );

      if (!result.ok) {
        res.status(400).json({ error: result.error ?? "Multi-plan generation failed" });
        return;
      }

      res.json(result.result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── REST: Generate test plan (Copilot Studio friendly) ────────────────

  app.post("/api/testing/generate-plan", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      log(`[TestPlanCS REST] scopeMode="${String(body["scopeMode"] ?? "")}", connectorsJson length=${String(body["connectorsJson"] ?? "").length}`);

      const environmentId = (body["environmentId"] as string)?.trim();
      let environmentName = (body["environmentName"] as string)?.trim() || "";
      const connectorsJson = (body["connectorsJson"] as string)?.trim();

      if (!environmentId || !connectorsJson) {
        res.status(400).json({ error: "environmentId and connectorsJson are required." });
        return;
      }

      // Resolve environment name: first from current session's design context,
      // then from environments API as a last resort.
      if (!environmentName) {
        // Check current session's design context — cheapest path, no cross-session leakage
        const tracking = resolveSessionKeyForRequest(req, {});
        if (tracking.key) {
          const resolved = resolveContextKey(tracking.key);
          const dc = resolved?.ctx?.designContext;
          if (dc && typeof dc["environmentName"] === "string" && (dc["environmentName"] as string).trim()) {
            environmentName = (dc["environmentName"] as string).trim();
            log(`[TestPlanCS REST] Resolved environmentName="${environmentName}" from session designContext`);
          }
        }
      }

      // Fallback: resolve from environments API if still blank
      if (!environmentName && config.server.authMode !== "noauth") {
        try {
          const envLookup = invokeConnectorTool("connector_listEnvironments", {}, config);
          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("env lookup timeout")), 8_000)
          );
          const envResult = await Promise.race([envLookup, timeout]);
          if (envResult.ok && envResult.result) {
            const envList = (envResult.result as Record<string, unknown>)["environments"] as Array<Record<string, string>> | undefined;
            const match = envList?.find((e) => e.id === environmentId);
            if (match?.displayName) {
              environmentName = match.displayName;
              log(`[TestPlanCS REST] Resolved environmentName="${environmentName}" from environmentId`);
            } else {
              log(`[TestPlanCS REST] No environment match for id="${environmentId}"`);
            }
          } else {
            log(`[TestPlanCS REST] Environment lookup failed: ${envResult.ok ? "empty result" : envResult.error ?? "unknown"}`);
          }
        } catch (envErr) {
          const msg = envErr instanceof Error ? envErr.message : String(envErr);
          log(`[TestPlanCS REST] Environment name resolution skipped: ${msg}`);
        }
      }

      // Parse the JSON-string envelope
      let connectors: Array<Record<string, unknown>>;
      try {
        connectors = JSON.parse(connectorsJson) as Array<Record<string, unknown>>;
      } catch {
        res.status(400).json({ error: "connectorsJson is not valid JSON." });
        return;
      }

      if (!Array.isArray(connectors) || connectors.length === 0) {
        res.status(400).json({ error: "connectorsJson must be a non-empty array." });
        return;
      }

      const variables = body["variables"] ? JSON.parse(body["variables"] as string) as Record<string, string> : {};

      // Extract tenant domain from caller's UPN — prefer custom domain over .onmicrosoft.com
      if (!variables["tenantDomain"]) {
        const claims = extractTokenClaims(req.headers["authorization"] as string | undefined);
        if (claims?.upn) {
          const domain = claims.upn.split("@")[1];
          if (domain) {
            variables["tenantDomain"] = domain;
            log(`[TestPlanCS REST] Resolved tenantDomain="${domain}" from caller UPN`);
          }
        }
      }

      const result = await invokeTool(
        "testing_generateMultiPlan",
        { environmentId, environmentName, connectors, variables },
        config,
      );

      if (!result.ok) {
        res.status(400).json({ error: result.error ?? "Test plan generation failed" });
        return;
      }

      const plan = result.result as Record<string, unknown>;
      const summary = plan["summary"] as Record<string, unknown> | undefined;
      res.json({
        totalConnectors: summary?.["totalConnectors"] ?? 0,
        totalOperations: summary?.["totalOperations"] ?? 0,
        testPlanMarkdown: plan["markdown"] ?? "",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── REST: Deploy status (long-poll) ──────────────────────────────────

  app.get("/api/graph/deploy/status", async (req, res) => {
    try {
      const jobId = (req.query["jobId"] as string | undefined)?.trim();

      if (!jobId) {
        res.status(400).json({ error: "jobId query parameter is required." });
        return;
      }

      const job = deployJobs.get(jobId);

      if (!job) {
        // Return 200 with error status — topic-friendlier than 404
        res.json({
          jobId,
          jobType: null,
          status: "expired",
          retryAfter: null,
          error: "Job not found or expired.",
        });
        return;
      }

      // Owner check: if job has an owner, validate caller matches
      if (job.ownerKey) {
        const sessionKey = normalizeSessionKey(
          req.headers["x-session-id"] ?? req.headers["x-ms-conversation-id"],
        );
        const claims = extractTokenClaims(req.headers["authorization"] as string | undefined);
        const callerKey = sessionKey ?? claims?.oidKey ?? claims?.subKey ?? undefined;

        if (callerKey !== job.ownerKey) {
          res.json({
            jobId,
            jobType: job.jobType,
            status: "unauthorized",
            retryAfter: null,
            error: "You are not the owner of this job.",
          });
          return;
        }
      }

      // If already terminal, return immediately
      if (job.status !== "accepted" && job.status !== "running") {
        res.json(flattenDeployJob(job));
        return;
      }

      // Long-poll: check every DEPLOY_STATUS_POLL_INTERVAL_MS, max DEPLOY_STATUS_POLL_MAX_MS
      const deadline = Date.now() + DEPLOY_STATUS_POLL_MAX_MS;
      while (Date.now() < deadline) {
        if (job.status !== "accepted" && job.status !== "running") {
          res.json(flattenDeployJob(job));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, DEPLOY_STATUS_POLL_INTERVAL_MS));
      }

      // Still running after long-poll timeout — return current state with retryAfter
      res.json(flattenDeployJob(job));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Download a generated file ─────────────────────────────────────────

  app.get("/download/:id/:filename", (req, res) => {
    const { id, filename } = req.params;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? "")) {
      res.status(400).json({ error: "Invalid generation ID." });
      return;
    }

    if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      res.status(400).json({ error: "Invalid filename." });
      return;
    }

    const filePath = path.join(outputRoot, id!, filename);

    if (!fs.existsSync(filePath)) {
      res.status(404).json({
        error: "File not found. It may have expired.",
        hint: `Generated files are automatically deleted after ${ttlMinutes} minutes.`,
      });
      return;
    }

    res.setHeader("Content-Type", contentTypeForFile(filename));
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    fs.createReadStream(filePath).pipe(res);
  });

  // ─── Test endpoint: Batch parameter echo ───────────────────────────────

  app.post("/api/graph/test/batch-echo", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const groupsJson = body["groupsJson"] as string | undefined;

    log(
      `[BatchEcho] Received: groupsJson type=${typeof groupsJson}, ` +
      `length=${groupsJson?.length ?? 0}`,
    );

    const g1BaseName = body["g1BaseName"] as string | undefined;
    const g1Ops = body["g1Ops"] as string | undefined;
    const g2BaseName = body["g2BaseName"] as string | undefined;
    const g2Ops = body["g2Ops"] as string | undefined;
    const g3BaseName = body["g3BaseName"] as string | undefined;
    const g3Ops = body["g3Ops"] as string | undefined;

    let parsedGroups: Array<{ baseName: string; ops: string }> = [];
    let parseError: string | null = null;
    let encodingUsed = "none";

    if (groupsJson && typeof groupsJson === "string" && groupsJson.trim().startsWith("[")) {
      try {
        parsedGroups = JSON.parse(groupsJson) as Array<{ baseName: string; ops: string }>;
        encodingUsed = "groupsJson";
        log(`[BatchEcho] JSON.parse succeeded: ${parsedGroups.length} group(s)`);
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err);
        log(`[BatchEcho] JSON.parse FAILED: ${parseError}`);
      }
    }

    if (parsedGroups.length === 0 && !parseError && g1BaseName) {
      encodingUsed = "individual";
      if (g1BaseName) parsedGroups.push({ baseName: g1BaseName, ops: g1Ops ?? "" });
      if (g2BaseName) parsedGroups.push({ baseName: g2BaseName, ops: g2Ops ?? "" });
      if (g3BaseName) parsedGroups.push({ baseName: g3BaseName, ops: g3Ops ?? "" });
      log(`[BatchEcho] Fallback params: ${parsedGroups.length} group(s)`);
    }

    const sampleResults = parsedGroups.map((g, i) => ({
      baseName: g.baseName,
      gistUrl: `https://gist.github.com/example/${i + 1}`,
      totalOperations: g.ops ? g.ops.split(",").filter(Boolean).length : 0,
      status: "success",
      warnings: [] as string[],
    }));

    res.json({
      encodingUsed,
      parseError,
      groupCount: parsedGroups.length,
      parsedGroups,
      resultsJson: JSON.stringify(sampleResults),
    });
  });

  // ─── Agent Factory: MCP Servers ────────────────────────────────────────

  app.get("/api/agent/mcp-servers", (req, res) => {
    try {
      const category = req.query["category"] as string | undefined;
      const stableOnly = req.query["stableOnly"] === "true";
      const filter: { category?: string; stableOnly?: boolean } = {};
      if (category != null) filter.category = category;
      if (stableOnly) filter.stableOnly = stableOnly;
      const servers = agentListMcpServers(filter);
      res.json({ servers, count: servers.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Agent Factory: Get Agent Context ──────────────────────────────────

  app.get("/api/agent/context", (req, res) => {
    try {
      const tracking = resolveSessionKeyForRequest(req, {});
      if (!tracking.key) {
        res.json({ agentContext: null, deployedConnectors: [], designContext: null });
        return;
      }
      const resolved = resolveContextKey(tracking.key);
      const ctx = resolved?.ctx;
      const dc = ctx?.designContext as Record<string, unknown> | undefined;
      const ac = ctx?.agentContext as Record<string, unknown> | undefined;
      const deployed = ctx?.deployResults ?? [];

      // Build deployed connector summaries for the card
      const connectorSummaries = (deployed as Array<Record<string, unknown>>).map((d) => ({
        displayName: d["displayName"] ?? "",
        apiName: d["apiName"] ?? "",
        operationCount: Array.isArray(d["operationIds"]) ? (d["operationIds"] as string[]).length : 0,
      }));

      res.json({
        agentName: ac?.["agentName"] ?? dc?.["agentName"] ?? "",
        agentPurpose: ac?.["agentPurpose"] ?? dc?.["agentPurpose"] ?? "",
        deployedConnectorCount: String(deployed.length),
        hasDeployedConnectors: deployed.length > 0 ? "true" : "false",
        deployedConnectorsJson: JSON.stringify(deployed),
        connectorSummariesJson: JSON.stringify(connectorSummaries),
        // Research-phase recommendations from agent context
        recommendedMcpServers: Array.isArray(ac?.["selectedMcpServers"])
          ? (ac["selectedMcpServers"] as string[]).join(",")
          : "",
        recommendedKnowledgeSourcesJson: Array.isArray(ac?.["knowledgeSources"])
          ? JSON.stringify(ac["knowledgeSources"])
          : "[]",
        includeCua: ac?.["includeCua"] === true ? "true" : "false",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Agent Factory: Generate Agent (async job) ─────────────────────────

  const agentJobs = new Map<string, DeployJob>();

  // Input normalization helpers — CS topic sends strings, endpoint expects typed values
  function normalizeMcpServerIds(raw: unknown): string[] | undefined {
    if (!raw) return undefined;
    if (Array.isArray(raw)) return raw.filter((s) => typeof s === "string" && s.trim());
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed || trimmed === "none" || trimmed === "[]") return undefined;
      return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return undefined;
  }

  function normalizeKnowledgeSources(raw: unknown): KnowledgeSource[] | undefined {
    if (!raw) return undefined;
    // Already an array of objects
    if (Array.isArray(raw)) return raw.length > 0 ? raw : undefined;
    // JSON string from topic
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed || trimmed === "none" || trimmed === "[]") return undefined;
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
      } catch {
        log(`[Agent Generate] Could not parse knowledgeSources JSON: ${trimmed.slice(0, 200)}`);
        return undefined;
      }
    }
    return undefined;
  }

  function normalizeBool(raw: unknown): boolean | undefined {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") {
      const lower = raw.trim().toLowerCase();
      if (lower === "true" || lower === "yes" || lower === "1") return true;
      if (lower === "false" || lower === "no" || lower === "0") return false;
    }
    return undefined;
  }

  app.post("/api/agent/generate", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const agentName = body["agentName"] as string;
      const agentPurpose = body["agentPurpose"] as string;

      if (!agentName || !agentPurpose) {
        res.status(400).json({ error: "agentName and agentPurpose are required." });
        return;
      }

      // Resolve session context for deploy results
      const tracking = resolveSessionKeyForRequest(req, {});
      const ownerKey = tracking.key;
      const ctx = ownerKey ? resolveContextKey(ownerKey)?.ctx : undefined;
      const deployedConnectors = (ctx?.deployResults ?? []) as unknown as DeployedConnectorInfo[];

      if (deployedConnectors.length === 0) {
        res.status(400).json({ error: "No deployed connectors found. Deploy connectors first." });
        return;
      }

      const environmentId = body["environmentId"] as string ??
        (ctx?.designContext?.["environmentId"] as string) ?? "";
      const solutionName = body["solutionName"] as string ?? "GCFApps";

      if (!environmentId) {
        res.status(400).json({ error: "environmentId is required." });
        return;
      }

      const jobId = randomUUID();
      const job: DeployJob = {
        id: jobId,
        jobType: "agent-generate",
        status: "accepted",
        createdAt: Date.now(),
        ownerKey,
      };
      agentJobs.set(jobId, job);

      log(`[Agent Generate] Created job ${jobId}`);

      const generationInput: AgentGenerationInput = {
        agentName,
        agentPurpose,
        mcpServerIds: normalizeMcpServerIds(body["mcpServerIds"]),
        knowledgeSources: normalizeKnowledgeSources(body["knowledgeSources"] ?? body["knowledgeSourcesJson"]),
        includeCua: normalizeBool(body["includeCua"]),
        instructionsOverride: body["instructionsOverride"] as string | undefined,
        environmentId,
        solutionName,
      };

      // Fire-and-forget
      void (async () => {
        try {
          job.status = "running";
          const result = await generateAgent(generationInput, deployedConnectors);
          job.result = result as unknown as Record<string, unknown>;
          job.status = result.success ? "success" : "failed";
          if (!result.success) job.error = result.error;
          job.completedAt = Date.now();
          log(`[Agent Generate] Job ${jobId} completed: ${job.status}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          job.status = "failed";
          job.error = message;
          job.completedAt = Date.now();
          log(`[Agent Generate] Job ${jobId} FAILED: ${message}`);
        }
      })();

      res.status(202).json({
        jobId,
        status: "accepted",
        retryAfter: 10,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Agent Factory: Poll Generation Status ─────────────────────────────

  app.get("/api/agent/generate/status", async (req, res) => {
    try {
      const jobId = (req.query["jobId"] as string | undefined)?.trim();
      if (!jobId) {
        res.status(400).json({ error: "jobId query parameter is required." });
        return;
      }

      const job = agentJobs.get(jobId);
      if (!job) {
        res.json({ jobId, status: "expired", error: "Job not found or expired." });
        return;
      }

      // If terminal, return immediately
      if (job.status !== "accepted" && job.status !== "running") {
        res.json({
          jobId: job.id,
          status: job.status,
          result: job.result ?? null,
          error: job.error ?? null,
        });
        return;
      }

      // Long-poll
      const deadline = Date.now() + DEPLOY_STATUS_POLL_MAX_MS;
      while (Date.now() < deadline) {
        if (job.status !== "accepted" && job.status !== "running") {
          res.json({
            jobId: job.id,
            status: job.status,
            result: job.result ?? null,
            error: job.error ?? null,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, DEPLOY_STATUS_POLL_INTERVAL_MS));
      }

      res.json({ jobId: job.id, status: job.status, retryAfter: 10 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Cleanup sweep ────────────────────────────────────────────────────

  const cleanupInterval = setInterval(() => {
    sweepExpiredOutputs(outputRoot, ttlMs);
    sweepExpiredSessions();
    sweepExpiredJobs();
  }, 5 * 60 * 1000);

  // ─── Start ─────────────────────────────────────────────────────────────

  const server = app.listen(port, () => {
    log(`Graph Connector Factory server listening on port ${port}`);
    log(`  MCP endpoint:      POST   http://localhost:${port}/mcp`);
    log(`  Session delete:    DELETE http://localhost:${port}/mcp`);
    log(`  Health check:      GET    http://localhost:${port}/health`);
    log(`  REST operations:   GET    http://localhost:${port}/api/graph/operations?endpoint=/users`);
    log(`  Session endpoints: GET    http://localhost:${port}/api/graph/session/endpoints`);
    log(`  Session context:   GET    http://localhost:${port}/api/graph/session/context`);
    log(`  Environments:      GET    http://localhost:${port}/api/graph/environments`);
    log(`  Name check:        GET    http://localhost:${port}/api/graph/namecheck?names=...&environmentId=...`);
    log(`  Generate:          POST   http://localhost:${port}/api/graph/connector`);
    log(`  Deploy:            POST   http://localhost:${port}/api/graph/deploy`);
    log(`  Deploy status:     GET    http://localhost:${port}/api/graph/deploy/status`);
    log(`  File downloads:    GET    http://localhost:${port}/download/:id/:filename`);
    log(`  Output directory:  ${outputRoot}`);
    log(`  Output TTL:        ${ttlMinutes} minutes`);
    log(`  Auth mode:         ${config.server.authMode}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log(`ERROR: Port ${port} is already in use. Kill the existing process or set GCF_PORT to use a different port.`);
    } else {
      log(`ERROR: Server failed to start: ${err.message}`);
    }
    process.exit(1);
  });

  // Graceful shutdown
  const shutdown = (signal: string) => {
    log(`${signal} received — shutting down gracefully...`);
    clearInterval(cleanupInterval);
    server.close(() => {
      log("Server closed.");
      process.exit(0);
    });
    // Force exit after 5s if connections don't drain
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Global safety nets
  process.on("uncaughtException", (err) => {
    log(`FATAL uncaughtException: ${err.message}\n${err.stack ?? ""}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log(`WARN unhandledRejection: ${reason}`);
  });

  // Suppress unused variable warning for cleanupInterval
  void cleanupInterval;
}
