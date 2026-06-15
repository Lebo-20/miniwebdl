let firebaseApp;
let firestoreDb;

export async function initFirebase() {
  if (firebaseApp && firestoreDb) {
    return { firebaseApp, firestoreDb };
  }

  const config = await fetch("/api/firebase-config").then((response) => response.json());
  const appModule = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js");
  const firestoreModule = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");

  firebaseApp = appModule.initializeApp(config);
  firestoreDb = firestoreModule.getFirestore(firebaseApp);

  return { firebaseApp, firestoreDb, firestoreModule };
}

export async function syncPlatformSources() {
  const { firestoreDb: db, firestoreModule } = await initFirebase();
  const sources = await fetch("/api/sources").then((response) => response.json());
  const batch = firestoreModule.writeBatch(db);
  const syncedAt = new Date().toISOString();

  for (const source of sources) {
    const platformRef = firestoreModule.doc(db, "platformSources", source.slug);
    batch.set(platformRef, {
      platform: source.platform,
      slug: source.slug,
      status: source.status,
      sourceFile: source.sourceFile,
      scrapedAt: source.scrapedAt,
      totalEndpoints: source.totalEndpoints,
      syncedAt
    }, { merge: true });

    for (const endpoint of source.endpoints) {
      const endpointId = `${source.slug}_${endpoint.method}_${endpoint.path}`.replace(/[^a-zA-Z0-9_-]+/g, "_");
      const endpointRef = firestoreModule.doc(db, "sourceEndpoints", endpointId);
      batch.set(endpointRef, {
        platformSlug: source.slug,
        platform: source.platform,
        method: endpoint.method,
        path: endpoint.path,
        fullUrl: endpoint.fullUrl,
        exampleUrl: endpoint.exampleUrl,
        statusCode: endpoint.statusCode,
        description: endpoint.description,
        params: endpoint.params,
        syncedAt
      }, { merge: true });
    }
  }

  await batch.commit();

  return {
    platformCount: sources.length,
    endpointCount: sources.reduce((total, source) => total + source.endpoints.length, 0),
    syncedAt
  };
}
