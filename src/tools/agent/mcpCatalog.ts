/**
 * Curated catalog of Microsoft first-party MCP servers.
 *
 * Only servers with known stable Power Platform connector API names are
 * marked as `stable: true`. Servers that require custom connector setup
 * or have tenant-specific names are flagged `stable: false`.
 *
 * Source: https://github.com/microsoft/mcp
 */

import type { McpServerCatalogEntry } from "./types";
import { log } from "../../logging/logger";

const MCP_CATALOG: McpServerCatalogEntry[] = [
  {
    id: "ms-learn-docs",
    displayName: "Microsoft Learn Docs MCP Server",
    description: "Search and retrieve Microsoft Learn documentation, API references, and technical guides.",
    category: "devtools",
    connectorApiName: "shared_microsoftlearndocsmcpserver",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_microsoftlearndocsmcpserver",
    operationId: "microsoft_docs_search",
    requiresOAuth: false,
    relevantFor: ["documentation", "api-reference", "troubleshooting", "how-to", "microsoft-learn"],
    repoUrl: "https://github.com/microsoft/mcp/tree/main/Microsoft%20Learn%20Docs%20MCP%20Server",
    stable: true,
  },
  {
    id: "azure",
    displayName: "Azure MCP Server",
    description: "Manage Azure resources ΓÇö storage, compute, networking, and monitoring.",
    category: "azure",
    connectorApiName: "shared_azuremcpserver",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_azuremcpserver",
    requiresOAuth: true,
    relevantFor: ["azure", "cloud", "infrastructure", "devops", "storage", "compute"],
    repoUrl: "https://github.com/microsoft/mcp/tree/main/Azure%20MCP%20Server",
    stable: false, // connector name may vary by tenant
  },
  {
    id: "m365",
    displayName: "Microsoft 365 MCP Server",
    description: "Access Microsoft 365 data ΓÇö emails, calendar, files, contacts via Microsoft Graph.",
    category: "m365",
    connectorApiName: "shared_microsoft365mcpserver",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_microsoft365mcpserver",
    requiresOAuth: true,
    relevantFor: ["email", "calendar", "files", "onedrive", "sharepoint", "contacts", "teams"],
    repoUrl: "https://github.com/microsoft/mcp/tree/main/Microsoft%20365%20MCP%20Server",
    stable: false,
  },
  {
    id: "dataverse",
    displayName: "Microsoft Dataverse MCP Server",
    description: "Query and manage Dataverse tables, entities, and business data.",
    category: "data",
    connectorApiName: "shared_microsoftdataversemcpserver",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_microsoftdataversemcpserver",
    requiresOAuth: true,
    relevantFor: ["dataverse", "dynamics", "crm", "business-data", "power-platform"],
    repoUrl: "https://github.com/microsoft/mcp/tree/main/Microsoft%20Dataverse%20MCP%20Server",
    stable: false,
  },
  {
    id: "playwright",
    displayName: "Playwright MCP Server",
    description: "Browser automation for web testing, scraping, and interaction.",
    category: "devtools",
    connectorApiName: "shared_playwrightmcpserver",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_playwrightmcpserver",
    requiresOAuth: false,
    relevantFor: ["browser", "testing", "web", "automation", "scraping"],
    repoUrl: "https://github.com/microsoft/mcp/tree/main/Playwright%20MCP%20Server",
    stable: false,
  },
  {
    id: "kusto",
    displayName: "Azure Data Explorer (Kusto) MCP Server",
    description: "Query Azure Data Explorer clusters with KQL.",
    category: "data",
    connectorApiName: "shared_kustomcpserver",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_kustomcpserver",
    requiresOAuth: true,
    relevantFor: ["kusto", "kql", "analytics", "logs", "telemetry", "data-explorer"],
    repoUrl: "https://github.com/microsoft/mcp/tree/main/Azure%20Data%20Explorer%20(Kusto)%20MCP%20Server",
    stable: false,
  },
  {
    id: "entra",
    displayName: "Microsoft Entra MCP Server",
    description: "Manage Entra ID identities, groups, and applications.",
    category: "security",
    connectorApiName: "shared_microsoftentramcpserver",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_microsoftentramcpserver",
    requiresOAuth: true,
    relevantFor: ["identity", "entra", "azure-ad", "users", "groups", "authentication"],
    repoUrl: "https://github.com/microsoft/mcp/tree/main/Microsoft%20Entra%20MCP%20Server",
    stable: false,
  },
  {
    id: "intune",
    displayName: "Microsoft Intune MCP Server",
    description: "Manage device policies, compliance, and configurations via Intune.",
    category: "m365",
    connectorApiName: "shared_microsoftintunemcpserver",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_microsoftintunemcpserver",
    requiresOAuth: true,
    relevantFor: ["intune", "devices", "mdm", "compliance", "endpoint-management"],
    repoUrl: "https://github.com/microsoft/mcp/tree/main/Microsoft%20Intune%20MCP%20Server",
    stable: false,
  },
];

/**
 * List MCP servers, optionally filtered by category or stability.
 */
export function listMcpServers(filter?: {
  category?: string;
  stableOnly?: boolean;
}): McpServerCatalogEntry[] {
  let results = [...MCP_CATALOG];

  if (filter?.category) {
    results = results.filter((s) => s.category === filter.category);
  }
  if (filter?.stableOnly) {
    results = results.filter((s) => s.stable);
  }

  return results;
}

/**
 * Get a single MCP server entry by catalog ID.
 */
export function getMcpServer(id: string): McpServerCatalogEntry | undefined {
  return MCP_CATALOG.find((s) => s.id === id);
}

/**
 * Get only stable (globally available) MCP servers.
 */
export function getStableMcpServers(): McpServerCatalogEntry[] {
  return MCP_CATALOG.filter((s) => s.stable);
}

/**
 * Resolve an array of catalog IDs to full entries.
 * Returns only entries that match valid IDs; logs warnings for unknown IDs.
 */
export function resolveMcpServers(ids: string[]): McpServerCatalogEntry[] {
  const resolved: McpServerCatalogEntry[] = [];
  for (const id of ids) {
    const entry = getMcpServer(id);
    if (entry) {
      resolved.push(entry);
    } else {
      log(`[MCP Catalog] Unknown MCP server ID "${id}" — skipping`);
    }
  }
  return resolved;
}
