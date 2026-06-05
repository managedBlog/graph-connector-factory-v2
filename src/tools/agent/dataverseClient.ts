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
import type { KnowledgeSource } from "./types";
import { truncateInstructions } from "./instructionUtils";

class DataverseHttpError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number | undefined;

  constructor(message: string, status: number, retryAfterSeconds?: number | undefined) {
    super(message);
    this.name = "DataverseHttpError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dataverseRequest(
  orgUrl: string,
  token: string,
  path: string,
  options?: { method?: "GET" | "POST" | "PATCH"; body?: unknown; ifMatch?: string },
): Promise<Response> {
  const method = options?.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
    Accept: "application/json",
  };
  if (options?.ifMatch) {
    headers["If-Match"] = options.ifMatch;
  }

  const requestInit: RequestInit = { method, headers };
  if (options?.body != null) {
    requestInit.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${orgUrl}${path}`, requestInit);

  if (!response.ok) {
    const errText = await response.text();
    const retryAfterRaw = response.headers.get("Retry-After");
    const retryAfter = retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) : undefined;
    throw new DataverseHttpError(
      `Dataverse ${method} ${path} failed (${response.status}): ${errText}`,
      response.status,
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }

  return response;
}

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

const FLOW_BASE_PATH = "providers/Microsoft.ProcessSimple";
const BAP_ADMIN_BASE = "https://api.bap.microsoft.com";
const BAP_ADMIN_ENV_PATH = "providers/Microsoft.BusinessAppPlatform/scopes/admin/environments";
const ORG_URL_CACHE_TTL_MS = 5 * 60 * 1000;

interface OrgUrlCacheEntry {
  readonly orgUrl: string;
  readonly expiresAt: number;
}

const orgUrlCache = new Map<string, OrgUrlCacheEntry>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/[{}]/g, "");
}

function extractIdentifierCandidates(value: string): string[] {
  const candidates = new Set<string>();
  const trimmed = value.trim();
  if (!trimmed) return [];

  candidates.add(normalizeIdentifier(trimmed));

  const envPathMatch = trimmed.match(/\/environments\/([^\/\s?]+)/i);
  if (envPathMatch?.[1]) {
    candidates.add(normalizeIdentifier(envPathMatch[1]));
  }

  const guidMatch = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (guidMatch?.[0]) {
    candidates.add(normalizeIdentifier(guidMatch[0]));
  }

  return [...candidates];
}

function isServicePrincipalMode(authMethod: string): boolean {
  return authMethod === "appOnly" || authMethod === "clientCredential" || authMethod === "certificate";
}

function extractOrgUrlFromEnvironment(env: Record<string, unknown>): string | undefined {
  const properties = asRecord(env["properties"]);
  const linkedMetadata = asRecord(properties?.["linkedEnvironmentMetadata"]);
  const runtimeEndpoints = asRecord(properties?.["runtimeEndpoints"]);
  const candidates = [
    getNonEmptyString(linkedMetadata?.["instanceUrl"]),
    getNonEmptyString(linkedMetadata?.["environmentUrl"]),
    getNonEmptyString(properties?.["instanceUrl"]),
    getNonEmptyString(properties?.["environmentUrl"]),
    getNonEmptyString(runtimeEndpoints?.["dataverse"]),
    getNonEmptyString(runtimeEndpoints?.["microsoftDataverse"]),
  ];

  for (const candidate of candidates) {
    if (candidate?.startsWith("https://")) {
      return candidate.replace(/\/$/, "");
    }
  }
  return undefined;
}

function environmentMatchesId(
  env: Record<string, unknown>,
  targetCandidates: readonly string[],
): boolean {
  const properties = asRecord(env["properties"]);
  const ids = [
    getNonEmptyString(env["name"]),
    getNonEmptyString(env["id"]),
    getNonEmptyString(properties?.["environmentId"]),
  ].filter((value): value is string => Boolean(value));

  const environmentCandidates = new Set<string>();
  for (const id of ids) {
    for (const candidate of extractIdentifierCandidates(id)) {
      environmentCandidates.add(candidate);
    }
  }

  for (const targetCandidate of targetCandidates) {
    if (environmentCandidates.has(targetCandidate)) {
      return true;
    }
    for (const id of ids) {
      if (normalizeIdentifier(id).includes(targetCandidate)) {
        return true;
      }
    }
  }

  return false;
}

async function listPowerPlatformEnvironments(): Promise<Record<string, unknown>[]> {
  const config = loadConfig();
  const credential = createCredentialProvider(config.powerPlatform.auth);
  const tokenResult = await credential.getToken(config.powerPlatform.auth.scope);
  if (!tokenResult.accessToken) {
    throw new Error("Power Platform environment lookup failed: empty token received.");
  }

  const isServicePrincipal = isServicePrincipalMode(config.powerPlatform.auth.method);
  const environmentsUrl = isServicePrincipal
    ? `${BAP_ADMIN_BASE}/${BAP_ADMIN_ENV_PATH}?api-version=${config.powerPlatform.flowApiVersion}`
    : `${config.powerPlatform.flowApiUrl}/${FLOW_BASE_PATH}/environments?api-version=${config.powerPlatform.flowApiVersion}`;

  const response = await fetch(environmentsUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${tokenResult.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Power Platform environment lookup failed (${response.status}): ${errText}`);
  }

  const payload = (await response.json()) as { value?: unknown };
  if (!Array.isArray(payload.value)) {
    return [];
  }

  return payload.value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

