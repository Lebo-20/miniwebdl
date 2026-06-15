# Domain Deployment: teamdlbot.biz.id

## Status Saat Ini

Tanggal pengecekan: 2026-06-03.

Domain yang diminta:

```text
teamdlbot.biz.id
www.teamdlbot.biz.id
```

Hasil lokal:

```text
Resolve-DnsName teamdlbot.biz.id      -> belum resolve
Resolve-DnsName www.teamdlbot.biz.id  -> belum resolve
```

Artinya domain belum punya DNS publik aktif di resolver lokal, atau belum terdelegasi ke nameserver yang benar.

Percobaan `cloudflared tunnel route dns` berhasil secara CLI, tetapi akun Cloudflare yang sedang login memilih zone `teamdlbot.web.id`, sehingga record yang dibuat menjadi:

```text
teamdlbot.biz.id.teamdlbot.web.id
www.teamdlbot.biz.id.teamdlbot.web.id
```

Itu bukan record yang dibutuhkan. Hapus record tersebut dari DNS zone `teamdlbot.web.id` jika muncul di dashboard Cloudflare.

Kesimpulan blocker:

```text
Zone teamdlbot.biz.id sudah dibuat di Cloudflare, tetapi nameserver registrar belum diarahkan ke Cloudflare.
```

Nameserver Cloudflare yang ditampilkan dashboard:

```text
dawn.ns.cloudflare.com
rex.ns.cloudflare.com
```

Nameserver lama yang harus diganti di registrar:

```text
nsx1.domainesia.com
nsx2.domainesia.com
```

## Aplikasi Lokal

TEAMDL berjalan di:

```text
http://localhost:3000
```

File `.env` sudah diset:

```text
WEB_PUBLIC_URL=https://teamdlbot.biz.id
```

## Cloudflare Tunnel

Template konfigurasi tunnel untuk domain ini:

```text
cloudflare/teamdlbot.biz.id.tunnel.yml
```

Target tunnel:

```text
teamdlbot.biz.id      -> http://localhost:3000
www.teamdlbot.biz.id  -> http://localhost:3000
```

Konfigurasi lokal `C:\Users\mauta\.cloudflared\config.yml` sudah diperbarui agar memuat:

```text
teamdlbot.biz.id      -> http://localhost:3000
www.teamdlbot.biz.id  -> http://localhost:3000
```

Host lama `teamdlbot.web.id` tetap dibiarkan di file konfigurasi agar layanan sebelumnya tidak terputus.

Konfigurasi lama dibackup di:

```text
C:\Users\mauta\.cloudflared\config.yml.backup-teamdlbot-web-id
```

## DNS Cloudflare Yang Harus Dibuat

Status dashboard Cloudflare:

```text
teamdlbot.biz.id      -> Tunnel/CNAME botvlix-teamdl, Proxied, TTL Auto
www.teamdlbot.biz.id  -> Tunnel/CNAME botvlix-teamdl, Proxied, TTL Auto
```

Catatan: halaman review DNS Cloudflare menampilkan tipe sebagai `Tunnel` dengan content `[object Object]`, tetapi dialog detail/delete menampilkan record sebagai CNAME ke tunnel `botvlix-teamdl`.

### Otomatis Via Cloudflare API

Script:

```text
scripts/setup-cloudflare-domain.ps1
```

Jalankan:

```powershell
$env:CLOUDFLARE_API_TOKEN="isi_token_cloudflare"
npm run setup:cloudflare
```

