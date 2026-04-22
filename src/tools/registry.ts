/**
 * Unified tool registry for Graph Connector Factory.
 *
 * Routes tool invocations to the correct handler based on tool prefix:
 *   graph_*      → Graph research tools (CSDL, swagger generation)
 *   connector_*  → Connector deploy tools (Power Platform CRUD)
 *   appreg_*     → App registration tools (Entra ID CRUD)
 *
 * This replaces the previous multi-server A2A architecture with direct
 * function calls — eliminating MCP protocol overhead entirely.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { AvailableTool, ToolInvocationResult } from "../transport/mcpAdapter";
import type { AgentConfig } from "../config/types";
import { getRequestContext } from "../auth/requestContext";
import { log, logError } from "../logging/logger";
import { publishToGist, getGitHubToken } from "../output/gistPublisher";

// Graph research imports
import type {
  GraphListOperationsToolInput,
  GraphListOperationsToolOutput,
  GraphGenerateConnectorToolInput,
  GraphGenerateConnectorToolOutput,
  GraphDeployPipelineToolInput,
  GraphSetDesignContextToolInput,
  GraphSetDesignContextToolOutput,
  GraphOperationInfo,
} from "./graph/types";
import { getOperationsForEndpoint, MetadataProviderConfig } from "./graph/graphMetadata";
import { generateConnector, GenerateConnectorOptions } from "./graph/connectorGenerator";

// ─── Hash naming utilities ─────────────────────────────────────────────────

const HASH_SUFFIX_RE = /_[0-9a-f]{4}$/;

export function generateNameSuffix(): string {
  return crypto.randomBytes(2).toString("hex");
}

export function hasHashSuffix(name: string): boolean {
  return HASH_SUFFIX_RE.test(name);
}

export function stripHashSuffix(name: string): string {
  return name.replace(HASH_SUFFIX_RE, "");
}

export function appendHashSuffix(name: string): string {
  const base = stripHashSuffix(name);
  return `${base}_${generateNameSuffix()}`;
}

// ─── Module-level state (per-session in future — TODO: move to AsyncLocalStorage) ──

let lastOperationsCache: Map<string, GraphOperationInfo> = new Map();
const generatedSwaggerCache = new Map<string, { swagger: string; gistRawUrl?: string }>();

// ─── Tool definitions ──────────────────────────────────────────────────────

/**
 * Returns all available tools for MCP tools/list and REST introspection.
 * Combines graph research, connector deploy, and app registration tools.
 */
export function listAllTools(): AvailableTool[] {
  return [
    ...graphToolDefinitions,
    // CDA and ARA tools are exposed via their own invokeTool dispatchers.
    // We expose their schemas here for MCP discovery.
  ];
}

const graphToolDefinitions: AvailableTool[] = [
  {
    name: "graph_listOperations",
    description: "List available HTTP operations for Microsoft Graph API endpoint paths.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "Single Graph API endpoint path." },
        endpoints: { type: "array", items: { type: "string" }, description: "Batch endpoint paths." },
        version: { type: "string", enum: ["v1.0", "beta"] },
        forceRefresh: { type: "boolean" },
      },
    },
  },
  {
    name: "graph_generateConnector",
    description: "Generate a Power Platform Swagger 2.0 connector from selected Graph API operations.",
    inputSchema: {
      type: "object",
      properties: {
        operationIds: { type: "array", items: { type: "string" } },
        baseName: { type: "string" },
        connectorName: { type: "string" },
        connectorDescription: { type: "string" },
        version: { type: "string", enum: ["v1.0", "beta"] },
        format: { type: "string", enum: ["swagger-json", "swagger-yaml", "openapi-json", "all"] },
        outputDir: { type: "string" },
        authConfig: {
          type: "object",
          properties: {
            tenantId: { type: "string" },
            clientId: { type: "string" },
            scopes: { type: "array", items: { type: "string" } },
          },
        },
        iconUri: { type: "string" },
      },
      required: ["operationIds"],
    },
  },
  {
    name: "graph_deployPipeline",
    description: "Deploy a connector to Power Platform and configure its app registration.",
    inputSchema: {
      type: "object",
      properties: {
        swagger: { type: "string" },
        swaggerUrl: { type: "string" },
        baseName: { type: "string" },
        environmentId: { type: "string" },
        authType: { type: "string" },
        skipAppRegistration: { type: "boolean" },
        shareWithEmails: { type: "array", items: { type: "string" } },
        oauthTenantId: { type: "string" },
        oauthClientId: { type: "string" },
        oauthResourceUri: { type: "string" },
      },
    },
  },
  {
    name: "graph_setDesignContext",
    description: "Persist design decisions for the current session's build phase.",
    inputSchema: {
      type: "object",
      properties: {
        endpoints: { type: "array", items: { type: "string" } },
        authType: { type: "string", enum: ["NoAuth", "OAuthAAD", "FederatedIdentity"] },
        connectorCount: { type: "number" },
        connectorGroups: { type: "array", items: { type: "object", properties: { endpoints: { type: "array", items: { type: "string" } } }, required: ["endpoints"] } },
        appRegistrationStrategy: { type: "string", enum: ["single", "separate"] },
        environmentId: { type: "string" },
        baseName: { type: "string" },
        targetVersion: { type: "string", enum: ["v1.0", "beta"] },
        notes: { type: "string" },
      },
    },
  },
  {
    name: "graph_completeAppRegistration",
    description: "Retry app registration for a previously deployed connector.",
    inputSchema: {
      type: "object",
      properties: {
        connectorId: { type: "string" },
        baseName: { type: "string" },
        federatedIdentitySubject: { type: "string" },
        federatedIdentityIssuer: { type: "string" },
        federatedIdentityAudience: { type: "string" },
        redirectUri: { type: "string" },
        clientId: { type: "string" },
        graphApiScopes: { type: "array", items: { type: "string" } },
      },
      required: ["connectorId"],
    },
  },
];

