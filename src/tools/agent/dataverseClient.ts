/**
 * Dataverse Web API client for post-creation agent configuration.
 *
 * Used to add knowledge sources (and other components) that can't be
 * provisioned through `pac copilot create` template alone.
 *
 * Auth: Uses the server's CredentialProvider (certificate/secret/managed identity)
 * with the Dataverse org URL as the token scope. This avoids depending on the
 * Azure CLI being on PATH in the server process.
 */

import { randomUUID } from "crypto";
import { log, logError } from "../../logging/logger";
import { createCredentialProvider } from "../../auth";
import { loadConfig } from "../../config";
import { runPac } from "./pacRunner";
import type { KnowledgeSource } from "./types";
import { truncateInstructions } from "./instructionUtils";

// ——— Auth ————————————————————————————————————————————————————————————

/**
 * Get an access token for the Dataverse org URL using the server's credential provider.
 * Scope is `{orgUrl}/.default` (e.g., `https://orgd8cb0ffa.crm.dynamics.com/.default`).
 */
export async function getDataverseToken(orgUrl: string): Promise<string> {
  const resource = orgUrl.replace(/\/$/, "");
  const scope = `${resource}/.default`;

  const config = loadConfig();
  const credential = createCredentialProvider(config.powerPlatform.auth);
  const result = await credential.getToken(scope);

  if (!result.accessToken) {
    throw new Error("Failed to get Dataverse token: empty token received");
  }

  return result.accessToken;
}

// ——— Environment resolution ——————————————————————————————————————————

/**
 * Resolve a PAC environment GUID to its Dataverse org URL.
 * Parses `pac env list` output to find the matching URL.
 */
export async function resolveOrgUrl(environmentId: string): Promise<string> {
  const result = await runPac(["env", "list"], { timeout: 30_000 });
  if (!result.success) {
    throw new Error(`pac env list failed: ${result.stderr}`);
  }

  // Parse lines looking for the environment ID and extract the URL
  const lines = result.stdout.split(/\r?\n/);
  for (const line of lines) {
    if (line.includes(environmentId)) {
      const urlMatch = line.match(/(https:\/\/[^\s]+\.crm[^\s]*\.dynamics\.com\/?)/i);
      if (urlMatch) {
        const url = urlMatch[1]!.replace(/\/$/, "");
        log(`[Dataverse] Resolved env ${environmentId} → ${url}`);
        return url;
      }
    }
  }

  throw new Error(`Could not resolve org URL for environment ${environmentId} from pac env list`);
}

// ——— Knowledge Source Operations —————————————————————————————————————

function sanitizeForSchema(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "");
}

function generateRandomSuffix(): string {
  // Match the pattern seen in existing components (21-char alphanumeric)
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 21; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Add a SharePoint knowledge source to an existing bot via Dataverse API.
 */
async function addSharePointKnowledgeSource(
  orgUrl: string,
  token: string,
  botId: string,
  ks: KnowledgeSource,
  prefix: string,
  botSchemaName: string,
): Promise<void> {
  const sanitizedName = sanitizeForSchema(ks.displayName);
  const suffix = generateRandomSuffix();
  const schemaName = `${prefix}_${botSchemaName}.topic.${sanitizedName}_${suffix}`;

  const data = [
    "kind: KnowledgeSourceConfiguration",
    "source:",
    "  kind: SharePointSearchSource",
    `  site: ${ks.url}`,
  ].join("\r\n");

  const body = {
    componenttype: 16,
    name: ks.displayName,
    description: ks.description || `Knowledge source from ${ks.url}`,
    schemaname: schemaName,
    data,
    "parentbotid@odata.bind": `/bots(${botId})`,
  };

  const response = await fetch(`${orgUrl}/api/data/v9.2/botcomponents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Dataverse POST failed (${response.status}): ${errText}`);
  }

  log(`[Dataverse] Added knowledge source "${ks.displayName}" to bot ${botId}`);
}

/**
 * Add all knowledge sources to a newly created bot.
 * Returns warnings for any that failed (does not throw on partial failure).
 */
export async function addKnowledgeSources(
  environmentId: string,
  botId: string,
  knowledgeSources: KnowledgeSource[],
  publisherPrefix: string,
  botSchemaName: string,
): Promise<string[]> {
  const warnings: string[] = [];

  // Filter to SharePoint only for MVP
  const spSources = knowledgeSources.filter((ks) => ks.type === "sharepoint");
  if (spSources.length === 0) {
    if (knowledgeSources.length > 0) {
      warnings.push("Only SharePoint knowledge sources are supported. Non-SharePoint sources were skipped.");
    }
    return warnings;
  }

  // Resolve org URL and get token
  let orgUrl: string;
  let token: string;
  try {
    orgUrl = await resolveOrgUrl(environmentId);
    token = await getDataverseToken(orgUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[Dataverse] Auth failed for knowledge sources: ${msg}`);
    warnings.push(`Could not authenticate to Dataverse: ${msg}. Knowledge sources were not added.`);
    return warnings;
  }

  // Add each knowledge source with retry
  for (const ks of spSources) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await addSharePointKnowledgeSource(orgUrl, token, botId, ks, publisherPrefix, botSchemaName);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < 3) {
          log(`[Dataverse] Retry ${attempt}/3 for "${ks.displayName}": ${msg}`);
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        } else {
          logError(`[Dataverse] Failed to add knowledge source "${ks.displayName}" after 3 attempts: ${msg}`);
          warnings.push(`Failed to add knowledge source "${ks.displayName}": ${msg}`);
        }
      }
    }
  }

  return warnings;
}


/**
 * Set agent instructions by creating a GptComponentMetadata (type 15) component.
 * PAC copilot create does not create this from the JSON template — we must add it post-creation.
 */
export async function setAgentInstructions(
  environmentId: string,
  botId: string,
  agentName: string,
  instructions: string,
  botSchemaName: string,
): Promise<void> {
  const safeInstructions = truncateInstructions(instructions);

  const orgUrl = await resolveOrgUrl(environmentId);
  const token = await getDataverseToken(orgUrl);

  const schemaName = `${botSchemaName}.gpt.default`;

  const data = [
    "kind: GptComponentMetadata",
    `displayName: ${agentName}`,
    `instructions: ${safeInstructions.replace(/\n/g, "\\n")}`,
    "gptCapabilities:",
    "  webBrowsing: false",
    "  codeInterpreter: false",
  ].join("\n");

  const body = {
    componenttype: 15,
    name: "Agent 1",
    schemaname: schemaName,
    data,
    "parentbotid@odata.bind": `/bots(${botId})`,
  };

  const response = await fetch(`${orgUrl}/api/data/v9.2/botcomponents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to set agent instructions (${response.status}): ${errText}`);
  }

  log(`[Dataverse] Set instructions for bot ${botId} (${schemaName})`);
}