Jika token punya akses ke lebih dari satu Cloudflare account:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID="account_id_cloudflare"
npm run setup:cloudflare
```

Izin minimal API token:

```text
Zone:Zone:Edit
Zone:DNS:Edit
Zone:Settings:Edit
```

Script akan:

- Membuat zone `teamdlbot.biz.id` jika belum ada.
- Membuat/memperbarui CNAME root ke tunnel.
- Membuat/memperbarui CNAME `www` ke tunnel.
- Mengaktifkan SSL strict.
- Mengaktifkan Always Use HTTPS.
- Mengaktifkan Automatic HTTPS Rewrites.
- Mengaktifkan minimum TLS 1.2.
- Menampilkan nameserver Cloudflare yang harus dipasang di registrar.

Registrar tetap harus diubah manual atau lewat API registrar, karena Cloudflare tidak bisa mengganti nameserver di registrar tanpa akses registrar.

### Manual Via cloudflared

Jika menggunakan Cloudflare Tunnel named tunnel `botvlix-teamdl`, buat DNS route:

```bash
cloudflared tunnel route dns botvlix-teamdl teamdlbot.biz.id
cloudflared tunnel route dns botvlix-teamdl www.teamdlbot.biz.id
```

Perintah ini hanya akan benar jika zone `teamdlbot.biz.id` sudah ada di akun Cloudflare. Jika belum, Cloudflare akan memilih zone lain yang cocok sebagian, seperti yang terjadi pada percobaan saat ini.

Atau di dashboard Cloudflare DNS, buat:

```text
Type   Name  Target
CNAME  @     <tunnel-id>.cfargotunnel.com
CNAME  www   <tunnel-id>.cfargotunnel.com
```

Keduanya harus Proxied.

## SSL/TLS Cloudflare

Di Cloudflare dashboard:

```text
SSL/TLS mode: Full (strict)
Always Use HTTPS: On
Automatic HTTPS Rewrites: On
Minimum TLS Version: TLS 1.2
```

Untuk tunnel, Cloudflare edge certificate menangani HTTPS publik. Origin tetap lokal `http://localhost:3000`.

## Jika Menggunakan VPS + Nginx

Contoh virtual host:

```nginx
server {
    listen 80;
    server_name teamdlbot.biz.id www.teamdlbot.biz.id;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name teamdlbot.biz.id www.teamdlbot.biz.id;

    ssl_certificate /etc/letsencrypt/live/teamdlbot.biz.id/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/teamdlbot.biz.id/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Monitoring

Script monitor:

```text
scripts/monitor-domain.ps1
```

Jalankan:

```bash
npm run monitor:domain
```

Fungsi:

- Cek local web `localhost:3000`.
- Restart `npm run dev:web` jika local web mati.
- Cek proses Cloudflare Tunnel.
- Restart tunnel jika proses mati.
- Cek DNS root dan `www`.
- Cek HTTPS publik.

Scheduled task Windows sudah dibuat:

```text
Task name: TEAMDL Domain Monitor
Schedule: setiap 5 menit
Command: powershell -ExecutionPolicy Bypass -File scripts/monitor-domain.ps1
```

Validasi scheduled task:

```text
Task To Run: powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\mauta\OneDrive\Documents\TEAMDL\scripts\monitor-domain.ps1"
Repeat: setiap 5 menit
Status: Ready
```

Hasil monitor terakhir:

```text
[OK] Local web - http://localhost:3000
[OK] Cloudflare Tunnel - process running
[FAIL] DNS teamdlbot.biz.id - nameserver registrar belum diganti ke Cloudflare
[FAIL] DNS www.teamdlbot.biz.id - nameserver registrar belum diganti ke Cloudflare
[FAIL] HTTPS https://teamdlbot.biz.id - menunggu delegasi nameserver aktif
```

Tunnel aktif:

```text
Tunnel: botvlix-teamdl
Tunnel ID: 8526eb2d-1be3-477b-85f7-5eda9d1bcd29
Connector: connected
```

## Checklist Final

- Domain terdaftar di registrar.
- Nameserver registrar diarahkan ke Cloudflare.
- Zone `teamdlbot.biz.id` aktif di Cloudflare.
- DNS root `@` aktif.
- DNS `www` aktif.
- SSL/TLS Full Strict aktif.
- Always Use HTTPS aktif.
- Auto HTTPS Rewrites aktif.
- Tunnel/VPS online.
- `https://teamdlbot.biz.id` status 200.
- `https://www.teamdlbot.biz.id` status 200 atau redirect valid.
- Tidak ada Cloudflare Error 1033, 521, 522, 526.
