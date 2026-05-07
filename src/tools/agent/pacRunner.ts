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

  log(`[PAC] Running: pac ${args.join(" ")}${cwd ? ` (cwd: ${cwd})` : ""}`);

  return new Promise<PacResult>((resolve) => {
    execFile(
      "pac",
      args,
      { timeout, cwd, maxBuffer: 10 * 1024 * 1024 },
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
    const result = await runPac(["--version"], { timeout: 10_000 });
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

/**
 * Get publisher prefix for a solution by querying Dataverse.
 * Falls back to "mme" if lookup fails (default for this environment).
 */
export async function getPublisherPrefix(
  environmentId: string,
  solutionName: string,
): Promise<string> {
  // For MVP, we use the known prefix for this environment.
  // The spike proved that "mme" is the correct prefix for GCF solutions.
  // A full implementation would query the Dataverse publisher API.
  log(`[PAC] Using publisher prefix "mme" for solution "${solutionName}"`);
  return "mme";
}
