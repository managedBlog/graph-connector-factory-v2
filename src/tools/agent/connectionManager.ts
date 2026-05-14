/**
 * Connection Manager — creates and manages Power Platform connections via the Power Apps API.
 *
 * After `pac copilot create`, connection references exist but have `connectionid: null`.
 * This module:
 *   1. Lists existing connections (or creates new ones)
 *   2. Provides OAuth consent URLs for new connections
 *   3. Patches connection references in Dataverse to bind them to real connections
 *
 * API: https://api.powerapps.com/providers/Microsoft.PowerApps/apis/{api}/connections
 * Auth: Azure CLI token with audience https://service.powerapps.com/
 */

import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { log, logError } from "../../logging/logger";
import type { ConnectionInfo, ConnectionReferenceInfo } from "./types";
import { getDataverseToken, resolveOrgUrl } from "./dataverseClient";

const POWERAPPS_AUDIENCE = "https://service.powerapps.com/";

// ——— Token ———————————————————————————————————————————————————————————

async function getPowerAppsToken(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "az",
      ["account", "get-access-token", "--resource", POWERAPPS_AUDIENCE, "--query", "accessToken", "-o", "tsv"],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Failed to get Power Apps token: ${stderr || error.message}`));
          return;
        }
        const token = stdout.trim();
        if (!token || !token.startsWith("ey")) {
          reject(new Error("Invalid Power Apps token received"));
          return;
        }
        resolve(token);
      },
    );
  });
}

// ——— List Connections ————————————————————————————————————————————————

/**
 * List all connections in the environment for a specific connector API.
 * Returns only "Connected" connections by default.
 */
export async function listConnections(
  environmentId: string,
  connectorApiName?: string,
): Promise<ConnectionInfo[]> {
  const token = await getPowerAppsToken();
  const uri = `https://api.powerapps.com/providers/Microsoft.PowerApps/connections?api-version=2016-11-01&$filter=environment eq '${environmentId}'`;

  const response = await fetch(uri, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to list connections: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { value: PowerAppsConnection[] };
  const connections: ConnectionInfo[] = [];

  for (const conn of data.value) {
    const apiName = conn.properties.apiId.replace("/providers/Microsoft.PowerApps/apis/", "");

    if (connectorApiName && apiName !== connectorApiName) {
      continue;
    }

    const status = conn.properties.statuses?.[0]?.status;
    connections.push({
      connectionId: conn.name,
      connectorApiName: apiName,
      status: status === "Connected" ? "Connected" : status === "Error" ? "Error" : "Unauthenticated",
    });
  }

  return connections;
}

// ——— Create Connection ——————————————————————————————————————————————

/**
 * Create a new connection for a connector in the environment.
 * The connection is created in an "Unauthenticated" state for OAuth connectors;
 * the user must visit the consent URL to complete authentication.
 */
export async function createConnection(
  environmentId: string,
  connectorApiName: string,
): Promise<ConnectionInfo> {
  const token = await getPowerAppsToken();
  const connectionId = randomUUID().replace(/-/g, "");

  const uri = `https://api.powerapps.com/providers/Microsoft.PowerApps/apis/${connectorApiName}/connections/${connectionId}?api-version=2016-11-01&$filter=environment eq '${environmentId}'`;

  const body = JSON.stringify({
    properties: {
      environment: {
        id: `/providers/Microsoft.PowerApps/environments/${environmentId}`,
        name: environmentId,
      },
    },
  });

  const response = await fetch(uri, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to create connection for ${connectorApiName}: ${response.status} ${errText}`);
  }

  const result = (await response.json()) as PowerAppsConnection;
  const status = result.properties.statuses?.[0]?.status;

  log(`[ConnectionManager] Created connection ${connectionId} for ${connectorApiName} (status: ${status})`);

  const connInfo: ConnectionInfo = {
    connectionId,
    connectorApiName,
    status: status === "Connected" ? "Connected" : "Unauthenticated",
  };

  // Get consent link if not already connected
  if (status !== "Connected") {
    try {
      connInfo.consentUrl = await getConsentLink(environmentId, connectorApiName, connectionId, token);
    } catch (err) {
      logError(`[ConnectionManager] Could not get consent link: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return connInfo;
}

// ——— Consent Link ———————————————————————————————————————————————————

/**
 * Get the OAuth consent URL for an unauthenticated connection.
 */
async function getConsentLink(
  environmentId: string,
  connectorApiName: string,
  connectionId: string,
  token?: string,
): Promise<string> {
  const authToken = token ?? (await getPowerAppsToken());

  const uri = `https://api.powerapps.com/providers/Microsoft.PowerApps/apis/${connectorApiName}/connections/${connectionId}/getConsentLink?api-version=2016-11-01&$filter=environment eq '${environmentId}'`;

  const response = await fetch(uri, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ redirectUrl: "https://flow.microsoft.com" }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get consent link: ${response.status}`);
  }

  const data = (await response.json()) as { consentLink: string };
  return data.consentLink;
}

// ——— Ensure Connection —————————————————————————————————————————————

/**
 * Find an existing connected connection for a connector, or create a new one.
 * Returns the connection ID and optional consent URL.
 */
export async function ensureConnection(
  environmentId: string,
  connectorApiName: string,
): Promise<ConnectionInfo> {
  // Check for existing connected connection first
  const existing = await listConnections(environmentId, connectorApiName);
  const connected = existing.find((c) => c.status === "Connected");

  if (connected) {
    log(`[ConnectionManager] Reusing existing connection ${connected.connectionId} for ${connectorApiName}`);
    return connected;
  }

  // No connected connection found — create a new one
  log(`[ConnectionManager] No existing connection for ${connectorApiName}, creating new one...`);
  return createConnection(environmentId, connectorApiName);
}

// ——— Bind Connections to Agent ——————————————————————————————————————

/**
 * After agent creation, bind connections to the agent's connection references.
 *
 * Steps:
 *   1. Query Dataverse for the bot's connection references
 *   2. For each, find or create a connection matching the connector
 *   3. PATCH the connectionid field on each connection reference
 *
 * Returns connection info for all connectors (with consent URLs for any new ones).
 */
export async function bindAgentConnections(
  environmentId: string,
  botSchemaName: string,
): Promise<{ connections: ConnectionInfo[]; warnings: string[] }> {
  const warnings: string[] = [];
  const connections: ConnectionInfo[] = [];

  // Resolve Dataverse org URL and get token
  let orgUrl: string;
  let dvToken: string;
  try {
    orgUrl = await resolveOrgUrl(environmentId);
    dvToken = await getDataverseToken(orgUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Could not authenticate to Dataverse for connection binding: ${msg}`);
    return { connections, warnings };
  }

  // Get connection references for this bot
  const connRefs = await getConnectionReferences(orgUrl, dvToken, botSchemaName);
  log(`[ConnectionManager] Found ${connRefs.length} connection references for ${botSchemaName}`);
  for (const ref of connRefs) {
    log(`[ConnectionManager]   ref: ${ref.connectionreferencelogicalname} → connector: ${ref.connectorid} (current connectionid: ${ref.connectionid ?? "null"})`);
  }

  if (connRefs.length === 0) {
    warnings.push("No connection references found for agent. Connections cannot be bound automatically.");
    return { connections, warnings };
  }

  // For each connection reference, ensure a connection exists and patch it
  for (const ref of connRefs) {
    const connectorApiName = ref.connectorid.replace("/providers/Microsoft.PowerApps/apis/", "");

    try {
      const connInfo = await ensureConnection(environmentId, connectorApiName);
      connections.push(connInfo);

      // Patch the connectionid on the connection reference
      await patchConnectionId(orgUrl, dvToken, ref.connectionreferenceid, connInfo.connectionId);
      log(`[ConnectionManager] Bound ${connectorApiName} → ${connInfo.connectionId} on ref ${ref.connectionreferenceid}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[ConnectionManager] Failed to bind connection for ${connectorApiName}: ${msg}`);
      warnings.push(`Failed to bind connection for ${connectorApiName}: ${msg}`);
    }
  }

  return { connections, warnings };
}

