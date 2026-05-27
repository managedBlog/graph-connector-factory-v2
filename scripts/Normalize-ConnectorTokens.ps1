<#
.SYNOPSIS
    Normalizes exported custom connector files back to token placeholders.

.DESCRIPTION
    Dev exports contain concrete tenant/app/host values. This script rewrites the
    4 custom connector source files back to placeholders used by Prepare-Artifacts.ps1:
      - __SERVER_HOST__
      - __OAUTH_CLIENT_ID__
      - __OAUTH_RESOURCE_URI__
      - __TENANT_ID__

    Run this on the source/export machine before committing connector source files.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$connectorDir = Join-Path $repoRoot 'copilot-studio\solutions\connectors\Connector'

$files = @{
    RestOpenApi = Join-Path $connectorDir 'new_gcf-20rest-20connector_openapidefinition.json'
    RestConn    = Join-Path $connectorDir 'new_gcf-20rest-20connector_connectionparameters.json'
    McpOpenApi  = Join-Path $connectorDir 'new_gcf-20mcp-20agent_openapidefinition.json'
    McpConn     = Join-Path $connectorDir 'new_gcf-20mcp-20agent_connectionparameters.json'
}

foreach ($f in $files.GetEnumerator()) {
    if (-not (Test-Path $f.Value)) {
        throw "Required connector file not found: $($f.Value)"
    }
}

function Set-TokenizedContent {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [hashtable] $ValueToToken
    )

    $content = Get-Content $Path -Raw
    $original = $content

    foreach ($value in ($ValueToToken.Keys | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object Length -Descending | Get-Unique)) {
        $token = $ValueToToken[$value]
        if ($value -ne $token) {
            $content = $content.Replace($value, $token)
        }
    }

    if ($content -ne $original) {
        Set-Content -Path $Path -Value $content -Encoding UTF8 -NoNewline
        return $true
    }
    return $false
}

# Discover concrete values from current export payloads
$restOpenApiObj = Get-Content $files.RestOpenApi -Raw | ConvertFrom-Json
$mcpOpenApiObj  = Get-Content $files.McpOpenApi -Raw | ConvertFrom-Json
$restConnObj    = Get-Content $files.RestConn -Raw | ConvertFrom-Json
$mcpConnObj     = Get-Content $files.McpConn -Raw | ConvertFrom-Json

$restOAuth = $restConnObj.token.oAuthSettings
$mcpOAuth  = $mcpConnObj.token.oAuthSettings

$tenantCandidates = @(
    $restOAuth.customParameters.TenantId.value,
    $mcpOAuth.customParameters.TenantId.value
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

$clientIdCandidates = @(
    $restOAuth.clientId,
    $mcpOAuth.clientId
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

$resourceCandidates = @(
    $restOAuth.customParameters.ResourceUri.value,
    $mcpOAuth.customParameters.ResourceUri.value,
    $restOAuth.properties.AzureActiveDirectoryResourceId,
    $mcpOAuth.properties.AzureActiveDirectoryResourceId
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

$hostCandidates = @(
    $restOpenApiObj.host,
    $mcpOpenApiObj.host
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

$replacements = @{}
foreach ($v in $tenantCandidates) { $replacements[$v] = '__TENANT_ID__' }
foreach ($v in $clientIdCandidates) { $replacements[$v] = '__OAUTH_CLIENT_ID__' }
foreach ($v in $resourceCandidates) { $replacements[$v] = '__OAUTH_RESOURCE_URI__' }
foreach ($v in $hostCandidates) { $replacements[$v] = '__SERVER_HOST__' }

$changed = @()
foreach ($path in $files.Values) {
    if (Set-TokenizedContent -Path $path -ValueToToken $replacements) {
        $changed += $path
    }
}

# Validate placeholders now exist in expected files
$requiredTokensByPath = @{
    $files.RestOpenApi = @('__SERVER_HOST__')
    $files.McpOpenApi  = @('__SERVER_HOST__')
    $files.RestConn    = @('__OAUTH_CLIENT_ID__', '__OAUTH_RESOURCE_URI__', '__TENANT_ID__')
    $files.McpConn     = @('__OAUTH_CLIENT_ID__', '__OAUTH_RESOURCE_URI__', '__TENANT_ID__')
}

foreach ($entry in $requiredTokensByPath.GetEnumerator()) {
    $content = Get-Content $entry.Key -Raw
    foreach ($token in $entry.Value) {
        if (-not $content.Contains($token)) {
            throw "Tokenization failed: '$token' not found in $($entry.Key)"
        }
    }
}

Write-Host "`n=== Connector token normalization complete ===" -ForegroundColor Cyan
if ($changed.Count -eq 0) {
    Write-Host "No changes needed (files already tokenized)." -ForegroundColor Yellow
} else {
    Write-Host "Updated files:" -ForegroundColor Green
    $changed | Sort-Object | ForEach-Object { Write-Host "  - $_" }
}
