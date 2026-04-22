/**
 * Entry point for Graph Connector Factory unified server.
 */

import { loadConfig } from "./config";
import { setDebugLogging } from "./logging/logger";
import { log } from "./logging/logger";
import { startHttpServer } from "./transport/httpHost";

function main(): void {
  const config = loadConfig();

  if (config.debugLogging) {
    setDebugLogging(true);
  }

  log(`Starting Graph Connector Factory v1.0.0-alpha.1`);
  log(`Config: ${config.id} (${config.description})`);

  const transport = process.env["MCP_TRANSPORT"] ?? "http";

  if (transport === "http") {
    startHttpServer({ config });
  } else {
    // Stdio transport for MCP — future implementation
    log("Stdio transport not yet implemented in unified server. Use MCP_TRANSPORT=http.");
    process.exit(1);
  }
}

main();
