/**
 * PAC CLI wrapper for executing Power Platform commands from Node.js.
 *
 * Uses child_process.execFile to run PAC commands with explicit error handling.
 * PAC must be installed and have an active auth profile.
 */

import { execFile } from "child_process";
import { log, logError } from "../../logging/logger";

export interface PacResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes

/**
 * Run a PAC CLI command and capture output.
 */
export async function runPac(
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<PacResult> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const cwd = options?.cwd;
  const useShell = process.platform === "win32";
  const pacExecutable = process.env.PAC_CLI_PATH?.trim() || "pac";

  log(`[PAC] Running: ${pacExecutable} ${args.join(" ")}${cwd ? ` (cwd: ${cwd})` : ""}`);

  return new Promise<PacResult>((resolve) => {
    execFile(
      pacExecutable,
      args,
      { timeout, cwd, maxBuffer: 10 * 1024 * 1024, shell: useShell },
      (error, stdout, stderr) => {
        const exitCode = error && "code" in error ? (error.code as number) ?? 1 : 0;

        if (error && !("code" in error)) {
          logError(`[PAC] Execution error: ${error.message}`);
          resolve({
            success: false,
            stdout: stdout ?? "",
            stderr: stderr ?? error.message,
            exitCode: 1,
          });
          return;
        }

        const success = exitCode === 0;
        if (!success) {
          log(`[PAC] Command failed (exit ${exitCode}): ${stderr || stdout}`);
        } else {
          log(`[PAC] Command succeeded (${stdout.split("\n").length} lines output)`);
        }

        resolve({ success, stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
      },
    );
  });
}

/**
 * Check if PAC CLI is installed and accessible.
 */
export async function isPacAvailable(): Promise<boolean> {
  try {
    const result = await runPac(["help"], { timeout: 10_000 });
    return result.success;
  } catch {
    return false;
  }
}

/**
 * Get the active PAC auth profile information.
 * Returns null if no active profile or PAC is not available.
 */
export async function getPacAuthInfo(): Promise<{
  user: string;
  environment?: string | undefined;
} | null> {
  const result = await runPac(["auth", "list"], { timeout: 15_000 });
  if (!result.success) return null;

  // Parse "Connected as {user}" from output
  const userMatch = result.stdout.match(/Connected as\s+(.+)/i);
  const envMatch = result.stdout.match(/Environment:\s*(.+)/i);

  if (userMatch) {
    return {
      user: userMatch[1]!.trim(),
      environment: envMatch?.[1]?.trim() ?? undefined,
    };
  }
  return null;
}

/**
 * Create a Copilot Studio agent from a template.
 */
export async function pacCopilotCreate(params: {
  displayName: string;
  schemaName: string;
  templateFileName: string;
  solution: string;
  environmentId: string;
}): Promise<PacResult & { agentId?: string | undefined; agentUrl?: string | undefined }> {
  const args = [
    "copilot", "create",
    "--displayName", params.displayName,
    "--schemaName", params.schemaName,
    "--templateFileName", params.templateFileName,
    "--solution", params.solution,
    "--environment", params.environmentId,
  ];

  const result = await runPac(args, {
    // pac copilot create can take 60+ seconds
    timeout: 300_000,
  });

  // Parse agent ID and URL from output
  let agentId: string | undefined;
  let agentUrl: string | undefined;

  // Output pattern: "with id {guid}"
  const idMatch = result.stdout.match(/with id\s+([0-9a-f-]{36})/i);
  if (idMatch) {
    agentId = idMatch[1];
  }

  // Output pattern: "Copilot created successfully: {url}"
  const urlMatch = result.stdout.match(/Copilot created successfully:\s+(https:\/\/\S+)/i);
  if (urlMatch) {
    agentUrl = urlMatch[1];
  }

  return { ...result, agentId: agentId ?? undefined, agentUrl: agentUrl ?? undefined };
}

export interface SolutionListEntry {
  uniqueName: string;
  friendlyName: string;
  publisherPrefix: string;
}

export interface SolutionNamePreflight {
  originalName: string;
  normalizedName: string;
  isValid: boolean;
  exists: boolean;
  message: string | undefined;
}

function sanitizeSolutionName(rawName: string): string {
  const trimmed = rawName.trim();
  const replaced = trimmed.replace(/[^A-Za-z0-9_]/g, "_");
  const collapsed = replaced.replace(/_+/g, "_");
  const stripped = collapsed.replace(/^_+|_+$/g, "");
  const prefixed = /^[A-Za-z]/.test(stripped) ? stripped : `S_${stripped}`;
  return prefixed.slice(0, 65);
}

function validateSolutionUniqueName(name: string): { valid: boolean; reason?: string } {
  if (!name.trim()) {
    return { valid: false, reason: "Solution name is required." };
  }
  if (name.length > 65) {
    return { valid: false, reason: "Solution name must be 65 characters or fewer." };
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    return {
      valid: false,
      reason: "Solution unique name must start with a letter and contain only letters, numbers, or underscores.",
    };
  }
  return { valid: true };
}

async function querySolutionByUniqueName(
  environmentId: string,
  solutionName: string,
): Promise<{ exists: boolean; publisherPrefix: string | undefined }> {
  const { resolveOrgUrl, getDataverseToken } = await import("./dataverseClient");
  const orgUrl = await resolveOrgUrl(environmentId);
  const token = await getDataverseToken(orgUrl);
  const escapedName = solutionName.replace(/'/g, "''");
  const uri =
    `${orgUrl}/api/data/v9.2/solutions?` +
    `$filter=uniquename eq '${escapedName}'&` +
    `$select=uniquename&` +
    `$expand=publisherid($select=customizationprefix)&$top=1`;
  const response = await fetch(uri, {
    headers: {
      Authorization: `Bearer ${token}`,
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to query solution "${solutionName}": ${response.status} ${errText}`);
  }
  const json = (await response.json()) as {
    value?: Array<{ publisherid?: { customizationprefix?: string } }>;
  };
  const row = json.value?.[0];
  if (!row) {
    return { exists: false, publisherPrefix: undefined };
  }
  return { exists: true, publisherPrefix: row.publisherid?.customizationprefix };
}

export async function preflightSolutionName(
  environmentId: string,
  rawSolutionName: string,
): Promise<SolutionNamePreflight> {
  const originalName = rawSolutionName ?? "";
  const normalizedName = sanitizeSolutionName(originalName);
  const validation = validateSolutionUniqueName(originalName.trim());
  const normalizedValidation = validateSolutionUniqueName(normalizedName);

  if (!validation.valid) {
    return {
      originalName,
      normalizedName,
      isValid: false,
      exists: false,
      message: validation.reason,
    };
  }

  if (!normalizedValidation.valid) {
    return {
      originalName,
      normalizedName,
      isValid: false,
      exists: false,
      message: normalizedValidation.reason,
    };
  }

  const existing = await querySolutionByUniqueName(environmentId, normalizedName);
  return {
    originalName,
    normalizedName,
    isValid: true,
    exists: existing.exists,
    message: undefined,
  };
}

export async function listSolutions(
  environmentId: string,
): Promise<SolutionListEntry[]> {
  const { resolveOrgUrl, getDataverseToken } = await import("./dataverseClient");
  const orgUrl = await resolveOrgUrl(environmentId);
  const token = await getDataverseToken(orgUrl);
  const uri =
    `${orgUrl}/api/data/v9.2/solutions?` +
    `$select=uniquename,friendlyname,ismanaged&` +
    `$expand=publisherid($select=customizationprefix)&` +
    `$filter=ismanaged eq false&$orderby=uniquename asc&$top=200`;

  const response = await fetch(uri, {
    headers: {
      Authorization: `Bearer ${token}`,
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to list solutions: ${response.status} ${errText}`);
  }
  const data = (await response.json()) as {
    value?: Array<{
      uniquename?: string;
      friendlyname?: string;
      publisherid?: { customizationprefix?: string };
    }>;
  };
  const seen = new Set<string>();
  const items: SolutionListEntry[] = [];
  for (const row of data.value ?? []) {
    const uniqueName = row.uniquename?.trim();
    if (!uniqueName || seen.has(uniqueName)) continue;
    seen.add(uniqueName);
    items.push({
      uniqueName,
      friendlyName: row.friendlyname?.trim() || uniqueName,
      publisherPrefix: row.publisherid?.customizationprefix?.trim() || "mme",
    });
  }
  return items;
}

/**
 * Get publisher prefix for a solution by querying Dataverse.
 * Falls back to "mme" if lookup fails (default for this environment).
 */
export async function getPublisherPrefix(
  environmentId: string,
  solutionName: string,
): Promise<string> {
  try {
    const existing = await querySolutionByUniqueName(environmentId, solutionName);
    if (existing.publisherPrefix) {
      log(`[PAC] Resolved publisher prefix "${existing.publisherPrefix}" for solution "${solutionName}"`);
      return existing.publisherPrefix;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[PAC] Publisher prefix lookup failed (using fallback): ${msg}`);
  }

  log(`[PAC] Using fallback publisher prefix "mme" for solution "${solutionName}"`);
  return "mme";
}

/**
 * Ensure target solution exists; create it when missing using Dataverse Web API.
 * Returns whether creation occurred and the publisher prefix for downstream schema naming.
 */
export async function ensureSolutionExists(
  environmentId: string,
  solutionName: string,
): Promise<{ created: boolean; publisherPrefix: string }> {
  const normalizedName = sanitizeSolutionName(solutionName);
  const validation = validateSolutionUniqueName(normalizedName);
  if (!validation.valid) {
    throw new Error(validation.reason ?? "Invalid solution name.");
  }
  const existing = await querySolutionByUniqueName(environmentId, normalizedName);
  if (existing.exists) {
    return { created: false, publisherPrefix: existing.publisherPrefix || "mme" };
  }

  const { resolveOrgUrl, getDataverseToken } = await import("./dataverseClient");
  const orgUrl = await resolveOrgUrl(environmentId);
  const token = await getDataverseToken(orgUrl);

  const defaultPublisherUri =
    `${orgUrl}/api/data/v9.2/publishers?` +
    `$select=publisherid,customizationprefix,uniquename&` +
    `$filter=isdefaultpublisher eq true&$top=1`;
  const publisherResp = await fetch(defaultPublisherUri, {
    headers: {
      Authorization: `Bearer ${token}`,
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
    },
  });
  if (!publisherResp.ok) {
    const errText = await publisherResp.text();
    throw new Error(`Failed to query default publisher: ${publisherResp.status} ${errText}`);
  }
  const publisherJson = (await publisherResp.json()) as {
    value?: Array<{
      publisherid?: string;
      customizationprefix?: string;
    }>;
  };
  const publisherId = publisherJson.value?.[0]?.publisherid;
  const publisherPrefix = publisherJson.value?.[0]?.customizationprefix;

  if (!publisherId) {
    throw new Error(`Could not resolve the default publisher to create solution "${solutionName}".`);
  }
  log(`[PAC] Resolved default publisher for "${normalizedName}" (prefix "${publisherPrefix || "mme"}")`);

  const createResp = await fetch(`${orgUrl}/api/data/v9.2/solutions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
    },
    body: JSON.stringify({
      uniquename: normalizedName,
      friendlyname: normalizedName,
      version: "1.0.0.0",
      "publisherid@odata.bind": `/publishers(${publisherId})`,
    }),
  });
  if (!createResp.ok) {
    const errText = await createResp.text();
    throw new Error(`Failed to create solution "${normalizedName}": ${createResp.status} ${errText}`);
  }

  log(`[PAC] Created missing solution "${normalizedName}"`);
  return {
    created: true,
    publisherPrefix: publisherPrefix || "mme",
  };
}

/**
 * Resolve environment ID to the format PAC CLI expects.
 *
 * The session context may provide a Dataverse org ID (from the org URL)
 * but PAC CLI needs the Power Platform environment GUID. This function
 * runs `pac env list` and matches by org URL to find the correct GUID.
 *
 * If the provided ID already works as a PAC environment GUID, returns it as-is.
 */
export async function resolveEnvironmentId(envIdOrOrgId: string): Promise<string> {
  // Quick check: run pac env list and look for a match
  const result = await runPac(["env", "list"], { timeout: 30_000 });
  if (!result.success) {
    log(`[PAC] env list failed, using provided ID as-is: ${envIdOrOrgId}`);
    return envIdOrOrgId;
  }

  // If the provided ID is already a valid environment GUID in the list, use it
  if (result.stdout.includes(envIdOrOrgId)) {
    log(`[PAC] Environment ID ${envIdOrOrgId} found directly in env list`);
    return envIdOrOrgId;
  }

  // Try matching by Dataverse org URL containing the org ID
  // pac env list output has columns: Index, Active, Display Name, Environment ID, URL, ...
  // The URL column contains the Dataverse org URL like https://orgXXXXXXXX.crm.dynamics.com/
  const lines = result.stdout.split(/\r?\n/);
  for (const line of lines) {
    if (line.toLowerCase().includes(envIdOrOrgId.toLowerCase().replace(/-/g, ""))) {
      // Found a line matching the org ID — extract the environment GUID
      const guidMatch = line.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (guidMatch) {
        const resolved = guidMatch[1]!;
        if (resolved !== envIdOrOrgId) {
          log(`[PAC] Resolved Dataverse org ID ${envIdOrOrgId} → environment GUID ${resolved}`);
          return resolved;
        }
      }
    }
  }

  // Fallback: try matching org URL pattern (orgXXXXXXXX)
  // The Dataverse org ID is often embedded in the URL as org{id-without-dashes}
  const orgIdNoDashes = envIdOrOrgId.replace(/-/g, "");
  for (const line of lines) {
    if (line.includes(`org${orgIdNoDashes}`)) {
      const guidMatch = line.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (guidMatch && guidMatch[1] !== envIdOrOrgId) {
        log(`[PAC] Resolved via org URL pattern org${orgIdNoDashes} → ${guidMatch[1]}`);
        return guidMatch[1]!;
      }
    }
  }

  log(`[PAC] Could not resolve ${envIdOrOrgId} from env list, using as-is`);
  return envIdOrOrgId;
}
