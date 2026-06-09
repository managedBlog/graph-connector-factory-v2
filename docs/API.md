# API Reference

Graph Connector Factory v2 exposes REST endpoints for Copilot Studio topic actions
and an MCP endpoint for AI tool invocation. The server supports two transports:

- **HTTP** (`MCP_TRANSPORT=http`, default) — Express server on port 3001 with REST endpoints + streamable HTTP MCP
- **Stdio** (`MCP_TRANSPORT=stdio`) — Newline-delimited JSON-RPC over stdin/stdout for VS Code MCP

When using stdio transport (VS Code), only the MCP tools are available — REST endpoints
are not served. See the [VS Code setup](../README.md#use-with-vs-code-mcp) in the README.

## Authentication

When the server is configured with `server.authMode: "authenticated"`, all API endpoints
(except `/health`) require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

The token must be issued by Entra ID for the audience configured in
`server.tokenValidation.allowedAudience` (typically `api://<ApiAppId>`).

The `/health` endpoint is always unauthenticated when
`server.allowUnauthenticatedHealth: true` (default).

---

## REST Endpoints

### GET /api/graph/operations

List Microsoft Graph API operations for one or more endpoints. Fetches and parses
the CSDL metadata, then returns matching operations.

**Query parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `endpoints` | string | Yes | Comma-separated Graph API paths (e.g., `/users,/groups`) |
| `version` | string | No | Graph API version (`v1.0` or `beta`). Default: `v1.0` |

**Response:** JSON array of operations with method, path, parameters, and schema info.

---

### GET /api/graph/session/endpoints

Returns the list of endpoints that have been explored in the current session.

**Response:** JSON object with an `endpoints` array.

---

### GET /api/graph/session/context

Returns the full session context including explored endpoints and design decisions
captured via `graph_setDesignContext`. All fields are flattened at the top level
(not nested) for Swagger 2.0 / Copilot Studio compatibility.

**Response:** Flat JSON object with all endpoint tracking and design context fields.

This endpoint is read-only and does not accept run control query parameters.
Run IDs remain server-managed and are surfaced in the response for status correlation.

---

### GET /api/graph/environments

List Power Platform environments available to the configured service principal.

**Response:** JSON array of environments with `id`, `displayName`, and `properties`.

---

### GET /api/graph/namecheck

Pre-flight check for connector name collisions. Verifies that proposed base names
don't conflict with existing connectors or Entra app registrations.

**Query parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `names` | string | Yes | Comma-separated proposed connector base names |
| `environmentId` | string | Yes | Target Power Platform environment ID |

**Response:** JSON object with conflict details per name.

---

### POST /api/graph/connector

Generate a Power Platform custom connector (Swagger 2.0) from selected Graph API
operations. Optionally publishes to GitHub Gist.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `baseName` | string | Yes | Connector base name |
| `operations` | array | Yes | Selected operation IDs from `/api/graph/operations` |
| `authConfig` | object | No | OAuth configuration overrides |
| `format` | string | No | Output format: `json` (default) or `yaml` |

**Response:** JSON object with generated swagger content, file URLs, and Gist URL (if enabled).

---

### POST /api/graph/connector/batch

Batch generate multiple connectors in a single call. Accepts a JSON string of groups,
generates each connector, publishes to Gist, and returns results.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `groups` | string | Yes | JSON string of connector groups (each with `baseName` and `ops`) |

**Response:** JSON string of results for Copilot Studio Parse Value node consumption.

---

### POST /api/graph/deploy

Start an asynchronous deployment of a Power Platform custom connector. Returns a
`jobId` immediately. Use `/api/graph/deploy/status` to poll for completion.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `swaggerContent` | string | Yes | Generated Swagger 2.0 JSON |
| `baseName` | string | Yes | Connector name |
| `environmentId` | string | Yes | Target environment ID |
| `authType` | string | No | Auth type (default: `FederatedIdentity`). For managed/federated identity in Power Platform, use delegated flow (not `client_credentials`). |
| `oauthTenantId` | string | No | Entra tenant ID |
| `oauthResourceUri` | string | No | OAuth resource URI |
| `runId` | string | No* | Run ID to scope execution to an existing active run |

**Response (202 Accepted):**

```json
{
  "jobId": "uuid",
  "status": "running",
  "message": "Deploy pipeline started"
}
```

The response is **flattened** (not nested) for Swagger 2.0 / Copilot Studio compatibility.
Response also includes `runId` when present.

---

### POST /api/graph/deploy/batch

Batch deploy multiple connectors. Each group is deployed sequentially.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `groups` | string | Yes | JSON string of deploy groups |
| `environmentId` | string | Yes | Target environment ID |
| `runId` | string | No* | Run ID to scope execution to an existing active run |

**Response:** JSON with per-group deploy results.

`*` When `GCF_STRICT_RUN_ISOLATION=true`, `runId` is required for deploy and batch deploy.

---

### GET /api/graph/deploy/status

Long-poll a deploy job. Holds the connection for up to 25 seconds before returning.
Loop until status is `success`, `partial`, or `failed`.

**Query parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `jobId` | string | Yes | Job ID from `/api/graph/deploy` |

**Response:**

| Field | Type | Description |
|-------|------|-------------|
| `jobId` | string | The job ID |
| `status` | string | `running`, `success`, `partial`, or `failed` |
| `connectorId` | string | Created connector ID (on success) |
| `appRegistrationId` | string | Created app registration ID |
| `errors` | array | Error messages (on failure) |
| `summary` | string | Human-readable summary |
| `elapsedMs` | number | Total elapsed time |

---

### GET /api/agent/context

Returns agent factory context, deployed connector summaries, and run-scoped deployment data.

**Response notes:**

- Includes `runId` and `strictRunIsolation`.
- `deployedConnectorsJson` and `connectorSummariesJson` are scoped to the active server-managed run when one is active.
- Includes `solutionChoicesJson` and `defaultSolutionName` for first-card solution selection.

---

### POST /api/agent/solution/preflight

Validates a candidate solution unique name and checks whether it already exists.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `environmentId` | string | Yes | Target environment |
| `solutionName` | string | Yes | Candidate solution unique name |

**Response fields:** `originalName`, `normalizedName`, `isValid`, `exists`, `message`.

---

### POST /api/agent/solution/ensure

Creates the solution if missing, or returns existing solution metadata.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `environmentId` | string | Yes | Target environment |
| `solutionName` | string | Yes | Solution unique name |

**Response fields:** `solutionName`, `created`, `publisherPrefix`.

---

### POST /api/agent/generate

Starts asynchronous Copilot Studio agent generation from deployed connector context.

**Request body additions:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `solutionName` | string | Yes | Existing solution unique name (no default fallback) |
| `runId` | string | No* | Run ID to scope deployed connector selection |

`*` When `GCF_STRICT_RUN_ISOLATION=true`, `runId` is required.

Status can return `success`, `partial`, or `failed`. `partial` indicates PAC succeeded but full Dataverse verification was incomplete.

---

## Infrastructure Endpoints

### GET /

Discovery / landing page. Returns server info and available endpoints.

### GET /health

Health check endpoint. Always returns `200 OK` with server status.
Unauthenticated by default (`server.allowUnauthenticatedHealth: true`).

### POST /mcp

MCP JSON-RPC 2.0 endpoint for AI tool invocation. Used by the GCF MCP Agent
connector in Copilot Studio.

Accepts standard MCP protocol messages (`tools/list`, `tools/call`, `prompts/list`, etc.).

### DELETE /mcp

Terminates an MCP session.

### GET /download/:id/:filename

Serves generated output files (Swagger JSON/YAML) by session output ID.

---

## MCP Tools

Three tools are exposed to MCP clients (Copilot Studio agent):

### graph_listOperations

Research Graph API endpoints by fetching and parsing CSDL metadata.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `endpoints` | string | Yes | Comma-separated Graph API paths |
| `version` | string | No | `v1.0` (default) or `beta` |

**Returns:** Array of operations with HTTP method, path, parameters, request body schema,
and response schema.

### graph_generateConnector

Generate a Swagger 2.0 connector definition from previously listed operations.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `baseName` | string | Yes | Connector display name |
| `operationIds` | string | Yes | Comma-separated operation IDs |
| `format` | string | No | `json` (default) or `yaml` |

**Returns:** Generated swagger content with download URL and Gist URL.

### graph_setDesignContext

Persist session-level design decisions for the connector workflow.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Design context key |
| `value` | string | Yes | Design context value |

**Returns:** Confirmation of stored context.

---

## Deploy Pipeline (Internal)

The deploy pipeline (`graph_deployPipeline`) is an internal tool not exposed to MCP.
It executes a three-step chain:

1. **App Registration** (`appreg_create`) — Create or reuse an Entra ID app registration
2. **Connector Deploy** (`connector_deploy`) — Deploy Swagger to Power Platform
3. **Configure for Connector** (`appreg_configureForConnector`) — Add FIC, redirect URI, permissions

The pipeline returns a `DeployPipelineResult` with status (`success` / `partial` / `failed`),
per-step results, error details, and timing information.

---

## Response Format Notes

All REST responses are **flat JSON objects** (not nested) to maintain compatibility with
Swagger 2.0 response schemas and Copilot Studio's Parse Value node. This is a deliberate
design decision — the deploy pipeline internally produces rich nested objects, but the
HTTP layer flattens them before responding.