// ——— Dataverse Helpers (connection-specific) ————————————————————————

/**
 * Query connection references for a bot by its schema name prefix.
 */
async function getConnectionReferences(
  orgUrl: string,
  token: string,
  botSchemaName: string,
): Promise<ConnectionReferenceInfo[]> {
  const uri = `${orgUrl}/api/data/v9.2/connectionreferences?$filter=startswith(connectionreferencelogicalname,'${botSchemaName}')&$select=connectionreferenceid,connectionreferencelogicalname,connectorid,connectionid`;

  const response = await fetch(uri, {
    headers: {
      Authorization: `Bearer ${token}`,
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to query connection references: ${response.status}`);
  }

  const data = (await response.json()) as { value: ConnectionReferenceInfo[] };
  return data.value;
}

/**
 * Patch the connectionid field on a connection reference record in Dataverse.
 */
async function patchConnectionId(
  orgUrl: string,
  token: string,
  connectionReferenceId: string,
  connectionId: string,
): Promise<void> {
  const uri = `${orgUrl}/api/data/v9.2/connectionreferences(${connectionReferenceId})`;

  const response = await fetch(uri, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
    body: JSON.stringify({ connectionid: connectionId }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to patch connectionid: ${response.status} ${errText}`);
  }
}

// ——— Internal Types —————————————————————————————————————————————————

interface PowerAppsConnection {
  name: string;
  properties: {
    apiId: string;
    displayName: string;
    statuses: Array<{ status: string }>;
  };
}
