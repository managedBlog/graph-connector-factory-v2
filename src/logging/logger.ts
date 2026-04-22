/**
 * Stderr-only logger. Keeps stdout clean for JSON-RPC protocol messages.
 */

let _debugEnabled = false;

/** Enable or disable debug logging from config. Env var MCP_DEBUG=1 always wins. */
export function setDebugLogging(enabled: boolean): void {
  _debugEnabled = enabled;
}

function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

export function log(message: string): void {
  process.stderr.write(`${ts()} [graph-connector] ${message}\n`);
}

export function logError(message: string): void {
  process.stderr.write(`${ts()} [graph-connector][ERROR] ${message}\n`);
}

export function logWarn(message: string): void {
  process.stderr.write(`${ts()} [graph-connector][WARN] ${message}\n`);
}

export function logDebug(message: string): void {
  if (_debugEnabled || process.env["MCP_DEBUG"] === "1") {
    process.stderr.write(`${ts()} [graph-connector][DEBUG] ${message}\n`);
  }
}
