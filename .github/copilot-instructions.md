<!-- Use this file to provide workspace-specific custom instructions to Copilot. -->

# Graph Connector Factory v2

Unified MCP server and Copilot Studio agent for creating Power Platform custom connectors
from Microsoft Graph API endpoints. **Deployment-ready** — tested end-to-end against live
Power Platform environment.

## Architecture

- **Single Node.js server** on port 3001 — Express HTTP serving REST endpoints + streamable HTTP MCP
- **Two custom connectors**: GCF REST Connector (10 topic action operations), GCF MCP Agent (AI research via MCP)
- **Two first-party MCP connectors**: MCP Server for Enterprise, Microsoft Learn Docs MCP
- **Two-solution-import pattern**: connector solution (tokenized, packed at deploy) → agent solution (static)
- **Two-app Entra pattern**: API app (server credentials, Graph permissions, MCP.access scope) +
  Client app (connector OAuth, redirect URIs, FICs created after connector import)
- **8-stage install pipeline**: Preflight → Build → Entra → Config → Artifacts → Connectors → FIC → Agent

## Key Decisions

- **D1**: All endpoints require OAuth — no NoAuth connectors
- **D2**: Purpose-built for connector creation (not a general-purpose swagger generator)
- **D3**: LESSONS-LEARNED.md is internal build reference only, not committed to public repo

## Connection References (4 total)

1. GCF REST Connector (custom) — REST topic actions (10 operations)
2. GCF MCP Agent (custom) — CSDL-aware swagger generation via MCP protocol
3. MCP Server for Enterprise (custom, first-party) — deep Graph API knowledge
4. Microsoft Learn Docs MCP (first-party) — documentation search

## Repository Structure

```
src/
  index.ts                    # Entry point — transport selection
  auth/                       # Token validation, credential providers (secret, cert, managed identity)
  config/                     # Config loader with zero-config defaults
  transport/httpHost.ts       # Express server — 16 routes (10 API + 6 infra)
  transport/mcpAdapter.ts     # MCP JSON-RPC 2.0 adapter
  tools/registry.ts           # Unified tool dispatcher (graph_*, connector_*, appreg_*)
  tools/graph/                # CSDL parsing, Swagger 2.0 generation, schema normalization
  tools/connector/            # Power Platform connector CRUD
  tools/appreg/               # Entra app registration management
  tools/deploy/pipeline.ts    # Three-step deploy: app reg → connector → FIC
  logging/                    # Stderr logger (stdout clean for JSON-RPC)
  output/                     # Gist publisher
  policies/                   # Autonomy mode, operation guards
  prompts/                    # MCP prompt templates
config/                       # config.template.json + config.json (gitignored)
artifacts/connectors/         # Swagger + apiProperties templates (tokenized)
scripts/                      # Install-GraphConnectorFactory.ps1, Prepare-Artifacts.ps1
copilot-studio/               # Agent YAML + solution source files
docs/                         # INSTALLATION.md, API.md
```

## Build & Run

```bash
npm install
npm run build        # TypeScript compile
npm run start:http   # Start HTTP server on port 3001
npm start            # Same as start:http (HTTP is the default transport)
npm run dev          # TypeScript watch mode
```

## Key Environment Variables

- `MCP_TRANSPORT` — `http` (default)
- `MCP_CONFIG_PATH` — config file path (default: `./config/config.json`)
- `MCP_DEBUG` — set to `1` for verbose logging
- `GCF_CLIENT_SECRET` — client secret for server auth (avoids storing in config)
- `GRAPH_CONNECTOR_GIST_TOKEN` — GitHub PAT for Gist publishing
