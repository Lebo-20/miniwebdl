# scripts/stop-all.ps1
# Script to stop all running services.

Write-Output "=== Menghentikan Semua Layanan TEAMDL ==="

# 1. Matikan Cloudflare Tunnel
Write-Output "[..] Menghentikan proses Cloudflare Tunnel..."
Stop-Process -Name cloudflared -Force -ErrorAction SilentlyContinue

# 2. Hentikan PM2 Processes
Write-Output "[..] Menghentikan Web Server (miniweb-web)..."
pm2 stop miniweb-web 2>&1 | Out-Null

Write-Output "[..] Menghentikan Telegram Bot (miniweb-bot)..."
pm2 stop miniweb-bot 2>&1 | Out-Null

Write-Output "[..] Menghentikan Cloudflare Tunnel (miniweb-tunnel)..."
pm2 stop miniweb-tunnel 2>&1 | Out-Null


Write-Output ""
Write-Output "=================================================="
Write-Output "[SUKSES] Semua layanan telah berhasil dihentikan!"
Write-Output "=================================================="
