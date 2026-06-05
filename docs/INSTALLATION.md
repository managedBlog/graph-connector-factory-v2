# Installation Guide

This guide covers the full deployment of Graph Connector Factory v2 to a Power Platform
environment, including Entra ID app registrations, connector import, and agent setup.

For VS Code MCP usage (no Power Platform deployment), see the
[VS Code setup](../README.md#use-with-vs-code-mcp) in the README.

## Overview

The installation script (`scripts/Install-GraphConnectorFactory.ps1`) runs an 8-stage
pipeline that:

1. Verifies prerequisites
2. Builds the Node.js server
3. Creates Entra ID app registrations (API + Client + Enterprise)
4. Generates the server config file
5. Token-replaces and packs solution ZIP files
6. Imports the connector solution to Power Platform
7. Configures Federated Identity Credentials + redirect URIs
8. Imports the agent solution to Power Platform

**Critical ordering**: Connectors (6) → FIC (7) → Agent (8). FIC Subjects are
auto-generated after connector import with a propagation delay of up to ~5 minutes.
The agent requires working connections, so FIC must complete before agent import.

## Prerequisites

Before running the install script, ensure you have:

- **Node.js** ≥ 18.0.0
- **npm** (included with Node.js)
- **Azure CLI** (`az`) — logged in with permissions to create app registrations
- **Power Platform CLI** (`pac`) — authenticated to your target environment
- **PowerShell** 5.1+ or 7+
- A **Power Platform environment** with solution import permissions
- An **Entra ID tenant** with app registration permissions

Verify with:

```powershell
.\scripts\Install-GraphConnectorFactory.ps1 -Stage Preflight
```

## Authentication Methods

The install script supports three auth methods for the server's own credentials:

| Method | Flag | Description |
|--------|------|-------------|
| Client Secret | `-AuthMethod ClientSecret` | (Default) Creates a client secret; store in `GCF_CLIENT_SECRET` env var at runtime |
| Certificate (OpenSSL) | `-AuthMethod Certificate-OpenSSL` | Generates a cert with OpenSSL; uploads public key to Entra |
| Certificate (Self-Signed) | `-AuthMethod Certificate-SelfSigned` | Generates a self-signed cert via PowerShell; uploads to Entra |

Certificate methods store the PEM file in `config/` (gitignored). The certificate path
is written to `config/config.json` automatically.

## Full Pipeline (Recommended)

For a complete deployment in one command:

```powershell
.\scripts\Install-GraphConnectorFactory.ps1 -Stage All `
    -ServerHost "your-server.devtunnels.ms" `
    -EnvironmentId "your-power-platform-environment-id"
```

The script will:
- Create all app registrations and print their IDs
- Generate `config/config.json`
- Pack and import solutions
- Configure FICs with exponential backoff retry
- Import the agent

Add `-AuthMethod Certificate-OpenSSL` for certificate auth:

```powershell
.\scripts\Install-GraphConnectorFactory.ps1 -Stage All `
    -ServerHost "your-server.devtunnels.ms" `
    -EnvironmentId "your-env-id" `
    -AuthMethod Certificate-OpenSSL
```

### ServerHost Format

The `-ServerHost` parameter accepts any format — the script automatically normalizes it:

- `https://host.devtunnels.ms` → `host.devtunnels.ms`
- `host.devtunnels.ms/` → `host.devtunnels.ms`
- `https://host.devtunnels.ms/path/` → `host.devtunnels.ms`

Swagger 2.0 requires a bare hostname (no protocol, no trailing path).

## Stage-by-Stage Deployment

For more control, run each stage individually. This is useful for debugging or when
you need to review output between stages.

### Stage 0: Plan (Dry Run)

```powershell
.\scripts\Install-GraphConnectorFactory.ps1 -Stage Plan
```

Prints what each stage does without making any changes.

### Stage 1: Preflight

```powershell
.\scripts\Install-GraphConnectorFactory.ps1 -Stage Preflight [-AuthMethod Certificate-OpenSSL]
```

Verifies that all required tools are installed and accessible.

### Stage 2: Build

```powershell
.\scripts\Install-GraphConnectorFactory.ps1 -Stage Build
```

Runs `npm install` and `npm run build` to compile the TypeScript server.

### Stage 3: Entra (App Registrations)

```powershell
.\scripts\Install-GraphConnectorFactory.ps1 -Stage Entra [-AuthMethod Certificate-OpenSSL]
```

Creates three app registrations in Entra ID:

| App | Purpose |
|-----|---------|
| **API app** | Server identity — holds Graph API permissions, `MCP.access` scope, client secret or certificate |
| **Client app** | Connector OAuth — receives redirect URIs and FICs after connector import |
| **Enterprise app** | MCP Server for Enterprise — registers the first-party enterprise MCP connector in your tenant |

**Save the output values** — you'll need `ApiAppId`, `ClientAppId`, `ClientAppObjectId`,
`TenantId`, `EnterpriseAppId`, and `EnterpriseAppObjectId` for subsequent stages.

### Stage 4: Config

```powershell
.\scripts\Install-GraphConnectorFactory.ps1 -Stage Config `
    -ApiAppId <id> -ApiAppSecret <secret> `
    -ClientAppId <id> -TenantId <tid> `
    -ServerHost <host> -EnvironmentId <eid> `
    -EnterpriseAppId <eid>
```

Generates `config/config.json` from the template with your values.

### Stage 5: Artifacts

```powershell
.\scripts\Install-GraphConnectorFactory.ps1 -Stage Artifacts `
    -ApiAppId <id> -ClientAppId <id> `
    -TenantId <tid> -ServerHost <host> `
    -EnterpriseAppId <eid>
```

Runs `Prepare-Artifacts.ps1` to:
- Token-replace connector swagger and apiProperties files (`__SERVER_HOST__`, `__OAUTH_CLIENT_ID__`, `__OAUTH_RESOURCE_URI__`, `__TENANT_ID__`)
- Retarget the enterprise connector to your tenant (if `-EnterpriseAppId` provided)
- Pack both solution ZIPs (`artifacts/solutions/GCFApps_connectors.zip` + `GCFApps_agent.zip`)

### Stage 6: Connectors

```powershell
.\scripts\Install-GraphConnectorFactory.ps1 -Stage Connectors -EnvironmentId <eid>
```

Imports the connector solution via `pac solution import`.

### Stage 7: FIC (Federated Identity Credentials)

```powershell
.\scripts\Install-GraphConnectorFactory.ps1 -Stage FIC `
    -ApiAppId <id> -ClientAppId <id> `
    -ClientAppObjectId <oid> -TenantId <tid> `
    -EnvironmentId <eid> `
    -EnterpriseAppId <eid> -EnterpriseAppObjectId <oid>
```

This stage:
1. Queries Power Platform for the imported connectors
2. Discovers the auto-generated FIC Subject values (with exponential backoff — up to ~5 min)
3. Creates FICs on the Client app (and Enterprise app for the enterprise connector)
4. Adds redirect URIs to the Client app

### Stage 8: Agent

```powershell
.\scripts\Install-GraphConnectorFactory.ps1 -Stage Agent -EnvironmentId <eid>
```

Imports the agent solution. The agent's connection references will resolve to the
connectors imported in Stage 6 (authenticated via the FICs created in Stage 7).

> **Note:** After import, you may need to manually create connections in the Power Platform
> portal if the connection references don't auto-resolve. Navigate to the agent's
> connection references and create connections for each connector.

## Enterprise MCP Connector

The MCP Server for Enterprise is a Microsoft first-party connector (global app ID:
`e8c77dc2-69b3-43f4-bc51-3213c9d915b4`). To use it in your tenant, you have three options:

| Option | Flag | When to use |
|--------|------|-------------|
| Retarget to your tenant | `-EnterpriseAppId <id>` | **Recommended** — creates a local app reg that maps to the enterprise connector |
| Skip entirely | `-SkipEnterprise` | If you don't need the enterprise MCP connector |
| Leave as-is | *(neither flag)* | Not recommended — source tenant values remain and the connector won't work |

The enterprise app registration requires two API permissions:
- `MCP.User.Read.All` (from the Enterprise MCP app)
- `User.Read` (from Microsoft Graph)

## After Installation

### Start the Server

```powershell
# Using client secret
$env:GCF_CLIENT_SECRET = "your-secret"
$env:MCP_TRANSPORT = "http"
# Optional: enable strict run isolation (requires runId on deploy/generate APIs)
$env:GCF_STRICT_RUN_ISOLATION = "true"
node dist/index.js

# Or using certificate (configured in config.json during Stage 4)
$env:MCP_TRANSPORT = "http"
node dist/index.js
```

### Verify

```powershell
# Health check
curl http://localhost:3001/health

# List environments (requires auth token)
curl -H "Authorization: Bearer <token>" http://localhost:3001/api/graph/environments
```

### Connect Copilot Studio

1. Open your Power Platform environment in the Copilot Studio portal
2. Navigate to the imported agent ("Microsoft Graph Connector Factory")
3. Verify all 4 connection references are resolved
4. Test the agent by starting a conversation

## Troubleshooting

### FIC Subject not found

The FIC Subject values are auto-generated by Power Platform after connector import.
There's a propagation delay of up to ~5 minutes. The install script retries with
exponential backoff. If it still fails:

1. Wait a few minutes and re-run Stage 7
2. Manually check Power Platform for the connector's auto-generated Subject value
3. Create the FIC manually via `az rest` or the Azure portal

### Connection references unresolved

If the agent's connection references show as unresolved after import:

1. Verify connectors were imported (Stage 6 succeeded)
2. Verify FICs were created (Stage 7 succeeded)
3. Navigate to the agent in Copilot Studio → Connection References
4. Manually create connections for any unresolved references

### Admin consent failures

The script creates service principals before granting admin consent. If consent fails:

1. Check that the Azure CLI user has Global Admin or Cloud App Admin role
2. Try granting consent manually in the Azure portal (Entra ID → App registrations → API permissions)

### pac solution import fails

Common causes:
- Environment not authenticated: run `pac auth create --environment <url>`
- Solution already exists: the script handles "already exists" as success
- Missing dependencies: ensure the connector solution is imported before the agent solution
