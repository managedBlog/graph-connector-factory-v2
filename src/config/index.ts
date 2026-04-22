/**
 * Config loader for the unified Graph Connector Factory server.
 */

import * as fs from "fs";
import * as path from "path";
import { AgentConfig } from "./types";

const DEFAULT_CONFIG_FILENAME = "config/config.json";

/** Built-in defaults so the server starts zero-config for development. */
function builtInDefaults(): AgentConfig {
  return {
    configVersion: "1.0.0",
    id: "graph-connector-factory",
    description: "Graph Connector Factory — unified server.",
    server: {
      authMode: "noauth",
      allowUnauthenticatedHealth: true,
      port: 3001,
    },
    graphResearch: {
      defaultVersion: "v1.0",
      csdlCacheTtlHours: 24,
      autoFlatten: true,
      maxOperationsPerConnector: 256,
    },
    powerPlatform: {
      apiUrl: "https://api.powerapps.com",
      apiVersion: "2024-01-01",
      powerAppsApiUrl: "https://api.powerapps.com",
      powerAppsApiVersion: "2024-01-01",
      flowApiUrl: "https://api.flow.microsoft.com",
      flowApiVersion: "2016-11-01",
      defaultEnvironmentId: "",
      auth: {
        method: "clientCredential",
        tenantId: "",
        clientId: "",
        scope: "https://service.powerapps.com/.default",
      },
    },
    graphApi: {
      baseUrl: "https://graph.microsoft.com",
      apiVersion: "v1.0",
      auth: {
        method: "clientCredential",
        tenantId: "",
        clientId: "",
        scope: "https://graph.microsoft.com/.default",
      },
    },
    deploy: {},
    policies: {
      riskTolerance: "cautious",
      allowDelete: false,
      secrets: { inlineSecretsAllowed: false },
    },
    output: {
      dir: "./output",
      ttlMinutes: 60,
    },
    modes: [],
  };
}

function resolveConfigPath(): string {
  const envPath = process.env["MCP_CONFIG_PATH"];
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config file not found at MCP_CONFIG_PATH: ${resolved}`);
    }
    return resolved;
  }
  return path.resolve(process.cwd(), DEFAULT_CONFIG_FILENAME);
}

function validateConfig(raw: unknown): AgentConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config must be a JSON object.");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj["configVersion"] !== "string") {
    throw new Error("Config missing or invalid 'configVersion' (expected string).");
  }
  if (typeof obj["id"] !== "string") {
    throw new Error("Config missing or invalid 'id' (expected string).");
  }

  // Validate server section
  const server = obj["server"];
  if (typeof server !== "object" || server === null) {
    throw new Error("Config missing 'server' object.");
  }
  const s = server as Record<string, unknown>;
  if (s["authMode"] !== "noauth" && s["authMode"] !== "authenticated") {
    throw new Error("Config 'server.authMode' must be 'noauth' or 'authenticated'.");
  }
  if (s["authMode"] === "authenticated") {
    const tv = s["tokenValidation"];
    if (typeof tv !== "object" || tv === null) {
      throw new Error("Config 'server.tokenValidation' is required when server.authMode='authenticated'.");
    }
    const tokenValidation = tv as Record<string, unknown>;
    if (typeof tokenValidation["tenantId"] !== "string" || !(tokenValidation["tenantId"] as string).trim()) {
      throw new Error("Config 'server.tokenValidation.tenantId' must be a non-empty string.");
    }
    if (typeof tokenValidation["allowedAudience"] !== "string" || !(tokenValidation["allowedAudience"] as string).trim()) {
      throw new Error("Config 'server.tokenValidation.allowedAudience' must be a non-empty string.");
    }
  }

  // Validate graphResearch
  const gr = obj["graphResearch"];
  if (typeof gr !== "object" || gr === null) {
    throw new Error("Config missing 'graphResearch' object.");
  }

  // Validate powerPlatform
  const pp = obj["powerPlatform"];
  if (typeof pp !== "object" || pp === null) {
    throw new Error("Config missing 'powerPlatform' object.");
  }

  // Validate graphApi
  const ga = obj["graphApi"];
  if (typeof ga !== "object" || ga === null) {
    throw new Error("Config missing 'graphApi' object.");
  }

  // Validate policies
  const policies = obj["policies"];
  if (typeof policies !== "object" || policies === null) {
    throw new Error("Config missing 'policies' object.");
  }

  return raw as AgentConfig;
}

export function loadConfig(configPath?: string): AgentConfig {
  const filePath = configPath ?? resolveConfigPath();

  if (!fs.existsSync(filePath)) {
    if (configPath || process.env["MCP_CONFIG_PATH"]) {
      throw new Error(`Config file not found: ${filePath}`);
    }
    return builtInDefaults();
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Config file is not valid JSON: ${filePath}`);
  }

  return validateConfig(parsed);
}

export function getEnabledModes(config: AgentConfig): ReadonlySet<string> {
  const enabled = new Set<string>();
  for (const mode of config.modes) {
    if (mode.enabled) {
      enabled.add(mode.id);
    }
  }
  return enabled;
}

export function defaultConfigPath(): string {
  return resolveConfigPath();
}