// ─── Unified dispatcher ────────────────────────────────────────────────────

/**
 * Invoke any tool by name. Routes to the correct handler.
 * This is the single entry point for both MCP and REST tool invocations.
 */
export async function invokeTool(
  toolName: string,
  input: unknown,
  config: AgentConfig
): Promise<ToolInvocationResult> {
  try {
    // Route by prefix
    if (toolName.startsWith("graph_")) {
      return await invokeGraphTool(toolName, input, config);
    }

    // For connector_* and appreg_* tools, we'll delegate to their
    // respective invokeTool functions once we wire up config adapters.
    // For now, return a clear "not yet wired" message.
    if (toolName.startsWith("connector_") || toolName.startsWith("appreg_")) {
      return {
        ok: false,
        toolName,
        error: `Tool ${toolName} routing not yet wired. This will use direct function calls in the unified server.`,
      };
    }

    return { ok: false, toolName, error: `Unknown tool: ${toolName}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Tool invocation error [${toolName}]: ${message}`);
    return { ok: false, toolName, error: message };
  }
}

// ─── Graph tool dispatch ───────────────────────────────────────────────────

async function invokeGraphTool(
  toolName: string,
  input: unknown,
  config: AgentConfig
): Promise<ToolInvocationResult> {
  switch (toolName) {
    case "graph_listOperations": {
      const typedInput = input as GraphListOperationsToolInput;
      const version = typedInput.version ?? config.graphResearch.defaultVersion;

      const endpointPaths: string[] = [];
      if (typedInput.endpoints && typedInput.endpoints.length > 0) {
        endpointPaths.push(...typedInput.endpoints);
      } else if (typedInput.endpoint) {
        endpointPaths.push(typedInput.endpoint);
      } else {
        return { ok: false, toolName, error: "Either 'endpoint' or 'endpoints' is required." };
      }

      const metaConfig: MetadataProviderConfig = {
        version,
        cachePath: "./cache",
        csdlCacheTtlHours: config.graphResearch.csdlCacheTtlHours,
        hidiCliPath: null,
        forceRefresh: typedInput.forceRefresh ?? false,
      };

      const allOperations: GraphOperationInfo[] = [];
      const allWarnings: string[] = [];
      let latestCacheAge = "";

      for (const ep of endpointPaths) {
        const result = await getOperationsForEndpoint(ep, metaConfig);
        allOperations.push(...result.operations);
        allWarnings.push(...result.warnings);
        latestCacheAge = result.cacheAge;
      }

      lastOperationsCache = new Map();
      for (const op of allOperations) {
        lastOperationsCache.set(op.operationId, op);
      }

      const output: GraphListOperationsToolOutput = {
        ...(endpointPaths.length === 1
          ? { endpoint: endpointPaths[0]! }
          : { endpoints: endpointPaths }),
        version,
        operations: allOperations,
        cacheAge: latestCacheAge,
        warnings: allWarnings,
      };

      return { ok: true, toolName, result: output };
    }

    case "graph_generateConnector": {
      const typedInput = input as GraphGenerateConnectorToolInput;
      const version = typedInput.version ?? config.graphResearch.defaultVersion;

      log(
        `[Generate] baseName="${typedInput.baseName ?? "(none)"}", ` +
        `operationIds=${typedInput.operationIds.length}, version=${version}`,
      );

      const selectedOps: GraphOperationInfo[] = [];
      const missingIds: string[] = [];

      for (const id of typedInput.operationIds) {
        const cached = lastOperationsCache.get(id);
        if (cached) {
          selectedOps.push(cached);
        } else {
          missingIds.push(id);
        }
      }

      if (selectedOps.length === 0) {
        return {
          ok: false,
          toolName,
          error: `No matching operations found. ${missingIds.length > 0 ? `Missing: ${missingIds.join(", ")}. Run graph_listOperations first.` : ""}`,
        };
      }

      if (missingIds.length > 0) {
        logError(`Some operation IDs not found in cache: ${missingIds.join(", ")}`);
      }

      const authConfig = typedInput.authConfig ?? {
        tenantId: "common",
        clientId: "",
        scopes: ["https://graph.microsoft.com/.default"],
      };

      const MAX_DISPLAY_NAME_LENGTH = 40;
      let resolvedConnectorName: string;
      const baseName = typedInput.baseName;
      if (baseName) {
        resolvedConnectorName = baseName.length > MAX_DISPLAY_NAME_LENGTH
          ? baseName.slice(0, MAX_DISPLAY_NAME_LENGTH)
          : baseName;
      } else if (typedInput.connectorName) {
        resolvedConnectorName = typedInput.connectorName;
      } else {
        resolvedConnectorName = "Custom Connector";
      }

      const genOptions: GenerateConnectorOptions = {
        version,
        operations: selectedOps,
        connectorName: resolvedConnectorName,
        connectorDescription: typedInput.connectorDescription ?? `Custom connector for Microsoft Graph API (${version}).`,
        authConfig,
        maxOperationsPerConnector: config.graphResearch.maxOperationsPerConnector,
        autoFlatten: config.graphResearch.autoFlatten,
        format: typedInput.format ?? "swagger-json",
      };

      const result = generateConnector(genOptions);

      const savedPaths: string[] = [];
      if (typedInput.outputDir) {
        const outDir = path.resolve(typedInput.outputDir);
        fs.mkdirSync(outDir, { recursive: true });
        for (const file of result.connectorFiles) {
          const filePath = path.join(outDir, file.filename);
          fs.writeFileSync(filePath, file.content, "utf-8");
          savedPaths.push(filePath);
        }
      }

      let gistUrl: string | undefined;
      let gistRawUrls: Record<string, string> | undefined;
      const ghToken = getGitHubToken();
      if (ghToken) {
        const gistResult = await publishToGist(
          result.connectorFiles,
          `${genOptions.connectorName} — Power Platform custom connector (${version})`,
          false,
          ghToken
        );
        if (gistResult) {
          gistUrl = gistResult.gistUrl;
          gistRawUrls = gistResult.rawUrls;
        }
      }

      const output: GraphGenerateConnectorToolOutput = {
        connectorFiles: result.connectorFiles,
        totalOperations: result.totalOperations,
        validationWarnings: result.validationWarnings,
        flatteningLog: result.flatteningLog,
        savedPaths,
        gistUrl,
        gistRawUrls,
        baseName: baseName ?? undefined,
      };

      // Cache swagger for deploy pipeline
      const swaggerJsonFile = result.connectorFiles.find(
        (f) => f.filename.endsWith(".json") && !f.filename.includes("openapi")
      );
      if (baseName && swaggerJsonFile) {
        const cacheEntry: { swagger: string; gistRawUrl?: string } = { swagger: swaggerJsonFile.content };
        if (gistRawUrls) {
          const firstJsonKey = Object.keys(gistRawUrls).find(
            (k) => k.endsWith(".json") && !k.includes("openapi")
          );
          if (firstJsonKey && gistRawUrls[firstJsonKey]) {
            cacheEntry.gistRawUrl = gistRawUrls[firstJsonKey] as string;
          }
        }
        generatedSwaggerCache.set(baseName, cacheEntry);
        log(`[Generate] Cached swagger under key "${baseName}" (cache size: ${generatedSwaggerCache.size})`);
      }

      return { ok: true, toolName, result: output };
    }

    case "graph_deployPipeline": {
      const typedInput = input as GraphDeployPipelineToolInput;

      const ctx = getRequestContext();
      if (!ctx?.bearerToken) {
        return {
          ok: true,
          toolName,
          result: {
            status: "authRequired",
            message: "Deploy requires authentication. Use the authenticated connector topic flow.",
          },
        };
      }

      // Resolve swagger from cache if not provided
      let swagger = typedInput.swagger;
      const swaggerUrl = typedInput.swaggerUrl;
      if (!swagger && !swaggerUrl) {
        const cacheKey = typedInput.baseName;
        const cached = cacheKey ? generatedSwaggerCache.get(cacheKey) : undefined;
        if (cached) {
          swagger = cached.swagger;
        } else if (generatedSwaggerCache.size > 0) {
          const lastEntry = [...generatedSwaggerCache.values()].pop()!;
          swagger = lastEntry.swagger;
        } else {
          return { ok: false, toolName, error: "No swagger available. Call graph_generateConnector first or provide swagger/swaggerUrl." };
        }
      }

      // Deploy pipeline will be wired in pipeline.ts
      // For now, return a placeholder indicating the tool is ready but pipeline isn't connected
      return {
        ok: false,
        toolName,
        error: "Deploy pipeline direct calls not yet wired. Coming in next phase.",
      };
    }

    case "graph_setDesignContext": {
      const typedInput = input as GraphSetDesignContextToolInput;
      const output: GraphSetDesignContextToolOutput = {
        saved: true,
        context: typedInput,
        message: "Design context saved for this session.",
      };
      return { ok: true, toolName, result: output };
    }

    case "graph_completeAppRegistration": {
      return {
        ok: false,
        toolName,
        error: "App registration retry not yet wired in unified server.",
      };
    }

    default:
      return { ok: false, toolName, error: `Unknown graph tool: ${toolName}` };
  }
}
