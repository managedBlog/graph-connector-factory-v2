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

// Connector deploy (CDA) imports
import { invokeTool as invokeConnectorTool, toolRegistry as connectorToolRegistry } from "./connector/tools";

// App registration (ARA) imports
import { invokeTool as invokeAppregTool, toolRegistry as appregToolRegistry } from "./appreg/tools";

// Deploy pipeline (direct function calls — replaces A2A orchestrator)
import { executeDeployPipeline, retryAppRegistration } from "./deploy/pipeline";

// CUA test plan generation
import { generateTestPlan } from "./testing/testPlanGenerator";
import { generateMultiConnectorTestPlan } from "./testing/multiConnectorPlan";
import type { TestPlanInput, MultiConnectorTestInput } from "./testing/types";

// Agent factory imports
import { listMcpServers, generateInstructions, resolveMcpServers } from "./agent";
import type { AgentFactoryContext } from "./agent";

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

/** Tools exposed to Copilot Studio via the MCP endpoint. */
const MCP_VISIBLE_TOOLS = new Set([
  "graph_listOperations",
  "graph_generateConnector",
  "graph_setDesignContext",
  "graph_generateTestPlan",
  "testing_generateMultiPlan",
  "agent_listMcpServers",
  "agent_setDesignContext",
  "agent_generateInstructions",
]);

/**
 * Returns tools visible to MCP clients (Copilot Studio).
 * Only exposes the AI research tools — internal pipeline tools are hidden.
 */
export function listMcpTools(): AvailableTool[] {
  return graphToolDefinitions.filter((t) => MCP_VISIBLE_TOOLS.has(t.name));
}

/**
 * Returns all available tools for REST introspection and internal dispatch.
 * Combines graph research, connector deploy, and app registration tools.
 */
