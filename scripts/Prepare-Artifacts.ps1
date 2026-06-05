<#
.SYNOPSIS
    Prepares Dataverse solution artifacts by replacing token placeholders and packing .zip files.

.DESCRIPTION
    Token-replaces connector solution files and packs both the connector and agent solutions
    into .zip files ready for pac solution import.

    Custom connector tokens (__SERVER_HOST__, __OAUTH_CLIENT_ID__, __OAUTH_RESOURCE_URI__,
    __TENANT_ID__) are replaced in the 4 tokenized files.

    Enterprise connector (MCP Server for Enterprise / cr863) handling:
      - If -EnterpriseAppId is provided: replaces the source clientId, flips
        IsFirstParty to False, and replaces the source tenant ID.
      - If -SkipEnterprise: strips the enterprise connector files from the solution
        and removes its entries from solution.xml and customizations.xml.
      - If neither: enterprise files are left as-is (may not work in target tenant).

.PARAMETER ServerHost
    Server hostname (e.g. abc123-3001.usw3.devtunnels.ms)

.PARAMETER OAuthClientId
    Client app ID from Entra (used as clientId on custom connectors)

.PARAMETER OAuthResourceUri
    API app identifier URI (e.g. api://<API_APP_ID>)

.PARAMETER TenantId
    Target Entra tenant ID

.PARAMETER EnterpriseAppId
    Optional. Enterprise app registration clientId for MCP Server for Enterprise connector.

.PARAMETER SkipEnterprise
    If set, strips the enterprise connector from the connector solution entirely.

.PARAMETER OutputDir
    Output directory for .zip files. Defaults to artifacts/solutions

.EXAMPLE
    .\Prepare-Artifacts.ps1 -ServerHost "abc123.devtunnels.ms" `
        -OAuthClientId "client-guid" -OAuthResourceUri "api://xxx" -TenantId "tenant-guid"

.EXAMPLE
    .\Prepare-Artifacts.ps1 -ServerHost "abc123.devtunnels.ms" `
        -OAuthClientId "client-guid" -OAuthResourceUri "api://xxx" -TenantId "tenant-guid" `
        -EnterpriseAppId "ent-guid"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $ServerHost,
    [Parameter(Mandatory)] [string] $OAuthClientId,
    [Parameter(Mandatory)] [string] $OAuthResourceUri,
    [Parameter(Mandatory)] [string] $TenantId,
    [string] $EnterpriseAppId,
    [switch] $SkipEnterprise,
    [string] $OutputDir
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$solutionsDir = Join-Path $repoRoot "copilot-studio" "solutions"
$connectorsSrcDir = Join-Path $solutionsDir "connectors"
$agentSrcDir = Join-Path $solutionsDir "agent"

function Resolve-FirstExistingPath {
    param(
        [Parameter(Mandatory)] [string[]] $Candidates,
        [Parameter(Mandatory)] [string] $Description
    )
    $resolved = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $resolved) {
        throw "$Description not found. Checked: $($Candidates -join ', ')"
    }
    return $resolved
}

function Assert-ZipHasRootSolutionXml {
    param([Parameter(Mandatory)] [string] $ZipPath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $hasRootSolution = $zip.Entries | Where-Object { $_.FullName -eq 'solution.xml' } | Select-Object -First 1
        if (-not $hasRootSolution) {
            throw "Packed zip is missing root solution.xml: $ZipPath"
        }
    }
    finally {
        $zip.Dispose()
    }
}

if (-not $OutputDir) {
    $OutputDir = Join-Path $repoRoot "artifacts" "solutions"
}

# Ensure output directory exists
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# Source-tenant constants (baked into the exported solution files)
$SOURCE_TENANT_ID             = '1ccffdab-21fe-40b2-9b3d-c3a7222a330e'
$SOURCE_ENTERPRISE_CLIENT_ID  = '1b29ab3c-915f-4521-8860-a1fbd8399ed7'

# Token replacement map for custom connectors
$tokenMap = @{
    '__SERVER_HOST__'       = $ServerHost
    '__OAUTH_CLIENT_ID__'   = $OAuthClientId
    '__OAUTH_RESOURCE_URI__'= $OAuthResourceUri
    '__TENANT_ID__'         = $TenantId
}

# Files that contain tokens (custom connectors only)
$tokenizedFiles = @(
    'new_gcf-20rest-20connector_openapidefinition.json',
    'new_gcf-20rest-20connector_connectionparameters.json',
    'new_gcf-20mcp-20agent_openapidefinition.json',
    'new_gcf-20mcp-20agent_connectionparameters.json'
)

# Required placeholder tokens per file. Fail fast if export drift replaced tokens
# with environment-specific values before packaging.
$requiredTokensByFile = @{
    'new_gcf-20rest-20connector_openapidefinition.json' = @('__SERVER_HOST__')
    'new_gcf-20mcp-20agent_openapidefinition.json'      = @('__SERVER_HOST__')
    'new_gcf-20rest-20connector_connectionparameters.json' = @('__OAUTH_CLIENT_ID__', '__OAUTH_RESOURCE_URI__', '__TENANT_ID__')
    'new_gcf-20mcp-20agent_connectionparameters.json'      = @('__OAUTH_CLIENT_ID__', '__OAUTH_RESOURCE_URI__', '__TENANT_ID__')
}

Write-Host "`n=== Preparing Solution Artifacts ===" -ForegroundColor Cyan
Write-Host "Source:  $solutionsDir"
Write-Host "Output:  $OutputDir"
Write-Host ""

# ─── Step 1: Copy connector solution to staging ─────────────────────────

$stagingDir = Join-Path $OutputDir "staging-connectors"
if (Test-Path $stagingDir) {
    Remove-Item $stagingDir -Recurse -Force
}
Copy-Item -Path $connectorsSrcDir -Destination $stagingDir -Recurse
Write-Host "  Copied connector solution to staging" -ForegroundColor Green

# ─── Step 2: Token-replace custom connector files ────────────────────────

$connectorDir = Resolve-FirstExistingPath -Description "Connector source folder in staging" -Candidates @(
    (Join-Path $stagingDir "Connectors"), # modern PAC unpack layout
    (Join-Path $stagingDir "Connector")   # legacy layout
)

$solutionXmlPath = Resolve-FirstExistingPath -Description "Solution manifest in staging" -Candidates @(
    (Join-Path $stagingDir "Other" "Solution.xml"), # modern PAC unpack layout
    (Join-Path $stagingDir "solution.xml")          # legacy layout
)

$custXmlPath = Resolve-FirstExistingPath -Description "Customizations manifest in staging" -Candidates @(
    (Join-Path $stagingDir "Other" "Customizations.xml"), # modern PAC unpack layout
    (Join-Path $stagingDir "customizations.xml")          # legacy layout
)

Write-Host "  Replacing tokens in custom connector files…" -ForegroundColor Yellow

foreach ($fileName in $tokenizedFiles) {
    $filePath = Join-Path $connectorDir $fileName
    if (-not (Test-Path $filePath)) {
        throw "Expected tokenized file not found: $filePath"
    }

    $content = Get-Content $filePath -Raw
    foreach ($requiredToken in $requiredTokensByFile[$fileName]) {
        if (-not $content.Contains($requiredToken)) {
            throw "Missing expected token '$requiredToken' in $fileName. Re-export or re-tokenize connector source files before running Prepare-Artifacts."
        }
    }
    foreach ($key in $tokenMap.Keys) {
        $content = $content.Replace($key, $tokenMap[$key])
    }
    Set-Content -Path $filePath -Value $content -Encoding UTF8 -NoNewline
    Write-Host "    ✓ $fileName" -ForegroundColor Green
}

# ─── Step 3: Enterprise connector handling ───────────────────────────────

if ($SkipEnterprise) {
    Write-Host "  Stripping enterprise connector (SkipEnterprise)…" -ForegroundColor Yellow

    # Remove enterprise connector files
    $entFiles = Get-ChildItem $connectorDir -Filter "cr863_5Fmcp-2Dserver-2Dfor-2Denterprise*" -ErrorAction SilentlyContinue
    foreach ($f in $entFiles) {
        Remove-Item $f.FullName -Force
        Write-Host "    Removed: $($f.Name)" -ForegroundColor DarkGray
    }

    # Strip enterprise RootComponent from solution.xml
    [xml]$sol = Get-Content $solutionXmlPath -Raw
    $entRoot = $sol.ImportExportXml.SolutionManifest.RootComponents.RootComponent |
        Where-Object { $_.schemaName -like "*cr863_5Fmcp-2Dserver-2Dfor-2Denterprise*" }
    if ($entRoot) {
        $entRoot.ParentNode.RemoveChild($entRoot) | Out-Null
        $sol.Save($solutionXmlPath)
        Write-Host "    Stripped RootComponent from solution.xml" -ForegroundColor DarkGray
    }

    # Strip enterprise Connector from customizations.xml
    [xml]$cust = Get-Content $custXmlPath -Raw
    $entConn = $cust.ImportExportXml.Connectors.Connector |
        Where-Object { $_.name -like "*cr863_5Fmcp-2Dserver-2Dfor-2Denterprise*" }
    if ($entConn) {
        $entConn.ParentNode.RemoveChild($entConn) | Out-Null
        $cust.Save($custXmlPath)
        Write-Host "    Stripped Connector from customizations.xml" -ForegroundColor DarkGray
    }

    Write-Host "    ✓ Enterprise connector stripped" -ForegroundColor Green
}
elseif (-not [string]::IsNullOrWhiteSpace($EnterpriseAppId)) {
    Write-Host "  Updating enterprise connector for target tenant…" -ForegroundColor Yellow

    $entJsonFiles = Get-ChildItem $connectorDir -Filter "cr863_5Fmcp-2Dserver-2Dfor-2Denterprise*.json" -ErrorAction SilentlyContinue
    foreach ($f in $entJsonFiles) {
        $content = Get-Content -LiteralPath $f.FullName -Raw
        $changed = $false

        # Replace source enterprise clientId with target
        if ($content.Contains($SOURCE_ENTERPRISE_CLIENT_ID)) {
            $content = $content.Replace($SOURCE_ENTERPRISE_CLIENT_ID, $EnterpriseAppId)
            $changed = $true
        }

        # Flip IsFirstParty from True to False
        if ($content.Contains('"IsFirstParty":"True"')) {
            $content = $content.Replace('"IsFirstParty":"True"', '"IsFirstParty":"False"')
            $changed = $true
        }

        # Replace source tenant ID with target
        if ($content.Contains($SOURCE_TENANT_ID)) {
            $content = $content.Replace($SOURCE_TENANT_ID, $TenantId)
            $changed = $true
        }

        if ($changed) {
            Set-Content -LiteralPath $f.FullName -Value $content -Encoding UTF8 -NoNewline
            Write-Host "    ✓ $($f.Name)" -ForegroundColor Green
        }
    }
}
else {
    Write-Host "  Enterprise connector: no -EnterpriseAppId or -SkipEnterprise provided" -ForegroundColor DarkYellow
    Write-Host "    Files left as-is with source-tenant values — connector may not work" -ForegroundColor DarkYellow
}

# ─── Step 4: Validate no unresolved tokens remain ────────────────────────

Write-Host "  Validating no unresolved tokens…" -ForegroundColor Yellow
$unresolvedFound = $false
foreach ($fileName in $tokenizedFiles) {
    $filePath = Join-Path $connectorDir $fileName
    if (Test-Path $filePath) {
        $content = Get-Content $filePath -Raw
        if ($content -match '__[A-Z_]+__') {
            Write-Host "    ✗ Unresolved token in ${fileName}: $($Matches[0])" -ForegroundColor Red
            $unresolvedFound = $true
        }
    }
}
if ($unresolvedFound) {
    throw "Unresolved placeholder tokens found in connector files. Check parameter values."
}
Write-Host "    ✓ All tokens resolved" -ForegroundColor Green

# ─── Step 5: Pack connector solution .zip ────────────────────────────────

$connectorZip = Join-Path $OutputDir "GCFApps_connectors.zip"
if (Test-Path $connectorZip) {
    Remove-Item $connectorZip -Force
}

# Package connector solution using SolutionPackager-aware layout handling
pac solution pack --zipfile $connectorZip --folder $stagingDir --packagetype Unmanaged
if ($LASTEXITCODE -ne 0) {
    throw "pac solution pack failed for connector solution."
}
Assert-ZipHasRootSolutionXml -ZipPath $connectorZip
Write-Host "  ✓ Connector solution: $connectorZip" -ForegroundColor Green

# Clean up staging
Remove-Item $stagingDir -Recurse -Force

# ─── Step 6: Pack agent solution .zip ────────────────────────────────────

$agentZip = Join-Path $OutputDir "GCFApps_agent.zip"
if (Test-Path $agentZip) {
    Remove-Item $agentZip -Force
}

# Agent solution has no token replacement — pack directly from source folder
pac solution pack --zipfile $agentZip --folder $agentSrcDir --packagetype Unmanaged
if ($LASTEXITCODE -ne 0) {
    throw "pac solution pack failed for agent solution."
}
Assert-ZipHasRootSolutionXml -ZipPath $agentZip
Write-Host "  ✓ Agent solution: $agentZip" -ForegroundColor Green

# ─── Done ────────────────────────────────────────────────────────────────

Write-Host "`n=== Artifact Preparation Complete ===" -ForegroundColor Cyan
Write-Host "  Connector: $connectorZip"
Write-Host "  Agent:     $agentZip"
Write-Host "  Next: Run Install-GraphConnectorFactory.ps1 -Stage Connectors`n"
