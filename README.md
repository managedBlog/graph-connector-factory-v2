# Graph Connector Factory v2

A unified MCP server and Copilot Studio agent for creating Power Platform custom connectors
from Microsoft Graph API endpoints.

Graph Connector Factory (GCF) lets you research Graph API endpoints, generate
Swagger 2.0 connector definitions, and deploy them to Power Platform — all
orchestrated through a Copilot Studio conversational agent or direct REST calls.

## Architecture

```
┌──────────────────────────────┐
│   Copilot Studio Agent       │  Conversational UI
│   (topics + actions)         │  ─ researches Graph endpoints
│                              │  ─ generates connectors
│                              │  ─ deploys to Power Platform
└──────┬──────────┬────────────┘
       │ REST     │ MCP (Streamable HTTP)
       ▼          ▼
┌──────────────────────────────┐
│   GCF Server (Node.js)       │  Single process, port 3001
│   ─ 10 REST API endpoints    │  ─ topic actions for agent
│   ─ MCP JSON-RPC endpoint    │  ─ AI tool invocation
│   ─ Graph CSDL parser        │  ─ metadata → operations
│   ─ Swagger 2.0 generator    │  ─ operations → connector
│   ─ Deploy pipeline          │  ─ connector → Power Platform
└──────────────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│   Microsoft Graph API        │  CSDL metadata + runtime calls
│   Power Platform APIs        │  Connector + solution management
│   Microsoft Entra ID         │  App registrations + FICs
└──────────────────────────────┘
```

**Key design decisions:**