/**
 * Resolve a Power Platform environment ID to its Dataverse org URL.
 * Uses the same Power Platform API auth context as environment listing.
 */
export async function resolveOrgUrl(environmentId: string): Promise<string> {
  const targetCandidates = extractIdentifierCandidates(environmentId);
  if (targetCandidates.length === 0) {
    throw new Error("Environment ID is required to resolve Dataverse org URL.");
  }
  const cacheKey = targetCandidates[0]!;
  const cached = orgUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.orgUrl;
  }

  const environments = await listPowerPlatformEnvironments();
  for (const env of environments) {
    if (!environmentMatchesId(env, targetCandidates)) {
      continue;
    }
    const orgUrl = extractOrgUrlFromEnvironment(env);
    if (!orgUrl) {
      throw new Error(
        `Environment ${environmentId} does not have a linked Dataverse organization URL.`,
      );
    }
    const cacheEntry: OrgUrlCacheEntry = {
      orgUrl,
      expiresAt: Date.now() + ORG_URL_CACHE_TTL_MS,
    };
    orgUrlCache.set(cacheKey, cacheEntry);
    log(`[Dataverse] Resolved env ${environmentId} → ${orgUrl}`);
    return orgUrl;
  }

  throw new Error(
    `Could not resolve org URL for environment ${environmentId} from Power Platform environments API.`,
  );
}

interface BotLookupRow {
  readonly botid: string;
  readonly schemaname?: string | undefined;
  readonly name?: string | undefined;
  readonly modifiedon?: string | undefined;
}

/**
 * Resolve bot ID after PAC create using safe fallback lookup when stdout parsing misses the GUID.
 */
