# Firebase Sync

Firebase config tersimpan di `shared/firebase/firebase.config.json`.

Data endpoint platform dibaca dari:

```text
storage/sources/*_endpoints.txt
```

API lokal:

```text
GET /api/firebase-config
GET /api/sources
GET /api/sources/:platformSlug
GET /api/sync-plan
```

Admin panel memiliki tombol `Sync Firebase` yang mencoba menulis metadata ke Firestore:

```text
platformSources/{platformSlug}
sourceEndpoints/{platformSlug_method_path}
```

Token platform disimpan server-side di `.env`:

```text
PLATFORM_TOKEN=...
```

Token tidak dikirim ke browser. API publik `/api/sources` dan `/api/sources/:platformSlug` menyensor parameter seperti `code`, `token`, `key`, dan URL yang membawa token.

Percobaan sinkron langsung sudah dilakukan, tetapi Firestore menolak dengan:

```text
PERMISSION_DENIED: Missing or insufficient permissions.
```

Artinya project Firebase aktif, tetapi Firestore rules belum mengizinkan write dari client. Untuk produksi, gunakan server-side service account. Untuk testing sementara, rules bisa dibuat lebih longgar hanya saat development.

Contoh rules development sementara:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /platformSources/{docId} {
      allow read: if true;
      allow write: if true;
    }

    match /sourceEndpoints/{docId} {
      allow read: if true;
      allow write: if true;
    }
  }
}
```

Jangan gunakan rules development ini untuk produksi.