export function listAllTools(): AvailableTool[] {
  const connectorTools: AvailableTool[] = Object.values(connectorToolRegistry).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }));

  const appregTools: AvailableTool[] = Object.values(appregToolRegistry)
    .filter((tool) => tool.name !== "setAutonomyMode")
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));

  return [
    ...graphToolDefinitions,
    ...connectorTools,
    ...appregTools,
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
        connectorGroups: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable group identifier (e.g. 'conn1')" },
              name: { type: "string", description: "Human-readable group name" },
              baseName: { type: "string", description: "Per-connector base name override" },
              endpoints: { type: "array", items: { type: "string" }, description: "Graph API endpoint paths" },
              operationPattern: { type: "string", description: "Pattern hint (CRUD, Read, Actions)" },
              operationIds: {
                type: "array",
                items: { type: "string" },
                description: "Exact operationId values from graph_listOperations. When present, only these operations are included in the build card. Use this to capture the specific operations agreed upon during research.",
              },
            },
            required: ["endpoints"],
          },
        },
        appRegistrationStrategy: { type: "string", enum: ["single", "separate"] },
        environmentId: { type: "string" },
        environmentName: { type: "string", description: "Display name of the target Power Platform environment" },
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
  {
    name: "graph_generateTestPlan",
    description: "Generate a structured CUA test plan for a deployed connector.",
    inputSchema: {
      type: "object",
      properties: {
        connectorId: { type: "string", description: "Connector ID from deploy result." },
        environmentId: { type: "string", description: "Power Platform environment ID." },
        displayName: { type: "string", description: "Connector display name." },
        deployStatus: { type: "string", enum: ["success", "partial", "failed"], description: "Deploy pipeline status." },
        authType: { type: "string", description: "Connector auth type (OAuthAAD, NoAuth, etc.)." },
        baseName: { type: "string", description: "Cache key to resolve swagger. Optional if swagger is provided." },
        swagger: { type: "string", description: "Inline swagger JSON. Alternative to baseName." },
        includeWriteOps: { type: "boolean", description: "Include POST/PATCH/DELETE test steps. Default false." },
        portalHost: { type: "string", description: "Portal base host override. Default: make.powerapps.com." },
      },
      required: ["connectorId", "environmentId", "displayName", "deployStatus", "authType"],
    },
  },
  {
    name: "testing_generateMultiPlan",
    description: "Generate a multi-connector CUA test plan — lean operation manifest for testing multiple connectors.",
    inputSchema: {
      type: "object",
      properties: {
        environmentId: { type: "string", description: "Power Platform environment ID." },
        connectors: {
          type: "array",
          description: "Connectors to test.",
          items: {
            type: "object",
            properties: {
              displayName: { type: "string", description: "Connector display name (CUA opens by name)." },
              scope: {
                description: "Operations to test: 'all', 'crud', or array of operation IDs.",
                oneOf: [
                  { type: "string", enum: ["all", "crud"] },
                  { type: "array", items: { type: "string" } },
                ],
              },
              swagger: { type: "string", description: "Inline swagger JSON for operation resolution." },
              baseName: { type: "string", description: "Cache key to resolve swagger from server cache." },
              bodyOverrides: { type: "object", description: "Override body templates keyed by entity set name." },
            },
            required: ["displayName", "scope"],
          },
        },
        variables: { type: "object", description: "Top-level variables for template substitution (e.g., tenantDomain)." },
      },
      required: ["environmentId", "connectors"],
    },
  },

  // ─── Agent Factory tools ──────────────────────────────────────────────────
  {
    name: "agent_listMcpServers",
    description: "List available Microsoft MCP servers for agent composition.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter by category: graph, azure, data, devtools, m365, security." },
        stableOnly: { type: "boolean", description: "Only return servers with globally stable connector names." },
      },
    },
  },
  {
    name: "agent_setDesignContext",
    description: "Persist agent factory design decisions for the current session (name, purpose, MCP servers, knowledge sources).",
    inputSchema: {
      type: "object",
      properties: {
        agentName: { type: "string", description: "Display name for the generated agent." },
        agentPurpose: { type: "string", description: "What the agent should help users do." },
        selectedMcpServers: { type: "array", items: { type: "string" }, description: "MCP server catalog IDs." },
        knowledgeSources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["sharepoint", "url"] },
              url: { type: "string" },
              displayName: { type: "string" },
              description: { type: "string" },
            },
            required: ["type", "url"],
          },
          description: "Knowledge sources (SharePoint sites, URLs).",
        },
        includeCua: { type: "boolean", description: "Whether to include Computer Use Agent capability." },
        instructionsOverride: { type: "string", description: "Custom instructions (replaces auto-generated)." },
      },
    },
  },
  {
    name: "agent_generateInstructions",
    description: "Preview auto-generated agent instructions based on current design context.",
    inputSchema: {
      type: "object",
      properties: {
        agentName: { type: "string", description: "Agent display name." },
        agentPurpose: { type: "string", description: "Agent purpose." },
        mcpServerIds: { type: "array", items: { type: "string" }, description: "MCP server catalog IDs." },
      },
      required: ["agentName", "agentPurpose"],
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
    if (toolName.startsWith("graph_") || toolName.startsWith("testing_")) {
      return await invokeGraphTool(toolName, input, config);
    }

    if (toolName.startsWith("agent_")) {
      return await invokeAgentTool(toolName, input, config);
    }

    if (toolName.startsWith("connector_") || toolName === "setAutonomyMode") {
      const cdaResult = await invokeConnectorTool(toolName, input, config);
      return {
        ok: cdaResult.ok,
        toolName,
        result: cdaResult.result,
        ...(cdaResult.error != null ? { error: cdaResult.error } : {}),
      };
    }

    if (toolName.startsWith("appreg_")) {
      const araResult = await invokeAppregTool(toolName, input, config);
      return {
        ok: araResult.ok,
        toolName,
        result: araResult.result,
        ...(araResult.error != null ? { error: araResult.error } : {}),
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
        enrichComplexTypes: config.graphResearch.enrichComplexTypes ?? false,
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

      const pipelineResult = await executeDeployPipeline(
        { ...typedInput, swagger, swaggerUrl },
        config,
      );

      // Auto-generate test plan on successful deploy if swagger is available
      let testPlan: unknown = undefined;
      if (pipelineResult.status !== "failed" && pipelineResult.connector) {
        try {
          // Resolve swagger for test plan from cache
          let testSwagger: string | Record<string, unknown> | undefined;
          const cacheKey = typedInput.baseName;
          const cached = cacheKey ? generatedSwaggerCache.get(cacheKey) : undefined;
          if (cached) {
            testSwagger = cached.swagger;
          } else if (swagger) {
            testSwagger = swagger;
          }

          if (testSwagger) {
            const plan = generateTestPlan({
              connectorId: pipelineResult.connector.connectorId,
              environmentId: pipelineResult.connector.environmentId,
              environmentName: typedInput.environmentName as string | undefined,
              displayName: pipelineResult.connector.displayName,
              deployStatus: pipelineResult.status,
              authType: pipelineResult.connector.authType ?? "OAuthAAD",
              swagger: testSwagger,
            });
            testPlan = plan;
            log(`[Deploy Pipeline] Auto-generated test plan: ${plan.summary.totalSteps} steps`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`[Deploy Pipeline] Test plan auto-generation skipped: ${msg}`);
        }
      }

      return {
        ok: pipelineResult.status !== "failed",
        toolName,
        result: { ...pipelineResult, ...(testPlan ? { testPlan } : {}) },
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
      const typedInput = input as Record<string, unknown>;
      const retryResult = await retryAppRegistration(
        {
          connectorId: typedInput["connectorId"] as string,
          baseName: typedInput["baseName"] as string | undefined,
          federatedIdentitySubject: typedInput["federatedIdentitySubject"] as string | undefined,
          federatedIdentityIssuer: typedInput["federatedIdentityIssuer"] as string | undefined,
          federatedIdentityAudience: typedInput["federatedIdentityAudience"] as string | undefined,
          redirectUri: typedInput["redirectUri"] as string | undefined,
          clientId: typedInput["clientId"] as string | undefined,
          graphApiScopes: typedInput["graphApiScopes"] as string[] | undefined,
        },
        config,
      );
      return { ok: retryResult.configured, toolName, result: retryResult };
    }

    case "graph_generateTestPlan": {
      const typedInput = input as Record<string, unknown>;

      // Resolve swagger from cache if baseName provided but no inline swagger
      let swagger = typedInput["swagger"] as string | Record<string, unknown> | undefined;
      if (!swagger && typedInput["baseName"]) {
        const cached = generatedSwaggerCache.get(typedInput["baseName"] as string);
        if (cached) {
          swagger = cached.swagger;
        }
      }
      if (!swagger && generatedSwaggerCache.size > 0) {
        const lastEntry = [...generatedSwaggerCache.values()].pop()!;
        swagger = lastEntry.swagger;
      }

      const testPlanInput: TestPlanInput = {
        connectorId: typedInput["connectorId"] as string,
        environmentId: typedInput["environmentId"] as string,
        environmentName: typedInput["environmentName"] as string | undefined,
        displayName: typedInput["displayName"] as string,
        deployStatus: typedInput["deployStatus"] as "success" | "partial" | "failed",
        authType: typedInput["authType"] as string,
        baseName: typedInput["baseName"] as string | undefined,
        swagger,
        includeWriteOps: typedInput["includeWriteOps"] as boolean | undefined,
        portalHost: typedInput["portalHost"] as string | undefined,
      };

      const testPlan = generateTestPlan(testPlanInput);
      log(`[TestPlan] Generated ${testPlan.summary.totalSteps} steps for "${testPlan.connectorName}"`);
      return { ok: true, toolName, result: { testPlan } };
    }

    case "testing_generateMultiPlan": {
      const typedInput = input as Record<string, unknown>;
      const connectors = typedInput["connectors"] as Array<Record<string, unknown>> | undefined;

      if (!connectors || connectors.length === 0) {
        return { ok: false, toolName, error: "At least one connector is required" };
      }

      // Resolve swagger from cache for any connector that specifies baseName
      const multiInput: MultiConnectorTestInput = {
        environmentId: typedInput["environmentId"] as string,
        environmentName: typedInput["environmentName"] as string | undefined,
        connectors: connectors.map((c) => {
          let swagger = c["swagger"] as string | Record<string, unknown> | undefined;
          if (!swagger && c["baseName"]) {
            const cached = generatedSwaggerCache.get(c["baseName"] as string);
            if (cached) swagger = cached.swagger;
          }
          return {
            displayName: c["displayName"] as string,
            scope: c["scope"] as "all" | "crud" | readonly string[],
            swagger,
            baseName: c["baseName"] as string | undefined,
            bodyOverrides: c["bodyOverrides"] as Record<string, Record<string, unknown>> | undefined,
          };
        }),
        variables: typedInput["variables"] as Record<string, string> | undefined,
      };

      const testPlan = generateMultiConnectorTestPlan(multiInput);
      log(`[MultiPlan] Generated ${testPlan.summary.totalOperations} operations across ${testPlan.summary.totalConnectors} connectors`);
      return { ok: true, toolName, result: testPlan };
    }

    default:
      return { ok: false, toolName, error: `Unknown graph tool: ${toolName}` };
  }
}

// ─── Agent Factory tool dispatch ───────────────────────────────────────────

async function invokeAgentTool(
  toolName: string,
  input: unknown,
  _config: AgentConfig,
): Promise<ToolInvocationResult> {
  switch (toolName) {
    case "agent_listMcpServers": {
      const typedInput = input as Record<string, unknown>;
      const filter: { category?: string; stableOnly?: boolean } = {};
      if (typedInput["category"] != null) filter.category = typedInput["category"] as string;
      if (typedInput["stableOnly"] != null) filter.stableOnly = typedInput["stableOnly"] as boolean;
      const servers = listMcpServers(filter);
      return { ok: true, toolName, result: { servers, count: servers.length } };
    }

    case "agent_setDesignContext": {
      // This tool is intercepted by httpHost.ts for session persistence.
      // If it reaches here, return the input as confirmation.
      const typedInput = input as AgentFactoryContext;
      return {
        ok: true,
        toolName,
        result: {
          saved: true,
          context: typedInput,
          message: "Agent factory design context saved for this session.",
        },
      };
    }

    case "agent_generateInstructions": {
      const typedInput = input as Record<string, unknown>;
      const agentName = typedInput["agentName"] as string;
      const agentPurpose = typedInput["agentPurpose"] as string;
      const mcpServerIds = typedInput["mcpServerIds"] as string[] | undefined;

      const mcpServers = mcpServerIds ? resolveMcpServers(mcpServerIds) : [];

      const instructions = generateInstructions({
        agentName,
        agentPurpose,
        connectorOperations: [], // Will be populated from deploy results at generation time
        mcpServers,
        knowledgeSources: [],
      });

      return {
        ok: true,
        toolName,
        result: {
          instructions,
          stats: {
            mcpServerCount: mcpServers.length,
          },
          message: "Instructions preview generated. Final instructions will include deployed connector operations.",
        },
      };
    }

    default:
      return { ok: false, toolName, error: `Unknown agent tool: ${toolName}` };
  }
}