- **Single server** — replaces the legacy 5-app A2A architecture with direct function calls
- **HTTP transport** — Express server exposing REST endpoints + streamable HTTP MCP endpoint
- **Two-app Entra pattern** — API app (server credentials, Graph permissions) + Client app (connector OAuth, redirect URIs, FICs)
- **Two-solution import** — connector solution (tokenized, packed at deploy time) + agent solution (static, connectors stripped)
- **Federated Identity Credentials** — avoids client secrets in connectors; uses FICs discovered after connector import

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | ≥ 18.0.0 | Server runtime |
| [Azure CLI](https://learn.microsoft.com/cli/azure/) | Latest | Entra app registration |
| [Power Platform CLI](https://learn.microsoft.com/power-platform/developer/cli/introduction) | Latest | Solution import (`pac`) |
| PowerShell | 5.1+ or 7+ | Installation scripts |

You also need:

- A **Microsoft Entra ID tenant** with permissions to create app registrations
- A **Power Platform environment** with permission to import solutions
- (Optional) A **GitHub Personal Access Token** for publishing generated connectors as Gists

## Quick Start

```bash
# Clone and build
git clone https://github.com/managedBlog/graph-connector-factory-v2.git
cd graph-connector-factory-v2
npm install
npm run build

# Configure (copy template and fill in your values)
cp config/config.template.json config/config.json
# Edit config/config.json with your tenant, app IDs, etc.

# Run the server
npm run start:http
```

The server starts on `http://localhost:3001`. Verify with:

```bash
curl http://localhost:3001/health
```

For full deployment to Power Platform (app registrations, connector import, agent import),
see the [Installation Guide](docs/INSTALLATION.md).

## Configuration

Copy `config/config.template.json` to `config/config.json` and fill in your values.
The config file is gitignored — it contains tenant-specific IDs but no secrets.

### Key sections

| Section | Purpose |
|---------|---------|
| `server` | Auth mode (`noauth` / `authenticated`), port, token validation |
| `graphResearch` | Graph API version, CSDL cache TTL, max operations per connector |
| `powerPlatform` | Power Platform API URLs, environment ID, auth credentials |
| `graphApi` | Graph API base URL, auth credentials |
| `deploy` | Default auth type (FederatedIdentity), naming prefix |
| `policies` | Risk tolerance, delete protection, autonomy mode |
| `output` | Output directory, TTL, Gist publishing |

### Environment variables

| Variable | Purpose |
|----------|---------|
| `MCP_TRANSPORT` | Transport mode: `http` (default) |
| `MCP_CONFIG_PATH` | Override config file path (default: `./config/config.json`) |
| `MCP_DEBUG` | Set to `1` for debug logging |
| `GCF_CLIENT_SECRET` | Client secret for server auth (avoids storing in config) |
| `GRAPH_CONNECTOR_GIST_TOKEN` | GitHub PAT for Gist publishing |

### Server authentication

The server supports three auth methods for its own credentials (calling Graph API and Power Platform):

| Method | Config `auth.method` | Notes |
|--------|---------------------|-------|
| Client Secret | `clientCredential` | Secret via `GCF_CLIENT_SECRET` env var or config |
| Certificate | `certificate` | PEM file in `config/` directory |
| Managed Identity | `managedIdentity` | For Azure-hosted deployments |

## API Reference

See the full [API Reference](docs/API.md) for request/response details.

### REST Endpoints (Topic Actions)

These endpoints power the Copilot Studio agent's topic actions:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/graph/operations` | List Graph API operations for endpoints |
| `GET` | `/api/graph/session/endpoints` | Get explored endpoints for current session |
| `GET` | `/api/graph/session/context` | Get full session context with design decisions |
| `GET` | `/api/graph/environments` | List Power Platform environments |
| `GET` | `/api/graph/namecheck` | Pre-flight name collision check |
| `POST` | `/api/graph/connector` | Generate a single connector (Swagger + Gist) |
| `POST` | `/api/graph/connector/batch` | Batch generate multiple connectors |
| `POST` | `/api/graph/deploy` | Start async connector deployment |
| `POST` | `/api/graph/deploy/batch` | Batch deploy multiple connectors |
| `GET` | `/api/graph/deploy/status` | Poll async deploy job status |

### Infrastructure Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Discovery / landing page |
| `GET` | `/health` | Health check |
| `POST` | `/mcp` | MCP JSON-RPC 2.0 (AI tool invocation) |
| `DELETE` | `/mcp` | MCP session termination |
| `GET` | `/download/:id/:filename` | Serve generated output files |

### MCP Tools

Three tools are exposed to Copilot Studio via the MCP protocol:

| Tool | Purpose |
|------|---------|
| `graph_listOperations` | Research Graph API endpoints, parse CSDL, return operations |
| `graph_generateConnector` | Generate Swagger 2.0 from selected operations |
| `graph_setDesignContext` | Persist session design decisions (naming, auth, scope) |

Additional internal tools (`graph_deployPipeline`, `graph_completeAppRegistration`) are
used by the deploy pipeline but not exposed to MCP clients.

## Copilot Studio Agent

The agent is defined in `copilot-studio/agent/` and deployed as a Power Platform solution.
It uses **4 connection references**:

| Connector | Type | Purpose |
|-----------|------|---------|
| GCF REST Connector | Custom | Topic actions (10 REST operations) |
| GCF MCP Agent | Custom | AI-powered Graph research via MCP |
| MCP Server for Enterprise | Custom (first-party) | Deep Graph API knowledge |
| Microsoft Learn Docs MCP | First-party | Documentation search |

The agent orchestrates a conversational workflow: research endpoints → select operations →
name the connector → generate Swagger → deploy to Power Platform.

## Project Structure

```
src/
  index.ts                    # Entry point — transport selection
  auth/                       # Token validation, credential providers
  config/                     # Config loader, type definitions
  logging/                    # Stderr logger (keeps stdout clean for JSON-RPC)
  modes/                      # (Reserved for future mode system)
  output/                     # Gist publisher
  policies/                   # Autonomy mode, operation guards
  prompts/                    # MCP prompt templates
  tools/
    registry.ts               # Unified tool dispatcher (graph_*, connector_*, appreg_*)
    graph/                    # CSDL parsing, Swagger generation, schema normalization
    connector/                # Power Platform connector CRUD
    appreg/                   # Entra app registration management
    deploy/
      pipeline.ts             # Three-step deploy: app reg → connector → FIC
  transport/
    httpHost.ts               # Express server — all REST + MCP routes
    mcpAdapter.ts             # MCP JSON-RPC 2.0 adapter

config/
  config.template.json        # Configuration template (copy to config.json)
  config.json                 # Runtime config (gitignored)

artifacts/
  connectors/                 # Swagger + apiProperties templates (tokenized)
    manifest.json             # Connector definitions for token replacement
    prepared/                 # Token-replaced output (gitignored)
  solutions/                  # Packed solution zips (gitignored)

scripts/
  Install-GraphConnectorFactory.ps1   # 8-stage installation pipeline
  Prepare-Artifacts.ps1               # Token replacement + solution packing

copilot-studio/
  agent/                      # Agent YAML definitions (topics, actions, connections)
  solutions/
    connectors/               # Connector solution (source for packing)
    agent/                    # Agent solution (imported after connectors + FIC)
```

## Development

```bash
npm run build       # Compile TypeScript to dist/
npm run dev         # TypeScript watch mode
npm run start:http  # Start HTTP server on port 3001
npm start           # Start server (defaults to HTTP)
npm run clean       # Remove dist/
```

Set `MCP_DEBUG=1` for verbose logging to stderr.

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Server won't start (EADDRINUSE) | Port 3001 in use | Stop the other process or change port in config |
| `401 Unauthorized` on API calls | Token validation failing | Check `server.tokenValidation` in config matches your Entra app |
| CSDL fetch fails | Network or Graph API issue | Check `graphApi.baseUrl` and credentials; CSDL is cached for 24h |
| Deploy returns `partial` | App reg succeeded but connector failed (or vice versa) | Check the per-step errors in the response; often a permissions issue |
| FIC Subject not found | Propagation delay after connector import | The install script retries with exponential backoff; wait up to 5 minutes |
| Connection references unresolved | Agent imported before connectors | Follow install stage ordering: Connectors (6) → FIC (7) → Agent (8) |
| Enterprise connector fails | Missing app registration in target tenant | Use `-EnterpriseAppId` to retarget, or `-SkipEnterprise` to exclude |
| `GCF_CLIENT_SECRET` not found | Server auth misconfigured | Set the env var or use certificate auth instead |

## License

This project is licensed under the [MIT License](LICENSE).
