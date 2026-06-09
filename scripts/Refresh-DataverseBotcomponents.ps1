param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$ConfigPath = "",
    [string]$EnvironmentId = "",
    [string]$OrgUrl = "",
    [string[]]$Updates = @(
        "copilots_header_91a5e.action.GCFRESTConnector-AgentGenerateStatus=copilot-studio\solutions\agent\botcomponents\copilots_header_91a5e.action.GCFRESTConnector-AgentGenerateStatus\data",
        "copilots_header_91a5e.topic.AgentFactory=copilot-studio\solutions\agent\botcomponents\copilots_header_91a5e.topic.AgentFactory\data"
    ),
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Resolve-OrgUrlFromPac {
    param(
        [Parameter(Mandatory = $true)][string]$TargetEnvironmentId
    )

    $envList = pac env list
    $line = $envList | Where-Object { $_ -match [regex]::Escape($TargetEnvironmentId) } | Select-Object -First 1
    if (-not $line) {
        throw "Could not find environment '$TargetEnvironmentId' in 'pac env list' output."
    }

    $match = [regex]::Match($line, "https://\S+\.crm\.dynamics\.com/")
    if (-not $match.Success) {
        throw "Could not parse Dataverse URL from line: $line"
    }

    return $match.Value.TrimEnd("/")
}

function Get-DataverseAccessToken {
    param(
        [Parameter(Mandatory = $true)][string]$Resource
    )

    $token = az account get-access-token --resource $Resource --query accessToken -o tsv
    if (-not $token) {
        throw "Failed to acquire Dataverse access token via Azure CLI."
    }
    return $token
}

function Parse-UpdateEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Entry
    )

    $parts = $Entry -split "=", 2
    if ($parts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0]) -or [string]::IsNullOrWhiteSpace($parts[1])) {
        throw "Invalid update entry '$Entry'. Expected format: schemaName=relative\path\to\data"
    }

    return @{
        SchemaName = $parts[0].Trim()
        RelativePath = $parts[1].Trim()
    }
}

function Patch-BotcomponentData {
    param(
        [Parameter(Mandatory = $true)][string]$DataverseUrl,
        [Parameter(Mandatory = $true)][hashtable]$Headers,
        [Parameter(Mandatory = $true)][string]$SchemaName,
        [Parameter(Mandatory = $true)][string]$DataFilePath,
        [switch]$DryRunMode
    )

    if (-not (Test-Path -LiteralPath $DataFilePath)) {
        throw "Data file not found: $DataFilePath"
    }

    $escapedSchema = $SchemaName.Replace("'", "''")
    $query = "$DataverseUrl/api/data/v9.2/botcomponents?`$select=botcomponentid,schemaname,componenttype,modifiedon&`$filter=schemaname eq '$escapedSchema'&`$top=50"
    $found = Invoke-RestMethod -Method Get -Uri $query -Headers $Headers
    $rows = @(@($found.value) | Where-Object { $_.componenttype -eq 9 })

    if ($rows.Count -eq 0) {
        throw "No componenttype=9 rows found for '$SchemaName'."
    }

    if ($DryRunMode) {
        Write-Host "[DRY RUN] $SchemaName -> $($rows.Count) row(s), file: $DataFilePath"
        return
    }

    $dataContent = Get-Content -LiteralPath $DataFilePath -Raw
    $patchHeaders = @{
        Authorization   = $Headers.Authorization
        "OData-MaxVersion" = "4.0"
        "OData-Version" = "4.0"
        Accept          = "application/json"
        "Content-Type"  = "application/json"
        "If-Match"      = "*"
    }
    $body = @{ data = $dataContent } | ConvertTo-Json -Depth 5 -Compress

    foreach ($row in $rows) {
        Invoke-RestMethod -Method Patch -Uri "$DataverseUrl/api/data/v9.2/botcomponents($($row.botcomponentid))" -Headers $patchHeaders -Body $body | Out-Null
    }

    $verify = Invoke-RestMethod -Method Get -Uri $query -Headers $Headers
    $verifyRows = @(@($verify.value) | Where-Object { $_.componenttype -eq 9 })
    if ($verifyRows.Count -ne $rows.Count) {
        throw "Verify mismatch for '$SchemaName': expected $($rows.Count), got $($verifyRows.Count)."
    }

    Write-Host "Patched $SchemaName -> $($verifyRows.Count) row(s)"
}

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $RepoRoot "config\config.json"
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Config file not found: $ConfigPath"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($EnvironmentId)) {
    $EnvironmentId = $config.powerPlatform.defaultEnvironmentId
}
if ([string]::IsNullOrWhiteSpace($EnvironmentId)) {
    throw "EnvironmentId was not provided and defaultEnvironmentId is missing in config."
}

if ([string]::IsNullOrWhiteSpace($OrgUrl)) {
    $OrgUrl = Resolve-OrgUrlFromPac -TargetEnvironmentId $EnvironmentId
}
$OrgUrl = $OrgUrl.TrimEnd("/")

$token = Get-DataverseAccessToken -Resource $OrgUrl
$headers = @{
    Authorization   = "Bearer $token"
    "OData-MaxVersion" = "4.0"
    "OData-Version" = "4.0"
    Accept          = "application/json"
}

Write-Host "RepoRoot: $RepoRoot"
Write-Host "EnvironmentId: $EnvironmentId"
Write-Host "OrgUrl: $OrgUrl"

foreach ($entry in $Updates) {
    $parsed = Parse-UpdateEntry -Entry $entry
    $fullPath = if ([System.IO.Path]::IsPathRooted($parsed.RelativePath)) {
        $parsed.RelativePath
    } else {
        Join-Path $RepoRoot $parsed.RelativePath
    }

    Patch-BotcomponentData `
        -DataverseUrl $OrgUrl `
        -Headers $headers `
        -SchemaName $parsed.SchemaName `
        -DataFilePath $fullPath `
        -DryRunMode:$DryRun
}

if ($DryRun) {
    Write-Host "Dry run complete."
} else {
    Write-Host "Dataverse botcomponent refresh complete."
}
