/**
 * Curated catalog of verified Microsoft first-party MCP servers.
 *
 * All entries have been verified against a live Power Platform tenant.
 * Connector API names are globally stable (marketplace connectors).
 *
 * Source: Power Platform APIs discovery + https://github.com/microsoft/mcp
 */

import type { McpServerCatalogEntry } from "./types";
import { log } from "../../logging/logger";

const MCP_CATALOG: McpServerCatalogEntry[] = [
  // ── Generally Available ──────────────────────────────────────────────
  {
    id: "ms-learn-docs",
    displayName: "Microsoft Learn Docs MCP",
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
    id: "sentinel",
    displayName: "Microsoft Sentinel MCP",
    description: "Tools from the Microsoft Sentinel MCP server for security playbooks and incident response.",
    category: "security",
    connectorApiName: "shared_sentinelmcp",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_sentinelmcp",
    requiresOAuth: true,
    relevantFor: ["security", "sentinel", "siem", "incidents", "threat-detection", "logs"],
    stable: true,
  },
  {
    id: "m365-admin",
    displayName: "Microsoft 365 Admin Center MCP",
    description: "MCP server for Microsoft 365 Admin Center operations — tenant settings, users, licensing.",
    category: "admin",
    connectorApiName: "shared_a365adminmcp",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_a365adminmcp",
    requiresOAuth: true,
    relevantFor: ["admin", "tenant", "licensing", "m365", "management"],
    stable: true,
  },
  {
    id: "fabric-iq",
    displayName: "Fabric IQ Ontology MCP",
    description: "Interact with Microsoft Fabric IQ ontology for data intelligence and analytics.",
    category: "data",
    connectorApiName: "shared_fabriciqmcpserver",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_fabriciqmcpserver",
    requiresOAuth: true,
    relevantFor: ["fabric", "data", "analytics", "ontology", "intelligence"],
    stable: true,
  },

  // ── Work IQ (M365 Preview) ───────────────────────────────────────────
  {
    id: "workiq-mail",
    displayName: "Work IQ Mail MCP",
    description: "Microsoft Outlook Mail operations — read, send, and manage email. (Preview)",
    category: "m365",
    connectorApiName: "shared_a365outlookmailmcp",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_a365outlookmailmcp",
    requiresOAuth: true,
    relevantFor: ["email", "outlook", "mail", "messages"],
    stable: true,
  },
  {
    id: "workiq-calendar",
    displayName: "Work IQ Calendar MCP",
    description: "Microsoft Outlook Calendar operations — events, scheduling, availability. (Preview)",
    category: "m365",
    connectorApiName: "shared_a365outlookcalendarmcp",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_a365outlookcalendarmcp",
    requiresOAuth: true,
    relevantFor: ["calendar", "events", "scheduling", "outlook"],
    stable: true,
  },
  {
    id: "workiq-teams",
    displayName: "Work IQ Teams MCP",
    description: "Microsoft Teams operations — channels, messages, meetings. (Preview)",
    category: "m365",
    connectorApiName: "shared_a365teamsmcp",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_a365teamsmcp",
    requiresOAuth: true,
    relevantFor: ["teams", "chat", "channels", "meetings", "collaboration"],
    stable: true,
  },
  {
    id: "workiq-word",
    displayName: "Work IQ Word MCP",
    description: "Microsoft Word operations — document creation and editing. (Preview)",
    category: "m365",
    connectorApiName: "shared_a365wordmcp",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_a365wordmcp",
    requiresOAuth: true,
    relevantFor: ["word", "documents", "authoring"],
    stable: true,
  },
  {
    id: "workiq-user",
    displayName: "Work IQ User MCP",
    description: "Microsoft 365 User operations — profile, presence, organization info. (Preview)",
    category: "m365",
    connectorApiName: "shared_a365memcp",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_a365memcp",
    requiresOAuth: true,
    relevantFor: ["users", "profile", "presence", "directory"],
    stable: true,
  },
  {
    id: "workiq-copilot",
    displayName: "Work IQ Copilot MCP",
    description: "Microsoft Copilot Search operations — intelligent search across M365. (Preview)",
    category: "m365",
    connectorApiName: "shared_a365copilotchatmcp",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_a365copilotchatmcp",
    requiresOAuth: true,
    relevantFor: ["copilot", "search", "ai", "chat"],
    stable: true,
  },
  {
    id: "workiq-onedrive",
    displayName: "Work IQ OneDrive MCP",
    description: "Microsoft OneDrive operations — files, folders, sharing. (Preview)",
    category: "m365",
    connectorApiName: "shared_workiqonedrive",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_workiqonedrive",
    requiresOAuth: true,
    relevantFor: ["onedrive", "files", "storage", "sharing"],
    stable: true,
  },
  {
    id: "workiq-sharepoint",
    displayName: "Work IQ SharePoint MCP",
    description: "Microsoft SharePoint operations — sites, lists, documents. (Preview)",
    category: "m365",
    connectorApiName: "shared_workiqsharepoint",
    connectorId: "/providers/Microsoft.PowerApps/apis/shared_workiqsharepoint",
    requiresOAuth: true,
    relevantFor: ["sharepoint", "sites", "lists", "documents", "content"],
    stable: true,
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
