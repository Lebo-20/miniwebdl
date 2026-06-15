# TEAMDL Telegram Bot

Struktur ini memisahkan bot Telegram, data menu, dan web pendukung agar mudah dikembangkan.

## Jalankan

1. Salin `.env.example` menjadi `.env`, lalu isi `BOT_TOKEN` dan `ADMIN_ID`.
2. Jalankan web:

```bash
npm run dev:web
```

3. Jalankan bot Telegram di terminal lain:

```bash
npm run dev:bot
```

## Struktur

```text
apps/
  bot/        Telegram bot /start dengan tombol inline
    src/
      config.js        Loader konfigurasi .env
      handlers.js      Handler command dan callback
      keyboards.js     Susunan tombol inline
      telegram-api.js  Wrapper Telegram Bot API
      data/            Data judul dan platform
  web/        Web pendukung/admin lokal
shared/
  menu.config.json  Konfigurasi menu web pendukung
```

## Tombol Bot

Menu `/start` bot:

- `BELI VIP`
- `CARI JUDUL`
- `ALL PLATFORM`
- `ADMIN PANEL`, hanya tampil jika Telegram user id sama dengan `ADMIN_ID`.

## Firebase dan Source Platform

Konfigurasi Firebase ada di `shared/firebase/firebase.config.json`.

Endpoint platform TXT disimpan di `storage/sources/` dan dibaca otomatis oleh:

- `/api/sources`
- `/api/sources/:platformSlug`
- `/api/sync-plan`

Panduan sinkron Firestore ada di `docs/firebase-sync.md`.

## Setup Cloudflare Otomatis

Script otomatis untuk domain `teamdlbot.biz.id`:

```bash
npm run setup:cloudflare
```

Sebelum menjalankan, buat Cloudflare API token dengan izin:

- `Zone:Zone:Edit`
- `Zone:DNS:Edit`
- `Zone:Settings:Edit`

Lalu set token di terminal:

```powershell
$env:CLOUDFLARE_API_TOKEN="isi_token_cloudflare"
npm run setup:cloudflare
```

Jika akun Cloudflare punya lebih dari satu account, set juga:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID="account_id_cloudflare"
```

Script akan membuat zone, DNS root dan `www`, lalu mengaktifkan SSL strict, Always Use HTTPS, Automatic HTTPS Rewrites, dan minimum TLS 1.2. Setelah itu pasang nameserver yang ditampilkan script di registrar domain.
