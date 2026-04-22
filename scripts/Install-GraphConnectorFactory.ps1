<#
.SYNOPSIS
    Staged installation script for Graph Connector Factory v2.

.DESCRIPTION
    Deploys Graph Connector Factory v2 through a series of stages:
      0. Plan       — Print what each stage does (no changes).
      1. Preflight  — Verify prerequisites (node, npm, az, pac).
      2. Build      — Run npm install and npm run build.
      3. Entra      — Create API + Client app registrations in Entra ID.
      4. Config     — Generate config/config.json from template + values.
      5. Artifacts   — Prepare connector artifacts with token replacement.
      6. Connectors — Deploy connectors via pac connector create.
      7. FIC        — Discover managed-identity subjects, add FICs to Client app.
      All           — Run stages 1–7 sequentially.

    Architecture: two-app pattern (API app + Client app), two connectors
    (Unified REST + MCP Agent), OAuth via Federated Identity Credentials.

.EXAMPLE
    .\Install-GraphConnectorFactory.ps1 -Stage Plan
    .\Install-GraphConnectorFactory.ps1 -Stage Preflight
    .\Install-GraphConnectorFactory.ps1 -Stage Entra
    .\Install-GraphConnectorFactory.ps1 -Stage Config -ApiAppId <id> -ApiAppSecret <secret> `
        -ClientAppId <id> -TenantId <tid> -ServerHost <host> -EnvironmentId <eid>
    .\Install-GraphConnectorFactory.ps1 -Stage All
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Plan', 'Preflight', 'Build', 'Entra', 'Config', 'Artifacts', 'Connectors', 'FIC', 'All')]
    [string] $Stage,

    # --- Entra stage outputs / Config stage inputs ---
    [string] $ApiAppId,
    [string] $ApiAppSecret,
    [string] $ClientAppId,
    [string] $ClientAppObjectId,
    [string] $TenantId,
    [string] $McpAccessScopeId,

    # --- Config / Artifacts inputs ---
    [string] $ServerHost,
    [string] $EnvironmentId,

    # --- Connector outputs / FIC inputs ---
    [string] $UnifiedConnectorId,
    [string] $McpConnectorId,

    # --- Behaviour ---
    [switch] $NonInteractive
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$configDir = Join-Path $repoRoot 'config'
$artifactsDir = Join-Path $repoRoot 'artifacts' 'connectors'
$preparedDir = Join-Path $artifactsDir 'prepared'
$manifestPath = Join-Path $artifactsDir 'manifest.json'

# ─────────────────────────────────────────────────────────────────
# Helper functions
# ─────────────────────────────────────────────────────────────────

function Write-StageHeader {
    param([string] $Title)
    Write-Host "`n╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║  $($Title.PadRight(52))║" -ForegroundColor Cyan
    Write-Host "╚══════════════════════════════════════════════════════╝`n" -ForegroundColor Cyan
}

function Write-Step {
    param([string] $Message)
    Write-Host "  → $Message" -ForegroundColor White
}

function Write-Success {
    param([string] $Message)
    Write-Host "  ✓ $Message" -ForegroundColor Green
}

function Write-Failure {
    param([string] $Message)
    Write-Host "  ✗ $Message" -ForegroundColor Red
}

