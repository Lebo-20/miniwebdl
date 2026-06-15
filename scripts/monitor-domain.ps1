param(
  [string]$Domain = "teamdlbot.biz.id",
  [string]$WwwDomain = "www.teamdlbot.biz.id",
  [string]$HttpsUrl = "https://teamdlbot.biz.id",
  [string]$CloudflaredConfig = "$env:USERPROFILE\.cloudflared\config.yml",
  [string]$ProjectDir = ""
)

$ErrorActionPreference = "SilentlyContinue"

# Resolve ProjectDir dynamically if empty
if ([string]::IsNullOrEmpty($ProjectDir)) {
    $ProjectDir = Split-Path -Parent $PSScriptRoot
}

# Parse PORT dynamically from .env
$Port = 3000
$EnvPath = "$ProjectDir\.env"
if (Test-Path $EnvPath) {
    $envContent = Get-Content $EnvPath -Raw
    if ($envContent -match "PORT=(\d+)") {
        $Port = $Matches[1]
    }
}
$LocalUrl = "http://localhost:$Port"

function Write-Status($Name, $Ok, $Detail) {
  $state = if ($Ok) { "OK" } else { "FAIL" }
  Write-Output "[$state] $Name - $Detail"
}

function Ensure-WebServer {
  $local = $null
  try {
    $local = Invoke-WebRequest -Uri $LocalUrl -UseBasicParsing -TimeoutSec 5
  } catch {
    # Connection refused or timed out
  }

  if ($local -and $local.StatusCode -eq 200) {
    Write-Status "Local web" $true "$LocalUrl"
    return
  }

  Write-Status "Local web" $false "Restarting miniweb-web via PM2"
  $webCheck = pm2 describe miniweb-web 2>&1
  if ($LASTEXITCODE -ne 0 -or !$webCheck -or $webCheck -like "*does not exist*") {
      pm2 start "$ProjectDir\apps\web\server.js" --name miniweb-web
  } else {
      pm2 reload miniweb-web --update-env
  }
}

function Ensure-Cloudflared {
  $cloudflared = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*cloudflared*" -and $_.CommandLine -like "*$CloudflaredConfig*" }
  if ($cloudflared) {
    Write-Status "Cloudflare Tunnel" $true "process running"
    return
  }

  $exe = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
  if (!(Test-Path $exe)) {
    $exe = "C:\botvlix\cloudflared.exe"
  }

  if (Test-Path $exe) {
    Write-Status "Cloudflare Tunnel" $false "Restarting tunnel"
    Start-Process -WindowStyle Hidden -FilePath $exe -ArgumentList "tunnel","--config",$CloudflaredConfig,"--protocol","http2","run"
  } else {
    Write-Status "Cloudflare Tunnel" $false "cloudflared.exe not found"
  }
}

function Check-Dns($HostName) {
  $records = Resolve-DnsName $HostName -ErrorAction SilentlyContinue
  if ($records) {
    $summary = ($records | Select-Object -First 3 | ForEach-Object { "$($_.Type):$($_.IPAddress)$($_.NameHost)" }) -join ", "
    Write-Status "DNS $HostName" $true $summary
  } else {
    Write-Status "DNS $HostName" $false "not resolving"
  }
}

function Check-Https {
  $response = Invoke-WebRequest -Uri $HttpsUrl -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 10
  Write-Status "HTTPS $HttpsUrl" ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) "status $($response.StatusCode)"
}

Ensure-WebServer
Ensure-Cloudflared
Check-Dns $Domain
Check-Dns $WwwDomain
Check-Https
