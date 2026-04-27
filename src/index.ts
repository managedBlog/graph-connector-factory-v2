/**
 * Entry point for Graph Connector Factory unified server.
 */

import { loadConfig } from "./config";
import { setDebugLogging } from "./logging/logger";
import { log } from "./logging/logger";
import { startHttpServer } from "./transport/httpHost";
import { startStdioServer } from "./transport/stdioHost";

function main(): void {
  const config = loadConfig();

  if (config.debugLogging) {
    setDebugLogging(true);
  }

  log(`Starting Graph Connector Factory v1.0.0-alpha.1`);
  log(`Config: ${config.id} (${config.description})`);

  const transport = process.env["MCP_TRANSPORT"] ?? "http";

  if (transport === "stdio") {
    startStdioServer();
  } else if (transport === "http") {
    startHttpServer({ config });
  } else {
    log(`Unknown transport: ${transport}. Use MCP_TRANSPORT=http or MCP_TRANSPORT=stdio.`);
    process.exit(1);
  }
}

main();
