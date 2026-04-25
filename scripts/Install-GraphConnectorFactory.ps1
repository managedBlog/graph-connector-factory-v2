<#
.SYNOPSIS
    Staged installation script for Graph Connector Factory v2.

.DESCRIPTION
    Deploys Graph Connector Factory v2 through a series of stages:
      0. Plan       — Print what each stage does (no changes).
      1. Preflight  — Verify prerequisites (node, npm, az, pac).
      2. Build      — Run npm install and npm run build.
      3. Entra      — Create API + Client + Enterprise app registrations in Entra ID.
      4. Config     — Generate config/config.json from template + values.
      5. Artifacts  — Token-replace connector solution files, pack .zip files.
      6. Connectors — Import connector solution via pac solution import.
      7. FIC        — Discover auto-generated FIC Subjects, add FICs + redirect URIs.
      8. Agent      — Import agent solution via pac solution import.
      All          — Run stages 1–8 sequentially.

    Architecture: two-app pattern (API app + Client app), optional enterprise app,
    three connectors (Unified REST + MCP Agent + MCP Server for Enterprise),
    OAuth via Federated Identity Credentials.

    CRITICAL ORDERING: Connectors (6) → FIC (7) → Agent (8).
    FIC must happen after connector import (to discover auto-generated Subject)
    and before agent import (so connections can authenticate).

