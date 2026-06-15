# scripts/start-all.ps1
# Script to auto-check free ports, configure configurations, and start all services.

$ProjectDir = Split-Path -Parent $PSScriptRoot
$EnvPath = "$ProjectDir\.env"
$CfLocalConfig = "$env:USERPROFILE\.cloudflared\config.yml"
$CfProjectConfig = "$ProjectDir\cloudflare\teamdlbot.biz.id.tunnel.yml"

Write-Output "=== Memulai Proses Inisialisasi TEAMDL ==="

# 1. Cari port kosong mulai dari 3000
$port = 3000
while ($true) {
    $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Where-Object { $_.State -eq "Listen" }
    if (!$conn) {
        break
    }
    $port++
}

Write-Output "[OK] Port kosong terdeteksi: $port"

# 2. Update .env file
if (Test-Path $EnvPath) {
    $envContent = Get-Content $EnvPath -Raw
    if ($envContent -match "PORT=\d+") {
        $envContent = $envContent -replace "PORT=\d+", "PORT=$port"
        Set-Content $EnvPath -Value $envContent -NoNewline
        Write-Output "[OK] Update PORT=$port di .env"
    } else {
        $envContent += "`nPORT=$port"
        Set-Content $EnvPath -Value $envContent
        Write-Output "[OK] Menambahkan PORT=$port di .env"
    }
} else {
    Write-Output "[WARN] File .env tidak ditemukan di $EnvPath"
}

# 3. Update Cloudflare Tunnel configuration files
function Update-TunnelConfig($path, $port) {
    if (Test-Path $path) {
        $content = Get-Content $path -Raw
        $content = $content -replace "service:\s*http://localhost:\d+", "service: http://localhost:$port"
        Set-Content $path -Value $content
        Write-Output "[OK] Update port tunnel di: $path"
    } else {
        Write-Output "[WARN] File config tunnel tidak ditemukan di: $path"
    }
}

Update-TunnelConfig $CfLocalConfig $port
Update-TunnelConfig $CfProjectConfig $port

# 4. Matikan terowongan Cloudflare lama jika ada
Write-Output "[..] Mematikan terowongan Cloudflare lama..."
Stop-Process -Name cloudflared -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# 5. Jalankan atau Muat Ulang PM2 Processes
Write-Output "[..] Memeriksa status proses PM2..."

# Web Server
$webCheck = pm2 describe miniweb-web 2>&1
if ($LASTEXITCODE -ne 0 -or !$webCheck -or $webCheck -like "*does not exist*") {
    Write-Output "[..] Memulai miniweb-web baru di PM2..."
    pm2 start apps/web/server.js --name miniweb-web
} else {
    Write-Output "[..] Memuat ulang miniweb-web dengan port baru..."
    pm2 reload miniweb-web --update-env
}

# Telegram Bot
$botCheck = pm2 describe miniweb-bot 2>&1
if ($LASTEXITCODE -ne 0 -or !$botCheck -or $botCheck -like "*does not exist*") {
    Write-Output "[..] Memulai miniweb-bot baru di PM2..."
    pm2 start apps/bot/bot.js --name miniweb-bot
} else {
    Write-Output "[..] Memuat ulang miniweb-bot..."
    pm2 reload miniweb-bot --update-env
}

# 6. Jalankan atau Muat Ulang Cloudflare Tunnel di PM2
Write-Output "[..] Memeriksa status proses Cloudflare Tunnel di PM2..."
$tunnelCheck = pm2 describe miniweb-tunnel 2>&1
if ($LASTEXITCODE -ne 0 -or !$tunnelCheck -or $tunnelCheck -like "*does not exist*") {
    Write-Output "[..] Memulai miniweb-tunnel baru di PM2..."
    pm2 start scripts/tunnel.js --name miniweb-tunnel
} else {
    Write-Output "[..] Memuat ulang miniweb-tunnel..."
    pm2 reload miniweb-tunnel --update-env
}


Write-Output ""
Write-Output "=================================================="
Write-Output "[SUKSES] Semua layanan telah berhasil dijalankan!"
Write-Output " - Port Lokal:  http://localhost:$port"
Write-Output " - URL Publik:  https://teamdlbot.biz.id"
Write-Output " - Status PM2:  Ketik 'pm2 status' untuk melihat detail."
Write-Output "=================================================="
