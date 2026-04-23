<!-- Use this file to provide workspace-specific custom instructions to Copilot. -->

# Graph Connector Factory v2

This is a **clean-room port** of a Copilot Studio + MCP server ecosystem for creating
Power Platform custom connectors from Microsoft Graph API endpoints.

## Project Status

Sessions 1-3 are complete (scaffolding, business logic lift, REST endpoints, swagger
artifacts, installation scripts). See the plan for current session details:

**Plan**: `C:\Users\CloudAdmin\.copilot\session-state\c0241501-d68a-4112-a818-c69bcab9d927\plan.md`

## Architecture

- **Single Node.js server** on port 3001 — serves both MCP (AI chat) and REST (topic actions)
- **3 custom connectors**: GCF Unified Connector (REST), GCF MCP Agent, MCP Server for Enterprise
- **2 first-party MCP connectors**: Microsoft Learn Docs MCP, MCP Server for Enterprise
- **Two-solution-import pattern**: connector solution first (tokenized, packed at deploy time),
  then agent solution (static, connectors stripped)
- **Two-app Entra pattern**: API app (MCP.access scope, Graph permissions, client secret) +
  Client app (redirect URI, delegated permissions, FICs after connector creation)

## Key Decisions

- **D1**: All endpoints require OAuth — no NoAuth connectors
- **D2**: Purpose-built for connector creation (not a general-purpose swagger generator)
- **D3**: LESSONS-LEARNED.md is internal build reference only, not committed to public repo
- **D5**: 5-6 session timeline
- **D6**: Legacy repo preserved as reference

## Connection References (5 total)

1. GCF Unified Connector (custom) — REST topic actions (9 operations)
2. GCF MCP Agent (custom) — CSDL-aware swagger generation via MCP protocol
3. MCP Server for Enterprise (custom) — Microsoft first-party MCP for deep Graph API knowledge
4. Microsoft Learn Docs MCP (first-party) — documentation search
5. *(Connection references must resolve to connectors that exist in the target environment)*

## Legacy Repo (read-only reference)

The original monorepo lives at:
`C:\Users\CloudAdmin\OneDrive - Managed Modern Endpoint\Documents\MCP Agents\Graph Connector Agent`

It contains the 5-app architecture (GRS, CDA, ARA, deploy-server, gateway) that v2 replaces
with a single server. Use it **only** as historical reference for understanding prior decisions
or checking original implementations. Do **not** port code from it — all essential business
logic has already been lifted into v2 during Sessions 1-2.

## Repository Structure

```
src/                        # TypeScript source
  transport/httpHost.ts     # All 15 REST endpoints (1,457 LOC)
  tools/registry.ts         # Unified 27-tool dispatcher
  tools/deploy/pipeline.ts  # Direct-call deploy pipeline (~480 LOC)
  tools/graph/              # CSDL parsing, swagger generation, schema normalization
config/                     # Config template and runtime config (config.json is gitignored)
artifacts/connectors/       # Swagger files, apiProperties, manifest (tokenized templates)
scripts/                    # Install and artifact preparation scripts
copilot-studio/             # Solution exports and cloned agent files
```

## Build & Run

```bash
npm install
npm run build       # TypeScript compile
npm start           # Start server (MCP mode)
npm run start:http  # Start server (HTTP mode on port 3001)
npm run dev         # Development mode with ts-node
```