function Write-ValueTable {
    param([hashtable] $Values)
    $maxKey = ($Values.Keys | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum
    foreach ($key in ($Values.Keys | Sort-Object)) {
        $pad = $key.PadRight($maxKey)
        Write-Host "    $pad : " -ForegroundColor Gray -NoNewline
        Write-Host "$($Values[$key])" -ForegroundColor Yellow
    }
}

function Test-Command {
    param([string] $Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Assert-Parameter {
    param(
        [string] $Name,
        [string] $Value,
        [string] $StageName
    )
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Parameter -$Name is required for the $StageName stage."
    }
}

function Invoke-AzCli {
    <# Run az CLI, capture JSON output, and convert. Throws on non-zero exit. #>
    param([string[]] $Arguments)
    $output = & az @Arguments --output json 2>&1
    if ($LASTEXITCODE -ne 0) {
        $errText = ($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) -join "`n"
        if (-not $errText) { $errText = $output -join "`n" }
        throw "az CLI failed (exit $LASTEXITCODE): $errText"
    }
    $jsonText = ($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    if ($jsonText) {
        return $jsonText | ConvertFrom-Json
    }
    return $null
}

function Invoke-WithRetry {
    <# Retry a script block until it succeeds or max attempts are exhausted. #>
    param(
        [scriptblock] $ScriptBlock,
        [int]         $MaxAttempts   = 6,
        [int]         $DelaySeconds  = 10,
        [string]      $Activity      = 'operation'
    )
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            $result = & $ScriptBlock
            if ($null -ne $result) { return $result }
        } catch {
            Write-Host "    Attempt $attempt/$MaxAttempts for $Activity failed: $_" -ForegroundColor DarkYellow
        }
        if ($attempt -lt $MaxAttempts) {
            Write-Host "    Waiting ${DelaySeconds}s before retry…" -ForegroundColor DarkGray
            Start-Sleep -Seconds $DelaySeconds
        }
    }
    throw "Failed after $MaxAttempts attempts: $Activity"
}

function Read-HostIfInteractive {
    param([string] $Prompt)
    if ($NonInteractive) {
        throw "Running in non-interactive mode but a value is required: $Prompt"
    }
    return Read-Host $Prompt
}

# ─────────────────────────────────────────────────────────────────
# Stage 0 — Plan
# ─────────────────────────────────────────────────────────────────

function Invoke-StagePlan {
    Write-StageHeader 'Stage 0 · Plan'
    Write-Host @"
  This installer deploys Graph Connector Factory v2 in stages.
  Run each stage in order, or use -Stage All to run them all.

  Stage 1  Preflight   — Check prerequisites (node ≥18, npm, az CLI, pac CLI).
  Stage 2  Build       — npm install && npm run build in repo root.
  Stage 3  Entra       — Create API + Client app registrations in Entra ID.
                         Outputs app IDs, secret, scope ID, tenant ID.
  Stage 4  Config      — Generate config/config.json from template + Entra values.
  Stage 5  Artifacts   — Token-replace connector swagger & apiProperties files.
  Stage 6  Connectors  — Deploy connectors via pac connector create.
  Stage 7  FIC         — Discover managed-identity subjects on connectors,
                         add Federated Identity Credentials to Client app.

  Typical workflow:
    .\Install-GraphConnectorFactory.ps1 -Stage Preflight
    .\Install-GraphConnectorFactory.ps1 -Stage Build
    .\Install-GraphConnectorFactory.ps1 -Stage Entra
    # Copy output values, then:
    .\Install-GraphConnectorFactory.ps1 -Stage Config -ApiAppId ... -ApiAppSecret ... `
        -ClientAppId ... -TenantId ... -ServerHost ... -EnvironmentId ...
    .\Install-GraphConnectorFactory.ps1 -Stage Artifacts -ApiAppId ... `
        -ClientAppId ... -TenantId ... -ServerHost ...
    .\Install-GraphConnectorFactory.ps1 -Stage Connectors -EnvironmentId ...
    .\Install-GraphConnectorFactory.ps1 -Stage FIC -ClientAppObjectId ... -TenantId ...
"@ -ForegroundColor Gray
}

# ─────────────────────────────────────────────────────────────────
# Stage 1 — Preflight
# ─────────────────────────────────────────────────────────────────

function Invoke-StagePreflight {
    Write-StageHeader 'Stage 1 · Preflight'
    $ok = $true

    # Node.js ≥ 18
    Write-Step 'Checking node…'
    if (Test-Command 'node') {
        $nodeVer = (node --version) -replace '^v', ''
        $major = [int]($nodeVer.Split('.')[0])
        if ($major -ge 18) {
            Write-Success "node $nodeVer"
        } else {
            Write-Failure "node $nodeVer — need ≥ 18.0.0"; $ok = $false
        }
    } else { Write-Failure 'node not found'; $ok = $false }

    # npm
    Write-Step 'Checking npm…'
    if (Test-Command 'npm') {
        Write-Success "npm $(npm --version)"
    } else { Write-Failure 'npm not found'; $ok = $false }

    # Azure CLI + login
    Write-Step 'Checking az CLI…'
    if (Test-Command 'az') {
        Write-Success "az $(az version --output tsv 2>$null | Select-Object -First 1)"
        Write-Step 'Checking az login status…'
        try {
            $account = az account show --output json 2>$null | ConvertFrom-Json
            Write-Success "Signed in as $($account.user.name) (tenant $($account.tenantId))"
        } catch {
            Write-Failure 'az CLI is not logged in. Run: az login'; $ok = $false
        }
    } else { Write-Failure 'az CLI not found'; $ok = $false }

    # PAC CLI + login
    Write-Step 'Checking pac CLI…'
    if (Test-Command 'pac') {
        Write-Success 'pac CLI found'
        Write-Step 'Checking pac auth status…'
        try {
            $pacAuth = pac auth list 2>&1
            if ($pacAuth -match 'UNIVERSAL\b|Active') {
                Write-Success 'pac CLI is authenticated'
            } else {
                Write-Warning 'pac CLI may not be authenticated. Run: pac auth create'
            }
        } catch {
            Write-Warning 'Could not verify pac auth. Run: pac auth create'
        }
    } else { Write-Failure 'pac CLI not found — install via: dotnet tool install --global Microsoft.PowerApps.CLI.Tool'; $ok = $false }

    if (-not $ok) {
        throw 'Preflight checks failed. Fix the issues above and re-run.'
    }
    Write-Host "`n  All preflight checks passed." -ForegroundColor Green
}

# ─────────────────────────────────────────────────────────────────
# Stage 2 — Build
# ─────────────────────────────────────────────────────────────────

function Invoke-StageBuild {
    Write-StageHeader 'Stage 2 · Build'

    Push-Location $repoRoot
    try {
        Write-Step 'Running npm install…'
        & npm install --no-audit --no-fund 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
        Write-Success 'npm install complete'

        Write-Step 'Running npm run build…'
        & npm run build 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
        Write-Success 'Build complete'
    } finally {
        Pop-Location
    }
}

# ─────────────────────────────────────────────────────────────────
# Stage 3 — Entra
# ─────────────────────────────────────────────────────────────────

function Invoke-StageEntra {
    Write-StageHeader 'Stage 3 · Entra ID App Registrations'

    # Retrieve tenant ID from current session
    Write-Step 'Retrieving tenant ID…'
    $account = Invoke-AzCli @('account', 'show')
    $tenantId = $account.tenantId
    Write-Success "Tenant: $tenantId"

    $graphAppId = '00000003-0000-0000-c000-000000000000'
    $appReadWriteAllId   = '1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9'  # Application.ReadWrite.All (Application)
    $appRoleAssignRWId   = '06b708a9-e830-4db3-a914-8e69da51d44f'  # AppRoleAssignment.ReadWrite.All (Application)

    # ── API App ──────────────────────────────────────────────────
    Write-Step 'Creating API app "Graph Connector Factory"…'

    # Check if app already exists
    $existingApps = Invoke-AzCli @('ad', 'app', 'list', '--display-name', 'Graph Connector Factory', '--query', "[?displayName=='Graph Connector Factory']")
    if ($existingApps -and $existingApps.Count -gt 0) {
        $apiApp = $existingApps[0]
        Write-Warning "API app already exists (appId: $($apiApp.appId)). Reusing."
    } else {
        $apiApp = Invoke-AzCli @('ad', 'app', 'create', '--display-name', 'Graph Connector Factory', '--sign-in-audience', 'AzureADMyOrg')
    }
    $apiAppId     = $apiApp.appId
    $apiObjectId  = $apiApp.id
    Write-Success "API App ID:     $apiAppId"
    Write-Success "API Object ID:  $apiObjectId"

    # Set identifier URI
    Write-Step 'Setting identifier URI…'
    Invoke-AzCli @('ad', 'app', 'update', '--id', $apiAppId, '--identifier-uris', "api://$apiAppId")
    Write-Success "Identifier URI: api://$apiAppId"

    # Add MCP.access scope
    Write-Step 'Adding MCP.access scope…'
    $scopeId = [guid]::NewGuid().ToString()
    $scopeJson = @(
        @{
            id                       = $scopeId
            isEnabled                = $true
            type                     = 'User'
            adminConsentDescription  = 'Access Graph Connector Factory MCP'
            adminConsentDisplayName  = 'MCP.access'
            userConsentDescription   = 'Access Graph Connector Factory MCP'
            userConsentDisplayName   = 'MCP.access'
            value                    = 'MCP.access'
        }
    ) | ConvertTo-Json -Depth 5 -Compress

    # az ad app update expects the --set value as a single argument
    Invoke-AzCli @('ad', 'app', 'update', '--id', $apiAppId, '--set', "api.oauth2PermissionScopes=$scopeJson")
    Write-Success "MCP.access scope ID: $scopeId"

    # Add Graph API permissions (Application type)
    Write-Step 'Adding Graph API permissions…'
    Invoke-AzCli @('ad', 'app', 'permission', 'add', '--id', $apiAppId,
        '--api', $graphAppId,
        '--api-permissions', "$appReadWriteAllId=Role", "$appRoleAssignRWId=Role")
    Write-Success 'Graph API permissions added (Application.ReadWrite.All, AppRoleAssignment.ReadWrite.All)'

    # Grant admin consent
    Write-Step 'Granting admin consent for API app…'
    try {
        Invoke-AzCli @('ad', 'app', 'permission', 'admin-consent', '--id', $apiAppId)
        Write-Success 'Admin consent granted'
    } catch {
        Write-Warning "Admin consent may require Global Admin. Grant manually if needed: az ad app permission admin-consent --id $apiAppId"
    }

    # Create client secret
    Write-Step 'Creating client secret…'
    $secretResult = Invoke-AzCli @('ad', 'app', 'credential', 'reset', '--id', $apiAppId,
        '--display-name', 'GCF Server Secret', '--years', '2')
    $apiSecret = $secretResult.password
    Write-Success 'Client secret created'
    Write-Warning 'Save this secret NOW — it will not be shown again.'

    # Ensure service principal
    Write-Step 'Ensuring service principal for API app…'
    try {
        Invoke-AzCli @('ad', 'sp', 'create', '--id', $apiAppId)
        Write-Success 'Service principal created'
    } catch {
        if ($_.Exception.Message -match 'already exists') {
            Write-Success 'Service principal already exists'
        } else { throw }
    }

    # ── Client App ───────────────────────────────────────────────
    Write-Step 'Creating Client app "Graph Connector Factory - Client"…'

    $existingClients = Invoke-AzCli @('ad', 'app', 'list', '--display-name', 'Graph Connector Factory - Client',
        '--query', "[?displayName=='Graph Connector Factory - Client']")
    if ($existingClients -and $existingClients.Count -gt 0) {
        $clientApp = $existingClients[0]
        Write-Warning "Client app already exists (appId: $($clientApp.appId)). Reusing."
    } else {
        $clientApp = Invoke-AzCli @('ad', 'app', 'create',
            '--display-name', 'Graph Connector Factory - Client',
            '--sign-in-audience', 'AzureADMyOrg',
            '--web-redirect-uris', 'https://global.consent.azure-apim.net/redirect')
    }
    $clientAppId    = $clientApp.appId
    $clientObjectId = $clientApp.id
    Write-Success "Client App ID:     $clientAppId"
    Write-Success "Client Object ID:  $clientObjectId"

    # Add delegated permission: MCP.access on API app
    Write-Step 'Adding MCP.access delegated permission to Client app…'
    Invoke-AzCli @('ad', 'app', 'permission', 'add', '--id', $clientAppId,
        '--api', $apiAppId,
        '--api-permissions', "$scopeId=Scope")
    Write-Success 'MCP.access (Delegated) added to Client app'

    # Grant admin consent for client app
    Write-Step 'Granting admin consent for Client app…'
    try {
        Invoke-AzCli @('ad', 'app', 'permission', 'admin-consent', '--id', $clientAppId)
        Write-Success 'Admin consent granted'
    } catch {
        Write-Warning "Admin consent may require Global Admin. Grant manually if needed: az ad app permission admin-consent --id $clientAppId"
    }

    # Ensure service principal for client app
    Write-Step 'Ensuring service principal for Client app…'
    try {
        Invoke-AzCli @('ad', 'sp', 'create', '--id', $clientAppId)
        Write-Success 'Service principal created'
    } catch {
        if ($_.Exception.Message -match 'already exists') {
            Write-Success 'Service principal already exists'
        } else { throw }
    }

    # ── Power Platform management app registration ───────────────
    Write-Step 'Registering apps as Power Platform management apps…'
    try {
        & pac admin register-management-app --application-id $apiAppId 2>&1 | Out-Null
        Write-Success "API app registered as management app"
    } catch {
        Write-Warning "Could not register API app as management app: $_"
    }
    try {
        & pac admin register-management-app --application-id $clientAppId 2>&1 | Out-Null
        Write-Success "Client app registered as management app"
    } catch {
        Write-Warning "Could not register Client app as management app: $_"
    }

    # ── Output summary ───────────────────────────────────────────
    Write-Host "`n────────────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "  Entra ID Registration Complete — Save These Values!" -ForegroundColor Green
    Write-Host "────────────────────────────────────────────────────────" -ForegroundColor Cyan

    $outputValues = @{
        'API App ID'          = $apiAppId
        'API Object ID'       = $apiObjectId
        'API Client Secret'   = $apiSecret
        'Client App ID'       = $clientAppId
        'Client Object ID'    = $clientObjectId
        'MCP.access Scope ID' = $scopeId
        'Tenant ID'           = $tenantId
    }
    Write-ValueTable $outputValues

    Write-Host "`n  Next: run the Config stage with these values:" -ForegroundColor Yellow
    Write-Host @"
    .\Install-GraphConnectorFactory.ps1 -Stage Config ``
        -ApiAppId '$apiAppId' ``
        -ApiAppSecret '<SECRET_ABOVE>' ``
        -ClientAppId '$clientAppId' ``
        -TenantId '$tenantId' ``
        -ServerHost '<YOUR_SERVER_HOST>' ``
        -EnvironmentId '<YOUR_ENV_ID>'
"@ -ForegroundColor DarkGray

    # Return values for pipeline / All stage
    return @{
        ApiAppId          = $apiAppId
        ApiObjectId       = $apiObjectId
        ApiAppSecret      = $apiSecret
        ClientAppId       = $clientAppId
        ClientObjectId    = $clientObjectId
        McpAccessScopeId  = $scopeId
        TenantId          = $tenantId
    }
}

# ─────────────────────────────────────────────────────────────────
# Stage 4 — Config
# ─────────────────────────────────────────────────────────────────

function Invoke-StageConfig {
    Write-StageHeader 'Stage 4 · Config Generation'

    Assert-Parameter 'ApiAppId'      $ApiAppId      'Config'
    Assert-Parameter 'ApiAppSecret'  $ApiAppSecret  'Config'
    Assert-Parameter 'ClientAppId'   $ClientAppId   'Config'
    Assert-Parameter 'TenantId'      $TenantId      'Config'
    Assert-Parameter 'ServerHost'    $ServerHost    'Config'
    Assert-Parameter 'EnvironmentId' $EnvironmentId 'Config'

    $templatePath = Join-Path $configDir 'config.template.json'
    $outputPath   = Join-Path $configDir 'config.json'

    if (-not (Test-Path $templatePath)) {
        throw "Config template not found at: $templatePath"
    }

    Write-Step "Reading template: $templatePath"
    $content = Get-Content $templatePath -Raw

    # Replace placeholder tokens
    $replacements = @{
        '<YOUR_ENTRA_TENANT_ID>'               = $TenantId
        '<YOUR_API_APP_CLIENT_ID>'             = $ApiAppId
        '<YOUR_POWER_PLATFORM_ENVIRONMENT_ID>' = $EnvironmentId
        '<YOUR_KEY_VAULT_URL_OR_REMOVE>'       = ''
        '<YOUR_SECRET_NAME_OR_REMOVE>'         = ''
        '<YOUR_GITHUB_PAT_OR_REMOVE>'          = ''
        '<YOUR_EMAIL_OR_REMOVE>'               = ''
    }

    foreach ($token in $replacements.Keys) {
        $content = $content.Replace($token, $replacements[$token])
    }

    # Parse, inject secret inline (config.json is gitignored), and add server host
    $config = $content | ConvertFrom-Json

    # Server host (stored but template doesn't have a dedicated placeholder)
    if ($config.server.PSObject.Properties.Name -notcontains 'host') {
        $config.server | Add-Member -NotePropertyName 'host' -NotePropertyValue $ServerHost
    } else {
        $config.server.host = $ServerHost
    }

    # Inject client secret for local dev (Power Platform auth section)
    if ($config.powerPlatform.auth.PSObject.Properties.Name -notcontains 'clientSecret') {
        $config.powerPlatform.auth | Add-Member -NotePropertyName 'clientSecret' -NotePropertyValue $ApiAppSecret
    } else {
        $config.powerPlatform.auth.clientSecret = $ApiAppSecret
    }

    # Same for Graph API auth
    if ($config.graphApi.auth.PSObject.Properties.Name -notcontains 'clientSecret') {
        $config.graphApi.auth | Add-Member -NotePropertyName 'clientSecret' -NotePropertyValue $ApiAppSecret
    } else {
        $config.graphApi.auth.clientSecret = $ApiAppSecret
    }

    Write-Step "Writing config: $outputPath"
    $config | ConvertTo-Json -Depth 10 | Set-Content -Path $outputPath -Encoding UTF8
    Write-Success "config.json generated at: $outputPath"

    Write-Warning 'config.json contains secrets — ensure it is listed in .gitignore.'
}

# ─────────────────────────────────────────────────────────────────
# Stage 5 — Artifacts
# ─────────────────────────────────────────────────────────────────

function Invoke-StageArtifacts {
    Write-StageHeader 'Stage 5 · Artifact Preparation'

    Assert-Parameter 'ApiAppId'   $ApiAppId   'Artifacts'
    Assert-Parameter 'ClientAppId' $ClientAppId 'Artifacts'
    Assert-Parameter 'TenantId'   $TenantId   'Artifacts'
    Assert-Parameter 'ServerHost' $ServerHost 'Artifacts'

    $oauthScope       = "api://$ApiAppId/MCP.access"
    $oauthResourceUri = "api://$ApiAppId"
    $prepareScript    = Join-Path $PSScriptRoot 'Prepare-Artifacts.ps1'

    if (-not (Test-Path $prepareScript)) {
        throw "Prepare-Artifacts.ps1 not found at: $prepareScript"
    }

    Write-Step "Calling Prepare-Artifacts.ps1…"
    & $prepareScript `
        -ServerHost      $ServerHost `
        -OAuthScope      $oauthScope `
        -OAuthClientId   $ClientAppId `
        -OAuthResourceUri $oauthResourceUri `
        -TenantId        $TenantId

    Write-Success 'Artifact preparation complete'
}

# ─────────────────────────────────────────────────────────────────
# Stage 6 — Connectors
# ─────────────────────────────────────────────────────────────────

function Invoke-StageConnectors {
    Write-StageHeader 'Stage 6 · Connector Deployment'

    Assert-Parameter 'EnvironmentId' $EnvironmentId 'Connectors'

    if (-not (Test-Path $manifestPath)) {
        throw "Manifest not found: $manifestPath. Run the Artifacts stage first."
    }

    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $results  = @{}

    foreach ($connector in $manifest.connectors) {
        $swaggerPath  = Join-Path $preparedDir $connector.swaggerFile
        $propsPath    = Join-Path $preparedDir $connector.apiPropertiesFile

        if (-not (Test-Path $swaggerPath)) {
            throw "Prepared swagger not found: $swaggerPath. Run the Artifacts stage first."
        }
        if (-not (Test-Path $propsPath)) {
            throw "Prepared apiProperties not found: $propsPath. Run the Artifacts stage first."
        }

        Write-Step "Deploying connector: $($connector.displayName)…"
        $pacOutput = & pac connector create `
            --api-definition-file $swaggerPath `
            --api-properties-file $propsPath `
            --environment $EnvironmentId 2>&1

        if ($LASTEXITCODE -ne 0) {
            Write-Failure "Failed to deploy $($connector.displayName)"
            Write-Host ($pacOutput -join "`n") -ForegroundColor Red
            throw "pac connector create failed for $($connector.displayName)"
        }

        # Try to extract connector ID from pac output
        $connectorIdLine = $pacOutput | Where-Object { $_ -match 'connector.*id|connectorId|/connectors/' } | Select-Object -First 1
        $connectorId = ''
        if ($connectorIdLine -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') {
            $connectorId = $Matches[1]
        }

        $results[$connector.id] = $connectorId
        Write-Success "$($connector.displayName) deployed (ID: $connectorId)"
        Write-Host ($pacOutput -join "`n") -ForegroundColor DarkGray
    }

    # Output summary
    Write-Host "`n────────────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "  Connector Deployment Complete" -ForegroundColor Green
    Write-Host "────────────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-ValueTable $results

    if ($results.ContainsKey('gcf-unified-connector') -and $results.ContainsKey('gcf-mcp-agent')) {
        Write-Host "`n  Next: run the FIC stage:" -ForegroundColor Yellow
        Write-Host @"
    .\Install-GraphConnectorFactory.ps1 -Stage FIC ``
        -ClientAppObjectId '<CLIENT_OBJECT_ID>' ``
        -TenantId '<TENANT_ID>' ``
        -UnifiedConnectorId '$($results['gcf-unified-connector'])' ``
        -McpConnectorId '$($results['gcf-mcp-agent'])' ``
        -EnvironmentId '<ENV_ID>'
"@ -ForegroundColor DarkGray
    }

    return $results
}

