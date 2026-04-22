<#
.SYNOPSIS
    Prepares connector artifacts by replacing token placeholders with actual values.

.DESCRIPTION
    Reads the connector manifest, then for each connector replaces placeholder tokens
    in the swagger and apiProperties files with values from the provided parameters.
    Outputs prepared files to a staging directory ready for pac connector create.

.PARAMETER ServerHost
    Server hostname (e.g. abc123-3001.usw3.devtunnels.ms)

.PARAMETER OAuthScope
    OAuth scope (e.g. api://<API_APP_ID>/MCP.access)

.PARAMETER OAuthClientId
    Client app ID from Entra

.PARAMETER OAuthResourceUri
    API app identifier URI (e.g. api://<API_APP_ID>)

.PARAMETER TenantId
    Entra tenant ID

.PARAMETER OutputDir
    Output directory for prepared artifacts. Defaults to artifacts/connectors/prepared

.EXAMPLE
    .\Prepare-Artifacts.ps1 -ServerHost "abc123.devtunnels.ms" -OAuthScope "api://xxx/MCP.access" `
        -OAuthClientId "client-guid" -OAuthResourceUri "api://xxx" -TenantId "tenant-guid"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $ServerHost,
    [Parameter(Mandatory)] [string] $OAuthScope,
    [Parameter(Mandatory)] [string] $OAuthClientId,
    [Parameter(Mandatory)] [string] $OAuthResourceUri,
    [Parameter(Mandatory)] [string] $TenantId,
    [string] $OutputDir
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$artifactsDir = Join-Path $repoRoot "artifacts" "connectors"
$manifestPath = Join-Path $artifactsDir "manifest.json"

if (-not $OutputDir) {
    $OutputDir = Join-Path $artifactsDir "prepared"
}

# Ensure output directory exists
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# Token replacement map
$tokenMap = @{
    '__SERVER_HOST__'       = $ServerHost
    '__OAUTH_SCOPE__'       = $OAuthScope
    '__OAUTH_CLIENT_ID__'   = $OAuthClientId
    '__OAUTH_RESOURCE_URI__'= $OAuthResourceUri
    '__TENANT_ID__'         = $TenantId
}

# Read manifest
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

Write-Host "`n=== Preparing Connector Artifacts ===" -ForegroundColor Cyan
Write-Host "Source:  $artifactsDir"
Write-Host "Output:  $OutputDir"
Write-Host "Connectors: $($manifest.connectors.Count)`n"

foreach ($connector in $manifest.connectors) {
    Write-Host "  Processing: $($connector.displayName)" -ForegroundColor Yellow

    # Process swagger file
    $swaggerSrc = Join-Path $artifactsDir $connector.swaggerFile
    $swaggerContent = Get-Content $swaggerSrc -Raw
    foreach ($key in $tokenMap.Keys) {
        $swaggerContent = $swaggerContent.Replace($key, $tokenMap[$key])
    }
    $swaggerDest = Join-Path $OutputDir $connector.swaggerFile
    Set-Content -Path $swaggerDest -Value $swaggerContent -Encoding UTF8
    Write-Host "    Swagger:       $($connector.swaggerFile)" -ForegroundColor Green

    # Process apiProperties file
    $propsSrc = Join-Path $artifactsDir $connector.apiPropertiesFile
    $propsContent = Get-Content $propsSrc -Raw
    foreach ($key in $tokenMap.Keys) {
        $propsContent = $propsContent.Replace($key, $tokenMap[$key])
    }
    $propsDest = Join-Path $OutputDir $connector.apiPropertiesFile
    Set-Content -Path $propsDest -Value $propsContent -Encoding UTF8
    Write-Host "    Properties:    $($connector.apiPropertiesFile)" -ForegroundColor Green
}

Write-Host "`n=== Artifact Preparation Complete ===" -ForegroundColor Cyan
Write-Host "Prepared files are in: $OutputDir"
Write-Host "Next step: Run Install-GraphConnectorFactory.ps1 -Stage Connectors`n"