.EXAMPLE
    .\Install-GraphConnectorFactory.ps1 -Stage Plan
    .\Install-GraphConnectorFactory.ps1 -Stage Preflight
    .\Install-GraphConnectorFactory.ps1 -Stage Entra
    .\Install-GraphConnectorFactory.ps1 -Stage Config -ApiAppId <id> -ApiAppSecret <secret> `
        -ClientAppId <id> -TenantId <tid> -ServerHost <host> -EnvironmentId <eid>
    .\Install-GraphConnectorFactory.ps1 -Stage Agent -EnvironmentId <eid>
    .\Install-GraphConnectorFactory.ps1 -Stage All
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Plan', 'Preflight', 'Build', 'Entra', 'Config', 'Artifacts', 'Connectors', 'FIC', 'Agent', 'All')]
    [string] $Stage,

    # --- Entra stage outputs / Config stage inputs ---
    [string] $ApiAppId,
    [string] $ApiAppSecret,
    [string] $ClientAppId,
    [string] $ClientAppObjectId,
    [string] $TenantId,
    [string] $McpAccessScopeId,

    # --- Enterprise MCP connector ---
    [string] $EnterpriseAppId,
    [string] $EnterpriseAppObjectId,
    [switch] $SkipEnterprise,

    # --- Config / Artifacts inputs ---
    [string] $ServerHost,
    [string] $EnvironmentId,
    [string] $CertificatePath,

    # --- Agent stage ---
    [string] $SettingsFile,

    # --- Behaviour ---
    [ValidateSet('ClientSecret', 'Certificate-OpenSSL', 'Certificate-SelfSigned')]
    [string] $AuthMethod = 'ClientSecret',
    [switch] $NonInteractive
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$configDir = Join-Path $repoRoot 'config'
$solutionsDir = Join-Path $repoRoot 'copilot-studio' 'solutions'
$solutionsOutputDir = Join-Path $repoRoot 'artifacts' 'solutions'

# Enterprise MCP Server for Enterprise — global app ID (same across all tenants)
$ENTERPRISE_MCP_APP_ID = 'e8c77dc2-69b3-43f4-bc51-3213c9d915b4'

# Connector schema names for FIC discovery (stable across environments)
$FIC_CONNECTOR_SCHEMAS = @(
    @{ SchemaName = 'new_gcf-20rest-20connector'; DisplayName = 'GCF REST Connector'; IsEnterprise = $false },
    @{ SchemaName = 'new_gcf-20mcp-20agent';     DisplayName = 'GCF MCP Agent';       IsEnterprise = $false },
    @{ SchemaName = 'cr863_5Fmcp-2Dserver-2Dfor-2Denterprise'; DisplayName = 'MCP-Server-for-Enterprise'; IsEnterprise = $true }
)

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
  Stage 3  Entra       — Create API + Client + Enterprise app registrations.
                         Outputs app IDs, secret, scope ID, tenant ID.
  Stage 4  Config      — Generate config/config.json from template + Entra values.
  Stage 5  Artifacts   — Token-replace connector solution files, pack .zip files.
  Stage 6  Connectors  — Import connector solution via pac solution import.
  Stage 7  FIC         — Discover auto-generated FIC Subjects on connectors,
                         add Federated Identity Credentials + redirect URIs.
  Stage 8  Agent       — Import agent solution via pac solution import.

  CRITICAL ORDERING: Connectors (6) → FIC (7) → Agent (8).
  FIC must run AFTER connectors (to read auto-generated Subject)
  and BEFORE agent (so connections can authenticate).

  Typical workflow:
    .\Install-GraphConnectorFactory.ps1 -Stage Preflight
    .\Install-GraphConnectorFactory.ps1 -Stage Build
    .\Install-GraphConnectorFactory.ps1 -Stage Entra
    # Copy output values, then:
    .\Install-GraphConnectorFactory.ps1 -Stage Config -ApiAppId ... -ApiAppSecret ... `
        -ClientAppId ... -TenantId ... -ServerHost ... -EnvironmentId ...
    .\Install-GraphConnectorFactory.ps1 -Stage Artifacts -ApiAppId ... `
        -ClientAppId ... -TenantId ... -ServerHost ... [-EnterpriseAppId ... | -SkipEnterprise]
    .\Install-GraphConnectorFactory.ps1 -Stage Connectors -EnvironmentId ...
    .\Install-GraphConnectorFactory.ps1 -Stage FIC -ClientAppObjectId ... -TenantId ... `
        -EnvironmentId ... [-EnterpriseAppObjectId ...]
    .\Install-GraphConnectorFactory.ps1 -Stage Agent -EnvironmentId ...
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

    # Certificate tool preflight (only when using certificate auth)
    if ($AuthMethod -eq 'Certificate-OpenSSL') {
        Write-Step 'Checking openssl (required for -AuthMethod Certificate-OpenSSL)…'
        if (Test-Command 'openssl') {
            Write-Success "openssl found"
        } else {
            throw 'openssl not found — required for Certificate-OpenSSL. Install OpenSSL or use -AuthMethod Certificate-SelfSigned.'
        }
    } elseif ($AuthMethod -eq 'Certificate-SelfSigned') {
        Write-Step 'Checking New-SelfSignedCertificate (required for -AuthMethod Certificate-SelfSigned)…'
        if (Get-Command 'New-SelfSignedCertificate' -ErrorAction SilentlyContinue) {
            Write-Success "New-SelfSignedCertificate available"
        } else {
            throw 'New-SelfSignedCertificate not available — this cmdlet requires Windows. Use -AuthMethod Certificate-OpenSSL instead.'
        }
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
    Invoke-AzCli @('ad', 'app', 'update', '--id', $apiAppId, '--identifier-uris', "api://$apiAppId") | Out-Null
    Write-Success "Identifier URI: api://$apiAppId"

    # Add MCP.access scope via Graph PATCH (--set api.* fails on fresh apps)
    Write-Step 'Adding MCP.access scope…'

    # Check if scope already exists
    $appDetail = Invoke-AzCli @('rest', '--method', 'GET',
        '--uri', "https://graph.microsoft.com/v1.0/applications/$apiObjectId",
        '--headers', 'Content-Type=application/json')
    $existingScopes = @()
    if ($appDetail.api -and $appDetail.api.oauth2PermissionScopes) {
        $existingScopes = @($appDetail.api.oauth2PermissionScopes)
    }
    $mcpScope = $existingScopes | Where-Object { $_.value -eq 'MCP.access' }

    if ($mcpScope) {
        $scopeId = $mcpScope.id
        Write-Success "MCP.access scope already exists (ID: $scopeId)"
    } else {
        $scopeId = [guid]::NewGuid().ToString()
        $scopeBody = @{
            api = @{
                oauth2PermissionScopes = @(
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
                )
            }
        } | ConvertTo-Json -Depth 5 -Compress
        $tmpScopeFile = Join-Path $env:TEMP 'gcf-scope-body.json'
        $scopeBody | Set-Content $tmpScopeFile -Encoding utf8 -NoNewline
        try {
            Invoke-AzCli @('rest', '--method', 'PATCH',
                '--uri', "https://graph.microsoft.com/v1.0/applications/$apiObjectId",
                '--body', "@$tmpScopeFile",
                '--headers', 'Content-Type=application/json') | Out-Null
            Write-Success "MCP.access scope ID: $scopeId"
        } finally {
            Remove-Item $tmpScopeFile -ErrorAction SilentlyContinue
        }
    }

    # Add Graph API permissions (Application type)
    Write-Step 'Adding Graph API permissions…'
    Invoke-AzCli @('ad', 'app', 'permission', 'add', '--id', $apiAppId,
        '--api', $graphAppId,
        '--api-permissions', "$appReadWriteAllId=Role", "$appRoleAssignRWId=Role") | Out-Null
    Write-Success 'Graph API permissions added (Application.ReadWrite.All, AppRoleAssignment.ReadWrite.All)'

    # ── Credential creation (secret OR certificate) ──
    $apiSecret       = $null
    $certificatePath = $null
    $isCertAuth      = $AuthMethod -like 'Certificate-*'

    if ($isCertAuth) {
        Write-Step 'Generating self-signed certificate…'
        $certDir      = Join-Path $repoRoot 'config'
        $certPubPath  = Join-Path $certDir 'gcf-server-cert.pem'
        $certKeyPath  = Join-Path $certDir 'gcf-server-key.pem'
        $certCombined = Join-Path $certDir 'gcf-server.pem'

        if ($AuthMethod -eq 'Certificate-OpenSSL') {
            # Generate via OpenSSL (cross-platform)
            & openssl req -x509 -newkey rsa:2048 -keyout $certKeyPath -out $certPubPath `
                -days 730 -nodes -subj "/CN=GraphConnectorFactory" 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw 'OpenSSL certificate generation failed.'
            }
            # Combine key + cert into single PEM for Azure Identity SDK
            Get-Content $certKeyPath, $certPubPath | Set-Content $certCombined -Encoding UTF8
        } else {
            # Generate via New-SelfSignedCertificate (Windows-native)
            $cert = New-SelfSignedCertificate -Subject "CN=GraphConnectorFactory" `
                -CertStoreLocation "Cert:\CurrentUser\My" `
                -KeyExportPolicy Exportable `
                -KeySpec Signature `
                -KeyLength 2048 `
                -NotAfter (Get-Date).AddYears(2)

            # Export public cert as PEM
            $pubBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
            $pubB64   = [Convert]::ToBase64String($pubBytes, 'InsertLineBreaks')
            "-----BEGIN CERTIFICATE-----`n$pubB64`n-----END CERTIFICATE-----" | Set-Content $certPubPath -Encoding UTF8

            # Export private key + cert as PFX, then convert to PEM via .NET
            $pfxBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, '')
            $pfxPath  = Join-Path $certDir 'gcf-server-temp.pfx'
            [IO.File]::WriteAllBytes($pfxPath, $pfxBytes)

            # Load PFX and extract RSA private key as PEM
            $pfxCert   = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($pfxPath, '', 'Exportable')
            $rsaKey    = [System.Security.Cryptography.RSA]($pfxCert.PrivateKey)
            $keyBytes  = $rsaKey.ExportRSAPrivateKey()
            $keyB64    = [Convert]::ToBase64String($keyBytes, 'InsertLineBreaks')
            "-----BEGIN RSA PRIVATE KEY-----`n$keyB64`n-----END RSA PRIVATE KEY-----" | Set-Content $certKeyPath -Encoding UTF8

            # Combine key + cert into single PEM for Azure Identity SDK
            Get-Content $certKeyPath, $certPubPath | Set-Content $certCombined -Encoding UTF8

            # Clean up temp PFX and cert store entry
            Remove-Item $pfxPath -ErrorAction SilentlyContinue
            Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
        }

        Write-Success "Certificate generated: $certCombined"

        # Upload public cert to app registration (--append to preserve existing creds)
        Write-Step 'Uploading certificate to API app registration…'
        Invoke-AzCli @('ad', 'app', 'credential', 'reset', '--id', $apiAppId,
            '--cert', "@$certPubPath", '--append') | Out-Null
        Write-Success 'Certificate uploaded to app registration'

        # Store absolute path for config generation
        $certificatePath = (Resolve-Path $certCombined).Path

        # Lock down private key files
        if ($IsWindows -or $env:OS -match 'Windows') {
            icacls $certKeyPath /inheritance:r /grant:r "${env:USERNAME}:(R)" 2>&1 | Out-Null
            icacls $certCombined /inheritance:r /grant:r "${env:USERNAME}:(R)" 2>&1 | Out-Null
        }
        Write-Warning "Private key files are in config/. They are gitignored but keep them secure."
    } else {
        # ClientSecret path
        Write-Step 'Creating client secret…'
        $secretResult = Invoke-AzCli @('ad', 'app', 'credential', 'reset', '--id', $apiAppId,
            '--display-name', 'GCF Server Secret', '--years', '2')
        $apiSecret = $secretResult.password
        Write-Success 'Client secret created'
    }

    # Ensure service principal (must exist BEFORE admin consent)
    Write-Step 'Ensuring service principal for API app…'
    try {
        Invoke-AzCli @('ad', 'sp', 'create', '--id', $apiAppId) | Out-Null
        Write-Success 'Service principal created'
    } catch {
        if ($_.Exception.Message -match 'already exists|already in use') {
            Write-Success 'Service principal already exists'
        } else { throw }
    }

    # Grant admin consent (requires SP to exist; may need propagation delay)
    Write-Step 'Granting admin consent for API app…'
    Start-Sleep -Seconds 5  # Allow SP to propagate in Entra ID
    $consentAttempts = 3
    $consentGranted = $false
    for ($i = 1; $i -le $consentAttempts; $i++) {
        try {
            $consentOutput = Invoke-AzCli @('ad', 'app', 'permission', 'admin-consent', '--id', $apiAppId)
            Write-Success 'Admin consent granted for API app'
            $consentGranted = $true
            break
        } catch {
            Write-Warning "Admin consent attempt $i/$consentAttempts failed: $($_.Exception.Message)"
            if ($i -lt $consentAttempts) {
                Write-Host "    Retrying in 10s…" -ForegroundColor DarkGray
                Start-Sleep -Seconds 10
            }
        }
    }
    if (-not $consentGranted) {
        Write-Warning "Admin consent could not be granted automatically. Grant manually:"
        Write-Warning "  az ad app permission admin-consent --id $apiAppId"
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
        '--api-permissions', "$scopeId=Scope") | Out-Null
    Write-Success 'MCP.access (Delegated) added to Client app'

    # Ensure service principal for client app (must exist BEFORE admin consent)
    Write-Step 'Ensuring service principal for Client app…'
    try {
        Invoke-AzCli @('ad', 'sp', 'create', '--id', $clientAppId) | Out-Null
        Write-Success 'Service principal created'
    } catch {
        if ($_.Exception.Message -match 'already exists|already in use') {
            Write-Success 'Service principal already exists'
        } else { throw }
    }

    # Grant admin consent for client app (requires SP to exist)
    Write-Step 'Granting admin consent for Client app…'
    Start-Sleep -Seconds 5
    $consentGranted = $false
    for ($i = 1; $i -le 3; $i++) {
        try {
            $consentOutput = Invoke-AzCli @('ad', 'app', 'permission', 'admin-consent', '--id', $clientAppId)
            Write-Success 'Admin consent granted for Client app'
            $consentGranted = $true
            break
        } catch {
            Write-Warning "Admin consent attempt $i/3 failed: $($_.Exception.Message)"
            if ($i -lt 3) {
                Write-Host "    Retrying in 10s…" -ForegroundColor DarkGray
                Start-Sleep -Seconds 10
            }
        }
    }
    if (-not $consentGranted) {
        Write-Warning "Admin consent could not be granted automatically for Client app. Grant manually:"
        Write-Warning "  az ad app permission admin-consent --id $clientAppId"
    }

    # ── Power Platform management app registration ───────────────
    Write-Step 'Registering apps as Power Platform management apps…'
    try {
        $regOutput = & pac admin application register --application-id $apiAppId 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not register API app as management app: $regOutput"
        } else {
            Write-Success "API app registered as management app"
        }
    } catch {
        Write-Warning "Could not register API app as management app: $_"
    }
    try {
        $regOutput = & pac admin application register --application-id $clientAppId 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not register Client app as management app: $regOutput"
        } else {
            Write-Success "Client app registered as management app"
        }
    } catch {
        Write-Warning "Could not register Client app as management app: $_"
    }

    # ── Enterprise MCP Server for Enterprise ─────────────────────
    # Per Microsoft docs, the MCP Server for Enterprise connector requires a
    # dedicated client app registration named "MCP Server for Enterprise" with
    # MCP.User.Read.All (delegated) + Graph User.Read permissions.
    # FIC for this connector routes to the enterprise app, NOT the Client app.
    # Ref: https://learn.microsoft.com/en-us/graph/mcp-server/use-enterprise-mcp-server-copilot-studio
    $enterpriseAppId       = $EnterpriseAppId
    $enterpriseAppObjectId = $EnterpriseAppObjectId
    $skipEnt               = $SkipEnterprise.IsPresent

    # Well-known scope IDs for required permissions
    $ENTERPRISE_APP_DISPLAY_NAME = 'MCP Server for Enterprise'
    $MCP_USER_READ_ALL_SCOPE_ID  = '98caa7ee-5b52-4b41-829f-c090dc6087f1'   # MCP.User.Read.All
    $GRAPH_USER_READ_SCOPE_ID    = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'   # User.Read
    $GRAPH_APP_ID                = '00000003-0000-0000-c000-000000000000'    # Microsoft Graph

    if (-not $skipEnt) {
        Write-Step 'Checking if MCP Server for Enterprise SP exists in tenant…'
        $enterpriseSpResult = Invoke-AzCli @('rest', '--method', 'get',
            '--url', "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '$ENTERPRISE_MCP_APP_ID'&`$select=id,appId,displayName,oauth2PermissionScopes",
            '--output', 'json') 2>$null

        if (-not $enterpriseSpResult.value -or $enterpriseSpResult.value.Count -eq 0) {
            Write-Warning 'MCP Server for Enterprise is NOT provisioned in this tenant.'
            Write-Host '  Enterprise connector will be stripped from the solution.' -ForegroundColor Yellow
            Write-Host '  To provision: https://learn.microsoft.com/en-us/graph/mcp-server/get-started' -ForegroundColor DarkGray
            $skipEnt = $true
        } else {
            $enterpriseSp = $enterpriseSpResult.value[0]
            Write-Success "MCP Server for Enterprise SP found: $($enterpriseSp.displayName)"

            # Verify MCP.User.Read.All scope exists on the SP
            $mcpUserReadAll = $enterpriseSp.oauth2PermissionScopes | Where-Object { $_.id -eq $MCP_USER_READ_ALL_SCOPE_ID }
            if (-not $mcpUserReadAll) {
                $mcpUserReadAll = $enterpriseSp.oauth2PermissionScopes | Where-Object { $_.value -eq 'MCP.User.Read.All' }
            }
            if ($mcpUserReadAll) {
                Write-Success "MCP.User.Read.All scope confirmed (ID: $($mcpUserReadAll.id))"
            } else {
                Write-Warning 'MCP.User.Read.All scope not found on enterprise SP — permissions may be incomplete'
            }

            # ── Resolve enterprise app registration ──────────────────
            # Priority: explicit -EnterpriseAppId > displayName search > oauth2PermissionGrants fallback > create new

            if ([string]::IsNullOrWhiteSpace($enterpriseAppId)) {
                # Strategy 1: Search by exact displayName "MCP Server for Enterprise"
                Write-Step "Searching for existing app registration: $ENTERPRISE_APP_DISPLAY_NAME…"
                $nameSearchResult = Invoke-AzCli @('rest', '--method', 'get',
                    '--url', "https://graph.microsoft.com/v1.0/applications?`$filter=displayName eq '$ENTERPRISE_APP_DISPLAY_NAME'&`$select=id,appId,displayName,requiredResourceAccess,web",
                    '--output', 'json') 2>$null

                $candidates = @()
                if ($nameSearchResult.value -and $nameSearchResult.value.Count -gt 0) {
                    # Exact displayName match only
                    $candidates = @($nameSearchResult.value | Where-Object { $_.displayName -eq $ENTERPRISE_APP_DISPLAY_NAME })
                }

                if ($candidates.Count -eq 1) {
                    $enterpriseAppId       = $candidates[0].appId
                    $enterpriseAppObjectId = $candidates[0].id
                    Write-Success "Found existing app: $ENTERPRISE_APP_DISPLAY_NAME (appId: $enterpriseAppId)"
                } elseif ($candidates.Count -gt 1) {
                    # Multiple matches — pick the one with expected MCP permissions
                    $bestMatch = $candidates | Where-Object {
                        $_.requiredResourceAccess | Where-Object { $_.resourceAppId -eq $ENTERPRISE_MCP_APP_ID }
                    } | Select-Object -First 1

                    if ($bestMatch) {
                        $enterpriseAppId       = $bestMatch.appId
                        $enterpriseAppObjectId = $bestMatch.id
                        Write-Success "Found app with MCP permissions: $ENTERPRISE_APP_DISPLAY_NAME (appId: $enterpriseAppId)"
                    } else {
                        $enterpriseAppId       = $candidates[0].appId
                        $enterpriseAppObjectId = $candidates[0].id
                        Write-Warning "Multiple '$ENTERPRISE_APP_DISPLAY_NAME' apps found — using first: $enterpriseAppId"
                    }
                }
            }

            if ([string]::IsNullOrWhiteSpace($enterpriseAppId)) {
                # Strategy 2: Fallback — reverse lookup via oauth2PermissionGrants
                Write-Step 'Checking oauth2PermissionGrants for existing enterprise app…'
                $grants = Invoke-AzCli @('rest', '--method', 'get',
                    '--url', "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?`$filter=resourceId eq '$($enterpriseSp.id)'&`$select=clientId,scope",
                    '--output', 'json') 2>$null

                if ($grants.value -and $grants.value.Count -gt 0) {
                    foreach ($grant in $grants.value) {
                        try {
                            $grantSpInfo = Invoke-AzCli @('rest', '--method', 'get',
                                '--url', "https://graph.microsoft.com/v1.0/servicePrincipals/$($grant.clientId)`?`$select=appId,displayName",
                                '--output', 'json')
                        } catch {
                            Write-Host "  Grant references SP $($grant.clientId) which no longer exists — skipping" -ForegroundColor DarkGray
                            continue
                        }

                        try {
                            $grantAppInfo = Invoke-AzCli @('ad', 'app', 'show', '--id', $grantSpInfo.appId)
                        } catch {
                            Write-Host "  App registration for $($grantSpInfo.appId) not found — skipping" -ForegroundColor DarkGray
                            continue
                        }

                        if ($grantAppInfo.displayName -eq $ENTERPRISE_APP_DISPLAY_NAME) {
                            $enterpriseAppId       = $grantAppInfo.appId
                            $enterpriseAppObjectId = $grantAppInfo.id
                            Write-Success "Found via grant lookup: $($grantAppInfo.displayName) (appId: $enterpriseAppId)"
                            break
                        }
                    }
                }

                if ([string]::IsNullOrWhiteSpace($enterpriseAppId)) {
                    Write-Host '  No existing enterprise app found via grant lookup.' -ForegroundColor DarkGray
                }
            }

            # Resolve full app object if we have an appId but not objectId (e.g. passed via param)
            if (-not [string]::IsNullOrWhiteSpace($enterpriseAppId) -and [string]::IsNullOrWhiteSpace($enterpriseAppObjectId)) {
                Write-Step 'Resolving enterprise app object ID…'
                $resolvedApp = Invoke-AzCli @('ad', 'app', 'show', '--id', $enterpriseAppId)
                $enterpriseAppObjectId = $resolvedApp.id
                Write-Success "Resolved object ID: $enterpriseAppObjectId"
            }

            # ── Create if still not found ────────────────────────────
            if ([string]::IsNullOrWhiteSpace($enterpriseAppId)) {
                Write-Step "Creating app registration: $ENTERPRISE_APP_DISPLAY_NAME…"
                $enterpriseApp = Invoke-AzCli @('ad', 'app', 'create',
                    '--display-name', $ENTERPRISE_APP_DISPLAY_NAME,
                    '--web-redirect-uris', 'https://global.consent.azure-apim.net/redirect')
                $enterpriseAppId       = $enterpriseApp.appId
                $enterpriseAppObjectId = $enterpriseApp.id
                Write-Success "Created: $ENTERPRISE_APP_DISPLAY_NAME (appId: $enterpriseAppId, objectId: $enterpriseAppObjectId)"
            }

            # ── Reconcile permissions (idempotent) ───────────────────
            # Required: MCP.User.Read.All on enterprise SP + User.Read on MS Graph
            Write-Step 'Reconciling API permissions on enterprise app…'
            $currentApp = Invoke-AzCli @('rest', '--method', 'get',
                '--url', "https://graph.microsoft.com/v1.0/applications/$enterpriseAppObjectId`?`$select=requiredResourceAccess,web",
                '--output', 'json')
            $existingAccess = @()
            if ($currentApp.requiredResourceAccess) {
                $existingAccess = @($currentApp.requiredResourceAccess)
            }

            # Build required permission entries
            $requiredEntries = @(
                @{ resourceAppId = $ENTERPRISE_MCP_APP_ID; scopeId = $MCP_USER_READ_ALL_SCOPE_ID; label = 'MCP.User.Read.All' },
                @{ resourceAppId = $GRAPH_APP_ID;          scopeId = $GRAPH_USER_READ_SCOPE_ID;   label = 'User.Read' }
            )

            $permissionsChanged = $false
            foreach ($req in $requiredEntries) {
                $existingResource = $existingAccess | Where-Object { $_.resourceAppId -eq $req.resourceAppId }
                if ($existingResource) {
                    $hasScope = $existingResource.resourceAccess | Where-Object { $_.id -eq $req.scopeId }
                    if (-not $hasScope) {
                        $existingResource.resourceAccess += @(@{ id = $req.scopeId; type = 'Scope' })
                        $permissionsChanged = $true
                        Write-Host "    Adding missing permission: $($req.label)" -ForegroundColor DarkCyan
                    } else {
                        Write-Success "$($req.label) already present"
                    }
                } else {
                    $existingAccess += @(@{
                        resourceAppId  = $req.resourceAppId
                        resourceAccess = @(@{ id = $req.scopeId; type = 'Scope' })
                    })
                    $permissionsChanged = $true
                    Write-Host "    Adding permission: $($req.label)" -ForegroundColor DarkCyan
                }
            }

            if ($permissionsChanged) {
                $entPermBody = @{ requiredResourceAccess = $existingAccess } | ConvertTo-Json -Depth 5 -Compress
                $tmpEntPermFile = Join-Path $env:TEMP 'gcf-ent-perm-body.json'
                $entPermBody | Set-Content $tmpEntPermFile -Encoding utf8 -NoNewline
                try {
                    Invoke-AzCli @('rest', '--method', 'PATCH',
                        '--uri', "https://graph.microsoft.com/v1.0/applications/$enterpriseAppObjectId",
                        '--body', "@$tmpEntPermFile",
                        '--headers', 'Content-Type=application/json') | Out-Null
                    Write-Success 'API permissions updated'
                } catch {
                    Write-Warning "Failed to update permissions: $_"
                } finally {
                    Remove-Item $tmpEntPermFile -ErrorAction SilentlyContinue
                }
            } else {
                Write-Success 'All required API permissions already present'
            }

            # Ensure redirect URI
            $baseRedirect = 'https://global.consent.azure-apim.net/redirect'
            $currentWebUris = @()
            if ($currentApp.web -and $currentApp.web.redirectUris) {
                $currentWebUris = @($currentApp.web.redirectUris)
            }
            if ($currentWebUris -notcontains $baseRedirect) {
                $allUris = @($currentWebUris) + @($baseRedirect)
                $updateArgs = @('ad', 'app', 'update', '--id', $enterpriseAppObjectId, '--web-redirect-uris') + $allUris
                Invoke-AzCli $updateArgs | Out-Null
                Write-Success "Base redirect URI added to enterprise app"
            }

            # Ensure SP for enterprise app
            try {
                Invoke-AzCli @('ad', 'sp', 'create', '--id', $enterpriseAppId) | Out-Null
                Write-Success 'Enterprise app service principal created'
            } catch {
                if ($_.Exception.Message -match 'already exists|already in use') {
                    Write-Success 'Enterprise app service principal already exists'
                } else { throw }
            }

            # Grant admin consent
            try {
                Invoke-AzCli @('ad', 'app', 'permission', 'admin-consent', '--id', $enterpriseAppId) | Out-Null
                Write-Success 'Admin consent granted for enterprise app'
            } catch {
                Write-Warning "Admin consent may require Global Admin. Grant manually: az ad app permission admin-consent --id $enterpriseAppId"
            }
        }
    } else {
        Write-Host "`n  Enterprise MCP: Skipped (-SkipEnterprise)" -ForegroundColor DarkGray
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
    if (-not $skipEnt -and -not [string]::IsNullOrWhiteSpace($enterpriseAppId)) {
        $outputValues['Enterprise App ID']       = $enterpriseAppId
        $outputValues['Enterprise Object ID']    = $enterpriseAppObjectId
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
    $result = @{
        ApiAppId          = $apiAppId
        ApiObjectId       = $apiObjectId
        ApiAppSecret      = $apiSecret
        CertificatePath   = $certificatePath
        AuthMethod        = $AuthMethod
        ClientAppId       = $clientAppId
        ClientObjectId    = $clientObjectId
        McpAccessScopeId  = $scopeId
        TenantId          = $tenantId
    }
    if (-not $skipEnt -and -not [string]::IsNullOrWhiteSpace($enterpriseAppId)) {
        $result.EnterpriseAppId       = $enterpriseAppId
        $result.EnterpriseAppObjectId = $enterpriseAppObjectId
    }
    if ($skipEnt) {
        $result.SkipEnterprise = $true
    }
    return $result
}

# ─────────────────────────────────────────────────────────────────
# Stage 4 — Config
# ─────────────────────────────────────────────────────────────────

function Invoke-StageConfig {
    Write-StageHeader 'Stage 4 · Config Generation'

    Assert-Parameter 'ApiAppId'      $ApiAppId      'Config'
    Assert-Parameter 'ClientAppId'   $ClientAppId   'Config'
    Assert-Parameter 'TenantId'      $TenantId      'Config'
    Assert-Parameter 'ServerHost'    $ServerHost    'Config'
    Assert-Parameter 'EnvironmentId' $EnvironmentId 'Config'

    # Auth-method-specific validation
    $isCertAuth = $AuthMethod -like 'Certificate-*'
    if ($isCertAuth) {
        if ([string]::IsNullOrWhiteSpace($CertificatePath)) {
            throw "Parameter -CertificatePath is required for Certificate auth. Run Stage 3 (Entra) with -AuthMethod Certificate first."
        }
        if (-not (Test-Path $CertificatePath)) {
            throw "Certificate file not found: $CertificatePath"
        }
    } else {
        Assert-Parameter 'ApiAppSecret' $ApiAppSecret 'Config'
    }

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

    $config = $content | ConvertFrom-Json

    # Server host
    if ($config.server.PSObject.Properties.Name -notcontains 'host') {
        $config.server | Add-Member -NotePropertyName 'host' -NotePropertyValue $ServerHost
    } else {
        $config.server.host = $ServerHost
    }

    # ── Auth configuration based on method ──
    if ($isCertAuth) {
        Write-Step 'Configuring certificate authentication…'

        # Set method to certificate on both auth sections
        $config.powerPlatform.auth.method = 'certificate'
        $config.graphApi.auth.method      = 'certificate'

        # Add certificatePath
        foreach ($section in @($config.powerPlatform.auth, $config.graphApi.auth)) {
            if ($section.PSObject.Properties.Name -notcontains 'certificatePath') {
                $section | Add-Member -NotePropertyName 'certificatePath' -NotePropertyValue $CertificatePath
            } else {
                $section.certificatePath = $CertificatePath
            }
            # Remove clientSecret if present from template
            if ($section.PSObject.Properties.Name -contains 'clientSecret') {
                $section.PSObject.Properties.Remove('clientSecret')
            }
        }

        Write-Success "Auth method: certificate ($CertificatePath)"
    } else {
        Write-Step 'Configuring client secret authentication…'

        # Set environment variable (current session + persisted)
        $env:GCF_CLIENT_SECRET = $ApiAppSecret
        [Environment]::SetEnvironmentVariable('GCF_CLIENT_SECRET', $ApiAppSecret, 'User')
        Write-Success 'GCF_CLIENT_SECRET set in current session and persisted to user environment'

        # Do NOT write secret to config.json — server reads from env var
        # Remove clientSecret from config if present
        foreach ($section in @($config.powerPlatform.auth, $config.graphApi.auth)) {
            if ($section.PSObject.Properties.Name -contains 'clientSecret') {
                $section.PSObject.Properties.Remove('clientSecret')
            }
        }

        Write-Success 'Auth method: clientCredential (secret via GCF_CLIENT_SECRET env var)'
    }

    Write-Step "Writing config: $outputPath"
    $config | ConvertTo-Json -Depth 10 | Set-Content -Path $outputPath -Encoding UTF8
    Write-Success "config.json generated at: $outputPath"

    if ($isCertAuth) {
        Write-Warning 'config.json references a local certificate file — ensure both are secured.'
    } else {
        Write-Host "  ℹ  Secret is NOT in config.json. It is stored in the GCF_CLIENT_SECRET" -ForegroundColor Cyan
        Write-Host "     environment variable. Restart VS Code / terminals to pick it up." -ForegroundColor Cyan
    }
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

    $oauthResourceUri = "api://$ApiAppId"
    $prepareScript    = Join-Path $PSScriptRoot 'Prepare-Artifacts.ps1'

    if (-not (Test-Path $prepareScript)) {
        throw "Prepare-Artifacts.ps1 not found at: $prepareScript"
    }

    Write-Step "Calling Prepare-Artifacts.ps1…"
    $prepArgs = @{
        ServerHost      = $ServerHost
        OAuthClientId   = $ClientAppId
        OAuthResourceUri = $oauthResourceUri
        TenantId        = $TenantId
        OutputDir       = $solutionsOutputDir
    }

    if ($SkipEnterprise) {
        $prepArgs['SkipEnterprise'] = $true
    } elseif (-not [string]::IsNullOrWhiteSpace($EnterpriseAppId)) {
        $prepArgs['EnterpriseAppId'] = $EnterpriseAppId
    }

    & $prepareScript @prepArgs

    # Verify outputs
    $connectorZip = Join-Path $solutionsOutputDir 'GCFApps_connectors.zip'
    $agentZip     = Join-Path $solutionsOutputDir 'GCFApps_agent.zip'

    if (-not (Test-Path $connectorZip)) {
        throw "Connector solution zip not found: $connectorZip"
    }
    if (-not (Test-Path $agentZip)) {
        throw "Agent solution zip not found: $agentZip"
    }

    Write-Success 'Artifact preparation complete'
    Write-Success "Connector zip: $connectorZip"
    Write-Success "Agent zip:     $agentZip"
}

# ─────────────────────────────────────────────────────────────────
# Stage 6 — Connectors (Solution Import)
# ─────────────────────────────────────────────────────────────────

function Invoke-StageConnectors {
    Write-StageHeader 'Stage 6 · Connector Solution Import'

    Assert-Parameter 'EnvironmentId' $EnvironmentId 'Connectors'

    $connectorZip = Join-Path $solutionsOutputDir 'GCFApps_connectors.zip'
    if (-not (Test-Path $connectorZip)) {
        throw "Connector solution zip not found: $connectorZip. Run the Artifacts stage first."
    }

    Write-Step "Importing connector solution: $connectorZip"
    Write-Step "Target environment: $EnvironmentId"

    $pacOutput = & pac solution import `
        --path $connectorZip `
        --force-overwrite `
        --publish-changes `
        --environment $EnvironmentId 2>&1

    if ($LASTEXITCODE -ne 0) {
        Write-Failure 'Connector solution import failed'
        Write-Host ($pacOutput -join "`n") -ForegroundColor Red
        Write-Host "`n  Troubleshooting:" -ForegroundColor Yellow
        Write-Host "    - Verify pac auth: pac auth list" -ForegroundColor Yellow
        Write-Host "    - Verify environment: pac env list" -ForegroundColor Yellow
        Write-Host "    - Check for missing dependencies in the solution" -ForegroundColor Yellow
        throw 'pac solution import failed for connector solution'
    }

    Write-Host ($pacOutput -join "`n") -ForegroundColor DarkGray
    Write-Success 'Connector solution imported successfully'

    Write-Host "`n────────────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "  Connector Solution Import Complete" -ForegroundColor Green
    Write-Host "────────────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "`n  IMPORTANT: FIC Subject generation may take up to 5 minutes." -ForegroundColor Yellow
    Write-Host "  The FIC stage will poll with exponential backoff.`n" -ForegroundColor Yellow

    Write-Host "  Next: run the FIC stage:" -ForegroundColor Yellow
    Write-Host @"
    .\Install-GraphConnectorFactory.ps1 -Stage FIC ``
        -ClientAppObjectId '<CLIENT_OBJECT_ID>' ``
        -TenantId '<TENANT_ID>' ``
        -EnvironmentId '$EnvironmentId'
"@ -ForegroundColor DarkGray
}

# ─────────────────────────────────────────────────────────────────
# Stage 7 — FIC (Federated Identity Credentials)
#
# CRITICAL: Must run AFTER Connectors (Stage 6) and BEFORE Agent (Stage 8).
# Power Platform auto-generates FIC Subject values after connector import.
# There is a propagation delay — we use exponential backoff to wait.
# ─────────────────────────────────────────────────────────────────

function Invoke-StageFIC {
    Write-StageHeader 'Stage 7 · Federated Identity Credentials'

    Assert-Parameter 'ClientAppObjectId' $ClientAppObjectId 'FIC'
    Assert-Parameter 'TenantId'          $TenantId          'FIC'
    Assert-Parameter 'EnvironmentId'     $EnvironmentId     'FIC'

    $issuer = "https://login.microsoftonline.com/$TenantId/v2.0"

    # Resolve enterprise app object ID if enterprise app ID provided
    $entObjId = $EnterpriseAppObjectId
    if (-not $SkipEnterprise -and [string]::IsNullOrWhiteSpace($entObjId) -and -not [string]::IsNullOrWhiteSpace($EnterpriseAppId)) {
        Write-Step 'Resolving Enterprise app object ID…'
        $entApp = Invoke-AzCli @('ad', 'app', 'show', '--id', $EnterpriseAppId, '--query', 'id', '--output', 'tsv')
        if ($entApp) {
            $entObjId = "$entApp".Trim()
            Write-Success "Enterprise app object ID: $entObjId"
        }
    }

    # Build connector list to process
    $connectorSchemas = @()
    foreach ($schema in $FIC_CONNECTOR_SCHEMAS) {
        if ($schema.IsEnterprise -and $SkipEnterprise) { continue }
        $connectorSchemas += $schema
    }

    if ($connectorSchemas.Count -eq 0) {
        Write-Warning 'No connectors to process for FIC.'
        return
    }

    # ── Phase 1: List connectors in environment ──────────────────────
    Write-Step 'Phase 1: Listing connectors in environment…'
    $ppApiBase    = 'https://api.powerapps.com/providers/Microsoft.PowerApps'
    $ppApiVersion = '2016-11-01'

    $listUrl = "${ppApiBase}/apis?api-version=${ppApiVersion}&`$filter=environment eq '${EnvironmentId}'"
    $listResponse = Invoke-AzCli @('rest', '--method', 'GET', '--url', $listUrl,
        '--resource', 'https://service.powerapps.com/', '--output', 'json')

    if (-not $listResponse -or -not $listResponse.value) {
        throw "Failed to list connectors in environment $EnvironmentId"
    }
    $allConnectors = @($listResponse.value)
    Write-Success "Found $($allConnectors.Count) connector(s) in environment"

    # ── Phase 2+3: Match and extract FIC with exponential backoff ────
    Write-Step 'Phase 2: Matching connectors and extracting FIC values…'
    Write-Host ''

    $maxRetries    = 6      # 6 attempts: initial + 5 retries (waits: 10, 20, 40, 80, 160 ≈ 5 min)
    $baseDelaySec  = 10
    $ficEntries    = @()
    $pendingSchemas = [System.Collections.Generic.List[hashtable]]::new()
    foreach ($s in $connectorSchemas) { $pendingSchemas.Add($s) }

    for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
        $stillPending = [System.Collections.Generic.List[hashtable]]::new()

        foreach ($schema in $pendingSchemas) {
            Write-Host "    [$attempt/$maxRetries] Looking for: $($schema.SchemaName)" -ForegroundColor White

            # Match connector by schema name or display name
            # The API encodes underscores as -5f (e.g. new_gcf → new-5fgcf)
            # and lowercases everything. Also match by displayName as fallback.
            $schemaPattern = $schema.SchemaName
            $schemaPatternEncoded = ($schemaPattern -replace '_', '-5f').ToLower()
            $schemaPatternLower = $schemaPattern.ToLower()
            $match = $allConnectors | Where-Object {
                $_.name -ilike "*$schemaPattern*" -or
                $_.name -ilike "*$schemaPatternEncoded*" -or
                $_.name -ilike "*$schemaPatternLower*" -or
                $_.properties.displayName -eq $schema.DisplayName
            }

            if (-not $match) {
                Write-Host "      NOT FOUND in environment — will retry" -ForegroundColor Yellow
                $stillPending.Add($schema)
                continue
            }

            # Handle multiple matches
            if ($match -is [array] -and $match.Count -gt 1) {
                Write-Warning "Multiple matches for $($schema.SchemaName) — using first"
                $match = $match[0]
            }

            $connId = $match.name
            Write-Host "      Found: $connId" -ForegroundColor DarkGray

            # GET full connector definition to read FIC fields
            $getUrl = "${ppApiBase}/apis/${connId}?api-version=${ppApiVersion}&`$filter=environment eq '${EnvironmentId}'"
            try {
                $fullDef = Invoke-AzCli @('rest', '--method', 'GET', '--url', $getUrl,
                    '--resource', 'https://service.powerapps.com/', '--output', 'json')
            } catch {
                Write-Host "      Failed to GET definition: $_" -ForegroundColor Red
                $stillPending.Add($schema)
                continue
            }

            # Extract FIC fields
            $oAuthSettings = $null
            try { $oAuthSettings = $fullDef.properties.connectionParameters.token.oAuthSettings } catch { }

            if (-not $oAuthSettings) {
                Write-Host "      No oAuthSettings found — will retry" -ForegroundColor Yellow
                $stillPending.Add($schema)
                continue
            }

            $redirectUri = $oAuthSettings.redirectUrl
            $ficBlock    = $null
            try { $ficBlock = $oAuthSettings.properties.FederatedIdentityCredentials } catch { }

            $ficSubject  = if ($ficBlock) { $ficBlock.Subject } else { $null }
            $ficIssuer   = if ($ficBlock) { $ficBlock.Issuer } else { $null }

            if ([string]::IsNullOrWhiteSpace($ficSubject)) {
                Write-Host "      Subject not yet populated — will retry" -ForegroundColor DarkYellow
                $stillPending.Add($schema)
                continue
            }

            # FIC entry collected successfully
            $ficName = "fic-$($schema.SchemaName -replace '[^a-zA-Z0-9-]', '-')"
            $ficEntries += @{
                SchemaName    = $schema.SchemaName
                DisplayName   = $schema.DisplayName
                IsEnterprise  = $schema.IsEnterprise
                ConnectorId   = $connId
                FicName       = $ficName
                FicSubject    = $ficSubject
                FicIssuer     = if ($ficIssuer) { $ficIssuer } else { $issuer }
                RedirectUri   = $redirectUri
            }

            Write-Success "Extracted FIC for: $($schema.DisplayName)"
            Write-Host "      Subject:      $ficSubject" -ForegroundColor DarkGray
            Write-Host "      Redirect URI: $redirectUri" -ForegroundColor DarkGray
            Write-Host ''
        }

        if ($stillPending.Count -eq 0) {
            $pendingSchemas = $stillPending
            break
        }

        if ($attempt -lt $maxRetries) {
            $wait = $baseDelaySec * [math]::Pow(2, $attempt - 1)
            Write-Host ''
            Write-Host "    Waiting ${wait}s for FIC Subject generation ($($stillPending.Count) pending)…" -ForegroundColor DarkCyan
            Start-Sleep -Seconds $wait

            # Refresh connector list
            try {
                $listResponse = Invoke-AzCli @('rest', '--method', 'GET', '--url', $listUrl,
                    '--resource', 'https://service.powerapps.com/', '--output', 'json')
                $allConnectors = @($listResponse.value)
            } catch {
                Write-Warning "Failed to refresh connector list: $_"
            }
        }

        $pendingSchemas = $stillPending
    }

    # Report connectors whose Subject never appeared
    if ($pendingSchemas.Count -gt 0) {
        Write-Host ''
        Write-Warning "FIC Subject still empty after $maxRetries retries for:"
        foreach ($s in $pendingSchemas) {
            Write-Host "      - $($s.DisplayName) ($($s.SchemaName))" -ForegroundColor Yellow
        }
        Write-Host ''
        Write-Host "  Verify in make.powerapps.com → connector Security tab:" -ForegroundColor Yellow
        Write-Host "    1. clientAssertionType = GenericFederatedIdentityCredential" -ForegroundColor Yellow
        Write-Host "    2. FederatedIdentityCredentials block has a Subject value" -ForegroundColor Yellow

        if ($NonInteractive) {
            throw "FIC discovery incomplete for $($pendingSchemas.Count) connector(s). Cannot proceed in non-interactive mode."
        }

        Write-Host ''
        $continue = Read-Host "  Continue with $($ficEntries.Count) collected FIC(s)? (y/n)"
        if ($continue -ne 'y') { throw 'FIC discovery incomplete. Re-run after Subject values are available.' }
    }

    if ($ficEntries.Count -eq 0) {
        throw "No FIC values discovered. Ensure connector solution was imported (Stage 6) and wait for Subject generation."
    }

    # ── Phase 4: Create FIC credentials ──────────────────────────────
    Write-Step "Phase 3: Creating Federated Identity Credentials…"
    Write-Host ''

    $ficFailures = @()
    foreach ($entry in $ficEntries) {
        # Route to correct app: enterprise → enterprise app, core → client app
        $targetObjId = if ($entry.IsEnterprise -and $entObjId) { $entObjId } else { $ClientAppObjectId }
        $targetLabel = if ($entry.IsEnterprise) { 'ENTERPRISE' } else { 'CLIENT' }

        if ($entry.IsEnterprise -and -not $entObjId) {
            Write-Warning "Skipping enterprise FIC — no EnterpriseAppObjectId available"
            $ficFailures += $entry.DisplayName
            continue
        }

        Write-Step "  Creating FIC: $($entry.FicName) → $targetLabel app"

        # Check if FIC already exists
        $existingFics = Invoke-AzCli @('ad', 'app', 'federated-credential', 'list', '--id', $targetObjId)
        $alreadyExists = $false
        if ($existingFics) {
            foreach ($fic in $existingFics) {
                if ($fic.subject -eq $entry.FicSubject -or $fic.name -eq $entry.FicName) {
                    Write-Success "FIC already exists for $($entry.DisplayName) — skipping"
                    $alreadyExists = $true
                    break
                }
            }
        }

        if (-not $alreadyExists) {
            $ficParams = @{
                name        = $entry.FicName
                issuer      = $entry.FicIssuer
                subject     = $entry.FicSubject
                audiences   = @('api://AzureADTokenExchange')
                description = "FIC for Power Platform connector: $($entry.DisplayName)"
            }

            $ficFile = Join-Path $repoRoot "artifacts" "fic-$($entry.FicName).json"
            $ficParams | ConvertTo-Json -Depth 5 | Set-Content -Path $ficFile -Encoding UTF8

            try {
                Invoke-AzCli @('ad', 'app', 'federated-credential', 'create',
                    '--id', $targetObjId,
                    '--parameters', "@$ficFile")
                Write-Success "FIC added for $($entry.DisplayName) on $targetLabel app"
            } catch {
                Write-Failure "FIC creation failed for $($entry.DisplayName): $_"
                $ficFailures += $entry.DisplayName
            } finally {
                if (Test-Path $ficFile) { Remove-Item $ficFile -Force }
            }
        }
    }

    # Fail hard if any FIC operations failed — Agent import depends on working auth
    if ($ficFailures.Count -gt 0) {
        Write-Host ''
        Write-Warning "FIC creation failed for: $($ficFailures -join ', ')"
        throw "FIC stage incomplete — $($ficFailures.Count) credential(s) failed. Agent import cannot proceed safely."
    }

    # ── Phase 5: Add redirect URIs ───────────────────────────────────
    Write-Step 'Phase 4: Adding redirect URIs…'

    # Group URIs by target app
    $urisByApp = @{}
    foreach ($entry in $ficEntries) {
        $uri = $entry.RedirectUri
        if ([string]::IsNullOrWhiteSpace($uri)) { continue }
        if ($entry.IsEnterprise) {
            if (-not $entObjId) {
                Write-Warning "Skipping enterprise redirect URI — no EnterpriseAppObjectId"
                continue
            }
            $targetObjId = $entObjId
        } else {
            $targetObjId = $ClientAppObjectId
        }
        if (-not $urisByApp.ContainsKey($targetObjId)) { $urisByApp[$targetObjId] = @() }
        if ($uri -notin $urisByApp[$targetObjId]) { $urisByApp[$targetObjId] += $uri }
    }

    foreach ($appObjId in $urisByApp.Keys) {
        $label = if ($appObjId -eq $ClientAppObjectId) { 'CLIENT' } elseif ($appObjId -eq $entObjId) { 'ENTERPRISE' } else { 'APP' }
        $clientAppInfo = Invoke-AzCli @('ad', 'app', 'show', '--id', $appObjId)
        $currentUris = @()
        if ($clientAppInfo.web -and $clientAppInfo.web.redirectUris) {
            $currentUris = @($clientAppInfo.web.redirectUris)
        }

        $newUris = @($urisByApp[$appObjId] | Where-Object { $_ -notin $currentUris })
        if ($newUris.Count -gt 0) {
            $allUris = @($currentUris) + @($newUris)
            $updateArgs = @('ad', 'app', 'update', '--id', $appObjId, '--web-redirect-uris') + $allUris
            Invoke-AzCli $updateArgs
            foreach ($uri in $newUris) {
                Write-Success "Redirect URI added ($label): $uri"
            }
        } else {
            Write-Success "All redirect URIs already present on $label app"
        }
    }

    # Verify base redirect URI on Client app
    Write-Step 'Verifying base redirect URI on Client app…'
    $clientAppInfo = Invoke-AzCli @('ad', 'app', 'show', '--id', $ClientAppObjectId)
    $redirectUri = 'https://global.consent.azure-apim.net/redirect'
    $currentUris = @()
    if ($clientAppInfo.web -and $clientAppInfo.web.redirectUris) {
        $currentUris = @($clientAppInfo.web.redirectUris)
    }

    if ($currentUris -contains $redirectUri) {
        Write-Success "Base redirect URI already present: $redirectUri"
    } else {
        Write-Step "Adding base redirect URI: $redirectUri"
        $allUris = @($currentUris) + @($redirectUri)
        $updateArgs = @('ad', 'app', 'update', '--id', $ClientAppObjectId, '--web-redirect-uris') + $allUris
        Invoke-AzCli $updateArgs
        Write-Success 'Base redirect URI added'
    }

    Write-Host "`n────────────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "  FIC Configuration Complete" -ForegroundColor Green
    Write-Host "────────────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "`n  Connectors are now configured with Federated Identity." -ForegroundColor Green
    Write-Host "  Next: run the Agent stage to import the Copilot Studio agent.`n" -ForegroundColor Gray

    Write-Host @"
    .\Install-GraphConnectorFactory.ps1 -Stage Agent ``
        -EnvironmentId '$EnvironmentId'
"@ -ForegroundColor DarkGray
}

