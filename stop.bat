@echo off
title Menghentikan Layanan TEAMDL
echo ==================================================
echo   TEAMDL Launcher - Menghentikan Semua Layanan
echo ==================================================
echo.
echo [1/3] Menghentikan proses melalui skrip internal...
call npm stop
echo.
echo [2/3] Mematikan daemon PM2 (PM2 Kill)...
call npx pm2 kill
echo.
echo [3/3] Memaksa menutup proses cloudflared yang menggantung...
taskkill /f /im cloudflared.exe >nul 2>&1
echo.
echo ==================================================
echo [SUKSES] Semua proses di latar belakang telah dihentikan total!
echo ==================================================
echo Tekan tombol apa saja untuk menutup...
pause >nul
