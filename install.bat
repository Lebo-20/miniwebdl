@echo off
title Installer Dependensi TEAMDL
echo ==================================================
echo   TEAMDL Installer - Menyiapkan Perpustakaan
echo ==================================================
echo.

:: 1. Periksa apakah Node.js terinstal
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js tidak terdeteksi pada sistem ini!
    echo Silakan unduh dan instal Node.js (versi >= 18) dari:
    echo https://nodejs.org/
    echo.
    echo Tekan tombol apa saja untuk keluar...
    pause >nul
    exit /b 1
)

echo [OK] Node.js terdeteksi.
echo.

:: 2. Instal library npm lokal
echo [..] Menginstal dependensi proyek (npm install)...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Gagal menginstal dependensi lokal!
    pause
    exit /b 1
)
echo [OK] Dependensi lokal berhasil diinstal.
echo.

:: 3. Periksa dan instal PM2 secara global
echo [..] Memeriksa PM2 process manager...
pm2 -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] PM2 tidak terdeteksi. Menginstal PM2 secara global (npm install pm2 -g)...
    call npm install pm2 -g
    if %errorlevel% neq 0 (
        echo [ERROR] Gagal menginstal PM2 secara global!
        echo Silakan coba jalankan terminal sebagai Administrator lalu jalankan: npm install pm2 -g
        pause
        exit /b 1
    )
) else (
    echo [OK] PM2 sudah terinstal.
)
echo.

echo ==================================================
echo [SUKSES] Semua persiapan selesai!
echo ==================================================
echo Anda sekarang dapat menjalankan aplikasi dengan perintah:
echo   npm start
echo.
echo Tekan tombol apa saja untuk menutup...
pause >nul