# ─────────────────────────────────────────────────────────────────
# Stage 8 — Agent (Solution Import)
#
# CRITICAL: Must run AFTER FIC (Stage 7). Connection references in
# the agent solution need working connectors with valid FIC.
# ─────────────────────────────────────────────────────────────────

function Invoke-StageAgent {
    Write-StageHeader 'Stage 8 · Agent Solution Import'

    Assert-Parameter 'EnvironmentId' $EnvironmentId 'Agent'

    $agentZip = Join-Path $solutionsOutputDir 'GCFApps_agent.zip'
    if (-not (Test-Path $agentZip)) {
        throw "Agent solution zip not found: $agentZip. Run the Artifacts stage first."
    }

    Write-Step "Importing agent solution: $agentZip"
    Write-Step "Target environment: $EnvironmentId"

    Write-Host "`n  NOTE: The agent solution contains connection references." -ForegroundColor Yellow
    Write-Host "  Connections may need to be created manually in the portal" -ForegroundColor Yellow
    Write-Host "  after this import completes.`n" -ForegroundColor Yellow

    $pacArgs = @('solution', 'import',
        '--path', $agentZip,
        '--force-overwrite',
        '--publish-changes',
        '--environment', $EnvironmentId)

    if (-not [string]::IsNullOrWhiteSpace($SettingsFile)) {
        if (-not (Test-Path $SettingsFile)) {
            throw "Settings file not found: $SettingsFile"
        }
        $pacArgs += @('--settings-file', $SettingsFile)
        Write-Step "Using settings file: $SettingsFile"
    }

    $pacOutput = & pac @pacArgs 2>&1

    if ($LASTEXITCODE -ne 0) {
        Write-Failure 'Agent solution import failed'
        Write-Host ($pacOutput -join "`n") -ForegroundColor Red
        Write-Host "`n  Troubleshooting:" -ForegroundColor Yellow
        Write-Host "    - Ensure connectors were imported first (Stage 6)" -ForegroundColor Yellow
        Write-Host "    - Ensure FIC was configured (Stage 7)" -ForegroundColor Yellow
        Write-Host "    - Try with --settings-file for connection reference mapping" -ForegroundColor Yellow
        Write-Host "    - Check if connections need manual creation in the portal" -ForegroundColor Yellow
        throw 'pac solution import failed for agent solution'
    }

    Write-Host ($pacOutput -join "`n") -ForegroundColor DarkGray
    Write-Success 'Agent solution imported successfully'

    Write-Host "`n────────────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "  Agent Solution Import Complete" -ForegroundColor Green
    Write-Host "────────────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "`n  Verify the agent in Copilot Studio:" -ForegroundColor Green
    Write-Host "    https://copilotstudio.microsoft.com`n" -ForegroundColor DarkGray
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

    # Propagate auth method outputs
    if ($entraResult.ContainsKey('CertificatePath') -and $entraResult.CertificatePath) {
        $script:CertificatePath = $entraResult.CertificatePath
    }

    # Propagate enterprise values if present
    if ($entraResult.ContainsKey('EnterpriseAppId')) {
        $script:EnterpriseAppId       = $entraResult.EnterpriseAppId
        $script:EnterpriseAppObjectId = $entraResult.EnterpriseAppObjectId
    }
    if ($entraResult.ContainsKey('SkipEnterprise') -and $entraResult.SkipEnterprise) {
        $script:SkipEnterprise = [switch]::new($true)
    }

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

    # Stage 6 — Connector solution import
    Invoke-StageConnectors

    # Stage 7 — FIC (MUST be after connectors, BEFORE agent)
    Invoke-StageFIC

    # Stage 8 — Agent solution import (MUST be after FIC)
    Write-Host "`n  ── Connection Setup Checkpoint ──" -ForegroundColor Yellow
    Write-Host "  Before importing the agent, verify that connections can be" -ForegroundColor Yellow
    Write-Host "  created for each connector in make.powerapps.com.`n" -ForegroundColor Yellow

    Invoke-StageAgent

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
    'Agent'      { Invoke-StageAgent }
    'All'        { Invoke-StageAll }
}
