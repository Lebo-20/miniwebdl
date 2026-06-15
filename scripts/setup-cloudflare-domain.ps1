param(
    [string]$Domain = "teamdlbot.biz.id",
    [string]$TunnelId = "8526eb2d-1be3-477b-85f7-5eda9d1bcd29",
    [string]$AccountId = $env:CLOUDFLARE_ACCOUNT_ID,
    [string]$ApiToken = $env:CLOUDFLARE_API_TOKEN
)

$ErrorActionPreference = "Stop"

if (-not $ApiToken) {
    throw "Set CLOUDFLARE_API_TOKEN first. Example: `$env:CLOUDFLARE_API_TOKEN='cf_api_token_here'"
}

$Headers = @{
    "Authorization" = "Bearer $ApiToken"
    "Content-Type"  = "application/json"
}

function Invoke-CfApi {
    param(
        [ValidateSet("GET", "POST", "PATCH", "PUT", "DELETE")]
        [string]$Method,
        [string]$Path,
        [object]$Body = $null
    )

    $uri = "https://api.cloudflare.com/client/v4$Path"
    $params = @{
        Method      = $Method
        Uri         = $uri
        Headers     = $Headers
        ErrorAction = "Stop"
    }

    if ($null -ne $Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 8)
    }

    $response = Invoke-RestMethod @params
    if (-not $response.success) {
        $messages = ($response.errors | ForEach-Object { $_.message }) -join "; "
        throw "Cloudflare API failed: $messages"
    }

    return $response
}

function Get-CfZone {
    param([string]$Name)
    $encodedName = [uri]::EscapeDataString($Name)
    $response = Invoke-CfApi -Method GET -Path "/zones?name=$encodedName"
    return $response.result | Select-Object -First 1
}

function Get-CfAccounts {
    $response = Invoke-CfApi -Method GET -Path "/accounts"
    return $response.result
}

function Ensure-CfZone {
    param([string]$Name)

    $zone = Get-CfZone -Name $Name
    if ($zone) {
        Write-Host "[OK] Zone exists: $Name ($($zone.id))"
        return $zone
    }

    if (-not $AccountId) {
        $accounts = @(Get-CfAccounts)
        if ($accounts.Count -eq 1) {
            $script:AccountId = $accounts[0].id
        } elseif ($accounts.Count -gt 1) {
            Write-Host "Available Cloudflare accounts:"
            $accounts | ForEach-Object { Write-Host "  $($_.id)  $($_.name)" }
            throw "Multiple accounts found. Set CLOUDFLARE_ACCOUNT_ID and run again."
        } else {
            throw "No Cloudflare account found for this token."
        }
    }

    Write-Host "[..] Creating full DNS zone: $Name"
    $body = @{
        name    = $Name
        type    = "full"
        account = @{ id = $script:AccountId }
    }
    $response = Invoke-CfApi -Method POST -Path "/zones" -Body $body
    Write-Host "[OK] Zone created: $Name ($($response.result.id))"
    return $response.result
}

function Ensure-CnameRecord {
    param(
        [string]$ZoneId,
        [string]$Name,
        [string]$Target
    )

    $encodedType = [uri]::EscapeDataString("CNAME")
    $encodedName = [uri]::EscapeDataString($Name)
    $existing = Invoke-CfApi -Method GET -Path "/zones/$ZoneId/dns_records?type=$encodedType&name=$encodedName"
    $body = @{
        type    = "CNAME"
        name    = $Name
        content = $Target
        ttl     = 1
        proxied = $true
        comment = "MINIWEB Cloudflare Tunnel route"
    }

    if ($existing.result.Count -gt 0) {
        $record = $existing.result | Select-Object -First 1
        Invoke-CfApi -Method PATCH -Path "/zones/$ZoneId/dns_records/$($record.id)" -Body $body | Out-Null
        Write-Host "[OK] DNS updated: $Name -> $Target"
        return
    }

    Invoke-CfApi -Method POST -Path "/zones/$ZoneId/dns_records" -Body $body | Out-Null
    Write-Host "[OK] DNS created: $Name -> $Target"
}

function Set-CfSetting {
    param(
        [string]$ZoneId,
        [string]$Setting,
        [string]$Value
    )

    Invoke-CfApi -Method PATCH -Path "/zones/$ZoneId/settings/$Setting" -Body @{ value = $Value } | Out-Null
    Write-Host "[OK] Setting $Setting = $Value"
}

$zone = Ensure-CfZone -Name $Domain
$zoneId = $zone.id
$tunnelTarget = "$TunnelId.cfargotunnel.com"

Ensure-CnameRecord -ZoneId $zoneId -Name $Domain -Target $tunnelTarget
Ensure-CnameRecord -ZoneId $zoneId -Name "www.$Domain" -Target $tunnelTarget

Set-CfSetting -ZoneId $zoneId -Setting "ssl" -Value "strict"
Set-CfSetting -ZoneId $zoneId -Setting "always_use_https" -Value "on"
Set-CfSetting -ZoneId $zoneId -Setting "automatic_https_rewrites" -Value "on"
Set-CfSetting -ZoneId $zoneId -Setting "min_tls_version" -Value "1.2"

$freshZone = Get-CfZone -Name $Domain

Write-Host ""
Write-Host "Cloudflare zone status:"
Write-Host "  Domain:      $Domain"
Write-Host "  Zone ID:     $($freshZone.id)"
Write-Host "  Status:      $($freshZone.status)"
Write-Host "  Nameservers:"
$freshZone.name_servers | ForEach-Object { Write-Host "    $_" }
Write-Host ""
Write-Host "Set these nameservers at your registrar, then wait for activation."