export async function resolveBotIdForPostCreate(input: {
  environmentId: string;
  pacAgentId?: string | undefined;
  botSchemaName: string;
  agentName: string;
}): Promise<string | undefined> {
  if (input.pacAgentId) return input.pacAgentId;

  const orgUrl = await resolveOrgUrl(input.environmentId);

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const token = await getDataverseToken(orgUrl);

    const bySchemaPath =
      `/api/data/v9.2/bots?` +
      `$select=botid,schemaname,name,modifiedon&` +
      `$filter=schemaname eq '${input.botSchemaName.replace(/'/g, "''")}'&` +
      `$orderby=modifiedon desc&$top=10`;

    const bySchemaResp = await dataverseRequest(orgUrl, token, bySchemaPath);
    const bySchemaJson = (await bySchemaResp.json()) as { value?: BotLookupRow[] };
    const bySchema = bySchemaJson.value ?? [];

    if (bySchema.length === 1) {
      return bySchema[0]!.botid;
    }
    if (bySchema.length > 1) {
      const nameFiltered = bySchema.filter((b) => b.name === input.agentName);
      if (nameFiltered.length === 1) {
        return nameFiltered[0]!.botid;
      }
      throw new Error(
        `Ambiguous bot lookup for schema "${input.botSchemaName}" (matches: ${bySchema.length}).`,
      );
    }

    const byNamePath =
      `/api/data/v9.2/bots?` +
      `$select=botid,schemaname,name,modifiedon&` +
      `$filter=name eq '${input.agentName.replace(/'/g, "''")}'&` +
      `$orderby=modifiedon desc&$top=2`;
    const byNameResp = await dataverseRequest(orgUrl, token, byNamePath);
    const byNameJson = (await byNameResp.json()) as { value?: BotLookupRow[] };
    const byName = byNameJson.value ?? [];
    if (byName.length === 1 && byName[0]?.schemaname === input.botSchemaName) {
      return byName[0]!.botid;
    }
    if (byName.length === 1 && attempt === maxAttempts) {
      throw new Error(
        `Bot lookup by name found non-matching schema "${byName[0]?.schemaname ?? ""}" (expected "${input.botSchemaName}").`,
      );
    }

    if (attempt < maxAttempts) {
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }

  return undefined;
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
 * Derive a meaningful display name for a knowledge source.
 * If the name is generic (e.g., "SharePoint Source 1"), extract the site name from the URL.
 * Example: "https://tenant.sharepoint.com/sites/ServiceDesk" → "ServiceDesk"
 */
function deriveKnowledgeSourceName(ks: KnowledgeSource): string {
  const generic = /^SharePoint\s+(Source|Knowledge\s+Source)\s*\d*$/i;
  if (ks.displayName && !generic.test(ks.displayName)) {
    return ks.displayName;
  }

  // Extract site name from URL path
  if (ks.url) {
    try {
      const url = new URL(ks.url);
      const segments = url.pathname.split("/").filter(Boolean);
      // Common patterns: /sites/SiteName or /teams/TeamName
      const siteIdx = segments.findIndex((s) => s === "sites" || s === "teams");
      const siteName = siteIdx >= 0 ? segments[siteIdx + 1] : undefined;
      if (siteName) {
        return decodeURIComponent(siteName);
      }
      // Fallback: last path segment
      const last = segments[segments.length - 1];
      if (last) return decodeURIComponent(last);
    } catch {
      // URL parse failed — fall through
    }
  }

  return ks.displayName || "SharePoint Knowledge Source";
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
  // Derive a meaningful name from the URL if the display name is generic
  const displayName = deriveKnowledgeSourceName(ks);
  const sanitizedName = sanitizeForSchema(displayName);
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
    name: displayName,
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

  log(`[Dataverse] Added knowledge source "${displayName}" to bot ${botId}`);
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
  const schemaName = `${botSchemaName}.gpt.default`;

  // YAML-safe: double-quote the instructions value and escape special chars
  const yamlEscapedInstructions = safeInstructions
    .replace(/\\/g, "\\\\")   // escape backslashes
    .replace(/"/g, '\\"')     // escape double quotes
    .replace(/\n/g, "\\n");   // newlines as literal \n

  const data = [
    "kind: GptComponentMetadata",
    `displayName: ${agentName}`,
    `instructions: "${yamlEscapedInstructions}"`,
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

  const maxAttempts = 5;
  let authRetryUsed = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const token = await getDataverseToken(orgUrl);
      const findPath =
        `/api/data/v9.2/botcomponents?` +
        `$select=botcomponentid,componenttype,schemaname,data,parentbotid,modifiedon&` +
        `$filter=schemaname eq '${schemaName.replace(/'/g, "''")}'&$top=10`;
      const existingResp = await dataverseRequest(orgUrl, token, findPath);
      const existingJson = (await existingResp.json()) as {
        value?: Array<{
          botcomponentid: string;
          componenttype?: number;
          schemaname?: string;
          data?: string;
          parentbotid?: string;
          "@odata.etag"?: string;
        }>;
      };
      const rows = existingJson.value ?? [];
      const candidates = rows.filter((r) => (r.componenttype ?? -1) === 15);
      const exactParent = candidates.filter((r) => (r.parentbotid ?? "").toLowerCase() === botId.toLowerCase());

      if (exactParent.length > 1) {
        throw new Error(`Ambiguous instruction components for ${schemaName} on bot ${botId}.`);
      }
      if (exactParent.length === 1) {
        const row = exactParent[0]!;
        await dataverseRequest(
          orgUrl,
          token,
          `/api/data/v9.2/botcomponents(${row.botcomponentid})`,
          {
            method: "PATCH",
            body: { data },
            ifMatch: row["@odata.etag"] ?? "*",
          },
        );
      } else {
        await dataverseRequest(orgUrl, token, "/api/data/v9.2/botcomponents", {
          method: "POST",
          body,
        });
      }

      const verifyResp = await dataverseRequest(orgUrl, token, findPath);
      const verifyJson = (await verifyResp.json()) as {
        value?: Array<{
          botcomponentid: string;
          componenttype?: number;
          schemaname?: string;
          data?: string;
          parentbotid?: string;
        }>;
      };
      const verify = (verifyJson.value ?? []).filter(
        (r) =>
          (r.componenttype ?? -1) === 15 &&
          (r.parentbotid ?? "").toLowerCase() === botId.toLowerCase() &&
          r.schemaname === schemaName,
      );
      if (verify.length !== 1) {
        throw new Error(`Instruction verify failed for ${schemaName}: expected 1 component, found ${verify.length}.`);
      }
      if ((verify[0]?.data ?? "") !== data) {
        throw new Error(`Instruction verify failed for ${schemaName}: stored data mismatch.`);
      }

      log(`[Dataverse] Set instructions for bot ${botId} (${schemaName})`);
      return;
    } catch (err) {
      if (err instanceof DataverseHttpError) {
        if (err.status === 401 && !authRetryUsed) {
          authRetryUsed = true;
          continue;
        }
        if (isTransientStatus(err.status) && attempt < maxAttempts) {
          const waitMs = (err.retryAfterSeconds ?? Math.pow(2, attempt)) * 1000;
          await sleep(waitMs);
          continue;
        }
      }
      if (
        err instanceof Error &&
        err.message.startsWith("Instruction verify failed") &&
        attempt < maxAttempts
      ) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed to set agent instructions after ${maxAttempts} attempts.`);
}

/**
 * Verify whether the target agent already has a persisted instruction component.
 */
export async function hasAgentInstructions(
  environmentId: string,
  botId: string,
  botSchemaName: string,
): Promise<boolean> {
  const schemaName = `${botSchemaName}.gpt.default`;
  const orgUrl = await resolveOrgUrl(environmentId);
  const token = await getDataverseToken(orgUrl);
  const findPath =
    `/api/data/v9.2/botcomponents?` +
    `$select=botcomponentid,componenttype,schemaname,data,_parentbotid_value&` +
    `$filter=schemaname eq '${schemaName.replace(/'/g, "''")}' and componenttype eq 15&$top=10`;
  const existingResp = await dataverseRequest(orgUrl, token, findPath);
  const existingJson = (await existingResp.json()) as {
    value?: Array<{
      componenttype?: number;
      schemaname?: string;
      data?: string;
      _parentbotid_value?: string;
    }>;
  };
  const match = (existingJson.value ?? []).find(
    (row) =>
      (row.componenttype ?? -1) === 15 &&
      row.schemaname === schemaName &&
      (row._parentbotid_value ?? "").toLowerCase() === botId.toLowerCase(),
  );
  return Boolean(match);
}

/**
 * Ensure bot description reflects the purpose entered in AgentFactory.
 */
export async function setAgentDescription(
  environmentId: string,
  botId: string,
  description: string,
): Promise<void> {
  const trimmed = description.trim();
  if (!trimmed) return;

  const orgUrl = await resolveOrgUrl(environmentId);
  const maxAttempts = 5;
  let authRetryUsed = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const token = await getDataverseToken(orgUrl);
      await dataverseRequest(orgUrl, token, `/api/data/v9.2/bots(${botId})`, {
        method: "PATCH",
        body: { description: trimmed },
        ifMatch: "*",
      });

      const verifyResp = await dataverseRequest(
        orgUrl,
        token,
        `/api/data/v9.2/bots(${botId})?$select=description`,
      );
      const verifyJson = (await verifyResp.json()) as { description?: string };
      if ((verifyJson.description ?? "").trim() !== trimmed) {
        throw new Error("Description verify mismatch after PATCH.");
      }
      log(`[Dataverse] Set description for bot ${botId}`);
      return;
    } catch (err) {
      if (err instanceof DataverseHttpError) {
        if (err.status === 401 && !authRetryUsed) {
          authRetryUsed = true;
          continue;
        }
        // Newly created bots can lag briefly before description PATCH succeeds.
        if (err.status === 404 && attempt < maxAttempts) {
          await sleep(Math.pow(2, attempt) * 1000);
          continue;
        }
        if (isTransientStatus(err.status) && attempt < maxAttempts) {
          const waitMs = (err.retryAfterSeconds ?? Math.pow(2, attempt)) * 1000;
          await sleep(waitMs);
          continue;
        }
      }
      if (
        err instanceof Error &&
        err.message === "Description verify mismatch after PATCH." &&
        attempt < maxAttempts
      ) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed to set agent description after ${maxAttempts} attempts.`);
}