# ─────────────────────────────────────────────────────────────────
# Stage 7 — FIC (Federated Identity Credentials)
# ─────────────────────────────────────────────────────────────────

function Invoke-StageFIC {
    Write-StageHeader 'Stage 7 · Federated Identity Credentials'

    Assert-Parameter 'ClientAppObjectId' $ClientAppObjectId 'FIC'
    Assert-Parameter 'TenantId'          $TenantId          'FIC'
    Assert-Parameter 'EnvironmentId'     $EnvironmentId     'FIC'

    $issuer = "https://login.microsoftonline.com/$TenantId/v2.0"

    # Build list of connectors to process
    $connectors = @()
    if ($UnifiedConnectorId) {
        $connectors += @{ Id = $UnifiedConnectorId; Name = 'gcf-unified-connector'; DisplayName = 'Graph Connector Factory' }
    }
    if ($McpConnectorId) {
        $connectors += @{ Id = $McpConnectorId; Name = 'gcf-mcp-agent'; DisplayName = 'Graph Connector Factory - MCP Agent' }
    }

    if ($connectors.Count -eq 0) {
        Write-Warning 'No connector IDs provided. Attempting to discover connectors from Power Platform…'

        # Try listing connectors and matching by name
        Write-Step 'Listing connectors in environment…'
        $pacList = & pac connector list --environment $EnvironmentId 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "pac connector list failed. Provide -UnifiedConnectorId and -McpConnectorId explicitly."
        }

        foreach ($line in $pacList) {
            if ($line -match 'Graph Connector Factory\b' -and $line -notmatch 'MCP Agent') {
                if ($line -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') {
                    $connectors += @{ Id = $Matches[1]; Name = 'gcf-unified-connector'; DisplayName = 'Graph Connector Factory' }
                }
            }
            if ($line -match 'MCP Agent') {
                if ($line -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') {
                    $connectors += @{ Id = $Matches[1]; Name = 'gcf-mcp-agent'; DisplayName = 'Graph Connector Factory - MCP Agent' }
                }
            }
        }

        if ($connectors.Count -eq 0) {
            throw 'Could not discover connectors. Provide -UnifiedConnectorId and -McpConnectorId explicitly.'
        }
        Write-Success "Discovered $($connectors.Count) connector(s)"
    }

    foreach ($conn in $connectors) {
        Write-Step "Processing: $($conn.DisplayName) ($($conn.Id))…"

        # Discover managed-identity subject with retry
        Write-Step '  Waiting for managed-identity subject…'
        $miSubject = Invoke-WithRetry -Activity "MI subject for $($conn.DisplayName)" -MaxAttempts 6 -DelaySeconds 10 -ScriptBlock {
            # Query the connector via Power Platform API to get MI info
            $connectorInfo = & pac connector list --environment $using:EnvironmentId 2>&1
            # Try az rest to get connector properties including MI
            $apiUrl = "https://api.powerapps.com/providers/Microsoft.PowerApps/apis/$($using:conn.Id)?api-version=2024-01-01&`$filter=environment eq '$($using:EnvironmentId)'"
            try {
                $response = az rest --method GET --url $apiUrl --resource 'https://service.powerapps.com/' --output json 2>$null
                if ($response) {
                    $parsed = $response | ConvertFrom-Json
                    $subject = $parsed.properties.metadata.managedIdentityObjectId
                    if ($subject) { return $subject }
                }
            } catch {
                # Fall through to retry
            }

            # Alternative: check if pac connector list output contains MI info
            foreach ($line in $connectorInfo) {
                if ($line -match $using:conn.Id -and $line -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') {
                    # This might be the MI object ID — only if it's different from the connector ID
                    $candidate = $Matches[1]
                    if ($candidate -ne $using:conn.Id) { return $candidate }
                }
            }
            return $null
        }

        if (-not $miSubject) {
            Write-Warning "Could not discover MI subject for $($conn.DisplayName). You can add the FIC manually later."
            Write-Warning "  az ad app federated-credential create --id $ClientAppObjectId --parameters <ficParams.json>"
            continue
        }

        Write-Success "MI Subject: $miSubject"

        # Build FIC parameters
        $ficName = "$($conn.Name)-fic"
        $ficParams = @{
            name        = $ficName
            issuer      = $issuer
            subject     = $miSubject
            audiences   = @('api://AzureADTokenExchange')
            description = "FIC for Power Platform connector: $($conn.DisplayName)"
        }
        $ficJson = $ficParams | ConvertTo-Json -Depth 5 -Compress

        # Check if FIC already exists
        Write-Step "  Checking existing FICs…"
        $existingFics = Invoke-AzCli @('ad', 'app', 'federated-credential', 'list', '--id', $ClientAppObjectId)
        $alreadyExists = $false
        if ($existingFics) {
            foreach ($fic in $existingFics) {
                if ($fic.subject -eq $miSubject -or $fic.name -eq $ficName) {
                    Write-Success "FIC already exists for $($conn.DisplayName) — skipping"
                    $alreadyExists = $true
                    break
                }
            }
        }

        if (-not $alreadyExists) {
            Write-Step "  Adding FIC: $ficName…"

            # Write FIC params to a temp file in the repo (not /tmp)
            $ficFile = Join-Path $repoRoot "artifacts" "fic-$($conn.Name).json"
            $ficParams | ConvertTo-Json -Depth 5 | Set-Content -Path $ficFile -Encoding UTF8

            try {
                Invoke-AzCli @('ad', 'app', 'federated-credential', 'create',
                    '--id', $ClientAppObjectId,
                    '--parameters', "@$ficFile")
                Write-Success "FIC added for $($conn.DisplayName)"
            } finally {
                # Clean up FIC param file
                if (Test-Path $ficFile) { Remove-Item $ficFile -Force }
            }
        }
    }

    # Verify redirect URI on Client app
    Write-Step 'Verifying redirect URI on Client app…'
    $clientAppInfo = Invoke-AzCli @('ad', 'app', 'show', '--id', $ClientAppObjectId)
    $redirectUri = 'https://global.consent.azure-apim.net/redirect'
    $currentUris = @()
    if ($clientAppInfo.web -and $clientAppInfo.web.redirectUris) {
        $currentUris = @($clientAppInfo.web.redirectUris)
    }

    if ($currentUris -contains $redirectUri) {
        Write-Success "Redirect URI already present: $redirectUri"
    } else {
        Write-Step "Adding redirect URI: $redirectUri"
        $allUris = @($currentUris) + @($redirectUri)
        $uriArg = $allUris -join ' '
        Invoke-AzCli @('ad', 'app', 'update', '--id', $ClientAppObjectId,
            '--web-redirect-uris', $redirectUri)
        Write-Success 'Redirect URI added'
    }

    Write-Host "`n────────────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "  FIC Configuration Complete" -ForegroundColor Green
    Write-Host "────────────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "`n  Connectors are now configured with Federated Identity." -ForegroundColor Green
    Write-Host "  Test by creating a connection in Power Platform.`n" -ForegroundColor Gray
}

# ─────────────────────────────────────────────────────────────────
# Stage: All — orchestrate full pipeline
# ─────────────────────────────────────────────────────────────────

function Invoke-StageAll {
    Write-StageHeader 'Full Installation Pipeline'

    # Stage 1
    Invoke-StagePreflight

    # Stage 2
    Invoke-StageBuild

    # Stage 3
    $entraResult = Invoke-StageEntra

    # Propagate Entra outputs to script-level variables
    $script:ApiAppId          = $entraResult.ApiAppId
    $script:ApiAppSecret      = $entraResult.ApiAppSecret
    $script:ClientAppId       = $entraResult.ClientAppId
    $script:ClientAppObjectId = $entraResult.ClientObjectId
    $script:TenantId          = $entraResult.TenantId
    $script:McpAccessScopeId  = $entraResult.McpAccessScopeId

    # Prompt for values not available from Entra stage
    if ([string]::IsNullOrWhiteSpace($ServerHost)) {
        $script:ServerHost = Read-HostIfInteractive 'Enter server host (e.g. abc123-3001.usw3.devtunnels.ms)'
    }
    if ([string]::IsNullOrWhiteSpace($EnvironmentId)) {
        $script:EnvironmentId = Read-HostIfInteractive 'Enter Power Platform environment ID'
    }

    # Stage 4
    Invoke-StageConfig

    # Stage 5
    Invoke-StageArtifacts

    # Stage 6
    $connResult = Invoke-StageConnectors

    if ($connResult.ContainsKey('gcf-unified-connector')) {
        $script:UnifiedConnectorId = $connResult['gcf-unified-connector']
    }
    if ($connResult.ContainsKey('gcf-mcp-agent')) {
        $script:McpConnectorId = $connResult['gcf-mcp-agent']
    }

    # Stage 7
    Invoke-StageFIC

    Write-Host "`n╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "║  Installation Complete!                              ║" -ForegroundColor Green
    Write-Host "╚══════════════════════════════════════════════════════╝`n" -ForegroundColor Green
}

# ─────────────────────────────────────────────────────────────────
# Main dispatch
# ─────────────────────────────────────────────────────────────────

Write-Host "`n  Graph Connector Factory v2 — Installer" -ForegroundColor Cyan
Write-Host "  Repo: $repoRoot`n" -ForegroundColor DarkGray

switch ($Stage) {
    'Plan'       { Invoke-StagePlan }
    'Preflight'  { Invoke-StagePreflight }
    'Build'      { Invoke-StageBuild }
    'Entra'      { Invoke-StageEntra }
    'Config'     { Invoke-StageConfig }
    'Artifacts'  { Invoke-StageArtifacts }
    'Connectors' { Invoke-StageConnectors }
    'FIC'        { Invoke-StageFIC }
    'All'        { Invoke-StageAll }
}
