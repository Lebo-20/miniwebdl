import { initFirebase } from "./firebase-sync.js";
import { mountWatchPlayer, cleanupActivePlayer } from "./src/pages/watch.js";

const isLocalDevelopment = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const isAdmin = !!localStorage.getItem("adminToken");
if (!isLocalDevelopment && !isAdmin) {
  console.log = () => {};
  console.debug = () => {};
  console.info = () => {};
}

const CATALOG_FETCH_TIMEOUT_MS = 15000;

// Safe JSON LocalStorage parser to prevent null/array crashes
function safeGetLocalStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    console.warn(`Failed to parse localStorage key "${key}":`, e);
    return {};
  }
}

// Fallback UUID v4 generator for non-secure HTTP contexts
function generateUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Database Sync and Local State
let localFavorites = safeGetLocalStorage("TEAMDL_favorites");
let localHistory = safeGetLocalStorage("TEAMDL_history");
let firebaseReady = false;
let db = null;
let firestoreModule = null;
let firestoreUserDoc = null;

// Watch time variables
let totalWatchSeconds = Number(localStorage.getItem("TEAMDL_watch_seconds") || "0");
let lastWatchTimeSync = 0;

function getWatchLevel(seconds) {
  const minutes = seconds / 60;
  // Thresholds in minutes: Lvl 1 (0m), Lvl 2 (2m), Lvl 3 (5m), Lvl 4 (10m), Lvl 5 (20m), Lvl 6 (40m), Lvl 7 (80m), Lvl 8 (160m), Lvl 9 (320m), Lvl 10 (640m)
  const thresholds = [0, 2, 5, 10, 20, 40, 80, 160, 320, 640, 1280];
  let lvl = 1;
  for (let i = 0; i < thresholds.length; i++) {
    if (minutes >= thresholds[i]) {
      lvl = i + 1;
    } else {
      break;
    }
  }
  
  const currentThreshold = thresholds[lvl - 1] || 0;
  const nextThreshold = thresholds[lvl] || (currentThreshold * 2);
  const percent = lvl >= thresholds.length ? 100 : Math.min(100, Math.max(0, ((minutes - currentThreshold) / (nextThreshold - currentThreshold)) * 100));
  
  const titles = [
    "Pemula (Newbie)",      // Level 1
    "Penjelajah (Explorer)", // Level 2
    "Pecinta Drama",        // Level 3
    "Pengamat Seri",        // Level 4
    "Marathoner",           // Level 5
    "Binge Watcher",        // Level 6
    "Ahli Sinema",          // Level 7
    "Kolektor Episode",     // Level 8
    "Legenda Drama",        // Level 9
    "Kaisar Teater",        // Level 10
    "Dewa Sinema"           // Level 11+
  ];
  const title = titles[Math.min(lvl - 1, titles.length - 1)];

  return {
    level: lvl,
    title: title,
    minutesWatched: Math.floor(minutes),
    secondsWatched: Math.floor(seconds),
    percent: Math.round(percent),
    currentThreshold,
    nextThreshold
  };
}

function accumulateWatchTime(seconds) {
  totalWatchSeconds += seconds;
  localStorage.setItem("TEAMDL_watch_seconds", String(totalWatchSeconds));
  
  // Debounce/Throttle syncing to Firestore (every 10s)
  throttledSyncWatchTime();
  
  // Live update level indicator in UI if on profile page
  if (location.pathname === "/profile") {
    updateProfileLevelUI();
  }
}

async function throttledSyncWatchTime() {
  const now = Date.now();
  if (now - lastWatchTimeSync < 10000) return;
  lastWatchTimeSync = now;
  await forceSyncWatchTime();
}

async function forceSyncWatchTime() {
  if (firebaseReady && db && firestoreModule) {
    try {
      const userDocRef = firestoreModule.doc(db, "users", userId);
      await firestoreModule.setDoc(userDocRef, { totalWatchSeconds: Math.floor(totalWatchSeconds) }, { merge: true });
      console.log("Synced total watch seconds to Firestore:", Math.floor(totalWatchSeconds));
    } catch (err) {
      console.warn("Failed to sync watch seconds to Firestore:", err);
    }
  }
}

// Dynamically updates level status card if user is viewing profile
function updateProfileLevelUI() {
  const stats = getWatchLevel(totalWatchSeconds);
  const badge = document.querySelector(".level-number-badge");
  const title = document.querySelector(".level-title-info h3");
  const desc = document.querySelector(".level-title-info p");
  const bar = document.querySelector(".level-progress-bar");
  const footer = document.querySelector(".level-footer");
  
  if (badge) badge.textContent = `LVL ${stats.level}`;
  if (title) title.textContent = stats.title;
  if (desc) desc.innerHTML = `Total menonton: <b>${stats.minutesWatched} menit</b> (${stats.secondsWatched} detik)`;
  if (bar) bar.style.width = `${stats.percent}%`;
  if (footer) {
    footer.innerHTML = `
      <span>LVL ${stats.level}</span>
      <span>${stats.percent}% menuju LVL ${stats.level + 1}</span>
      <span>LVL ${stats.level + 1}</span>
    `;
  }
}

// Generate or get user security/sync ID
function getUserId() {
  const params = new URLSearchParams(location.search);
  const authUid = params.get("auth_uid");
  const authName = params.get("auth_name");
  const authFirst = params.get("auth_first");
  const authLast = params.get("auth_last");
  const authUser = params.get("auth_user");
  
  if (authUid) {
    localStorage.setItem("TEAMDLUserId", authUid);
    if (authUid.startsWith("tg-")) {
      localStorage.setItem("TEAMDLTelegramId", authUid.replace(/^tg-/, ""));
    }
    if (authFirst) localStorage.setItem("TEAMDLUserFirstName", authFirst);
    if (authLast) localStorage.setItem("TEAMDLUserLastName", authLast);
    if (authUser) localStorage.setItem("TEAMDLUserUsername", authUser);
    
    if (authName) {
      localStorage.setItem("TEAMDLWatchPartyName", authName);
      if (!authFirst) {
        const parts = authName.split(/\s+/);
        localStorage.setItem("TEAMDLUserFirstName", parts[0] || "");
        localStorage.setItem("TEAMDLUserLastName", parts.slice(1).join(" ") || "");
      }
    }
    
    params.delete("auth_uid");
    params.delete("auth_name");
    params.delete("auth_first");
    params.delete("auth_last");
    params.delete("auth_user");
    const newSearch = params.toString();
    const cleanUrl = location.pathname + (newSearch ? `?${newSearch}` : "");
    history.replaceState({}, "", cleanUrl);
  }

  if (window.Telegram?.WebApp?.initDataUnsafe?.user?.id) {
    return `tg-${window.Telegram.WebApp.initDataUnsafe.user.id}`;
  }
  let localId = localStorage.getItem("TEAMDLUserId");
  if (!localId) {
    localId = `guest-${generateUUID()}`;
    localStorage.setItem("TEAMDLUserId", localId);
  }
  return localId;
}

const userId = getUserId();

async function syncDatabase() {
  try {
    const fb = await initFirebase();
    db = fb.firestoreDb;
    firestoreModule = fb.firestoreModule;
    firebaseReady = true;
    console.log("Firebase initialized successfully, starting synchronization...");

    const { doc, setDoc, getDocs, collection, deleteDoc } = firestoreModule;

    // 1. Sync Favorites
    const localFavs = safeGetLocalStorage("TEAMDL_favorites");
    const favRef = collection(db, "users", userId, "favorites");
    const favSnap = await getDocs(favRef);
    const remoteFavs = {};
    favSnap.forEach((d) => {
      remoteFavs[d.id] = d.data();
    });

    // Merge favorites
    const mergedFavs = { ...remoteFavs, ...localFavs };
    for (const [dramaId, item] of Object.entries(mergedFavs)) {
      const localItem = localFavs[dramaId];
      const remoteItem = remoteFavs[dramaId];

      if (localItem && !remoteItem) {
        await setDoc(doc(db, "users", userId, "favorites", dramaId), localItem);
      } else if (remoteItem && !localItem) {
        localFavs[dramaId] = remoteItem;
      } else if (localItem && remoteItem) {
        if (new Date(localItem.updatedAt) > new Date(remoteItem.updatedAt)) {
          await setDoc(doc(db, "users", userId, "favorites", dramaId), localItem);
        } else {
          localFavs[dramaId] = remoteItem;
        }
      }
    }
    
    localStorage.setItem("TEAMDL_favorites", JSON.stringify(localFavs));
    localFavorites = localFavs;

    // 2. Sync Watch History (and purge items older than 7 days)
    const localHist = safeGetLocalStorage("TEAMDL_history");
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    for (const [dramaId, item] of Object.entries(localHist)) {
      if (new Date(item.updatedAt) < sevenDaysAgo) {
        delete localHist[dramaId];
      }
    }

    const histRef = collection(db, "users", userId, "history");
    const histSnap = await getDocs(histRef);
    const remoteHist = {};
    histSnap.forEach((d) => {
      remoteHist[d.id] = d.data();
    });

    const mergedHist = { ...remoteHist, ...localHist };
    for (const [dramaId, item] of Object.entries(mergedHist)) {
      if (new Date(item.updatedAt) < sevenDaysAgo) {
        delete localHist[dramaId];
        await deleteDoc(doc(db, "users", userId, "history", dramaId)).catch(() => {});
        continue;
      }

      const localItem = localHist[dramaId];
      const remoteItem = remoteHist[dramaId];

      if (localItem && !remoteItem) {
        await setDoc(doc(db, "users", userId, "history", dramaId), localItem);
      } else if (remoteItem && !localItem) {
        localHist[dramaId] = remoteItem;
      } else if (localItem && remoteItem) {
        if (new Date(localItem.updatedAt) > new Date(remoteItem.updatedAt)) {
          await setDoc(doc(db, "users", userId, "history", dramaId), localItem);
        } else {
          localHist[dramaId] = remoteItem;
        }
      }
    }
    
    localStorage.setItem("TEAMDL_history", JSON.stringify(localHist));
    localHistory = localHist;
    // 3. Sync User Document (VIP status and profile info)
    const userDocRef = doc(db, "users", userId);
    const userDocSnap = await firestoreModule.getDoc(userDocRef);
    if (userDocSnap.exists()) {
      firestoreUserDoc = userDocSnap.data();
      console.log("Retrieved user document from Firestore:", firestoreUserDoc);
      if (firestoreUserDoc.vip) {
        localStorage.setItem("TEAMDL_firestore_vip", JSON.stringify(firestoreUserDoc.vip));
      }
      if (typeof firestoreUserDoc.totalWatchSeconds === "number") {
        const remoteSec = firestoreUserDoc.totalWatchSeconds;
        const localSec = Number(localStorage.getItem("TEAMDL_watch_seconds") || "0");
        if (remoteSec > localSec) {
          totalWatchSeconds = remoteSec;
          localStorage.setItem("TEAMDL_watch_seconds", String(totalWatchSeconds));
        } else if (localSec > remoteSec) {
          await setDoc(userDocRef, { totalWatchSeconds: localSec }, { merge: true }).catch(() => {});
        }
      } else {
        const localSec = Number(localStorage.getItem("TEAMDL_watch_seconds") || "0");
        if (localSec > 0) {
          await setDoc(userDocRef, { totalWatchSeconds: localSec }, { merge: true }).catch(() => {});
        }
      }
    } else {
      const userObj = window.Telegram?.WebApp?.initDataUnsafe?.user || {
        first_name: "Guest",
        last_name: "User",
        username: "guest_" + userId.slice(6, 12),
        id: "Tamu"
      };
      
      const initData = {
        userId: userId,
        first_name: userObj.first_name || "",
        last_name: userObj.last_name || "",
        username: userObj.username || "",
        id: String(userObj.id),
        createdAt: new Date().toISOString()
      };
      await setDoc(userDocRef, initData, { merge: true });
      console.log("Initialized user document in Firestore:", initData);
    }

    console.log("Database sync complete.");
    
    if (location.pathname === "/profile") {
      renderProfile();
    }
  } catch (error) {
    console.warn("Database sync failed or offline:", error);
  }
}

async function toggleFavoriteDrama(drama) {
  const localFavs = safeGetLocalStorage("TEAMDL_favorites");
  const isFav = !!localFavs[drama.id];
  const nowStr = new Date().toISOString();

  if (isFav) {
    delete localFavs[drama.id];
    localStorage.setItem("TEAMDL_favorites", JSON.stringify(localFavs));
    localFavorites = localFavs;

    if (firebaseReady && db && firestoreModule) {
      try {
        await firestoreModule.deleteDoc(firestoreModule.doc(db, "users", userId, "favorites", drama.id));
      } catch (err) {
        console.warn("Failed to remove favorite remotely:", err);
      }
    }
  } else {
    const favItem = {
      dramaId: drama.id,
      title: drama.title,
      poster: drama.poster || "",
      platform: drama.platform,
      updatedAt: nowStr
    };
    localFavs[drama.id] = favItem;
    localStorage.setItem("TEAMDL_favorites", JSON.stringify(localFavs));
    localFavorites = localFavs;

    if (firebaseReady && db && firestoreModule) {
      try {
        await firestoreModule.setDoc(firestoreModule.doc(db, "users", userId, "favorites", drama.id), favItem);
      } catch (err) {
        console.warn("Failed to add favorite remotely:", err);
      }
    }
  }
}

async function addDramaToHistory(drama, episodeNumber) {
  const localHist = safeGetLocalStorage("TEAMDL_history");
  const nowStr = new Date().toISOString();
  const histItem = {
    dramaId: drama.id,
    title: drama.title,
    poster: drama.poster || "",
    platform: drama.platform,
    episodeNumber: Number(episodeNumber),
    updatedAt: nowStr
  };
  
  localHist[drama.id] = histItem;
  localStorage.setItem("TEAMDL_history", JSON.stringify(localHist));
  localHistory = localHist;

  if (firebaseReady && db && firestoreModule) {
    try {
      await firestoreModule.setDoc(firestoreModule.doc(db, "users", userId, "history", drama.id), histItem);
    } catch (err) {
      console.warn("Failed to save history remotely:", err);
    }
  }
}

async function simulateVipPurchase(planDays) {
  try {
    const response = await fetch("/api/vip/purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: userId, plan: planDays })
    });
    const data = await response.json();
    if (data.ok) {
      const now = new Date();
      const expires = new Date();
      expires.setDate(now.getDate() + planDays);
      const vipData = {
        active: true,
        purchaseDate: now.toISOString(),
        expiresAt: expires.toISOString(),
        planDays: planDays
      };

      // Always write to LocalStorage immediately so state changes are instant
      localStorage.setItem("TEAMDL_firestore_vip", JSON.stringify(vipData));
      console.log("Saved VIP purchase metadata to LocalStorage immediately.");

      // Save purchase info to Firestore if connected
      if (firebaseReady && db && firestoreModule) {
        try {
          await firestoreModule.setDoc(firestoreModule.doc(db, "users", userId), { vip: vipData }, { merge: true });
          console.log("Saved VIP purchase metadata to Firestore successfully.");
        } catch (dbErr) {
          console.warn("Failed to write VIP metadata to Firestore:", dbErr);
        }
      }

      securitySession = null;
      securitySessionPromise = null;
      await ensureSecuritySession();
      
      if (window.Telegram?.WebApp?.showConfirm) {
        window.Telegram.WebApp.showConfirm(`Selamat! Pembelian VIP ${planDays} Hari berhasil disimulasikan.`);
      } else {
        alert(`Selamat! Pembelian VIP ${planDays} Hari berhasil disimulasikan.`);
      }
      
      // Re-fetch user doc from Firestore to sync local state immediately
      if (firebaseReady && db && firestoreModule) {
        try {
          const userDocSnap = await firestoreModule.getDoc(firestoreModule.doc(db, "users", userId));
          if (userDocSnap.exists()) {
            firestoreUserDoc = userDocSnap.data();
          }
        } catch (e) {}
      }
      
      renderProfile();
    }
  } catch (err) {
    console.warn("Failed to purchase VIP mock:", err);
  }
}

function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const seconds = Math.floor((new Date() - date) / 1000);
  
  let interval = Math.floor(seconds / 31536000);
  if (interval >= 1) return `${interval} tahun yang lalu`;
  interval = Math.floor(seconds / 2592000);
  if (interval >= 1) return `${interval} bulan yang lalu`;
  interval = Math.floor(seconds / 86400);
  if (interval >= 1) return `${interval} hari yang lalu`;
  interval = Math.floor(seconds / 3600);
  if (interval >= 1) return `${interval} jam yang lalu`;
  interval = Math.floor(seconds / 60);
  if (interval >= 1) return `${interval} menit yang lalu`;
  return "Baru saja";
}

const app = document.querySelector("#app");
const telegram = window.Telegram?.WebApp;

let platforms = [
  "DramaBox",
  "Melolo",
  "ShortMax",
  "DramaWave",
  "FreeReels",
  "GoodShort",
  "FlickReels",
  "NetShort",
  "MicroDrama",
  "DramaNova",
  "ReelShort",
  "CubeTV",
  "RapidTV",
  "DotDrama",
  "iDrama",
  "MoboReels",
  "PineDrama",
  "Serial+"
];

const fallbackDramas = [
  ["suami-untuk-tiga-tahun", "Suami untuk Tiga Tahun", "DramaBox", 65, "Romance", "CN", "2026", true],
  ["antara-gengsi-dan-kasih-keluarga", "Antara Gengsi dan Kasih Keluarga", "DramaBox", 63, "Family", "CN", "2026", false],
  ["menemukan-kembali-cinta-yang-hilang", "Menemukan Kembali Cinta yang Hilang", "DramaBox", 56, "Romance", "CN", "2025", false],
  ["istriku-pembaca-pikiran", "Istriku Pembaca Pikiran", "Melolo", 83, "Fantasy", "CN", "2026", true],
  ["reinkarnasi-ubah-nasib", "Reinkarnasi Ubah Nasib", "Melolo", 60, "Revenge", "CN", "2026", false],
  ["tuan-gelap", "Tuan Gelap", "ShortMax", 64, "Action", "KR", "2025", false],
  ["kesempatan-kedua", "Kesempatan Kedua", "ShortMax", 57, "Romance", "CN", "2026", false],
  ["kiamat-investasi-wanita", "Kiamat: Investasi pada Wanita Berbahaya", "DramaWave", 51, "Fantasy", "JP", "2025", false],
  ["hidup-kedua-permaisuri", "Hidup Kedua sebagai Permaisuri Gendut", "DramaWave", 81, "Historical", "CN", "2026", true],
  ["cinta-masa-kecil-licik", "Cinta Masa Kecil yang Licik", "FreeReels", 73, "Romance", "KR", "2025", false],
  ["satu-dewa-perang-tujuh-ratu", "Satu Dewa Perang, Tujuh Ratu", "FreeReels", 75, "Action", "CN", "2026", true],
  ["kumohon-kembalilah-padaku", "Kumohon, Kembalilah Padaku", "GoodShort", 104, "Romance", "US", "2026", true],
  ["romansa-19", "Romansa 19+", "GoodShort", 70, "Drama", "US", "2025", false],
  ["ibu-konglomerat-ayah-tabib", "Ibu Konglomerat, Ayah Tabib", "FlickReels", 70, "Family", "CN", "2026", false],
  ["telah-usir-aku-perusahaan-hancur", "Telah Usir Aku, Perusahaan Hancur", "FlickReels", 48, "Revenge", "CN", "2025", false],
  ["pelindung-ayah-selalu-ada", "Pelindung Ayah Selalu Ada", "NetShort", 88, "Family", "CN", "2026", false],
  ["rumah-yang-terkunci", "Rumah yang Terkunci", "NetShort", 42, "Mystery", "KR", "2025", false],
  ["ruang-bersalin-penuh-pengkhianatan", "Ruang Bersalin Penuh Pengkhianatan", "MicroDrama", 66, "Revenge", "CN", "2026", true],
  ["bos-wanita-rahasia", "Bos Wanita Rahasia", "MicroDrama", 54, "Office", "CN", "2026", false],
  ["bimbingan-pribadi-mertua-perempuan", "Bimbingan Pribadi Mertua Perempuan", "DramaNova", 30, "Drama", "CN", "2025", false],
  ["godaan-sahabat", "Godaan Sahabat", "DramaNova", 44, "Romance", "KR", "2025", false],
  ["tembakan-sang-raja-senjata", "Tembakan Sang Raja Senjata", "ReelShort", 63, "Action", "US", "2026", false],
  ["tunangan-sekaligus-musuh", "Tunangan Sekaligus Musuh", "ReelShort", 61, "Romance", "US", "2026", true],
  ["tak-bisa-menolak", "Tak Bisa Menolak", "CubeTV", 49, "Romance", "TH", "2025", false],
  ["pesta-malam-terakhir", "Pesta Malam Terakhir", "CubeTV", 39, "Thriller", "US", "2025", false],
  ["dokter-jenius-pulang", "Dokter Jenius Pulang", "RapidTV", 52, "Medical", "CN", "2026", false],
  ["warisan-yang-tertukar", "Warisan yang Tertukar", "DotDrama", 68, "Family", "CN", "2026", true],
  ["cinta-di-balik-kontrak", "Cinta di Balik Kontrak", "iDrama", 58, "Romance", "CN", "2026", false],
  ["pengawal-hati", "Pengawal Hati", "MoboReels", 45, "Action", "KR", "2025", false],
  ["pine-city-love", "Pine City Love", "PineDrama", 32, "Slice of Life", "CN", "2026", false],
  ["ratu-dendam", "Ratu Dendam", "Sereal+", 76, "Revenge", "CN", "2026", true]
].map(([id, title, platform, episodes, genre, country, year, vip], index) => ({
  id,
  title,
  platform,
  episodes,
  genre,
  country,
  language: normalizeContentLang(country),
  year,
  vip: episodes > 12,
  rating: (4.9 - (index % 5) * 0.1).toFixed(1),
  progress: 12 + (index * 7) % 78,
  tone: ["red", "gold", "blue", "violet", "green"][index % 5],
  poster: "",
  backdrop: "",
  isFallback: true,
  synopsis: `${title} menghadirkan konflik pendek penuh emosi, rahasia keluarga, dan pilihan sulit dalam ${episodes} episode.`
}));

let dramas = fallbackDramas;
let allSources = [];
const catalogPages = new Map();
const hasMoreCatalog = new Map();
let isLoadingCatalog = false;
let isCatalogHydrated = true;
const platformImages = new Map();
const platformModes = new Map();
const platformPlayability = new Map();
const platformLanguages = new Map();
const episodeCache = new Map();
let selectedSubtitleLang = localStorage.getItem("TEAMDLSubtitleLang") || "id";
let selectedContentLang = localStorage.getItem("TEAMDLContentLang") || "id";
let activeVideoMountId = 0;
let watchPartySocket = null;
let watchPartyState = null;
let watchPartyLocalAction = false;
let watchPartyVoiceStream = null;
let watchPartyVoiceMuted = false;
let watchPartySpeakerMuted = false;
let watchPartyVoiceMode = "open";
const watchPartySpeakingUsers = new Set();
const watchPartyUserVolumes = new Map();
let watchPartyPttActive = false;
let localAudioAnalyser = null;
let isLocalCurrentlySpeaking = false;
let watchPartyTypingTimer = null;
let watchPartyReconnectPaused = false;
const watchPartyPeers = new Map();
const watchPartyPendingIceCandidates = new Map();
const watchPartyPendingVoiceSignals = [];
let watchPartyIceServers = [{ urls: "stun:stun.l.google.com:19302" }];
let watchPartyAutoJoinedVoice = false;
let watchPartyAudioContext = null;
let watchPartySelectedMicId = localStorage.getItem("TEAMDLWatchPartyMicId") || "";
let watchPartyMicDevices = [];
let watchPartyDebugState = {
  micPermission: "Unknown",
  microphone: "Disconnected",
  audioTrack: "Inactive",
  peerConnection: "Idle",
  iceState: "New",
  remoteUsers: 0,
  receivingAudio: "No",
  sendingAudio: "No"
};
let securitySession = null;
let securityDevice = null;
let securitySessionPromise = null;
let sensitiveRequestsBlocked = false;
const MIN_PLATFORM_CARDS = 30;
const HOME_SECTION_LIMIT = 30;
const PROFILE_HISTORY_LIMIT = 4;
const PROFILE_FAVORITES_LIMIT = 6;

if (performance.getEntriesByType("navigation")[0]?.type === "reload") {
  sessionStorage.removeItem("TEAMDLSecurityRefreshRequired");
}

const platformApi = {
  dramabox: { detailEndpoint: 6, episodesEndpoint: 7, idParam: "bookId", episodeField: "videoUrl" },
  melolo: {
    detailEndpoint: 2,
    episodesEndpoint: 2,
    idParam: "id",
    episodeField: "videoUrl",
    streamEndpoint: 4,
    episodeParam: "ep",
    streamEpisodeMode: "number",
    stream: {
      path: "/api/platform/melolo/endpoint/4",
      idParam: "id",
      episodeParam: "ep",
      episodeMode: "number",
      episodeField: "videoUrl"
    }
  },
  goodshort: { detailEndpoint: 5, episodesEndpoint: 8, idParam: "id", episodeField: "videoUrl" },
  cubetv: { detailEndpoint: 4, episodesEndpoint: 5, idParam: "videoid", episodeField: "videoUrl" },
  dramawave: { detailEndpoint: 5, episodesEndpoint: 5, idParam: "id", episodeField: "m3u8_path" },
  microdrama: {
    detailEndpoint: 4,
    episodesEndpoint: 4,
    idParam: "id",
    episodeField: "videoUrl",
    streamEndpoint: 5,
    episodeParam: "episodeNo",
    streamEpisodeMode: "number",
    stream: {
      path: "/api/platform/microdrama/endpoint/5",
      idParam: "dramaId",
      episodeParam: "episodeNo",
      episodeMode: "number",
      episodeField: "videoUrl"
    }
  },
  pinedrama: { detailEndpoint: 14, episodesEndpoint: 16, idParam: "id", episodeField: "videoUrl" },
  moboreels: { detailEndpoint: 3, episodesEndpoint: 3, idParam: "seriesId", episodeField: "mediaUrl" },
  dramabite: { detailEndpoint: 5, episodesEndpoint: 6, idParam: "cid", episodeField: "url" },
  dotdrama: { episodesEndpoint: 4, idParam: "id", episodeField: "videoUrl", streamEndpoint: 5, episodeParam: "ep", streamEpisodeMode: "number" },
  dramanova: { episodesEndpoint: 6, idParam: "dramaId", episodeField: "videoUrl" },
  flickreels: { episodesEndpoint: 6, idParam: "id", episodeField: "videoUrl" },
  happyshort: { episodesEndpoint: 5, idParam: "id", episodeField: "videoUrl", streamEndpoint: 6, episodeParam: "ep", streamEpisodeMode: "number" },
  rapidtv: { episodesEndpoint: 4, idParam: "id", sourceIdField: "ecar", episodeField: "videoUrl", streamEndpoint: 5, episodeParam: "ep", streamEpisodeMode: "number" },
  reelife: { episodesEndpoint: 7, idParam: "id", episodeField: "videoUrl", streamEndpoint: 8, episodeParam: "chapterId", streamEpisodeMode: "sourceId" },
  shortmax: { episodesEndpoint: 10, idParam: "id", episodeField: "videoUrl" },
  shortswave: { episodesEndpoint: 5, idParam: "id", episodeField: "videoUrl", streamEndpoint: 7, episodeParam: "chapterId", streamEpisodeMode: "sourceId" },
  stardusttv: { episodesEndpoint: 4, idParam: "id", episodeField: "videoUrl", streamEndpoint: 5, episodeParam: "ep", streamEpisodeMode: "number" },
  velolo: { episodesEndpoint: 14, idParam: "id", episodeField: "videoUrl" },
  freereels: { episodesEndpoint: 6, idParam: "id", episodeField: "videoUrl", streamEndpoint: 7, episodeParam: "ep", streamEpisodeMode: "number" },
  fundrama: { episodesEndpoint: 5, idParam: "id", episodeField: "url" },
  idrama: { episodesEndpoint: 5, idParam: "id", episodeField: "videoUrl" },
  serialplus: { detailEndpoint: 4, episodesEndpoint: 5, idParam: "id", episodeField: "videoUrl" },
  serial: { detailEndpoint: 4, episodesEndpoint: 5, idParam: "id", episodeField: "videoUrl" },
  vigloo: {
    detailEndpoint: 5,
    episodesEndpoint: 6,
    idParam: "id",
    episodeField: "url",
    stream: {
      path: "/api/platform/vigloo/endpoint/7",
      idParam: "seasonId",
      episodeParam: "ep",
      episodeMode: "number",
      episodeField: "url"
    }
  }
};

const titleSeeds = [
  "Cinta yang Tersembunyi",
  "Rahasia Pewaris Muda",
  "Kontrak Pernikahan",
  "Malam Pengakuan",
  "Istri yang Hilang",
  "Balas Dendam Sang Putri",
  "CEO Tanpa Nama",
  "Ayah dari Masa Lalu",
  "Rumah Penuh Rahasia",
  "Cinta Setelah Luka",
  "Ratu yang Terbuang",
  "Janji di Ujung Kota"
];

// Initialize SPA history tracking
if (!history.state || typeof history.state.index === "undefined") {
  history.replaceState({ index: 0 }, "", location.pathname + location.search);
}
let spaHistoryIndex = history.state ? (history.state.index || 0) : 0;

const originalPushState = history.pushState;
history.pushState = function(state, title, url) {
  spaHistoryIndex++;
  const newState = { ...(state || {}), index: spaHistoryIndex };
  return originalPushState.call(this, newState, title, url);
};

const originalReplaceState = history.replaceState;
history.replaceState = function(state, title, url) {
  const newState = { ...(state || {}), index: spaHistoryIndex };
  return originalReplaceState.call(this, newState, title, url);
};

function spaBack(fallbackUrl = "/") {
  if (history.state && typeof history.state.index === "number" && history.state.index > 0) {
    history.back();
  } else {
    history.pushState({ index: 0 }, "", fallbackUrl);
    renderRoute();
  }
}

initSecurity();
initTelegram();
initNotifications();
renderRoute();
loadApiCatalog();
syncDatabase();
window.addEventListener("popstate", (event) => {
  if (event.state && typeof event.state.index === "number") {
    spaHistoryIndex = event.state.index;
  } else {
    spaHistoryIndex = 0;
  }
  renderRoute();
});
document.addEventListener("click", handleLanguageControls);
document.addEventListener("click", interceptLinks);
document.addEventListener("click", handlePlayerControls);
document.addEventListener("click", handleEpisodeTabs);
window.addEventListener("scroll", () => document.querySelector("#siteNav")?.classList.toggle("scrolled", window.scrollY > 40));

document.addEventListener("fullscreenchange", () => {
  const stage = document.querySelector("#playerShell");
  const isFS = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (stage) {
    stage.classList.toggle("player-fullscreen", isFS);
  }
  document.body.classList.toggle("player-fullscreen-active", isFS);
});
document.addEventListener("webkitfullscreenchange", () => {
  const stage = document.querySelector("#playerShell");
  const isFS = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (stage) {
    stage.classList.toggle("player-fullscreen", isFS);
  }
  document.body.classList.toggle("player-fullscreen-active", isFS);
});

async function initSecurity() {
  try {
    enforceOfficialHost();
    securityDevice = await buildDeviceFingerprint();
    installClientSecuritySensors();
    securitySession = await ensureSecuritySession();
    // Render current route again to update view with active session info
    if (location.pathname === "/profile" || location.pathname === "/vip" || location.pathname === "/") {
      renderRoute();
    }
  } catch (error) {
    console.warn("Security bootstrap failed", error);
  }
}

function initTelegram() {
  if (!telegram?.initData) return;
  document.body.dataset.telegram = "true";
  telegram.ready();
  telegram.expand();
  telegram.disableVerticalSwipes?.();

  const navActions = document.querySelector("#siteNav .nav-actions");
  if (navActions && !document.querySelector("#telegramOpenBrowserBtn")) {
    const openBtn = document.createElement("button");
    openBtn.id = "telegramOpenBrowserBtn";
    openBtn.type = "button";
    openBtn.className = "open-browser-btn";
    openBtn.style.cssText = "background: linear-gradient(135deg, rgba(233,163,0,0.1), rgba(255,123,0,0.15)); border: 1px solid rgba(233, 163, 0, 0.4); color: #ffe7a3; padding: 6px 12px; border-radius: 20px; font-size: 11px; font-weight: bold; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; transition: all 0.2s; box-shadow: 0 0 6px rgba(233,163,0,0.2);";
    openBtn.innerHTML = "🌐 Buka di Browser";
    
    openBtn.addEventListener("mouseover", () => {
      openBtn.style.background = "linear-gradient(135deg, rgba(233,163,0,0.2), rgba(255,123,0,0.25))";
      openBtn.style.borderColor = "rgba(233, 163, 0, 0.6)";
    });
    openBtn.addEventListener("mouseout", () => {
      openBtn.style.background = "linear-gradient(135deg, rgba(233,163,0,0.1), rgba(255,123,0,0.15))";
      openBtn.style.borderColor = "rgba(233, 163, 0, 0.4)";
    });

    openBtn.addEventListener("click", () => {
      const url = new URL(location.href);
      url.searchParams.set("auth_uid", userId);
      const userObj = telegram?.initDataUnsafe?.user;
      if (userObj) {
        url.searchParams.set("auth_first", userObj.first_name || "");
        url.searchParams.set("auth_last", userObj.last_name || "");
        url.searchParams.set("auth_user", userObj.username || "");
      } else {
        url.searchParams.set("auth_name", getWatchPartyUserName());
      }
      
      if (telegram && typeof telegram.openLink === "function") {
        telegram.openLink(url.toString());
      } else {
        window.open(url.toString(), "_blank");
      }
    });
    navActions.insertBefore(openBtn, navActions.firstChild);
  }
}

function enforceOfficialHost() {
  // Telegram Web opens Mini Apps inside an iframe. Server CSP still restricts
  // allowed frame ancestors, so the client should not force-redirect here.
}

async function buildDeviceFingerprint() {
  const storedId = localStorage.getItem("TEAMDLDeviceId") || crypto.randomUUID();
  localStorage.setItem("TEAMDLDeviceId", storedId);
  const canvas = document.createElement("canvas");
  canvas.width = 220;
  canvas.height = 40;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#102846";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.font = "16px Arial";
  ctx.fillText(`${navigator.userAgent}|${screen.width}x${screen.height}|${Intl.DateTimeFormat().resolvedOptions().timeZone}`, 8, 25);
  const webgl = document.createElement("canvas").getContext("webgl");
  const webglInfo = webgl ? `${webgl.getParameter(webgl.VENDOR)}:${webgl.getParameter(webgl.RENDERER)}` : "no-webgl";
  const raw = [
    navigator.userAgent,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.platform,
    webglInfo,
    canvas.toDataURL()
  ].join("|");
  return {
    deviceId: storedId,
    fingerprint: await sha256(raw)
  };
}

async function openSecuritySession() {
  if (!securityDevice) {
    securityDevice = await buildDeviceFingerprint();
  }
  const response = await fetch("/api/security/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Id": securityDevice.deviceId,
      "X-Device-Fingerprint": securityDevice.fingerprint,
      "X-User-Id": userSecurityId()
    },
    body: JSON.stringify({
      deviceId: securityDevice.deviceId,
      fingerprint: securityDevice.fingerprint,
      userId: userSecurityId()
    })
  });
  if (!response.ok) {
    throw new Error("Security session denied");
  }
  return response.json();
}

async function ensureSecuritySession() {
  if (securitySession) {
    return securitySession;
  }
  if (!securitySessionPromise) {
    securitySessionPromise = openSecuritySession()
      .then((session) => {
        securitySession = session;
        return session;
      })
      .finally(() => {
        securitySessionPromise = null;
      });
  }
  return securitySessionPromise;
}

async function secureFetch(url, options = {}) {
  if (sensitiveRequestsBlocked) {
    return new Response(JSON.stringify({ error: "Sensitive request blocked" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }
  return signedFetch(url, options, true);
}

async function secureFetchWithTimeout(url, options = {}, timeoutMs = CATALOG_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await secureFetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function signedFetch(url, options = {}, canRetry) {
  const session = await ensureSecuritySession();

  const method = (options.method || "GET").toUpperCase();
  const timestamp = Date.now();
  const nonce = crypto.randomUUID();
  const signature = await hmacSha256(`${method}:${url}:${timestamp}:${nonce}:${await deviceHash()}`, session.csrf);
  const headers = new Headers(options.headers || {});
  headers.set("X-Device-Id", securityDevice.deviceId);
  headers.set("X-Device-Fingerprint", securityDevice.fingerprint);
  headers.set("X-User-Id", userSecurityId());
  headers.set("X-Request-Timestamp", String(timestamp));
  headers.set("X-Request-Nonce", nonce);
  headers.set("X-Request-Signature", signature);
  const response = await fetch(url, { ...options, method, headers });
  if (response.status === 403 && canRetry) {
    securitySession = null;
    securitySessionPromise = null;
    await fetch("/api/security/logout", { method: "POST" }).catch(() => {});
    return signedFetch(url, options, false);
  }
  return response;
}

async function deviceHash() {
  return sha256(`${securityDevice.deviceId}:${securityDevice.fingerprint}`);
}

function installClientSecuritySensors() {
  document.addEventListener("contextmenu", (event) => event.preventDefault());
  document.addEventListener("dragstart", (event) => {
    if (event.target.closest("video")) {
      event.preventDefault();
    }
  });
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const blocked = event.key === "F12"
      || (event.ctrlKey && event.shiftKey && ["i", "j", "c"].includes(key))
      || (event.ctrlKey && ["u", "s"].includes(key));
    if (blocked) {
      event.preventDefault();
      forceSecurityExit("DEVTOOLS_SHORTCUT");
    }
  });

  const watched = ["fetch", "XMLHttpRequest", "localStorage"];
  const originals = new Map(watched.map((key) => [key, window[key]]));
  setInterval(() => {
    for (const [key, value] of originals.entries()) {
      if (window[key] !== value) {
        forceSecurityExit(`JS_TAMPERING_${key.toUpperCase()}`);
        return;
      }
    }
    const widthGap = Math.abs(window.outerWidth - window.innerWidth);
    const heightGap = Math.abs(window.outerHeight - window.innerHeight);
    window.__TEAMDLDevtoolsSignal = { widthGap, heightGap, checkedAt: Date.now() };
    if ((widthGap > 180 || heightGap > 180) && !window.__TEAMDLDevtoolsDimensionReported) {
      window.__TEAMDLDevtoolsDimensionReported = true;
      reportSecurityViolation("DEVTOOLS_DIMENSION_SIGNAL");
    }
  }, 1800);

  const observer = new MutationObserver((mutations) => {
    if (window.__TEAMDLSecurityExitInProgress) return;
    if (mutations.some((item) => [...item.removedNodes].some((node) => node.id === "app"))) {
      forceSecurityExit("DOM_TAMPERING");
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function forceSecurityExit(type) {
  window.__TEAMDLSecurityExitInProgress = true;
  sensitiveRequestsBlocked = true;
  cleanupVideoPlayer();
  if (type.startsWith("DEVTOOLS_")) {
    reportSecurityViolation("DEVTOOLS_DIMENSION_SIGNAL");
    document.body.innerHTML = securityDeniedMarkup("Developer Tools terdeteksi. Silakan tutup Developer Tools dan segarkan halaman (F5) untuk melanjutkan.");
    return;
  }
  reportSecurityViolation(type);
  sessionStorage.setItem("TEAMDLSecurityRefreshRequired", "true");
  document.body.innerHTML = securityDeniedMarkup("Sistem keamanan mendeteksi alat inspeksi browser yang dapat digunakan untuk mengakses atau menganalisis konten yang dilindungi.");
  setTimeout(() => location.replace("/"), 3000);
}

function securityDeniedMarkup(message) {
  return `
    <main class="security-denied">
      <section>
        <h1>Akses Dihentikan</h1>
        <p>${escapeHtml(message)}</p>
        <p>Untuk melindungi konten dan hak akses pengguna, halaman ini akan ditutup.</p>
      </section>
    </main>
  `;
}

function reportSecurityViolation(violationType) {
  const payload = JSON.stringify({
    violationType,
    deviceId: securityDevice?.deviceId || localStorage.getItem("TEAMDLDeviceId") || "unknown",
    userId: userSecurityId()
  });
  navigator.sendBeacon?.("/api/security/report", new Blob([payload], { type: "application/json" }))
    || fetch("/api/security/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }).catch(() => {});
}

function userSecurityId() {
  return telegram?.initDataUnsafe?.user?.id ? `tg-${telegram.initDataUnsafe.user.id}` : (localStorage.getItem("TEAMDLUserId") || "guest");
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(value, key) {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function interceptLinks(event) {
  if (event.target.closest("[data-language-toggle], [data-content-lang]")) return;
  const blockedPlatform = event.target.closest("[data-platform-blocked]");
  if (blockedPlatform) {
    event.preventDefault();
    showPlatformUnavailableNotice(blockedPlatform.textContent.replace(/OFF|MAINTENANCE/g, "").trim(), blockedPlatform.dataset.platformBlocked);
    return;
  }
  const lockedEpisode = event.target.closest("a.episode.locked");
  if (lockedEpisode) {
    event.preventDefault();
    showVipPrompt(lockedEpisode.dataset.episode || "");
    return;
  }

  const link = event.target.closest("a[href^='/']");
  if (!link) return;
  if (link.hasAttribute("download") || link.getAttribute("href").endsWith(".apk")) return;
  event.preventDefault();
  if (link.classList.contains("back-btn") || link.classList.contains("moviebox-back-btn") || link.classList.contains("back-pill")) {
    spaBack(link.getAttribute("href") || "/");
  } else {
    history.pushState({}, "", link.getAttribute("href"));
    renderRoute();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function showPlatformUnavailableNotice(platform, mode) {
  let notice = document.querySelector("#platformUnavailableNotice");
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "platformUnavailableNotice";
    notice.className = "platform-unavailable-notice";
    document.body.appendChild(notice);
  }
  notice.textContent = `${platform} sedang ${mode === "off" ? "OFF" : "MAINTENANCE"}. Platform tidak dapat digunakan sementara.`;
  notice.classList.add("show");
  clearTimeout(window.__platformNoticeTimer);
  window.__platformNoticeTimer = setTimeout(() => notice.classList.remove("show"), 3200);
}

function handleLanguageControls(event) {
  const toggle = event.target.closest("[data-language-toggle]");
  if (toggle) {
    event.preventDefault();
    document.querySelector("#globalLanguage")?.classList.toggle("open");
    return;
  }

  const option = event.target.closest("[data-content-lang]");
  if (option) {
    event.preventDefault();
    selectedContentLang = option.dataset.contentLang || "all";
    localStorage.setItem("TEAMDLContentLang", selectedContentLang);
    refreshLanguageMenu();
    loadApiCatalog();
    return;
  }

  if (!event.target.closest("#globalLanguage")) {
    document.querySelector("#globalLanguage")?.classList.remove("open");
  }
}

function renderRoute() {
  const path = location.pathname;
  cleanupVideoPlayer();
  // Clean up VIP QRIS modal if navigating away
  document.querySelector("#vipQrisModal")?.remove();
  document.body.style.overflow = "";
  document.body.classList.toggle("watch-mode", path.startsWith("/watch/") || path.startsWith("/moviebox/watch/") || path.startsWith("/watch-party/"));
  setActiveNav(path);
  refreshLanguageMenu();

  if (path.startsWith("/detail/")) return renderDetail(path.split("/").pop());
  if (path.startsWith("/watch/")) return renderPlayer(path.split("/").pop());
  if (path.startsWith("/platform/")) return renderCatalog(path.split("/").pop());
  if (path === "/search") return renderSearch();
  if (path === "/new") return renderNewTitlesPage();
  if (path === "/platform") return renderCatalog();
  if (path === "/vip") return renderVip();
  if (path === "/profile") return renderProfile();
  if (path === "/history") return renderHistoryPage();
  if (path === "/favorites") return renderFavoritesPage();
  if (path === "/moviebox") return renderMovieboxHome();
  if (path.startsWith("/moviebox/detail/")) return renderMovieboxDetail(decodeURIComponent(path.replace(/^\/moviebox\/detail\//, "")));
  if (path.startsWith("/moviebox/watch/")) return renderMovieboxPlayer(path.split("/").pop());
  if (path.startsWith("/watch-party/")) return renderWatchPartyRoom(path.split("/").pop());
  return renderHome();
}

function renderHome() {
  if (!isCatalogHydrated) {
    app.innerHTML = `
      ${loadingHero()}
      ${section("Platform Aktif", loadingPlatformRail())}
      ${section("NEW", loadingCatalogGrid(HOME_SECTION_LIMIT))}
      ${section("Semua Drama", loadingCatalogGrid(HOME_SECTION_LIMIT))}
    `;
    return;
  }

  if (!dramas.length) {
    app.innerHTML = `
      <section class="page-section top-space">
        <div class="empty-state">Belum ada judul yang tersedia saat ini.</div>
      </section>
    `;
    return;
  }

  const visible = languageFilteredDramas(dramas);
  if (!visible.length) {
    app.innerHTML = `
      <section class="page-section top-space">
        <div class="empty-state">Belum ada judul untuk bahasa ini.</div>
      </section>
    `;
    return;
  }
  const homeItems = visible;
  const hero = visible[0];
  const newItems = sortedNewTitleItems(homeItems).slice(0, HOME_SECTION_LIMIT);
  app.innerHTML = `
    <section class="hero hero-${hero.tone}">
      <div class="hero-art">${posterVisual(hero, "banner")}</div>
      <div class="hero-shade"></div>
      <div class="hero-copy">
        <div class="meta-line">
          <span class="badge">${slug(hero.platform)}</span>
          <span>${hero.episodes} Episodes</span>
        </div>
        <h1>${shortTitle(hero.title, 22)}</h1>
        <div class="button-row">
          <a class="primary-btn" href="/watch/${hero.id}">Tonton Sekarang</a>
          <a class="glass-btn" href="/detail/${hero.id}">Detail Info</a>
        </div>
        <div class="hero-dots"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      </div>
    </section>

    ${section("Platform Aktif", platformScroller())}
    ${section("NEW", catalogGrid(newItems.length ? newItems : homeItems.slice(0, HOME_SECTION_LIMIT)), "/new")}
    ${section("Semua Drama", catalogGrid(homeItems.slice(0, HOME_SECTION_LIMIT)))}
  `;
}

function renderDetail(id) {
  const drama = findDrama(id);
  if (!drama || (!isCatalogHydrated && !drama.sourceId)) {
    app.innerHTML = `
      <section class="detail-shell loading-detail">
        <div class="detail-backdrop skeleton-block" style="opacity: 0.15;"></div>
        <div style="grid-column: 1 / -1; grid-row: 1; z-index: 1;">
          <a class="back-pill" id="detailBackBtn" href="/" style="border: 1px solid rgba(255, 255, 255, 0.15); cursor: pointer; display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: inherit;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
            Kembali
          </a>
        </div>
        <div class="detail-poster skeleton-block"></div>
        <div class="detail-copy">
          <div class="skeleton-line short"></div>
          <div class="skeleton-line title"></div>
          <div class="skeleton-line"></div>
          <div class="skeleton-line wide"></div>
          <div class="button-row"><span class="skeleton-button"></span><span class="skeleton-button"></span></div>
        </div>
      </section>
      <section class="episodes-panel">
        <div class="section-head"><h2>Episodes</h2></div>
        ${loadingEpisodeGrid(40)}
      </section>
    `;
    return;
  }

  const cachedEpisodes = episodeCache.get(drama.id) || [];
  const activeEpisodeStart = activeDetailEpisodeStart();
  const isFav = !!localFavorites[drama.id];
  const favText = isFav ? "Favorit" : "Tambah Favorit";
  const favClass = isFav ? "glass-btn active" : "glass-btn";
  app.innerHTML = `
    <section class="detail-shell">
      <div class="detail-backdrop" style="background-image: url('${drama.backdrop || drama.poster}')"></div>
      <div style="grid-column: 1 / -1; grid-row: 1; z-index: 1;">
        <a class="back-pill" id="detailBackBtn" href="/" style="border: 1px solid rgba(255, 255, 255, 0.15); cursor: pointer; display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: inherit;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
          Kembali
        </a>
      </div>
      <div class="detail-poster">${posterVisual(drama, "poster")}${drama.vip ? "<span class='vip-corner'>VIP</span>" : ""}</div>
      <div class="detail-copy">
        <div class="meta-line gold"><span>${drama.platform}</span><span>${drama.episodes} Episode</span><span>${drama.country}</span><span>${drama.year}</span></div>
        <h1>${drama.title}</h1>
        <p class="genre">${drama.genre}</p>
        <p>${drama.synopsis}</p>
        <div class="button-row detail-actions">
          <a class="primary-btn gold-btn" href="/watch/${drama.id}">Watch Now</a>
          <button class="${favClass}" id="favBtn">${favText}</button>
          <button class="glass-btn" id="shareBtn">Share</button>
        </div>
      </div>
    </section>

    <section class="episodes-panel">
      <div class="section-head">
        <h2>Episodes</h2>
        <a href="/watch/${drama.id}">Continue Ep 4</a>
      </div>
      ${episodeTabsMarkup(drama, cachedEpisodes, activeEpisodeStart)}
      <div class="episode-grid" id="episodeGrid">${episodeLinks(drama, cachedEpisodes, 0, activeEpisodeStart).join("")}</div>
    </section>

    ${section(`Judul ${drama.platform} Lainnya`, catalogGrid(dramas.filter((item) => item.platform === drama.platform && item.id !== drama.id)))}
  `;



  const favBtn = document.querySelector("#favBtn");
  if (favBtn) {
    favBtn.addEventListener("click", async () => {
      await toggleFavoriteDrama(drama);
      const isNowFav = !!localFavorites[drama.id];
      favBtn.textContent = isNowFav ? "Favorit" : "Tambah Favorit";
      favBtn.className = isNowFav ? "glass-btn active" : "glass-btn";
    });
  }

  const shareBtn = document.querySelector("#shareBtn");
  if (shareBtn) {
    shareBtn.addEventListener("click", () => {
      if (navigator.share) {
        navigator.share({
          title: drama.title,
          text: drama.synopsis,
          url: window.location.href
        }).catch(() => {});
      } else {
        navigator.clipboard.writeText(window.location.href);
        alert("Link drama telah disalin ke clipboard!");
      }
    });
  }

  loadEpisodes(drama).then((items) => {
    const grid = document.querySelector("#episodeGrid");
    if (grid && findDrama(id).id === drama.id) {
      const start = activeDetailEpisodeStart();
      updateEpisodeTabs(drama, items, start);
      grid.innerHTML = episodeLinks(drama, items, 0, start).join("");
    }
  });
}

function renderPlayer(id) {
  if (sessionStorage.getItem("TEAMDLSecurityRefreshRequired") === "true") {
    app.innerHTML = securityDeniedMarkup("Session keamanan perlu divalidasi ulang. Silakan refresh halaman sebelum membuka episode lagi.");
    return;
  }

  const drama = findDrama(id);
  if (!drama || (!isCatalogHydrated && !drama.sourceId)) {
    app.innerHTML = `
      <section class="watch-page frivo-watch-page">
        <div class="watch-backdrop skeleton-block"></div>
        <div class="watch-container">
          <div class="watch-header">
            <span class="back-btn skeleton-muted">&larr;</span>
            <div class="watch-meta">
              <div class="skeleton-line title small-title"></div>
              <div class="skeleton-line short"></div>
            </div>
          </div>
          <div class="player-shell" id="playerShell">
            ${loadingVideoStage()}
          </div>
          <div class="floating-controls">
            <button class="float-btn skeleton" disabled>Ep</button>
            <button class="float-btn skeleton" disabled>CC</button>
          </div>
        </div>
      </section>
    `;
    return;
  }

  const params = new URLSearchParams(location.search);
  const episodeNumber = Math.max(1, Number(params.get("ep") || 1));
  addDramaToHistory(drama, episodeNumber);
  const cachedEpisodes = episodeCache.get(drama.id) || [];
  const activeEpisode = episodeByNumber(cachedEpisodes, episodeNumber);
  app.innerHTML = `
    <section class="watch-page frivo-watch-page">
      <div class="watch-backdrop" style="background-image: url('${drama.backdrop || drama.poster}')"></div>
      
      <div class="watch-container">
        <div class="watch-header">
          <a class="back-btn" href="/detail/${drama.id}" aria-label="Kembali">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
          </a>
          <div class="watch-meta">
            <h1>${drama.title}</h1>
            <p>${activeEpisode?.title || `Episode ${episodeNumber}`}</p>
          </div>
        </div>

        <div class="player-shell" id="playerShell">
          ${videoPlayer(drama, activeEpisode)}
        </div>

        <div class="floating-controls">
          <button class="float-btn" id="drawerToggleBtn" type="button" aria-label="Episodes">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"></rect><rect x="14" y="3" width="7" height="5"></rect><rect x="14" y="12" width="7" height="9"></rect><rect x="3" y="16" width="7" height="5"></rect></svg>
            <span>Ep</span>
          </button>

          ${subtitleControl(activeEpisode)}

          <button class="float-btn fullscreen-action" type="button" data-fullscreen aria-label="Fullscreen">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>
          </button>
        </div>

        <div class="episodes-drawer" id="episodesDrawer">
          <div class="drawer-overlay" id="drawerOverlay"></div>
          <div class="drawer-content">
            <div class="drawer-header">
              <h4>Daftar Episode</h4>
              <span class="total-badge">${cachedEpisodes.length || drama.episodes || "..."} total</span>
              <button class="close-drawer-btn" id="closeDrawerBtn">&times;</button>
            </div>
            <div class="episode-grid watch-episode-grid" id="episodeGrid">${episodeLinks(drama, cachedEpisodes, episodeNumber).join("")}</div>
          </div>
        </div>
      </div>
    </section>
  `;

  loadEpisodes(drama).then(async (items) => {
    try {
      const rawEpisode = episodeByNumber(items, episodeNumber) || { number: episodeNumber };
      const episode = await hydrateEpisodeVideo(drama, rawEpisode, episodeNumber);
      const player = document.querySelector("#playerShell");
      const grid = document.querySelector("#episodeGrid");
      const caption = document.querySelector("#subtitleControl");
      if (player) {
        cleanupVideoPlayer();
        player.outerHTML = videoPlayer(drama, episode);
        mountVideoPlayer();
        if (episode && episode.videoUrl) {
          mountWatchPlayer(drama, episode, episodeNumber, allSources, platformApi, secureFetch, selectedSubtitleLang);
        }
        if (episode?.locked && !episode.videoUrl) {
          setTimeout(() => showVipPrompt(String(episode.number)), 80);
        }
      }
      if (caption) {
        caption.outerHTML = subtitleControl(episode);
      }
      if (grid) {
        grid.innerHTML = episodeLinks(drama, items, episodeNumber).join("");
      }
      const total = document.querySelector(".drawer-header span.total-badge");
      if (total) {
        total.textContent = `${items.length} total`;
      }
    } catch (err) {
      console.error("[renderPlayer] Error hydrating/mounting player:", err);
      const player = document.querySelector("#playerShell");
      if (player) {
        cleanupVideoPlayer();
        player.outerHTML = videoPlayer(drama, { number: episodeNumber });
      }
    }
  }).catch((err) => {
    console.error("[renderPlayer] Failed to load episodes:", err);
    const player = document.querySelector("#playerShell");
    if (player) {
      cleanupVideoPlayer();
      player.outerHTML = videoPlayer(drama, { number: episodeNumber });
    }
  });

  mountVideoPlayer();
}

function renderSearch() {
  const params = new URLSearchParams(location.search);
  const initialQuery = params.get("q") || "";
  app.innerHTML = `
    <section class="page-section top-space">
      <h1>Cari Judul</h1>
      <div class="search-tools">
        <div class="search-box"><input id="searchInput" type="search" value="${escapeHtml(initialQuery)}" placeholder="Cari drama, platform, genre, bahasa"><button id="searchBtn">Cari</button></div>
        ${languageSegment("search-language")}
      </div>
      <div id="searchResults" class="catalog-grid">${!isCatalogHydrated ? loadingCatalogCards(8) : ""}</div>
    </section>
  `;
  const input = document.querySelector("#searchInput");
  const update = () => {
    if (!isCatalogHydrated) {
      document.querySelector("#searchResults").innerHTML = loadingCatalogCards(8);
      return;
    }
    const q = input.value.toLowerCase();
    const items = languageFilteredDramas(dramas).filter((drama) => `${drama.title} ${drama.platform} ${drama.genre} ${drama.language || ""} ${drama.country || ""}`.toLowerCase().includes(q));
    const resultsContainer = document.querySelector("#searchResults");
    if (!items.length) {
      resultsContainer.innerHTML = `<div class="empty-state">Belum ada judul untuk platform ini.</div>`;
    } else {
      resultsContainer.innerHTML = items.map(dramaCard).join("");
    }
  };
  input.addEventListener("input", update);
  document.querySelector("#searchBtn").addEventListener("click", update);
  update();
}

async function renderCatalog(platformSlug = "semua") {
  if (!isCatalogHydrated) {
    app.innerHTML = `
      ${loadingHero("catalog")}
      <section class="explore-panel">
        <p>EXPLORE</p>
        <h1>Temukan drama favoritmu</h1>
        <div class="platform-chips">${loadingChips(8)}</div>
        ${languageSegment("catalog-language")}
      </section>
      <section class="page-section">
        <div class="section-head"><h2>Semua Drama</h2></div>
        ${loadingCatalogGrid(18)}
      </section>
    `;
    return;
  }

  const platformNames = catalogPlatformNames();
  const activePlatform = platformSlug === "semua" ? null : platformNames.find((name) => slug(name) === platformSlug);
  const platformMode = activePlatform ? platformModes.get(slug(activePlatform)) : "active";
  if (activePlatform && platformMode && platformMode !== "active") {
    app.innerHTML = `
      <section class="page-section top-space">
        <div class="empty-state">
          <h1>${activePlatform}</h1>
          <p>Platform sedang ${platformMode}. Streaming sementara tidak bisa digunakan.</p>
          <a class="primary-btn" href="/platform">Lihat Platform Lain</a>
        </div>
      </section>
    `;
    return;
  }
  const platformItems = activePlatform ? dramas.filter((drama) => drama.platform === activePlatform) : dramas;
  const visibleDramas = languageFilteredDramas(platformItems);
  if (!visibleDramas.length) {
    app.innerHTML = `
      <section class="page-section top-space">
        <div class="empty-state">Belum ada judul untuk bahasa ini.</div>
      </section>
    `;
    return;
  }
  const hero = visibleDramas[0];
  if (!hero) {
    app.innerHTML = `
      <section class="page-section top-space">
        <div class="empty-state">Belum ada judul untuk platform ini.</div>
      </section>
    `;
    return;
  }
  app.innerHTML = `
    <section class="catalog-hero">
      <div class="catalog-hero-bg">${posterVisual(hero, "banner")}</div>
      <div class="catalog-hero-copy">
        <div class="meta-line"><span class="badge">${slug(hero.platform)}</span><span>${hero.episodes} Episodes</span></div>
        <h1>${shortTitle(hero.title, 22)}</h1>
        <div class="button-row">
          <a class="primary-btn" href="/watch/${hero.id}">Tonton Sekarang</a>
          <a class="glass-btn" href="/detail/${hero.id}">Detail Info</a>
        </div>
      </div>
      <div class="hero-dots"><i></i><i></i><i></i><i></i><i></i><i></i></div>
    </section>

    <section class="explore-panel">
      <p>EXPLORE</p>
      <h1>Temukan drama favoritmu</h1>
      <div class="platform-chips">
        <a class="${!activePlatform ? "active" : ""}" href="/platform">Semua (${dramas.length})</a>
        ${platformNames.map((name) => platformChip(name, activePlatform)).join("")}
        <a href="/moviebox" class="platform-chip-moviebox" style="background: linear-gradient(135deg, #e9a300, #ff7b00); color: #000 !important; font-weight: bold; border-radius: 20px; padding: 6px 14px; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 4px 10px rgba(255, 123, 0, 0.25);">🎬 MovieBox</a>
      </div>
      ${languageSegment("catalog-language")}
    </section>

    <section class="page-section">
      <div class="section-head">
        <div>
          <h2>${activePlatform || "Semua Drama"}</h2>
          <p class="muted">${activePlatform ? `Judul dari ${activePlatform}.` : "Campuran dari semua platform aktif."}</p>
        </div>
      </div>
      ${catalogGrid(visibleDramas)}
      <div id="catalogLoading" class="catalog-loading">MEMUAT LEBIH BANYAK...</div>
    </section>
  `;
}

function catalogPlatformNames() {
  return uniqueValues([
    ...allSources.map((source) => source.platform),
    ...platforms
  ]);
}

function activePlatformNames() {
  const visibleDramas = languageFilteredDramas(dramas);
  const platformsWithDramas = new Set(visibleDramas.map((d) => d.platform));
  const activeSources = allSources
    .filter((source) => source.status === "active" && platformsWithDramas.has(source.platform))
    .map((source) => source.platform);
  return uniqueValues(activeSources.length ? activeSources : [...platformsWithDramas]);
}

function platformChip(name, activePlatform) {
  const mode = platformModes.get(slug(name)) || "active";
  const playStatus = platformPlayability.get(slug(name)) || "unknown";
  const blocked = mode !== "active";
  const classes = [
    activePlatform === name ? "active" : "",
    blocked ? `platform-${mode}` : "",
    playStatus === "playable" ? "platform-playable" : playStatus !== "unknown" ? "platform-down" : ""
  ].filter(Boolean).join(" ");
  const statusLabel = blocked ? (playStatus && playStatus !== "playable" && playStatus !== "unknown" ? "DOWN" : mode === "off" ? "OFF" : "MNT") : "ON";
  const label = `<span class="platform-dot" aria-hidden="true"></span><span class="platform-status-label">${statusLabel}</span>`;
  return `<a class="${classes}" href="${blocked ? "#" : `/platform/${slug(name)}`}" ${blocked ? `data-platform-blocked="${mode}" aria-disabled="true"` : ""}>${name}${label}</a>`;
}

function renderNewTitlesPage() {
  if (!isCatalogHydrated) {
    app.innerHTML = `
      <section class="page-section top-space">
        <div class="section-head"><h2>Judul Baru</h2></div>
        ${loadingCatalogGrid(18)}
      </section>
    `;
    return;
  }

  const visible = sortedNewTitleItems(languageFilteredDramas(dramas));
  const grouped = groupNewTitlesByPlatform(visible);
  app.innerHTML = `
    <section class="page-section top-space">
      <div class="new-title-hero">
        <span class="badge">UPDATE PLATFORM</span>
        <h1>Judul Baru</h1>
        <p>Semua judul terbaru ditampilkan berurutan berdasarkan urutan upload/listing dari masing-masing platform.</p>
      </div>
      ${languageSegment("new-language")}
      ${visible.length ? `
        <div class="section-head new-title-head">
          <div>
            <h2>Semua Judul Baru</h2>
            <p class="muted">${visible.length} judul tersedia dari ${grouped.length} platform aktif.</p>
          </div>
        </div>
        ${grouped.map(([platform, items]) => `
          <section class="new-platform-section">
            <div class="section-head">
              <div>
                <h2>${escapeHtml(platform)}</h2>
                <p class="muted">${items.length} judul baru, mengikuti urutan upload/listing platform.</p>
              </div>
              <a href="/platform/${slug(platform)}">Lihat Platform</a>
            </div>
            ${catalogGrid(items)}
          </section>
        `).join("")}
      ` : `<div class="empty-state">Belum ada judul baru untuk filter bahasa ini.</div>`}
    </section>
  `;
}

function sortedNewTitleItems(items) {
  return [...items]
    .filter(isNewTitleCandidate)
    .sort((a, b) => {
      const platformCompare = String(a.platform || "").localeCompare(String(b.platform || ""));
      if (platformCompare !== 0) return platformCompare;
      const aOrder = Number.isFinite(Number(a.sourceOrder)) ? Number(a.sourceOrder) : 999999;
      const bOrder = Number.isFinite(Number(b.sourceOrder)) ? Number(b.sourceOrder) : 999999;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return Number(b.year || 0) - Number(a.year || 0) || String(a.title || "").localeCompare(String(b.title || ""));
    });
}

function groupNewTitlesByPlatform(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = item.platform || "Platform";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return [...groups.entries()];
}

function isNewTitleCandidate(item) {
  return !!item.sourceId || Number(item.year) >= 2025 || Number(item.progress) <= 12;
}

function renderVip() {
  const cachedFirestoreVip = JSON.parse(localStorage.getItem("TEAMDL_firestore_vip") || "null");
  const vip = firestoreUserDoc?.vip || cachedFirestoreVip || securitySession?.vip || { active: false, expiresAt: null, purchaseDate: null };
  const vipActive = vip.active && vip.expiresAt && new Date(vip.expiresAt) > new Date();
  if (typeof checkVipExpiryNotifications === "function") {
    checkVipExpiryNotifications(vip, vipActive);
  }

  const vipPlans = [
    { days: 7, price: 7000, label: "7 Hari", desc: "Cocok untuk coba-coba" },
    { days: 14, price: 14000, label: "14 Hari", desc: "Akses 2 minggu" },
    { days: 30, price: 30000, label: "30 Hari", desc: "Paket bulanan terpopuler", popular: true },
    { days: 60, price: 60000, label: "60 Hari", desc: "Hemat lebih banyak" },
    { days: 90, price: 90000, label: "90 Hari", desc: "Paket terlama & terhemat" }
  ];

  const formatRp = (n) => "Rp " + n.toLocaleString("id-ID");
  const formatDate = (d) => d ? new Date(d).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" }) : "-";

  let vipStatusHtml = "";
  if (vipActive) {
    const daysLeft = Math.max(0, Math.ceil((new Date(vip.expiresAt) - new Date()) / 86400000));
    vipStatusHtml = `
      <div class="vip-page-status active">
        <div class="vip-status-glow"></div>
        <div class="vip-page-status-icon">💎</div>
        <div class="vip-page-status-info">
          <span class="vip-page-badge active">VIP AKTIF</span>
          <p><b>Paket:</b> ${vip.planDays && vip.planDays !== "?" ? vip.planDays + " Hari" : "VIP Premium"}</p>
          <p><b>Berlaku hingga:</b> ${formatDate(vip.expiresAt)}</p>
          <p><b>Sisa:</b> ${daysLeft} hari lagi</p>
        </div>
      </div>
    `;
  } else {
    vipStatusHtml = `
      <div class="vip-page-status inactive">
        <div class="vip-page-status-icon">🔒</div>
        <div class="vip-page-status-info">
          <span class="vip-page-badge inactive">BELUM VIP</span>
          <p>Aktifkan VIP untuk membuka seluruh episode premium di semua drama.</p>
        </div>
      </div>
    `;
  }

  const planCardsHtml = vipPlans.map(p => `
    <button class="vip-plan-card${p.popular ? " popular" : ""}" data-vip-plan="${p.days}" data-vip-price="${p.price}">
      ${p.popular ? '<span class="vip-popular-tag">POPULER</span>' : ""}
      <strong>${p.label}</strong>
      <span class="vip-plan-price">${formatRp(p.price)}</span>
      <small>${p.desc}</small>
      <em>Rp 1.000 / hari</em>
    </button>
  `).join("");

  app.innerHTML = `
    <section class="vip-hero top-space" id="vipPage">
      <p class="badge" id="vipBadge">VIP ACCESS</p>
      <h1>Buka Semua Episode Premium</h1>
      <p class="vip-hero-subtitle">Akses drama VIP, episode terkunci, fitur lanjut nonton, dan prioritas update platform.</p>

      ${vipStatusHtml}

      <h2 class="vip-section-title">Pilih Paket VIP Regular</h2>
      <p class="vip-section-desc">Semua paket dihitung Rp 1.000 per hari. Pembayaran via QRIS.</p>

      <div class="vip-plans-grid" id="vipPlansGrid">
        ${planCardsHtml}
      </div>

      <div class="vip-features-section">
        <h3>Keuntungan VIP</h3>
        <div class="vip-features-grid">
          <div class="vip-feature-item"><span class="vip-feature-icon">🔓</span><strong>Buka Semua Episode</strong><p>Akses episode 13+ yang terkunci di semua drama.</p></div>
          <div class="vip-feature-item"><span class="vip-feature-icon">⚡</span><strong>Prioritas Server</strong><p>Streaming tanpa antrian, loading lebih cepat.</p></div>
          <div class="vip-feature-item"><span class="vip-feature-icon">🎬</span><strong>Akses Multi-Platform</strong><p>Tonton drama dari semua platform tanpa batas.</p></div>
          <div class="vip-feature-item"><span class="vip-feature-icon">💎</span><strong>Badge VIP Eksklusif</strong><p>Tampil beda dengan frame avatar dan badge VIP di profil.</p></div>
        </div>
      </div>
    </section>
  `;

  // QRIS Payment Modal (created as overlay, not in #app)
  document.querySelector("#vipQrisModal")?.remove();
  const qrisModal = document.createElement("div");
  qrisModal.id = "vipQrisModal";
  qrisModal.className = "vip-qris-modal";
  qrisModal.style.display = "none";
  qrisModal.innerHTML = `
    <div class="vip-qris-backdrop" data-close-qris></div>
    <div class="vip-qris-card">
      <button class="vip-qris-close" type="button" data-close-qris>&times;</button>
      <div class="vip-qris-header">
        <span class="vip-qris-badge">PEMBAYARAN QRIS</span>
        <h2 id="qrisTitle">VIP <span id="qrisPlanLabel"></span></h2>
        <p id="qrisPriceLabel" class="vip-qris-price"></p>
      </div>
      <div class="vip-qris-body">
        <div class="vip-qris-steps">
          <div class="vip-qris-step" id="qrisStep1">
            <div class="vip-step-number">1</div>
            <div class="vip-step-content">
              <strong>Scan & Bayar QRIS</strong>
              <p>Scan kode QR di bawah menggunakan aplikasi e-wallet atau mobile banking Anda.</p>
              <div class="vip-qris-image-wrapper">
                <img src="/assets/qris.png" alt="QRIS TeamDI" class="vip-qris-image" id="qrisImage" title="Klik untuk memperbesar" />
              </div>
              <p class="vip-qris-note">⚠️ Pastikan nominal transfer sesuai dengan harga paket yang dipilih.</p>
            </div>
          </div>
          <div class="vip-qris-step" id="qrisStep2">
            <div class="vip-step-number">2</div>
            <div class="vip-step-content">
              <strong>Upload Bukti Transfer</strong>
              <p>Setelah pembayaran berhasil, kirimkan screenshot bukti transfer Anda.</p>
              <div class="vip-upload-area" id="vipUploadArea">
                <input type="file" id="vipProofInput" accept="image/*" style="display:none" />
                <div class="vip-upload-placeholder" id="vipUploadPlaceholder">
                  <span class="vip-upload-icon">📸</span>
                  <p>Klik atau seret gambar bukti transfer ke sini</p>
                  <small>Format: JPG, PNG (Maks. 5MB)</small>
                </div>
                <div class="vip-upload-preview" id="vipUploadPreview" style="display:none">
                  <img id="vipPreviewImg" alt="Preview bukti" />
                  <button type="button" class="vip-remove-preview" id="vipRemovePreview">&times;</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <button class="primary-btn vip-submit-proof-btn" id="vipSubmitProof" disabled>
          📤 Kirim Bukti Pembayaran
        </button>
        <div class="vip-pending-state" id="vipPendingState" style="display:none">
          <div class="vip-pending-icon">⏳</div>
          <h3>Bukti Terkirim!</h3>
          <p>Bukti pembayaran Anda sedang diverifikasi oleh admin. Proses maksimal 1×24 jam.</p>
          <button class="glass-btn" type="button" data-close-qris>Tutup</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(qrisModal);

  // Event listeners
  let selectedPlanDays = 0;
  let selectedPlanPrice = 0;
  let proofFile = null;

  // Lightbox Zoom Event
  const qrisImage = document.getElementById("qrisImage");
  const openZoom = () => {
    const lightbox = document.createElement("div");
    lightbox.className = "vip-qris-lightbox";
    lightbox.innerHTML = `
      <div class="vip-qris-lightbox-backdrop"></div>
      <div class="vip-qris-lightbox-content">
        <button class="vip-qris-lightbox-close" type="button">&times;</button>
        <img src="/assets/qris.png" alt="QRIS TeamDI Zoomed" class="vip-qris-lightbox-img" />
        <p class="vip-qris-lightbox-caption">Scan dengan aplikasi pembayaran Anda</p>
      </div>
    `;
    document.body.appendChild(lightbox);
    const close = () => {
      lightbox.classList.add("fade-out");
      setTimeout(() => lightbox.remove(), 250);
    };
    lightbox.querySelector(".vip-qris-lightbox-backdrop").addEventListener("click", close);
    lightbox.querySelector(".vip-qris-lightbox-close").addEventListener("click", close);
  };
  qrisImage?.addEventListener("click", openZoom);

  // Plan selection
  document.querySelectorAll("[data-vip-plan]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      selectedPlanDays = Number(btn.dataset.vipPlan);
      selectedPlanPrice = Number(btn.dataset.vipPrice);
      document.getElementById("qrisPlanLabel").textContent = `${selectedPlanDays} Hari`;
      document.getElementById("qrisPriceLabel").textContent = formatRp(selectedPlanPrice);
      // Reset modal state
      document.getElementById("vipUploadPreview").style.display = "none";
      document.getElementById("vipUploadPlaceholder").style.display = "";
      document.getElementById("vipSubmitProof").disabled = true;
      document.getElementById("vipSubmitProof").style.display = "";
      document.getElementById("vipPendingState").style.display = "none";
      proofFile = null;
      qrisModal.style.display = "flex";
      document.body.style.overflow = "hidden";
    });
  });

  // Close modal
  document.querySelectorAll("[data-close-qris]").forEach(el => {
    el.addEventListener("click", () => {
      qrisModal.style.display = "none";
      document.body.style.overflow = "";
    });
  });

  // File upload
  const proofInput = document.getElementById("vipProofInput");
  const uploadArea = document.getElementById("vipUploadArea");
  const placeholder = document.getElementById("vipUploadPlaceholder");
  const previewWrap = document.getElementById("vipUploadPreview");
  const previewImg = document.getElementById("vipPreviewImg");
  const removeBtn = document.getElementById("vipRemovePreview");
  const submitBtn = document.getElementById("vipSubmitProof");

  uploadArea.addEventListener("click", (e) => {
    if (e.target.closest("#vipRemovePreview")) return;
    proofInput.click();
  });

  uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("dragover");
  });
  uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("dragover"));
  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("dragover");
    if (e.dataTransfer.files.length) handleProofFile(e.dataTransfer.files[0]);
  });

  proofInput.addEventListener("change", () => {
    if (proofInput.files.length) handleProofFile(proofInput.files[0]);
  });

  function handleProofFile(file) {
    if (!file.type.startsWith("image/")) return;
    if (file.size > 5 * 1024 * 1024) {
      alert("Ukuran file melebihi batas 5MB.");
      return;
    }
    proofFile = file;
    const reader = new FileReader();
    reader.onload = (e) => {
      previewImg.src = e.target.result;
      placeholder.style.display = "none";
      previewWrap.style.display = "flex";
      submitBtn.disabled = false;
    };
    reader.readAsDataURL(file);
  }

  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    proofFile = null;
    proofInput.value = "";
    previewWrap.style.display = "none";
    placeholder.style.display = "";
    submitBtn.disabled = true;
  });

  // Submit proof
  submitBtn.addEventListener("click", async () => {
    if (!proofFile || !selectedPlanDays) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "⏳ Mengirim...";

    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const base64 = e.target.result;
          const res = await fetch("/api/vip/upload-proof", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: userId,
              planDays: selectedPlanDays,
              price: selectedPlanPrice,
              image: base64
            })
          });
          const data = await res.json();
          if (data.ok) {
            submitBtn.style.display = "none";
            document.getElementById("vipPendingState").style.display = "";
            document.querySelector(".vip-qris-steps").style.display = "none";
            addLocalNotification(
              "proof_sent",
              "Bukti Pembayaran Terkirim",
              `Bukti transfer QRIS untuk paket VIP ${selectedPlanDays} Hari senilai ${formatRp(selectedPlanPrice)} telah berhasil diunggah dan sedang dalam proses verifikasi.`
            );
          } else {
            alert("Gagal mengirim bukti: " + (data.error || "Terjadi kesalahan"));
            submitBtn.disabled = false;
            submitBtn.textContent = "📤 Kirim Bukti Pembayaran";
          }
        } catch (err) {
          alert("Gagal mengirim bukti: " + err.message);
          submitBtn.disabled = false;
          submitBtn.textContent = "📤 Kirim Bukti Pembayaran";
        }
      };
      reader.readAsDataURL(proofFile);
    } catch (err) {
      alert("Gagal membaca file: " + err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = "📤 Kirim Bukti Pembayaran";
    }
  });
}

function section(title, content, href = "/platform") {
  return `<section class="rail-section"><div class="section-head"><h2>${title}</h2><a href="${href}">Lihat Semua</a></div>${content}</section>`;
}

function loadingHero(type = "home") {
  return `
    <section class="${type === "catalog" ? "catalog-hero" : "hero"} loading-hero">
      <div class="${type === "catalog" ? "catalog-hero-bg" : "hero-art"} skeleton-block"></div>
      <div class="${type === "catalog" ? "catalog-hero-copy" : "hero-copy"}">
        <div class="skeleton-line short"></div>
        <div class="skeleton-line hero-title"></div>
        <div class="skeleton-line wide"></div>
        <div class="skeleton-line"></div>
        <div class="button-row"><span class="skeleton-button"></span><span class="skeleton-button muted"></span></div>
      </div>
    </section>
  `;
}

function loadingPlatformRail(count = 12) {
  return `<div class="platform-rail">${Array.from({ length: count }, () => `
    <div class="platform-bubble loading-bubble">
      <span class="skeleton-block"></span>
      <small class="skeleton-text"></small>
    </div>
  `).join("")}</div>`;
}

function loadingCatalogGrid(count = 12) {
  return `<div class="catalog-grid">${loadingCatalogCards(count)}</div>`;
}

function loadingCatalogCards(count = 12) {
  return Array.from({ length: count }, () => `
    <div class="drama-card poster-card loading-card" aria-hidden="true">
      <div class="poster skeleton-block"></div>
      <strong class="skeleton-text"></strong>
      <small><span class="skeleton-text short"></span></small>
    </div>
  `).join("");
}

function loadingEpisodeGrid(count = 30, watch = false) {
  return `<div class="episode-grid ${watch ? "watch-episode-grid" : ""}">${Array.from({ length: count }, () => `<span class="episode skeleton skeleton-block"></span>`).join("")}</div>`;
}

function loadingVideoStage() {
  return `
    <div class="video-stage loading-video-stage" id="playerShell">
      <div class="skeleton-block"></div>
      <div class="player-center"><span class="play-pulse dot-loader" aria-label="Memuat"></span></div>
    </div>
  `;
}

function loadingChips(count = 8) {
  return Array.from({ length: count }, () => `<span class="skeleton-chip skeleton-block"></span>`).join("");
}

function platformScroller() {
  return `<div class="platform-rail">${activePlatformNames().map((name) => {
    const image = platformImages.get(name);
    return `<a href="/platform/${slug(name)}" class="platform-bubble platform-playable">${image ? `<span class="platform-image" style="${posterStyle(image)}"></span>` : `<span>${initials(name)}</span>`}<small><i></i>${name}</small></a>`;
  }).join("")}</div>`;
}

function catalogGrid(items) {
  if (!items.length) return `<div class="empty-state">Belum ada judul untuk platform ini.</div>`;
  return `<div class="catalog-grid">${items.map(dramaCard).join("")}</div>`;
}

function dramaRow(items) {
  return `<div class="poster-row">${items.map(dramaCard).join("")}</div>`;
}

function dramaCard(drama) {
  const lang = displayLanguage(drama);
  return `
    <a class="drama-card poster-card" href="/detail/${drama.id}">
      <div class="poster hero-${drama.tone}">
        ${posterVisual(drama, "poster")}
        <span class="platform-tag">${drama.platform}</span>
        ${lang ? `<span class="language-tag">${escapeHtml(lang)}</span>` : ""}
      </div>
      <strong>${drama.title}</strong>
      <small><span>${drama.episodes} episodes</span></small>
    </a>
  `;
}

function refreshLanguageMenu() {
  const menu = document.querySelector("#languageMenu");
  const label = document.querySelector("#languageLabel");
  const mobileLabel = document.querySelector("#mobileLanguageLabel");
  const langs = availableContentLanguages();
  const activeLabel = selectedContentLang === "all" ? "All" : selectedContentLang.toUpperCase();

  if (label) label.textContent = activeLabel;
  if (mobileLabel) mobileLabel.textContent = activeLabel;
  if (!menu) return;

  menu.innerHTML = [
    { lang: "all", label: "Semua" },
    ...langs.map((lang) => ({ lang, label: lang.toUpperCase() }))
  ].map((item) => `
    <button class="${item.lang === selectedContentLang ? "active" : ""}" type="button" data-content-lang="${escapeHtml(item.lang)}">
      ${escapeHtml(item.label)}${item.lang === selectedContentLang ? "<span>OK</span>" : ""}
    </button>
  `).join("");
}

function languageSegment(id) {
  const items = [
    { lang: "all", label: "Semua" },
    ...availableContentLanguages().map((lang) => ({ lang, label: lang.toUpperCase() }))
  ];
  return `
    <div class="language-segment" id="${id}">
      ${items.map((item) => `<button class="${item.lang === selectedContentLang ? "active" : ""}" type="button" data-content-lang="${escapeHtml(item.lang)}">${escapeHtml(item.label)}</button>`).join("")}
    </div>
  `;
}

function availableContentLanguages() {
  const preferred = ["id", "en", "th", "ko", "vi", "zh", "ja"];
  const found = new Set(dramas.map((drama) => drama.language).filter(Boolean));
  return [...preferred.filter((lang) => found.has(lang)), ...[...found].filter((lang) => !preferred.includes(lang)).sort()];
}

function languageFilteredDramas(items) {
  if (selectedContentLang === "all") {
    return items;
  }

  return items.filter((drama) => drama.language === selectedContentLang);
}

function displayLanguage(drama) {
  return drama.language ? drama.language.toUpperCase() : "";
}

function endpointPreview(source) {
  if (!source) return "";
  return `
    <h2 class="subhead">Endpoint Source</h2>
    <div class="endpoint-list">${source.endpoints.slice(0, 8).map(endpointCard).join("")}</div>
  `;
}

function endpointCard(endpoint) {
  return `
    <a class="endpoint-card" href="${endpoint.exampleUrl || endpoint.fullUrl || "#"}">
      <b>${endpoint.method || "GET"}</b>
      <strong>${endpoint.path || endpoint.fullUrl || "Endpoint"}</strong>
      <span>${endpoint.description || "Source endpoint"}</span>
    </a>
  `;
}

function episodeLinks(drama, items, activeNumber = 0, rangeStart = 0, rangeSize = 20) {
  const hasRange = Number(rangeStart) > 0;
  const start = hasRange ? Math.max(1, Number(rangeStart) || 1) : 1;
  const end = hasRange ? start + rangeSize - 1 : 80;
  if (items.length) {
    return items
      .filter((episode) => episode.number >= start && episode.number <= end)
      .map((episode) => {
      const locked = episode.locked;
      const active = episode.number === activeNumber;
      return `<a href="/watch/${drama.id}?ep=${episode.number}" class="episode ${active ? "active" : ""} ${locked ? "locked" : ""}" ${locked ? `data-episode="${episode.number}"` : ""}>${String(episode.number).padStart(2, "0")}${locked ? `<span class="lock-indicator"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></span>` : ""}</a>`;
    });
  }

  const total = drama.episodes || 12;
  const fallbackEnd = hasRange ? Math.min(end, total) : Math.min(total, 58);
  const count = Math.max(0, fallbackEnd - start + 1);
  return Array.from({ length: count }, (_, index) => {
    const n = start + index;
    return `<a href="/watch/${drama.id}?ep=${n}" class="episode skeleton">${String(n).padStart(2, "0")}</a>`;
  });
}

function episodeTabsMarkup(drama, items = [], activeStart = 1) {
  const total = Math.max(Number(drama.episodes) || 0, items.length || 0, 20);
  const ranges = [];
  for (let start = 1; start <= total; start += 20) {
    const end = Math.min(start + 19, total);
    ranges.push({ start, end });
  }
  return `<div class="episode-tabs" id="episodeTabs">${ranges.map(({ start, end }) => (
    `<button type="button" class="${start === activeStart ? "active" : ""}" data-episode-tab="${start}">${start}-${end}</button>`
  )).join("")}</div>`;
}

function activeDetailEpisodeStart() {
  const active = document.querySelector("#episodeTabs button.active");
  return Math.max(1, Number(active?.dataset.episodeTab || 1));
}

function updateEpisodeTabs(drama, items, activeStart) {
  const tabs = document.querySelector("#episodeTabs");
  if (tabs) {
    tabs.outerHTML = episodeTabsMarkup(drama, items, activeStart);
  }
}

function handleEpisodeTabs(event) {
  const tab = event.target.closest("[data-episode-tab]");
  if (!tab) {
    return;
  }

  event.preventDefault();
  const grid = document.querySelector("#episodeGrid");
  const detailId = location.pathname.startsWith("/detail/") ? location.pathname.split("/").pop() : "";
  const drama = detailId ? findDrama(detailId) : null;
  if (!grid || !drama) {
    return;
  }

  const start = Math.max(1, Number(tab.dataset.episodeTab || 1));
  tab.closest("#episodeTabs")?.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button === tab);
  });
  grid.innerHTML = episodeLinks(drama, episodeCache.get(drama.id) || [], 0, start).join("");
}

function videoPlayer(drama, episode) {
  if (episode?.videoUrl) {
    const cachedEpisodes = episodeCache.get(drama.id) || [];
    const totalEpisodes = cachedEpisodes.length || drama.episodes || 0;
    const nextEpisode = Number(episode.number) + 1;
    const hasNext = nextEpisode <= totalEpisodes;
    const nextUrl = hasNext ? `/watch/${drama.id}?ep=${nextEpisode}` : "";

    return `
      <div class="video-stage" id="playerShell">
        <video class="real-video" data-src="${escapeHtml(episode.videoUrl)}" data-subtitles="${escapeHtml(JSON.stringify(episode.subtitles || []))}" poster="${escapeHtml(drama.backdrop || drama.poster)}" data-next-url="${nextUrl}" playsinline preload="metadata" autoplay></video>
        <button class="player-fullscreen-back hide" id="fullscreenBackBtn" type="button" aria-label="Kembali">&larr;</button>
        <button class="player-play-toggle" id="playToggleBtn" type="button" data-play-toggle aria-label="Play/Pause"><span class="play-icon"></span></button>
        
        <div class="player-controls-bar hide" id="playerControlsBar">
          <div class="controls-left">
            <button class="control-btn" id="stopBtn" type="button" aria-label="Stop"><span class="stop-icon"></span></button>
            <button class="control-btn" id="playBtn" type="button" data-play-toggle aria-label="Play/Pause"><span class="play-icon"></span></button>
            <a class="control-btn ${nextUrl ? '' : 'disabled'}" id="nextBtn" href="${nextUrl || '#'}" aria-label="Next Episode"><span class="next-icon"></span></a>
          </div>
          <div class="controls-center">
            <div class="progress-container" id="progressContainer">
              <div class="progress-bar" id="progressBar"></div>
            </div>
          </div>
          <div class="controls-right">
            <span class="time-display" id="timeDisplay">0:00 / 0:00</span>
          </div>
        </div>

        <div class="subtitle-overlay" id="subtitleOverlay" aria-live="polite"></div>
        <div class="video-message" id="videoMessage"><span class="inline-dot-loader" aria-label="Memuat"></span></div>
      </div>
    `;
  }

  if (episode?.locked || episode?.accessDenied === "VIP_REQUIRED") {
    return `
      <div class="video-stage premium-locked hero-${drama.tone}" id="playerShell">
        ${posterVisual(drama, "banner")}
        <div class="video-overlay premium-lock-overlay">
          <div class="player-top"><a href="/detail/${drama.id}">Detail</a><button type="button" data-vip-open>VIP</button></div>
          <div class="premium-lock-copy">
            <span>VIP</span>
            <h2>Episode khusus VIP</h2>
            <p>Buka akses VIP untuk menonton episode premium ini.</p>
            <button class="primary-btn" type="button" data-vip-open>Beli VIP</button>
          </div>
        </div>
      </div>
    `;
  }

  if (episode && !episode.videoUrl) {
    return `
      <div class="video-stage hero-${drama.tone}" id="playerShell">
        ${posterVisual(drama, "banner")}
        <div class="video-overlay" style="background: linear-gradient(0deg, rgba(13, 19, 33, 0.95), rgba(13, 19, 33, 0.7)); display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 24px; z-index: 10;">
          <div class="player-top" style="position: absolute; top: 18px; left: 18px; right: 18px; display: flex; justify-content: space-between;"><a href="/detail/${drama.id}" style="color: #fff; text-decoration: none; font-weight: bold; display: flex; align-items: center; gap: 8px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg> Detail
          </a><button onclick="location.reload()" style="background: rgba(255,255,255,0.1); border: 0; color: #fff; border-radius: 20px; padding: 6px 14px; font-size: 12px; cursor: pointer; font-weight: bold;">Refresh</button></div>
          
          <div style="display: grid; justify-items: center; gap: 14px; max-width: 380px; margin: auto;">
            <span style="font-size: 40px;">⚠️</span>
            <h2 style="margin: 0; color: #fff; font-size: 20px; font-weight: 800;">Video Tidak Tersedia</h2>
            <p style="margin: 0; color: #94a3b8; font-size: 13px; line-height: 1.6;">Gagal memuat streaming video dari platform <b>${escapeHtml(drama.platform || "Upstream")}</b>. Token/kode server mungkin sudah kadaluwarsa atau diblokir.</p>
            <button onclick="location.reload()" style="margin-top: 8px; background: #ef4444; border: 0; color: #fff; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: background 0.2s;">Segarkan Halaman</button>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="video-stage hero-${drama.tone}" id="playerShell">
      ${posterVisual(drama, "banner")}
      <div class="video-overlay loading-player">
        <div class="player-top"><a href="/detail/${drama.id}">Detail</a><button>...</button></div>
        <div class="player-center"><button class="play-pulse dot-loader" type="button" aria-label="Memuat"></button></div>
      </div>
    </div>
  `;
}

function handlePlayerControls(event) {
  const drawerToggle = event.target.closest("#drawerToggleBtn");
  if (drawerToggle) {
    event.preventDefault();
    const drawer = document.querySelector("#episodesDrawer");
    if (drawer) drawer.classList.add("open");
    return;
  }

  const drawerClose = event.target.closest("#closeDrawerBtn") || event.target.closest("#drawerOverlay");
  if (drawerClose) {
    event.preventDefault();
    const drawer = document.querySelector("#episodesDrawer");
    if (drawer) drawer.classList.remove("open");
    return;
  }

  const captionToggle = event.target.closest("[data-subtitle-toggle]");
  if (captionToggle) {
    event.preventDefault();
    captionToggle.closest(".subtitle-control")?.classList.toggle("open");
    return;
  }

  const isMoviebox = location.pathname.startsWith("/moviebox") || location.pathname.startsWith("/watch-party");
  const subtitleOption = event.target.closest("[data-subtitle-lang]");
  if (subtitleOption) {
    event.preventDefault();
    if (location.pathname.startsWith("/watch-party/") && !watchPartyState?.isHost) {
      showWatchPartyToast("Subtitle hanya diatur host.");
      return;
    }
    if (subtitleOption.disabled) {
      return;
    }
    selectedSubtitleLang = subtitleOption.dataset.subtitleLang || "off";
    localStorage.setItem("TEAMDLSubtitleLang", selectedSubtitleLang);
    refreshSubtitleControls();
    const video = isMoviebox ? document.querySelector("video.moviebox-video-element") : document.querySelector("video.real-video");
    mountSubtitleOverlay(video);
    if (location.pathname.startsWith("/watch-party/") && watchPartyState?.isHost) {
      sendWatchPartyEvent("video:change_subtitle", { subtitle: selectedSubtitleLang });
    }
    return;
  }

  const playToggle = event.target.closest("[data-play-toggle]");
  if (playToggle) {
    if (location.pathname.startsWith("/watch-party/") && !watchPartyState?.isHost) {
      event.preventDefault();
      showWatchPartyToast("Kontrol video hanya untuk host.");
      return;
    }
    const video = isMoviebox ? document.querySelector("video.moviebox-video-element") : document.querySelector("video.real-video");
    if (video) {
      if (video.paused) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
      syncPlayButton(video);
    }
    return;
  }

  const fullscreen = event.target.closest("[data-fullscreen]");
  if (fullscreen) {
    event.preventDefault();
    enterPlayerFullscreen();
    return;
  }

  const vipOpen = event.target.closest("[data-vip-open]");
  if (vipOpen) {
    event.preventDefault();
    showVipPrompt("");
    return;
  }

  const vipClose = event.target.closest("[data-vip-close]");
  if (vipClose) {
    event.preventDefault();
    document.querySelector("#vipPrompt")?.remove();
    return;
  }

  const vipPrompt = event.target.closest(".vip-prompt");
  if (vipPrompt && event.target === vipPrompt) {
    vipPrompt.remove();
    return;
  }

  if (!event.target.closest(".subtitle-control")) {
    document.querySelectorAll(".subtitle-control.open").forEach((item) => item.classList.remove("open"));
  }
}

function subtitleControl(episode) {
  const subtitles = normalizeSubtitleOptions(episode?.subtitles || []);
  const active = subtitles.find((item) => item.lang === selectedSubtitleLang);
  const label = active?.lang.toUpperCase() || "Off";
  return `
    <div class="subtitle-control float-subtitle" id="subtitleControl">
      <button class="float-btn" type="button" data-subtitle-toggle aria-label="Subtitle">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        <span class="sub-badge">${escapeHtml(label)}</span>
      </button>
      <div class="subtitle-menu" role="menu">
        <button class="${selectedSubtitleLang === "off" ? "active" : ""}" type="button" data-subtitle-lang="off">Off${selectedSubtitleLang === "off" ? "<span>OK</span>" : ""}</button>
        ${subtitles.map((item) => `
          <button class="${item.lang === selectedSubtitleLang ? "active" : ""}" type="button" data-subtitle-lang="${escapeHtml(item.lang)}">${escapeHtml(item.lang.toUpperCase())}${item.lang === selectedSubtitleLang ? "<span>OK</span>" : ""}</button>
        `).join("")}
        ${subtitles.length ? "" : "<button type=\"button\" disabled>Subtitle belum tersedia</button>"}
      </div>
    </div>
  `;
}

function posterVisual(drama, mode) {
  const image = mode === "banner" ? drama.backdrop : drama.poster;
  return `<div class="visual visual-${mode}" style="${posterStyle(image)}"><span>${shortTitle(drama.title, mode === "poster" ? 26 : 36)}</span><i></i></div>`;
}

function findDrama(id) {
  if (!id) return null;
  const existing = dramas.find((item) => item.id === id || item.id?.toLowerCase() === id.toLowerCase());
  if (existing) {
    return existing;
  }

  const knownPlatforms = uniqueValues([
    ...allSources.map((source) => source.platform),
    ...platforms
  ]);
  const platform = knownPlatforms.find((item) => id?.startsWith(`${slug(item)}-`));
  if (platform) {
    const platformSlug = slug(platform);
    const sourceId = id.slice(platformSlug.length + 1);
    return {
      id,
      sourceId,
      title: `${platform} ${sourceId}`,
      platform,
      episodes: 0,
      genre: "Drama",
      country: "",
      language: platformLanguages.get(platform) || "id",
      year: "",
      vip: false,
      rating: "4.8",
      progress: 0,
      tone: "blue",
      poster: "",
      backdrop: "",
      synopsis: `Drama dari ${platform}.`
    };
  }

  return null;
}

async function loadEpisodes(drama) {
  if (episodeCache.has(drama.id)) {
    const cached = episodeCache.get(drama.id);
    console.log(`[loadEpisodes] Cache hit for ${drama.id}: ${cached.length} items`);
    return cached;
  }

  const config = platformApi[slug(drama.platform)];
  const source = allSources.find((item) => item.slug === slug(drama.platform));
  const serverEpisode = source?.episode;
  console.log(`[loadEpisodes] Drama: ${drama.id}, platform: ${drama.platform}, sourceId: ${drama.sourceId}`);
  console.log(`[loadEpisodes] config:`, config, `source:`, source?.slug, `serverEpisode:`, serverEpisode);
  const effectiveConfig = {
    ...(config || {}),
    idParam: serverEpisode?.idParam || config?.idParam,
    episodeField: serverEpisode?.episodeField || config?.episodeField || "videoUrl",
    stream: serverEpisode?.stream || config?.stream || null
  };
  if ((!serverEpisode && !config) || !drama.sourceId || !effectiveConfig.idParam) {
    console.warn(`[loadEpisodes] EARLY EXIT: serverEpisode=${!!serverEpisode}, config=${!!config}, sourceId=${drama.sourceId}, idParam=${effectiveConfig.idParam}`);
    const empty = [];
    episodeCache.set(drama.id, empty);
    return empty;
  }

  const proxyPath = serverEpisode?.path || (source ? endpointProxyPath(source, config.episodesEndpoint) : `/api/platform/${slug(drama.platform)}/endpoint/${config.episodesEndpoint}`);
  let url = `${proxyPath}?${effectiveConfig.idParam}=${encodeURIComponent(drama.sourceId)}`;
  const targetLang = selectedContentLang === "all" ? "id" : selectedContentLang;
  if (targetLang && source) {
    const platformLang = platformLanguageValue(source, targetLang);
    url += `&lang=${encodeURIComponent(platformLang)}`;
  }
  console.log(`[loadEpisodes] Fetching: ${url}`);
  const response = await secureFetch(url);
  console.log(`[loadEpisodes] Response status: ${response.status}`);
  if (!response.ok) {
    console.warn(`[loadEpisodes] API FAILED: status=${response.status}`);
    const empty = [];
    episodeCache.set(drama.id, empty);
    return empty;
  }

  const payload = await response.json();
  console.log(`[loadEpisodes] Payload keys:`, Object.keys(payload), `data.list?`, Array.isArray(payload?.data?.list) ? payload.data.list.length : "N/A");
  
  const totalEpisodes = Number(
    payload?.total_episodes
    || payload?.totalEpisodes
    || payload?.data?.total_episodes
    || payload?.data?.totalEpisodes
    || payload?.episodes
    || payload?.data?.episodes
    || 0
  );
  if (totalEpisodes > 0 && (!drama.episodes || drama.episodes < totalEpisodes)) {
    console.log(`[loadEpisodes] Updating drama episodes count to ${totalEpisodes}`);
    drama.episodes = totalEpisodes;
  }

  let items = normalizeEpisodes(payload, effectiveConfig);
  console.log(`[loadEpisodes] Normalized: ${items.length} episodes`);
  if (items.length && items.every(item => item.id === drama.sourceId)) {
    console.log(`[loadEpisodes] Items detected as drama detail itself, clearing items to force synthetic fallback.`);
    items = [];
  }
  if (!items.length && effectiveConfig.stream && drama.episodes) {
    items = createSyntheticEpisodes(drama.episodes);
  }
  episodeCache.set(drama.id, items);
  return items;
}

function normalizeEpisodes(payload, config) {
  const sourceItems = Array.isArray(payload?.ebeer)
    ? payload.ebeer
    : Array.isArray(payload?.dgiv?.ebeer)
      ? payload.dgiv.ebeer
      : Array.isArray(payload?.data?.list)
        ? payload.data.list
        : Array.isArray(payload?.data?.episodes)
          ? payload.data.episodes
          : Array.isArray(payload?.data?.chapters)
            ? payload.data.chapters
            : Array.isArray(payload?.list)
              ? payload.list
              : Array.isArray(payload?.episodes)
                ? payload.episodes
                : Array.isArray(payload?.chapters)
                  ? payload.chapters
                  : Array.isArray(payload?.videos)
                    ? payload.videos
                    : Array.isArray(payload?.data?.videos)
                      ? payload.data.videos
                      : Array.isArray(payload?.data?.payloads)
                        ? payload.data.payloads
                        : Array.isArray(payload?.data)
                          ? payload.data
                          : collectObjects(payload);
  return sourceItems
    .map((item, index) => {
      const videoUrl = resolveVideoUrl(item, config);

      const rawNumber = Number(textValue(item, [
        "episodeNo",
        "episodeNumber",
        "chapterNo",
        "chapterNum",
        "chapter_num",
        "chapter_no",
        "chapterIndex",
        "chapter_index",
        "episode",
        "seqNo",
        "seq_no",
        "ewheel",
        "ep",
        "order",
        "orderNumber",
        "serial_number",
        "episode_number",
        "episode_num",
        "episNum",
        "vid"
      ]));
      const number = Number.isFinite(rawNumber) && rawNumber > 0 ? rawNumber : index + 1;

      const episodeId = textValue(item, ["chapterId", "chapter_id", "episodeId", "episodeid", "episode_id", "id", "videoid", "videoId", "video_id", "episId", "vid", "Fwea", "Fite", "contentId", "eholi"]);
      const hasEpisodeContext = Boolean(
        rawNumber
        || episodeId
        || videoUrl
        || item.videoUrls
        || item.best_url
        || item.stream_url
        || item.streamUrl
        || item.cdn_url
        || item.m3u8_url
        || item.video_url
        || item.videoAddress
        || item.hls_url
        || item.play_url
        || item.h264
        || item.first_frame
        || item.duration
        || item.duration_ms
        || item.chapter_cover
        || item.chapter_title
        || item.chapter_id
        || item.chapter_num
        || item.is_lock
        || item.is_vip_episode
        || item.Bcold
        || item.Mopp
        || item.Bbar
        || item.Mmast
      );
      if (!hasEpisodeContext) {
        return null;
      }

      const lockValue = item.locked ?? item.lock ?? item.is_lock ?? item.isLock;
      const normalizedLock = String(lockValue ?? "").trim().toLowerCase();
      const priceValue = typeof item.price === "number" ? item.price : NaN;
      const isLocked = typeof lockValue === "boolean"
        ? lockValue
        : normalizedLock === "2" || normalizedLock === "vip" || normalizedLock === "locked" || normalizedLock === "true" || (!isNaN(priceValue) && priceValue > 0) || number > 12;

      return {
        id: episodeId || String(number),
        sourceId: episodeId || String(number),
        title: textValue(item, ["chapterName", "chapter_name", "chapterTitle", "chapter_title", "episodeName", "episodeTitle", "title", "name", "contentName"]) || `Episode ${number}`,
        number,
        locked: isLocked,
        videoUrl,
        streamParams: episodeStreamParams(item),
        subtitles: resolveSubtitles(item)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number);
}

function createSyntheticEpisodes(total) {
  return Array.from({ length: Math.min(Number(total) || 12, 80) }, (_, index) => ({
    id: String(index + 1),
    sourceId: String(index + 1),
    title: `Episode ${index + 1}`,
    number: index + 1,
    locked: index + 1 > 12,
    videoUrl: "",
    streamParams: {},
    subtitles: []
  }));
}

function episodeStreamParams(item) {
  const params = {};
  ["seasonId", "season_id", "videoId", "video_id", "chapterId", "chapter_id", "episodeId", "episode_id", "vid", "slug"].forEach((key) => {
    const value = textValue(item, [key]);
    if (value) {
      params[key] = value;
    }
  });
  if (item.id && !params.videoId && !params.episodeId) {
    params.videoId = String(item.id);
  }
  return params;
}

async function hydrateEpisodeVideo(drama, episode, episodeNumber) {
  if (!episode || episode.videoUrl || episode.locked) {
    return episode;
  }

  const source = allSources.find((item) => item.slug === slug(drama.platform));
  const stream = source?.episode?.stream || platformApi[slug(drama.platform)]?.stream;
  const idParam = stream?.idParam || source?.episode?.idParam;
  const episodeParam = stream?.episodeParam || "ep";
  const episodeValue = stream?.episodeMode === "sourceId"
    ? (episode.sourceId || episode.id || episodeNumber || episode.number || 1)
    : (episodeNumber || episode.number || episode.sourceId || 1);
  if (!stream?.path || !idParam || !drama.sourceId) {
    return episode;
  }

  const params = new URLSearchParams();
  params.set(idParam, drama.sourceId);
  params.set(episodeParam, String(episodeValue));
  if (selectedSubtitleLang && selectedSubtitleLang !== "off") {
    params.set("lang", selectedSubtitleLang);
  }
  Object.entries(episode.streamParams || {}).forEach(([key, value]) => {
    if (value && !params.has(key)) {
      params.set(key, value);
    }
  });

  const response = await secureFetch(`${stream.path}?${params.toString()}`);
  if (response.status === 403) {
    return { ...episode, accessDenied: "VIP_REQUIRED" };
  }
  if (!response.ok) {
    return episode;
  }

  const text = await response.text();
  const playlistUrl = hlsPlaylistObjectUrl(text);
  const payload = playlistUrl ? null : parseJson(text);
  const config = { episodeField: stream.episodeField || "videoUrl" };
  const videoUrl = playlistUrl || collectObjects(payload).map((item) => resolveVideoUrl(item, config)).find(Boolean) || "";
  if (!videoUrl) {
    return episode;
  }

  let parsedSubtitles = playlistUrl ? [] : collectObjects(payload).flatMap((item) => {
    const resolved = resolveSubtitles(item);
    const requestedLang = params.get("lang") || params.get("language") || "id";
    resolved.forEach((sub) => {
      if (sub.lang === "default") {
        sub.lang = requestedLang;
        sub.label = requestedLang.toUpperCase();
      }
    });
    return resolved;
  });

  const subtitleRoute = source?.routes?.["6"];
  if (slug(drama.platform) === "bilitv" && subtitleRoute) {
    const bilitvSubtitles = [
      { lang: "id", label: "Bahasa Indonesia", url: `${subtitleRoute}?id=${encodeURIComponent(drama.sourceId)}&ep=${encodeURIComponent(episodeValue)}&lang=id&format=vtt` },
      { lang: "en", label: "English", url: `${subtitleRoute}?id=${encodeURIComponent(drama.sourceId)}&ep=${encodeURIComponent(episodeValue)}&lang=en&format=vtt` }
    ];
    parsedSubtitles = [...parsedSubtitles, ...bilitvSubtitles];
  }

  const hydrated = {
    ...episode,
    videoUrl,
    subtitles: normalizeSubtitleOptions([...(episode.subtitles || []), ...parsedSubtitles])
  };
  const cached = episodeCache.get(drama.id) || [];
  episodeCache.set(drama.id, cached.map((item) => item.number === hydrated.number ? hydrated : item));
  return hydrated;
}

function resolveVideoUrl(item, config) {
  const direct = textValue(item, [
    config.episodeField,
    "videoUrl",
    "video_url",
    "videoURL",
    "video_hd",
    "videoHd",
    "video",
    "videoAddress",
    "video_address",
    "stream_url",
    "streamUrl",
    "cdn_url",
    "cdnUrl",
    "playUrl",
    "play_url",
    "hls_url",
    "hlsUrl",
    "m3u8_url",
    "m3u8_path",
    "m3u8",
    "external_audio_h264_m3u8",
    "external_audio_h265_m3u8",
    "best_url",
    "1080p_mp4",
    "720p_mp4",
    "540p_mp4",
    "mp4",
    "src",
    "mediaUrl",
    "media_url",
    "file_url",
    "downloadUrl",
    "h264",
    "h265",
    "h264Url",
    "h265Url",
    "Cvideo",
    "hs_path",
    "Bcold",
    "Mopp",
    "Bbar",
    "Mmast"
  ]);
  if (isPlayableMediaUrl(direct)) {
    return direct;
  }

  if (Array.isArray(item.videoUrls)) {
    const preferred = item.videoUrls.find((entry) => /hd|720|1080/i.test(`${entry.quality || ""} ${entry.name || ""}`))
      || item.videoUrls[0];
      const nestedUrl = textValue(preferred || {}, ["url", "videoUrl", "video_url", "cdn_url", "stream_url", "playUrl", "play_url", "m3u8_url", "m3u8", "mp4"]);
    if (isPlayableMediaUrl(nestedUrl)) {
      return nestedUrl;
    }
  }

  if (Array.isArray(item.videos)) {
    for (const entry of item.videos) {
      if (typeof entry === "string" && isPlayableMediaUrl(entry)) {
        return entry;
      }
      if (entry && typeof entry === "object") {
        const nestedUrl = textValue(entry, ["url", "videoUrl", "video_url", "cdn_url", "stream_url", "playUrl", "play_url", "m3u8_url", "m3u8", "mp4"]);
        if (isPlayableMediaUrl(nestedUrl)) {
          return nestedUrl;
        }
      }
    }
  }

  if (Array.isArray(item.streams)) {
    for (const entry of item.streams) {
      if (typeof entry === "string" && isPlayableMediaUrl(entry)) {
        return entry;
      }
      if (entry && typeof entry === "object") {
        const nestedUrl = textValue(entry, ["url", "videoUrl", "video_url", "cdn_url", "stream_url", "playUrl", "play_url", "m3u8_url", "m3u8", "mp4"]);
        if (isPlayableMediaUrl(nestedUrl)) {
          return nestedUrl;
        }
      }
    }
  }

  const qualityUrl = qualityObjectUrl(item.allQualities)
    || qualityObjectUrl(item.qualities)
    || qualityObjectUrl(item.streams)
    || qualityObjectUrl(item.urls);
  if (qualityUrl) {
    return qualityUrl;
  }

  const fallback = textValue(item, ["url"]);
  return isPlayableMediaUrl(fallback) ? fallback : "";
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hlsPlaylistObjectUrl(text) {
  if (!text || !text.trimStart().startsWith("#EXTM3U")) {
    return "";
  }

  const normalized = text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }
    return new URL(trimmed, location.origin).toString();
  }).join("\n");
  return URL.createObjectURL(new Blob([normalized], { type: "application/vnd.apple.mpegurl" }));
}

function qualityObjectUrl(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const entries = Object.entries(value)
    .map(([quality, url]) => ({ quality: Number(String(quality).replace(/\D/g, "")) || 0, url }))
    .filter((entry) => typeof entry.url === "string" && isPlayableMediaUrl(entry.url))
    .sort((a, b) => b.quality - a.quality);
  return entries[0]?.url || "";
}

function resolveSubtitles(item) {
  const rows = [
    ...arrayValue(item.subtitles),
    ...arrayValue(item.subtitle_list),
    ...arrayValue(item.subtitleList),
    ...arrayValue(item.captions),
    ...arrayValue(item.captionList)
  ];

  const directUrl = textValue(item, ["subtitle", "subtitleUrl", "caption", "captionUrl", "srt", "vtt", "subtitles"]);
  if (directUrl) {
    rows.push({ lang: textValue(item, ["subtitleLang", "captionLang", "lang", "language"]) || "default", url: directUrl });
  }

  return normalizeSubtitleOptions(rows
    .map((entry, index) => {
      if (typeof entry === "string") {
        return { lang: `sub${index + 1}`, label: `SUB ${index + 1}`, url: entry };
      }

      const url = textValue(entry, ["url", "subtitle", "subtitleUrl", "caption", "captionUrl", "srt", "vtt", "file"]);
      if (!url) {
        return null;
      }

      const lang = textValue(entry, ["lang", "language", "language_code", "code", "locale", "display_name", "name"]) || `sub${index + 1}`;
      const label = textValue(entry, ["display_name", "label", "name", "language", "lang"]) || lang;
      return { lang, label, url };
    })
    .filter(Boolean));
}

function normalizeSubtitleOptions(items) {
  const seen = new Set();
  return items
    .map((item) => ({
      lang: normalizeSubtitleLang(item.lang || item.label || "sub"),
      label: item.label || item.lang || "Subtitle",
      url: item.url
    }))
    .filter((item) => {
      if (!item.url || seen.has(item.lang)) {
        return false;
      }
      seen.add(item.lang);
      return true;
    })
    .sort((a, b) => subtitleSortScore(a.lang) - subtitleSortScore(b.lang) || a.lang.localeCompare(b.lang));
}

function normalizeSubtitleLang(value) {
  const text = String(value || "").trim().toLowerCase();
  const aliases = {
    bahasa: "id",
    indonesia: "id",
    indonesian: "id",
    inggris: "en",
    english: "en",
    thai: "th",
    thailand: "th",
    korean: "ko",
    korea: "ko",
    vietnamese: "vi",
    vietnam: "vi",
    chinese: "zh",
    mandarin: "zh",
    japanese: "ja",
    jepang: "ja"
  };
  const compact = text.replace(/[^a-z]/g, "");
  return aliases[compact] || text.replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 8) || "sub";
}

function normalizeContentLang(value) {
  const text = String(value || "").trim().toLowerCase();
  const map = {
    "11": "id",
    "6": "id",
    cn: "zh",
    zh: "zh",
    china: "zh",
    chinese: "zh",
    kr: "ko",
    ko: "ko",
    korea: "ko",
    korean: "ko",
    us: "en",
    uk: "en",
    en: "en",
    english: "en",
    jp: "ja",
    ja: "ja",
    japan: "ja",
    japanese: "ja",
    th: "th",
    thai: "th",
    thailand: "th",
    id: "id",
    in: "id",
    indonesia: "id",
    indonesian: "id",
    vi: "vi",
    vietnam: "vi",
    vietnamese: "vi"
  };
  if (map[text]) {
    return map[text];
  }
  const compact = text.replace(/[^a-z]/g, "");
  return map[compact] || compact.slice(0, 2);
}

function subtitleSortScore(lang) {
  const order = ["id", "en", "th", "ko", "vi", "zh", "ja"];
  const index = order.indexOf(lang);
  return index >= 0 ? index : 99;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function isPlayableMediaUrl(value) {
  if (!value) {
    return false;
  }

  if (/\.(srt|vtt)(?:$|[?&#])/i.test(value)) {
    return false;
  }

  return /\/api\/secure-media\/|\/api\/media\?|^https?:\/\/|^blob:/i.test(value);
}

function episodeByNumber(items, number) {
  return items.find((episode) => episode.number === number) || items[number - 1] || items[0] || null;
}

async function mountVideoPlayer() {
  const video = document.querySelector("video.real-video[data-src]");
  if (!video || video.dataset.mounted === "true") {
    return;
  }
  cleanupActivePlayer(video);

  const mountId = ++activeVideoMountId;
  video.dataset.mounted = "true";
  const src = video.dataset.src;
  const message = document.querySelector("#videoMessage");
  window.__TEAMDLVideoState = { src, mode: "starting", events: [] };
  mountSubtitleOverlay(video);

  const stage = document.querySelector("#playerShell");
  const backBtn = document.querySelector("#fullscreenBackBtn");
  const controlsBar = document.querySelector("#playerControlsBar");
  const progressBar = document.querySelector("#progressBar");
  const timeDisplay = document.querySelector("#timeDisplay");
  const progressContainer = document.querySelector("#progressContainer");
  const stopBtn = document.querySelector("#stopBtn");

  if (backBtn) {
    backBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      enterPlayerFullscreen();
    });
  }

  if (stage) {
    let controlsTimeout = null;

    const showControls = () => {
      if (backBtn) backBtn.classList.remove("hide");
      if (controlsBar) controlsBar.classList.remove("hide");
      if (controlsTimeout) clearTimeout(controlsTimeout);

      if (!video.paused) {
        controlsTimeout = setTimeout(() => {
          if (backBtn) backBtn.classList.add("hide");
          if (controlsBar) controlsBar.classList.add("hide");
        }, 4000);
      }
    };

    const showSeekIndicator = (labelText, side) => {
      let indicator = stage.querySelector(`.double-tap-indicator.${side}`);
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.className = `double-tap-indicator ${side}`;
        indicator.innerHTML = `
          <div class="double-tap-circle">
            <span class="double-tap-icon">${side === 'right' ? '&#9654;&#9654;' : '&#9664;&#9664;'}</span>
            <span class="double-tap-label">${labelText}</span>
          </div>
        `;
        stage.appendChild(indicator);
      } else {
        indicator.querySelector(".double-tap-label").textContent = labelText;
      }

      indicator.classList.remove("animate");
      void indicator.offsetWidth; // Force reflow
      indicator.classList.add("animate");
    };

    let clickTimeout = null;
    stage.addEventListener("click", (e) => {
      if (e.target.closest("#fullscreenBackBtn") || e.target.closest("#playerControlsBar") || e.target.closest("#playToggleBtn")) {
        return;
      }

      const now = Date.now();
      const delay = 300;
      if (video.dataset.lastClick && (now - Number(video.dataset.lastClick)) < delay) {
        if (clickTimeout) {
          clearTimeout(clickTimeout);
          clickTimeout = null;
        }

        const rect = stage.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const halfWidth = rect.width / 2;

        if (clickX > halfWidth) {
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
          showSeekIndicator("+10s", "right");
        } else {
          video.currentTime = Math.max(0, video.currentTime - 10);
          showSeekIndicator("-10s", "left");
        }
        video.dataset.lastClick = "0";
        showControls();
      } else {
        video.dataset.lastClick = String(now);
        clickTimeout = setTimeout(() => {
          if (video.paused) {
            video.play().catch(() => {});
          } else {
            video.pause();
          }
          syncPlayButton(video);
          showControls();
          clickTimeout = null;
        }, delay);
      }
    });

    stage.addEventListener("mousemove", () => {
      showControls();
    });

    document.addEventListener("fullscreenchange", () => {
      showControls();
    });

    // Stop Button handling
    if (stopBtn) {
      stopBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        video.pause();
        video.currentTime = 0;
        syncPlayButton(video);
        updateTimeDisplay(0, video.duration);
        showControls();
      });
    }

    // Progress Bar Seeking handling
    if (progressContainer) {
      progressContainer.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = progressContainer.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const width = rect.width;
        if (width > 0 && video.duration > 0) {
          const percent = clickX / width;
          video.currentTime = percent * video.duration;
          updateTimeDisplay(video.currentTime, video.duration);
        }
      });
    }

    const formatTime = (seconds) => {
      if (isNaN(seconds) || seconds === Infinity) return "0:00";
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
    };

    const updateTimeDisplay = (currentTime, duration) => {
      if (timeDisplay) {
        timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
      }
      if (progressBar && duration > 0) {
        const percent = (currentTime / duration) * 100;
        progressBar.style.width = `${percent}%`;
      }
    };

    video.addEventListener("timeupdate", () => {
      updateTimeDisplay(video.currentTime, video.duration);
    });

    video.addEventListener("durationchange", () => {
      updateTimeDisplay(video.currentTime, video.duration);
    });

    video.addEventListener("loadedmetadata", () => {
      updateTimeDisplay(video.currentTime, video.duration);
    });

    video.addEventListener("play", () => {
      showControls();
    });

    video.addEventListener("pause", () => {
      if (backBtn) backBtn.classList.remove("hide");
      if (controlsBar) controlsBar.classList.remove("hide");
      if (controlsTimeout) clearTimeout(controlsTimeout);
    });

    // Initial show
    showControls();
  }
  const clearLoadingMessage = () => {
    if (message) {
      message.innerHTML = "";
      message.style.display = "none";
    }
  };
  const loadingTimer = setTimeout(() => {
    if (isCurrentVideoMount(video, mountId) && video.readyState < 2) {
      showVideoMessage("Video belum bisa diputar dari sumber platform ini. Coba episode lain atau cek ulang platform di Admin.");
    }
  }, 15000);
  const clearLoadingTimer = () => clearTimeout(loadingTimer);
  const handleVideoReady = () => {
    clearLoadingTimer();
    clearLoadingMessage();
  };
  video.addEventListener("loadedmetadata", handleVideoReady, { once: true });
  video.addEventListener("canplay", handleVideoReady, { once: true });
  video.addEventListener("playing", handleVideoReady, { once: true });
  video.addEventListener("error", clearLoadingTimer, { once: true });
  let lastUpdateTime = Date.now();
  const handleTimeUpdate = () => {
    if (video.paused || video.ended || document.visibilityState !== "visible") {
      lastUpdateTime = Date.now();
      return;
    }
    const now = Date.now();
    const elapsedMs = now - lastUpdateTime;
    if (elapsedMs > 0 && elapsedMs < 5000) {
      accumulateWatchTime(elapsedMs / 1000);
    }
    lastUpdateTime = now;
  };

  video.addEventListener("timeupdate", handleTimeUpdate);
  video.addEventListener("play", () => {
    syncPlayButton(video);
    lastUpdateTime = Date.now();
  });
  video.addEventListener("pause", () => {
    syncPlayButton(video);
    lastUpdateTime = Date.now();
    forceSyncWatchTime();
  });
  video.addEventListener("ended", () => {
    handleVideoEnded();
    forceSyncWatchTime();
  });
  syncPlayButton(video);
}

function cleanupVideoPlayer() {
  activeVideoMountId += 1;
  document.querySelector("#playerShell")?.classList.remove("player-fullscreen");
  document.body.classList.remove("player-fullscreen-active");
  cleanupActivePlayer();

  // Pause and stop all video/audio playback in the document to prevent background audio leaks
  document.querySelectorAll("video, audio").forEach((media) => {
    try {
      media.pause();
      media.removeAttribute("src");
      media.load();
    } catch (e) {
      console.warn("Failed to stop media element during cleanup:", e);
    }
  });

  if (watchPartySocket) {
    watchPartyReconnectPaused = true;
    watchPartySocket.close();
    watchPartySocket = null;
  }
  if (watchPartyVoiceStream) {
    watchPartyVoiceStream.getTracks().forEach((track) => track.stop());
    watchPartyVoiceStream = null;
  }
  closeWatchPartyPeers();
  watchPartyState = null;

  if (window.__TEAMDLHls) {
    window.__TEAMDLHls.destroy();
    window.__TEAMDLHls = null;
  }

  document.querySelectorAll("video.real-video, video.moviebox-video-element").forEach((video) => {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.dataset.mounted = "false";
  });
}

function isCurrentVideoMount(video, mountId) {
  return activeVideoMountId === mountId && document.contains(video);
}

async function mountSubtitleOverlay(video) {
  const overlay = document.querySelector("#subtitleOverlay");
  if (!video || !overlay) {
    return;
  }

  const subtitles = normalizeSubtitleOptions(JSON.parse(video.dataset.subtitles || "[]"));
  if (selectedSubtitleLang !== "off" && !subtitles.some((item) => item.lang === selectedSubtitleLang)) {
    selectedSubtitleLang = subtitles[0]?.lang || "off";
    localStorage.setItem("TEAMDLSubtitleLang", selectedSubtitleLang);
    refreshSubtitleControls();
  }

  video.textTracks && [...video.textTracks].forEach((track) => {
    track.mode = "disabled";
  });

  overlay.textContent = "";
  delete overlay.dataset.ready;
  video.ontimeupdate = null;

  const active = subtitles.find((item) => item.lang === selectedSubtitleLang);
  if (!active) {
    return;
  }

  try {
    const response = await secureFetch(active.url);
    if (!response.ok) {
      return;
    }
    const cues = parseSubtitleText(await response.text());
    overlay.dataset.ready = "true";
    video.ontimeupdate = () => {
      const cue = cues.find((item) => video.currentTime >= item.start && video.currentTime <= item.end);
      overlay.innerHTML = cue ? escapeHtml(cue.text).replace(/\n/g, "<br>") : "";
    };
    video.dispatchEvent(new Event("timeupdate"));
  } catch {
    overlay.textContent = "";
  }
}

function parseSubtitleText(text) {
  const normalized = text
    .replace(/^\uFEFF/, "")
    .replace(/^WEBVTT[^\n]*(?:\n|\r\n)/i, "")
    .replace(/\r/g, "");

  return normalized.split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const timeIndex = lines.findIndex((line) => line.includes("-->"));
      if (timeIndex < 0) {
        return null;
      }

      const [start, end] = lines[timeIndex].split("-->").map((value) => subtitleTime(value.trim()));
      const cueText = lines.slice(timeIndex + 1)
        .join("\n")
        .replace(/<[^>]+>/g, "")
        .trim();
      if (!Number.isFinite(start) || !Number.isFinite(end) || !cueText) {
        return null;
      }

      return { start, end, text: cueText };
    })
    .filter(Boolean);
}

function subtitleTime(value) {
  const clean = value.split(/\s+/)[0].replace(",", ".");
  const parts = clean.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) {
    return NaN;
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  return Number(clean);
}

function refreshSubtitleControls() {
  const current = document.querySelector("#subtitleControl");
  const isMoviebox = location.pathname.startsWith("/moviebox") || location.pathname.startsWith("/watch-party");
  const video = isMoviebox ? document.querySelector("video.moviebox-video-element") : document.querySelector("video.real-video");
  if (!current || !video) {
    return;
  }

  const subtitles = normalizeSubtitleOptions(JSON.parse(video.dataset.subtitles || "[]"));
  current.outerHTML = isMoviebox ? movieboxSubtitleControl(subtitles) : subtitleControl({ subtitles });
}

function syncPlayButton(video) {
  const buttons = document.querySelectorAll("[data-play-toggle]");
  if (!buttons.length || !video) {
    return;
  }

  buttons.forEach((button) => {
    button.classList.toggle("playing", !video.paused);
    button.innerHTML = video.paused ? "<span class=\"play-icon\"></span>" : "<span class=\"pause-icon\"></span>";
  });
}

async function enterPlayerFullscreen() {
  const isMoviebox = location.pathname.startsWith("/moviebox") || location.pathname.startsWith("/watch-party");
  const video = isMoviebox ? document.querySelector("video.moviebox-video-element") : document.querySelector("video.real-video");
  const stage = document.querySelector("#playerShell");
  const target = stage || video;

  if (document.fullscreenElement || document.webkitFullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
    document.webkitExitFullscreen?.();
    stage?.classList.remove("player-fullscreen");
    document.body.classList.remove("player-fullscreen-active");
    return;
  }

  if (stage?.classList.contains("player-fullscreen")) {
    stage.classList.remove("player-fullscreen");
    document.body.classList.remove("player-fullscreen-active");
    return;
  }

  if (video?.webkitEnterFullscreen) {
    video.webkitEnterFullscreen();
    return;
  }

  if (target?.requestFullscreen) {
    try {
      await target.requestFullscreen();
      return;
    } catch {
      stage?.classList.add("player-fullscreen");
      document.body.classList.add("player-fullscreen-active");
      return;
    }
  }

  if (target?.webkitRequestFullscreen) {
    try {
      target.webkitRequestFullscreen();
      return;
    } catch {
      stage?.classList.add("player-fullscreen");
      document.body.classList.add("player-fullscreen-active");
      return;
    }
  }

  if (stage) {
    stage.classList.add("player-fullscreen");
    document.body.classList.add("player-fullscreen-active");
    return;
  }
}

function handleVideoEnded() {
  const currentId = location.pathname.startsWith("/watch/") ? location.pathname.split("/").pop() : "";
  if (!currentId) {
    return;
  }

  const drama = findDrama(currentId);
  const currentEpisode = Math.max(1, Number(new URLSearchParams(location.search).get("ep") || 1));
  const episodes = episodeCache.get(drama.id) || [];
  const next = episodes.find((episode) => episode.number > currentEpisode);
  if (!next) {
    return;
  }

  if (next.locked) {
    showVipPrompt(String(next.number));
    return;
  }

  history.pushState({}, "", `/watch/${drama.id}?ep=${next.number}`);
  renderRoute();
}

function showVipPrompt(episodeNumber) {
  document.querySelector("#vipPrompt")?.remove();
  const modal = document.createElement("div");
  modal.className = "vip-prompt";
  modal.id = "vipPrompt";
  modal.innerHTML = `
    <section class="vip-prompt-card" role="dialog" aria-modal="true" aria-labelledby="vipPromptTitle">
      <button class="vip-prompt-close" type="button" data-vip-close aria-label="Tutup">x</button>
      <span>VIP</span>
      <h2 id="vipPromptTitle">${episodeNumber ? `Episode ${escapeHtml(episodeNumber)} khusus VIP` : "Video khusus VIP"}</h2>
      <p>Episode ini hanya bisa ditonton oleh pengguna VIP. Beli VIP untuk membuka semua episode premium.</p>
      <div class="vip-prompt-actions">
        <a class="primary-btn" href="/vip">Beli VIP</a>
        <button class="glass-btn" type="button" data-vip-close>Nanti</button>
      </div>
    </section>
  `;
  document.body.appendChild(modal);
}

function pushVideoEvent(value) {
  if (!window.__TEAMDLVideoState) {
    return;
  }

  window.__TEAMDLVideoState.events.push(value);
  window.__TEAMDLVideoState.events = window.__TEAMDLVideoState.events.slice(-12);
}

async function detectHls(src) {
  if (/\/api\/secure-media\//i.test(src) && /[?&]kind=hls(?:&|$)/i.test(src)) {
    return true;
  }

  if (/\.m3u8(?:$|[?&#])/i.test(src)) {
    return true;
  }

  const response = await fetch(src, {
    method: "HEAD",
    headers: { Accept: "application/vnd.apple.mpegurl,video/mp4,*/*" }
  }).catch(() => null);
  if (!response) {
    return false;
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("mpegurl")) {
    return true;
  }

  if (/^video\//i.test(contentType) || contentType.includes("mp4")) {
    return false;
  }

  const length = Number(response.headers.get("content-length") || 0);
  if (length > 1024 * 1024) {
    return false;
  }

  const probe = await fetch(src, {
    headers: {
      Accept: "application/vnd.apple.mpegurl,text/plain,*/*",
      Range: "bytes=0-2047"
    }
  }).catch(() => null);
  if (!probe) {
    return false;
  }

  const text = await probe.text();
  return text.slice(0, 2048).trimStart().startsWith("#EXTM3U");
}

function showVideoMessage(text) {
  const message = document.querySelector("#videoMessage");
  if (message) {
    message.textContent = text;
  }
}

function transmuxUrl(src) {
  const url = new URL(src, location.href);
  const upstream = url.pathname === "/api/media" ? url.searchParams.get("url") : url.toString();
  return `/api/transmux?url=${encodeURIComponent(upstream)}`;
}

function setActiveNav(path) {
  const key = path.startsWith("/moviebox") ? "moviebox" : path.startsWith("/search") ? "search" : path === "/new" ? "new" : path.startsWith("/platform") ? "platform" : path.startsWith("/vip") ? "vip" : (path.startsWith("/profile") || path === "/history" || path === "/favorites") ? "profile" : "home";
  document.querySelectorAll("[data-nav]").forEach((item) => item.classList.toggle("active", item.dataset.nav === key));
}

function initials(value) {
  return value.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase();
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function shortTitle(value, max) {
  return value.length > max ? `${value.slice(0, max).trim()}...` : value;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function platformLanguageValue(source, targetLang) {
  const endpoints = source.endpoints || [];
  let defaultValue = "";
  for (const ep of endpoints) {
    const p = (ep.params || []).find((param) => /(^|[-_])lang(uage)?$/i.test(param.name));
    if (p && p.defaultValue) {
      defaultValue = p.defaultValue;
      break;
    }
  }

  if (!defaultValue) {
    return targetLang;
  }

  if (targetLang === "id") {
    const normalized = normalizeContentLang(defaultValue);
    if (normalized === "id") {
      return defaultValue;
    }
    const slugName = slug(source.platform || "");
    if (["dramabox", "goodshort", "netshort", "shortswave", "reelife", "dramawave"].includes(slugName)) {
      return "in";
    }
    if (slugName === "flickreels") {
      return "6";
    }
    if (slugName === "moboreels") {
      return "11";
    }
    return "id";
  }

  if (targetLang === "en") {
    const normalized = normalizeContentLang(defaultValue);
    if (normalized === "en") {
      return defaultValue;
    }
    const slugName = slug(source.platform || "");
    if (["dramabox", "goodshort", "netshort", "shortswave", "reelife", "dramawave"].includes(slugName)) {
      return "en";
    }
    return "en";
  }

  return targetLang;
}

async function loadApiCatalog() {
  const sources = await fetch(`/api/platforms?t=${Date.now()}`, { cache: "no-store" }).then((response) => response.json()).catch(() => []);
  allSources = sources;
  platformModes.clear();
  platformPlayability.clear();
  platformLanguages.clear();
  sources.forEach((source) => {
    platformModes.set(source.slug, source.status);
    platformPlayability.set(source.slug, source.playabilityStatus || "unknown");
    platformLanguages.set(source.platform, sourceLanguage(source));
    catalogPages.set(source.slug, 1);
    hasMoreCatalog.set(source.slug, true);
  });
  catalogPages.set("semua", 1);
  hasMoreCatalog.set("semua", true);
  const catalogSources = sources
    .filter((source) => source.status === "active" && Number(source.endpointCount || source.endpoints?.length || 0) > 0)
    .map((source) => ({ source, endpointIndex: selectCatalogEndpointIndex(source) }))
    .filter((item) => item.endpointIndex > 0);

  platforms = uniqueValues(sources.length ? sources.map((source) => source.platform) : platforms);

  const activeSources = sources.filter((source) => source.status === "active");

  // 1. Initialize immediately with fallback dramas to wow the user with instant load speed
  dramas = ensurePlatformCardCoverage([], activeSources);
  isCatalogHydrated = true;
  platformImages.clear();
  for (const drama of dramas) {
    if (!platformImages.has(drama.platform) && drama.poster) {
      platformImages.set(drama.platform, drama.poster);
    }
  }
  renderRoute();

  // 2. Fetch catalogs incrementally and asynchronously in the background
  catalogSources.forEach(async ({ source, endpointIndex }, i) => {
    setTimeout(async () => {
      try {
        let url = endpointProxyPath(source, endpointIndex);
        if (selectedContentLang !== "all") {
          const platformLang = platformLanguageValue(source, selectedContentLang);
          url += `${url.includes("?") ? "&" : "?"}lang=${encodeURIComponent(platformLang)}`;
        }
        const response = await secureFetchWithTimeout(url);
        if (!response.ok) {
          return;
        }
        const newItems = normalizeApiItems(source.platform, await response.json(), selectedContentLang);
        if (newItems.length > 0) {
          // Keep non-mock dramas from other platforms and any non-mock dramas from this platform
          const otherDramas = dramas.filter((d) => d.platform !== source.platform || !isFallbackDrama(d));
          const merged = dedupeDramas([...otherDramas, ...newItems]);
          
          dramas = ensurePlatformCardCoverage(merged, activeSources);
          
          const firstReal = newItems.find((d) => d.poster && !d.posterIsGenerated);
          if (firstReal) {
            platformImages.set(source.platform, firstReal.poster);
          }
          renderRoute();
          hydrateMissingPosterDetails(newItems).catch((error) => console.warn("Detail poster hydrate failed", error));
        }
      } catch (error) {
        console.warn(`[loadApiCatalog] Failed to load catalog for ${source.platform}:`, error);
      }
    }, i * 200);
  });

  checkAndShowMaintenanceNotification();
}

function selectCatalogEndpointIndex(source) {
  if (Number(source.catalogEndpointIndex) > 0) {
    return Number(source.catalogEndpointIndex);
  }

  const priorities = [
    /\/module$/i,
    /\/home(?:page)?(?:\/\d+)?$/i,
    /\/foryou$/i,
    /\/popular$/i,
    /\/new$/i,
    /\/browse$/i,
    /\/rank$/i,
    /\/dramas$/i,
    /\/list$/i,
    /\/list\/\d+$/i,
    /\/recommend$/i,
    /\/recommended$/i,
    /\/latest$/i,
    /\/hot$/i,
    /\/trending$/i,
    /\/dubbed$/i,
    /\/anime$/i,
    /\/category$/i,
    /\/series$/i,
    /\/search$/i
  ];
  const blocked = /detail|episode|video|play|rawurl|batchload|chapters|language|languages|nav/i;
  const endpoints = source.endpoints || [];

  for (const pattern of priorities) {
    const index = endpoints.findIndex((endpoint) => pattern.test(endpoint.path) && !blocked.test(endpoint.path));
    if (index >= 0) {
      return index + 1;
    }
  }

  const fallbackIndex = endpoints.findIndex((endpoint) => !blocked.test(endpoint.path));
  return fallbackIndex >= 0 ? fallbackIndex + 1 : 0;
}

function normalizeApiItems(platform, payload, requestLang = "all") {
  const objects = collectObjects(payload);
  return objects
    .map((item, index) => {
      const nestedInfo = item.redirectConfig?.videoInfo || item.videoInfo || item.program || item.drama || item.series || item.book || item.extra || {};
      const title = textValue(item, ["bookName", "bookTitle", "book_title", "title", "name", "dramaName", "videoName", "albumName", "seriesName", "shortPlayName", "short_play_name", "displayName", "contentName", "content_name", "dramaTitle", "nseri", "nfreed", "dentra", "sgui", "label"])
        || textValue(nestedInfo, ["bookName", "bookTitle", "book_title", "title", "name", "dramaName", "videoName", "albumName", "seriesName", "shortPlayName", "short_play_name", "displayName", "contentName", "content_name", "dramaTitle", "nseri", "nfreed", "dentra", "sgui", "label"])
        || shortTitle(textValue(item, ["introduction", "intro", "introduce", "description", "summary", "synopsis", "desc", "dwill", "dtas"]) || "", 42);
      const rawPoster = textValue(item, ["cover", "image", "poster", "thumb", "thumbnail", "bookCover", "coverUrl", "imgUrl", "bannerImg", "bannerImgUrl", "cover_url", "cover_img", "compress_cover_url", "big_cover", "pic", "imageUrl", "posterUrl", "poster_url", "verticalCover", "coverImage", "posterImg", "posterImgUrl", "coverWap", "contentCoverUrl", "pday", "puse"])
        || textValue(nestedInfo, ["cover", "image", "poster", "thumb", "thumbnail", "bookCover", "coverUrl", "imgUrl", "bannerImg", "bannerImgUrl", "cover_url", "cover_img", "compress_cover_url", "big_cover", "pic", "imageUrl", "posterUrl", "poster_url", "verticalCover", "coverImage", "posterImg", "posterImgUrl", "coverWap", "contentCoverUrl", "pday", "puse"]);
      if (!title) {
        return null;
      }
      const poster = rawPoster || generatedPosterDataUri(platform, title, index);

      const id = textValue(item, [platformSourceIdField(platform), "bookId", "book_id", "id", "videoid", "videoId", "video_id", "dramaId", "drama_id", "drama_intid", "seasonId", "season_id", "programId", "program_id", "playlet_id", "collection_id", "seriesId", "cid", "action", "shortPlayId", "shortPlayLibraryId", "albumId", "contentId", "content_id", "groupId", "fid", "dcup", "dbunch", "eaccou", "ecar", "dshame", "coper"])
        || textValue(item.redirectConfig || {}, ["id", "videoId", "video_id", "dramaId", "drama_id"])
        || textValue(nestedInfo, ["bookId", "book_id", "id", "videoid", "videoId", "video_id", "dramaId", "drama_id", "drama_intid", "seasonId", "season_id", "programId", "program_id", "playlet_id", "collection_id", "seriesId", "cid", "shortPlayId", "shortPlayLibraryId", "albumId", "contentId", "content_id", "groupId", "fid", "dshame", "coper"])
        || `${slug(platform)}-${slug(title)}-${index}`;
      const episodes = Number(textValue(item, ["chapterCount", "chapterNum", "episodeCount", "episode_count", "episodes", "chapters", "totalEpisode", "totalEpisodes", "total_episodes", "episode_num", "episNum", "total_episode", "lastChapterId", "episode", "episodeNum", "ewood", "ecur"])
        || textValue(nestedInfo, ["chapterCount", "episodeCount", "episode_count", "episodes", "chapters", "totalEpisode", "totalEpisodes", "total_episodes", "totalEpisodeNum", "episNum", "total_episode", "episode", "episodeNum", "ewood", "ecur"])) || 0;
      const rawLang = textValue(item, ["lang", "language", "locale", "country"])
        || textValue(nestedInfo, ["lang", "language", "locale", "country"]);
      const contentLang = rawLang
        ? normalizeContentLang(rawLang)
        : (requestLang && requestLang !== "all" ? requestLang : (normalizeContentLang(platformLanguages.get(platform)) || "id"));

      return {
        id: `${slug(platform)}-${slug(id)}`,
        sourceId: String(id),
        sourceOrder: index,
        title,
        platform,
        episodes,
        genre: textValue(item, ["category", "genre", "tagName", "tags", "attention"]) || "Drama",
        country: textValue(item, ["country", "lang"]) || "",
        language: contentLang,
        year: textValue(item, ["year"]) || "",
        vip: episodes > 12,
        rating: textValue(item, ["score", "rating"]) || "4.8",
        progress: 0,
        tone: ["red", "gold", "blue", "violet", "green"][index % 5],
        poster,
        posterIsGenerated: !rawPoster,
        backdrop: textValue(item, ["banner", "background", "backdrop", "horizontalCover", "landscapeImage", "bannerImg", "bannerImgUrl", "big_cover"]) || poster,
        synopsis: textValue(item, ["introduction", "intro", "introduce", "description", "summary", "desc", "synopsis", "dwill", "dtas"]) || `${title} dari ${platform}.`
      };
    })
    .filter(Boolean);
}

function platformSourceIdField(platform) {
  return {
    rapidtv: "ecar"
  }[slug(platform)] || "";
}

function sourceLanguage(source) {
  if (source.language) {
    return normalizeContentLang(source.language);
  }

  const langParam = (source.endpoints || [])
    .flatMap((endpoint) => endpoint.params || [])
    .find((param) => /(^|[-_])lang(uage)?$/i.test(param.name) && param.defaultValue);

  return normalizeContentLang(langParam?.defaultValue || "");
}

function collectObjects(value, list = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjects(item, list));
    return list;
  }

  if (!value || typeof value !== "object") {
    return list;
  }

  list.push(value);
  Object.values(value).forEach((item) => collectObjects(item, list));
  return list;
}

function textValue(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return "";
}

function dedupeDramas(items) {
  const seen = new Set();
  return items.filter((item) => {
    const platformKey = slug(item.platform || "");
    const languageKey = normalizeContentLang(item.language || "") || "all";
    const idKey = slug(String(item.sourceId || item.id || ""));
    const titleKey = slug(String(item.title || ""));
    const primaryKey = `${platformKey}:${languageKey}:id:${idKey || titleKey}`;
    const secondaryKey = `${platformKey}:${languageKey}:title:${titleKey}`;
    if (seen.has(primaryKey) || (titleKey && seen.has(secondaryKey))) {
      return false;
    }
    seen.add(primaryKey);
    if (titleKey) {
      seen.add(secondaryKey);
    }
    return true;
  });
}

function ensurePlatformCardCoverage(items, sources) {
  const output = dedupeDramas(items);
  const sourceMap = new Map();
  (sources || []).forEach((source) => {
    const platform = source.platform || source;
    if (!platform || sourceMap.has(platform)) {
      return;
    }
    sourceMap.set(platform, {
      platform,
      language: sourceLanguage(source) || platformLanguages.get(platform) || "id"
    });
  });
  const sourceRows = [...sourceMap.values()];

  sourceRows.forEach((source, platformIndex) => {
    const platform = source.platform;
    const language = normalizeContentLang(source.language || "id") || "id";
    const existingCount = output.filter((drama) => drama.platform === platform && normalizeContentLang(drama.language || "") === language).length;
    if (existingCount === 0) {
      // Only generate fallback dramas if there are absolutely no dramas for this platform
      for (let index = 0; index < 6; index += 1) {
        output.push(createFallbackDrama(platform, index, platformIndex, language));
      }
    }
  });

  return dedupeDramas(output);
}

function isFallbackDrama(drama) {
  if (!drama) return false;
  if (drama.isFallback) return true;
  if (!drama.sourceId) return true;

  const platformSlug = slug(drama.platform || "");
  if (platformSlug !== "freereels" && drama.sourceId.startsWith(`${platformSlug}-`)) {
    return true;
  }

  const staticFallbackSlugs = new Set([
    "suami-untuk-tiga-tahun",
    "antara-gengsi-dan-kasih-keluarga",
    "menemukan-kembali-cinta-yang-hilang",
    "istriku-pembaca-pikiran",
    "reinkarnasi-ubah-nasib",
    "tuan-gelap",
    "kesempatan-kedua",
    "kiamat-investasi-wanita",
    "hidup-kedua-permaisuri",
    "cinta-masa-kecil-licik",
    "satu-dewa-perang-tujuh-ratu",
    "kumohon-kembalilah-padaku",
    "romansa-19",
    "ibu-konglomerat-ayah-tabib",
    "telah-usir-aku-perusahaan-hancur",
    "pelindung-ayah-selalu-ada",
    "rumah-yang-terkunci",
    "ruang-bersalin-penuh-pengkhianatan",
    "bos-wanita-rahasia",
    "bimbingan-pribadi-mertua-perempuan",
    "godaan-sahabat",
    "tembakan-sang-raja-senjata",
    "tunangan-sekaligus-musuh",
    "tak-bisa-menolak",
    "pesta-malam-terakhir",
    "dokter-jenius-pulang",
    "warisan-yang-tertukar",
    "cinta-di-balik-kontrak",
    "pengawal-hati",
    "pine-city-love",
    "ratu-dendam"
  ]);
  if (staticFallbackSlugs.has(drama.sourceId)) {
    return true;
  }

  const numericPlatforms = ["dramabox", "goodshort", "cubetv", "dramawave", "pinedrama", "moboreels", "dramabite", "serialplus", "serial"];
  if (numericPlatforms.includes(platformSlug) && !/^\d+$/.test(drama.sourceId)) {
    return true;
  }
  return false;
}

function createFallbackDrama(platform, index, platformIndex = 0, language = "id") {
  const seedTitle = titleSeeds[(index + platformIndex) % titleSeeds.length];
  const title = `${seedTitle}${index >= titleSeeds.length ? ` ${Math.floor(index / titleSeeds.length) + 1}` : ""}`;
  const id = `${slug(platform)}-${slug(title)}-${index + 1}`;
  const countryByLanguage = { id: "ID", en: "US", zh: "CN", ko: "KR", ja: "JP", th: "TH", vi: "VI" };
  const normalizedLanguage = normalizeContentLang(language) || "id";
  const country = countryByLanguage[normalizedLanguage] || "ID";
  return {
    id,
    sourceId: id,
    isFallback: true,
    title,
    platform,
    episodes: 36 + ((platformIndex * 9 + index * 7) % 72),
    genre: ["Romance", "Revenge", "Family", "Action", "Fantasy", "Mystery"][index % 6],
    country,
    language: normalizedLanguage,
    year: String(2024 + ((platformIndex + index) % 3)),
    vip: index % 5 === 0,
    rating: (4.9 - (index % 5) * 0.1).toFixed(1),
    progress: 8 + ((platformIndex * 13 + index * 5) % 84),
    tone: ["red", "gold", "blue", "violet", "green"][(platformIndex + index) % 5],
    poster: generatedPosterDataUri(platform, title, index),
    posterIsGenerated: true,
    backdrop: generatedPosterDataUri(platform, title, index + 17, true),
    synopsis: `${title} dari ${platform} menghadirkan cerita pendek dengan konflik cepat dan episode padat.`
  };
}

async function hydrateMissingPosterDetails(items) {
  const targets = items
    .filter((drama) => drama.posterIsGenerated && drama.sourceId && !isFallbackDrama(drama))
    .slice(0, 40);
  if (!targets.length) {
    return;
  }

  const results = await Promise.allSettled(targets.map(async (drama) => {
    const source = allSources.find((item) => item.slug === slug(drama.platform));
    if (!source?.detail?.path || !source.detail.idParam) {
      return null;
    }

    let detailUrl = `${source.detail.path}?${source.detail.idParam}=${encodeURIComponent(drama.sourceId)}`;
    const targetLang = selectedContentLang === "all" ? "id" : selectedContentLang;
    if (targetLang) {
      const platformLang = platformLanguageValue(source, targetLang);
      detailUrl += `&lang=${encodeURIComponent(platformLang)}`;
    }
    const response = await secureFetch(detailUrl);
    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const found = normalizeApiItems(drama.platform, payload, targetLang).find((item) => item.poster && !item.posterIsGenerated);
    if (!found) {
      return null;
    }

    return { id: drama.id, poster: found.poster, backdrop: found.backdrop || found.poster, synopsis: found.synopsis, episodes: found.episodes };
  }));

  let changed = false;
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value) {
      continue;
    }

    const index = dramas.findIndex((item) => item.id === result.value.id);
    if (index < 0) {
      continue;
    }

    dramas[index] = {
      ...dramas[index],
      poster: result.value.poster,
      backdrop: result.value.backdrop,
      synopsis: result.value.synopsis || dramas[index].synopsis,
      episodes: result.value.episodes || dramas[index].episodes,
      posterIsGenerated: false
    };
    changed = true;
  }

  if (changed) {
    platformImages.clear();
    for (const drama of dramas) {
      if (!platformImages.has(drama.platform) && drama.poster && !drama.posterIsGenerated) {
        platformImages.set(drama.platform, drama.poster);
      }
    }
    renderRoute();
  }
}

function generatedPosterDataUri(platform, title, index = 0, wide = false) {
  const palettes = [
    ["#14213d", "#e50914", "#fca311"],
    ["#0f172a", "#2563eb", "#f8fafc"],
    ["#1f1235", "#a855f7", "#fef3c7"],
    ["#052e2b", "#10b981", "#ecfeff"],
    ["#2b0b12", "#fb7185", "#fff7ed"]
  ];
  const [bg, accent, text] = palettes[index % palettes.length];
  const width = wide ? 900 : 420;
  const height = wide ? 520 : 630;
  const safePlatform = escapeSvgText(platform);
  const safeTitle = escapeSvgText(shortTitle(title, wide ? 42 : 28));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${bg}"/>
          <stop offset="0.55" stop-color="#05070d"/>
          <stop offset="1" stop-color="${accent}"/>
        </linearGradient>
        <radialGradient id="r" cx="72%" cy="16%" r="58%">
          <stop offset="0" stop-color="${accent}" stop-opacity="0.92"/>
          <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <rect width="100%" height="100%" fill="url(#r)"/>
      <circle cx="${wide ? 690 : 315}" cy="${wide ? 110 : 118}" r="${wide ? 138 : 92}" fill="${accent}" opacity="0.34"/>
      <rect x="${wide ? 54 : 28}" y="${wide ? 54 : 32}" width="${wide ? 190 : 132}" height="42" rx="10" fill="${accent}"/>
      <text x="${wide ? 78 : 44}" y="${wide ? 82 : 59}" font-family="Arial, sans-serif" font-size="${wide ? 22 : 18}" font-weight="800" fill="#ffffff">${safePlatform}</text>
      <text x="${wide ? 54 : 30}" y="${wide ? 344 : 430}" font-family="Arial, sans-serif" font-size="${wide ? 54 : 42}" font-weight="900" fill="${text}">${safeTitle}</text>
      <text x="${wide ? 54 : 30}" y="${wide ? 404 : 486}" font-family="Arial, sans-serif" font-size="${wide ? 22 : 19}" font-weight="700" fill="#dbeafe">TEAMDL DRAMA</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg.replace(/\s+/g, " ").trim())}`;
}

function escapeSvgText(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));
}

function uniqueValues(items) {
  return [...new Set(items.filter(Boolean))];
}

function posterStyle(image) {
  if (!image) {
    return "";
  }

  return `--poster:url('${String(image).replace(/['\\]/g, "\\$&")}')`;
}

function getPageParamName(source, endpointIndex) {
  if (source.catalogPageParam) {
    return source.catalogPageParam;
  }

  const endpoint = (source.endpoints || [])[endpointIndex - 1];
  const param = endpoint?.params?.find((p) => /(^|[-_])page$/i.test(p.name));
  return param ? param.name : "page";
}

function endpointProxyPath(source, endpointIndex) {
  if (Number(source.catalogEndpointIndex) === Number(endpointIndex) && source.catalogPath) {
    return source.catalogPath;
  }
  const alias = source.routes?.[String(endpointIndex)] || source.endpointAliases?.[String(endpointIndex)];
  return alias || `/api/platform/${source.slug}/endpoint/${endpointIndex}`;
}

async function loadNextCatalogPage(platformSlug) {
  if (isLoadingCatalog) return;
  isLoadingCatalog = true;

  const loadingIndicator = document.querySelector("#catalogLoading");
  if (loadingIndicator) {
    loadingIndicator.style.display = "block";
  }

  try {
    const isSemua = platformSlug === "semua";
    const activePlatform = isSemua ? null : catalogPlatformNames().find((name) => slug(name) === platformSlug);
    const nextPage = (catalogPages.get(platformSlug) || 1) + 1;

    let newItems = [];

    if (isSemua) {
      const activeSources = allSources.filter((s) => s.status === "active" && Number(s.endpointCount || s.endpoints?.length || 0) > 0);
      const results = await Promise.allSettled(activeSources.map(async (source) => {
        const endpointIndex = selectCatalogEndpointIndex(source);
        if (endpointIndex <= 0) return [];
        if (hasMoreCatalog.get(source.slug) === false) return [];

        const pageParam = getPageParamName(source, endpointIndex);
        let url = `${endpointProxyPath(source, endpointIndex)}?${pageParam}=${nextPage}`;
        if (selectedContentLang !== "all") {
          const platformLang = platformLanguageValue(source, selectedContentLang);
          url += `&lang=${encodeURIComponent(platformLang)}`;
        }
        const response = await secureFetchWithTimeout(url);
        if (!response.ok) return [];

        const items = normalizeApiItems(source.platform, await response.json(), selectedContentLang);
        if (items.length === 0) {
          hasMoreCatalog.set(source.slug, false);
        }
        return items;
      }));

      newItems = dedupeDramas(results
        .filter((r) => r.status === "fulfilled")
        .flatMap((r) => r.value));
    } else {
      const source = allSources.find((s) => s.slug === platformSlug);
      if (source && source.status === "active" && Number(source.endpointCount || source.endpoints?.length || 0) > 0) {
        const endpointIndex = selectCatalogEndpointIndex(source);
        if (endpointIndex > 0 && hasMoreCatalog.get(platformSlug) !== false) {
          const pageParam = getPageParamName(source, endpointIndex);
          let url = `${endpointProxyPath(source, endpointIndex)}?${pageParam}=${nextPage}`;
          if (selectedContentLang !== "all") {
            const platformLang = platformLanguageValue(source, selectedContentLang);
            url += `&lang=${encodeURIComponent(platformLang)}`;
          }
          const response = await secureFetchWithTimeout(url);
          if (response.ok) {
            newItems = normalizeApiItems(source.platform, await response.json(), selectedContentLang);
            if (newItems.length === 0) {
              hasMoreCatalog.set(platformSlug, false);
            }
          }
        }
      }
    }

    if (newItems.length > 0) {
      const existingIds = new Set(dramas.map((item) => item.id));
      const trulyNewItems = newItems.filter((item) => !existingIds.has(item.id));

      if (trulyNewItems.length === 0) {
        hasMoreCatalog.set(platformSlug, false);
      }

      dramas = dedupeDramas([...dramas, ...newItems]);
      catalogPages.set(platformSlug, nextPage);

      const grid = document.querySelector(".page-section .catalog-grid");
      if (grid) {
        const filteredNewItems = languageFilteredDramas(activePlatform ? trulyNewItems.filter((item) => item.platform === activePlatform) : trulyNewItems);
        if (filteredNewItems.length) {
          grid.insertAdjacentHTML("beforeend", filteredNewItems.map(dramaCard).join(""));
        }
      }
    } else {
      hasMoreCatalog.set(platformSlug, false);
    }
  } catch (error) {
    console.error("Gagal memuat halaman berikutnya:", error);
  } finally {
    isLoadingCatalog = false;
    if (loadingIndicator) {
      loadingIndicator.style.display = "none";
    }
  }
}

function triggerCatalogLoadMore(platformSlug) {
  if (isLoadingCatalog || hasMoreCatalog.get(platformSlug) === false) {
    return;
  }
  loadNextCatalogPage(platformSlug);
}

window.addEventListener("scroll", () => {
  const path = location.pathname;
  if (path === "/platform" || path.startsWith("/platform/")) {
    const platformSlug = path.split("/").pop() || "semua";
    const threshold = 350;
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - threshold) {
      triggerCatalogLoadMore(platformSlug);
    }
  }
});

function recentHistoryItems() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return Object.values(localHistory)
    .filter(item => new Date(item.updatedAt) >= sevenDaysAgo)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function sortedFavoriteItems() {
  return Object.values(localFavorites)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function historyItemMarkup(item) {
  const dramaObj = findDrama(item.dramaId);
  const poster = item.poster || dramaObj.poster;
  return `
    <div class="history-item">
      <div class="history-poster" style="${poster ? `background-image: url('${poster}')` : ''}"></div>
      <div class="history-details">
        <strong>${escapeHtml(item.title)}</strong>
        <p>Menonton Episode ${item.episodeNumber}</p>
        <span>${formatRelativeTime(item.updatedAt)}</span>
      </div>
      <a class="primary-btn" href="/watch/${item.dramaId}?ep=${item.episodeNumber}" style="min-height:36px; padding:0 14px; font-size:12px;">Lanjut</a>
    </div>
  `;
}

function favoriteCardMarkup(item) {
  const dramaObj = findDrama(item.dramaId);
  return dramaCard({
    id: item.dramaId,
    title: item.title,
    poster: item.poster || dramaObj.poster,
    platform: item.platform,
    tone: dramaObj.tone || "blue",
    episodes: dramaObj.episodes || 0,
    language: dramaObj.language || ""
  });
}

function renderHistoryPage() {
  const historyItems = recentHistoryItems();
  app.innerHTML = `
    <section class="page-section top-space">
      <div class="profile-page">
        <div class="profile-section-heading">
          <h3 class="profile-section-title">Riwayat Tontonan (7 Hari Terakhir)</h3>
          <a class="profile-section-action" href="/profile">Kembali</a>
        </div>
        <div class="history-list">
          ${historyItems.length === 0 ? `
            <div class="empty-profile-state">Belum ada riwayat tontonan dalam 7 hari terakhir.</div>
          ` : historyItems.map(historyItemMarkup).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderFavoritesPage() {
  const favoriteItems = sortedFavoriteItems();
  app.innerHTML = `
    <section class="page-section top-space">
      <div class="profile-page">
        <div class="profile-section-heading">
          <h3 class="profile-section-title">Daftar Favorit Saya</h3>
          <a class="profile-section-action" href="/profile">Kembali</a>
        </div>
        <div class="catalog-grid">
          ${favoriteItems.length === 0 ? `
            <div class="empty-profile-state" style="grid-column: 1 / -1;">Belum ada drama favorit yang disimpan.</div>
          ` : favoriteItems.map(favoriteCardMarkup).join("")}
        </div>
      </div>
    </section>
  `;
}

// Profile page rendering view
function renderProfile() {
  const cachedUser = {
    first_name: localStorage.getItem("TEAMDLUserFirstName") || "Guest",
    last_name: localStorage.getItem("TEAMDLUserLastName") || "User",
    username: localStorage.getItem("TEAMDLUserUsername") || "",
    id: localStorage.getItem("TEAMDLTelegramId") || "Tamu"
  };

  if (!cachedUser.username && userId.startsWith("tg-")) {
    cachedUser.username = "user_" + userId.replace(/^tg-/, "");
  } else if (!cachedUser.username) {
    cachedUser.username = "guest_" + userId.slice(6, 12);
  }

  const user = telegram?.initDataUnsafe?.user || (userId.startsWith("tg-") ? cachedUser : {
    first_name: "Guest",
    last_name: "User",
    username: "guest_" + userId.slice(6, 12),
    id: "Tamu"
  });
  
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const telegramHandle = user.username ? `@${user.username}` : "Belum terhubung";
  const avatarUrl = user.photo_url || "";
  const avatarInitials = initials(fullName || "GT");

  const userIsAdmin = String(userId) === "tg-5888747846" || String(user.id) === "5888747846";

  const cachedFirestoreVip = JSON.parse(localStorage.getItem("TEAMDL_firestore_vip") || "null");
  const vip = firestoreUserDoc?.vip || cachedFirestoreVip || securitySession?.vip || { active: false, expiresAt: null, purchaseDate: null };
  const vipActive = !!(vip.active && vip.expiresAt && new Date(vip.expiresAt) > new Date());
  const expiresTime = vip.expiresAt ? new Date(vip.expiresAt).getTime() : 0;
  const purchaseTime = vip.purchaseDate ? new Date(vip.purchaseDate).getTime() : 0;
  const planDays = expiresTime && purchaseTime && !isNaN(expiresTime) && !isNaN(purchaseTime) ? Math.round((expiresTime - purchaseTime) / (24 * 60 * 60 * 1000)) : null;
  const vipDurationText = planDays ? `VIP ${planDays} Hari` : "VIP Premium";
  
  const formatVipDate = (dateStr) => {
    if (!dateStr) return "-";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "-";
    try {
      return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
    } catch {
      return "-";
    }
  };

  const purchaseDateFormatted = formatVipDate(vip.purchaseDate);
  const expiresDateFormatted = formatVipDate(vip.expiresAt);

  const historyItems = recentHistoryItems();
  const favoriteItems = sortedFavoriteItems();
  const latestHistoryItem = historyItems[0];
  const latestFavoriteItem = favoriteItems[0];
  syncVipNotifications(vip, vipActive, { vipDurationText, purchaseDateFormatted, expiresDateFormatted });
  checkVipExpiryNotifications(vip, vipActive);
  const notificationItems = getLocalNotifications();
  const unreadNotificationCount = notificationItems.filter(item => !item.read).length;

  const watchStats = getWatchLevel(totalWatchSeconds);

  app.innerHTML = `
    <section class="page-section top-space">
      <div class="profile-page">
        <!-- 1. Header Card -->
        <div class="profile-header-card">
          <button class="profile-header-notification ${unreadNotificationCount > 0 ? 'has-unread' : ''}" id="profileHeaderNotificationBtn" type="button" aria-label="Buka notifikasi">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect width="20" height="16" x="2" y="4" rx="2"></rect>
              <path d="m22 7-8.97 5.7a2 2 0 0 1-2.06 0L2 7"></path>
            </svg>
            <span class="profile-header-notification-badge" id="profileHeaderNotificationBadge">${unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}</span>
          </button>
          <div class="profile-avatar ${userIsAdmin ? 'avatar-frame-admin' : (vipActive ? 'avatar-frame-vip' : 'avatar-frame-guest')}">
            <div class="profile-avatar-inner" style="${avatarUrl ? `background-image: url('${avatarUrl}')` : ''}">
              ${avatarUrl ? '' : avatarInitials}
            </div>
            <div class="avatar-badge">${userIsAdmin ? 'ADMIN' : (vipActive ? 'VIP' : 'GUEST')}</div>
          </div>
          <div class="profile-info">
            <h2>${escapeHtml(fullName)}${userIsAdmin ? ` <span style="font-size: 11px; background: #ef4444; color: #fff; padding: 2px 8px; border-radius: 12px; font-weight: bold; margin-left: 6px; vertical-align: middle;">ADMIN</span>` : ""}</h2>
            <p>Username: ${escapeHtml(telegramHandle)}</p>
            <p>ID Telegram: <span class="tele-id">${escapeHtml(String(user.id))}${userIsAdmin ? ' (Admin)' : ''}</span></p>
            <div class="user-id-wrapper">
              <p style="margin: 0; padding: 0;">User ID:</p>
              <span class="user-id-badge" onclick="navigator.clipboard.writeText('${escapeHtml(userId)}'); alert('User ID copied: ${escapeHtml(userId)}');" title="Klik untuk menyalin">
                ${escapeHtml(userId)}
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </span>
            </div>
          </div>
        </div>

        <!-- Telegram Sync / Connect Account Card -->
        ${userId.startsWith("guest-") ? `
          <div id="telegramSyncContainer" class="profile-sync-card" style="padding: 20px; border-radius: 16px; background: rgba(233, 163, 0, 0.05); border: 1px solid rgba(233, 163, 0, 0.15); margin-bottom: 24px; text-align: center;">
            <div style="font-size: 24px; margin-bottom: 10px;">🔑</div>
            <h3 style="color: #e9a300; margin-bottom: 8px; font-size: 16px;">Hubungkan Akun Telegram</h3>
            <p style="font-size: 12px; color: rgba(255, 255, 255, 0.7); margin-bottom: 16px; line-height: 1.5; max-width: 380px; margin-left: auto; margin-right: auto;">
              Ingin mengakses akun Telegram Anda di browser luar? Hubungkan akun Anda untuk menyinkronkan status VIP, riwayat tontonan, dan daftar favorit secara otomatis.
            </p>
            <button class="primary-btn gold-btn" id="startTelegramLoginBtn" style="padding: 10px 20px; border-radius: 20px; font-weight: bold; cursor: pointer; font-size: 13px; border: none; background: #e9a300; color: #000; transition: transform 0.2s;">Koneksikan Akun</button>
          </div>
        ` : `
          <div style="padding: 14px 18px; border-radius: 16px; background: rgba(34, 197, 94, 0.05); border: 1px solid rgba(34, 197, 94, 0.2); margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 18px;">✅</span>
              <span style="font-size: 13px; color: rgba(255,255,255,0.8);">Terhubung ke Akun Telegram: <strong>${escapeHtml(fullName)}</strong></span>
            </div>
            <button id="telegramLogoutBtn" style="background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2); padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; cursor: pointer; transition: all 0.2s;">Keluar Akun</button>
          </div>
        `}

        <!-- 2. VIP Status Card -->
        <div class="vip-status-card ${vipActive ? '' : 'non-vip'}">
          <div class="vip-status-info">
            <span class="vip-badge-large">${vipActive ? 'VIP AKTIF' : 'NON-VIP'}</span>
            ${vipActive ? `
              <p><b>Paket:</b> ${vipDurationText}</p>
              <p><b>Tanggal Pembelian:</b> ${purchaseDateFormatted}</p>
              <p><b>Kedaluwarsa:</b> ${expiresDateFormatted}</p>
            ` : `
              <p>Aktifkan VIP untuk membuka kunci seluruh episode drama premium.</p>
            `}
          </div>
          <div class="vip-buy-buttons">
            <button class="primary-btn gold-btn vip-buy-btn" data-buy-plan="30">Beli VIP 30 Hari</button>
            <button class="primary-btn gold-btn vip-buy-btn" data-buy-plan="365">Beli VIP 365 Hari</button>
          </div>
        </div>

        <!-- Watch Time Level Card -->
        <div class="level-status-card">
          <div class="level-header">
            <div class="level-number-badge">LVL ${watchStats.level}</div>
            <div class="level-title-info">
              <h3>${watchStats.title}</h3>
              <p>Total menonton: <b>${watchStats.minutesWatched} menit</b> (${watchStats.secondsWatched} detik)</p>
            </div>
          </div>
          <div class="level-progress-bar-shell">
            <div class="level-progress-bar" style="width: ${watchStats.percent}%"></div>
          </div>
          <div class="level-footer">
            <span>LVL ${watchStats.level}</span>
            <span>${watchStats.percent}% menuju LVL ${watchStats.level + 1}</span>
            <span>LVL ${watchStats.level + 1}</span>
          </div>
        </div>

        <!-- Help Center Card -->
        <div class="help-center-card">
          <div class="help-header">
            <div class="help-icon-wrapper">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            </div>
            <div class="help-title-info">
              <h3>Pusat Bantuan & Laporan</h3>
              <p>Butuh bantuan atau ingin melaporkan kendala di website?</p>
            </div>
          </div>
          <div class="help-action-buttons">
            <button class="primary-btn help-btn" id="openFaqBtn">Tanya Jawab (Q&A)</button>
            <button class="primary-btn purple-btn help-btn" id="openChatBtn">Live Chat Admin</button>
            <button class="primary-btn admin-ticket-btn help-btn" id="openAdminTicketBtn" data-tgid="${escapeHtml(String(user.id))}" style="display:none;">Tiket Masuk</button>
          </div>
        </div>

        <!-- 3. Koleksi & Aktivitas -->
        <div class="profile-section-heading">
          <h3 class="profile-section-title">Koleksi & Aktivitas</h3>
        </div>
        <div class="profile-menu-grid">
          <a class="profile-menu-card" href="/history">
            <span>Riwayat</span>
            <strong>${historyItems.length}</strong>
            <p>${latestHistoryItem ? `Terakhir: ${escapeHtml(shortTitle(latestHistoryItem.title, 30))}` : "Belum ada riwayat 7 hari terakhir."}</p>
          </a>
          <a class="profile-menu-card" href="/favorites">
            <span>Favorit</span>
            <strong>${favoriteItems.length}</strong>
            <p>${latestFavoriteItem ? `Terakhir disimpan: ${escapeHtml(shortTitle(latestFavoriteItem.title, 30))}` : "Belum ada drama favorit."}</p>
          </a>
          <a class="profile-menu-card" href="/new">
            <span>Judul Baru</span>
            <strong>${sortedNewTitleItems(dramas).length}</strong>
            <p>Lihat semua update terbaru dari masing-masing platform.</p>
          </a>
          <a class="profile-menu-card apk-download-card" href="/app-release.apk" download style="background: linear-gradient(135deg, rgba(233, 163, 0, 0.08), rgba(255, 123, 0, 0.12)); border: 1px solid rgba(233, 163, 0, 0.25);">
            <span>Aplikasi Android</span>
            <strong style="color: #e9a300; font-size: 16px; margin-top: 4px; display: inline-flex; align-items: center; gap: 4px;">📥 Unduh APK</strong>
            <p>Unduh dan pasang aplikasi mobile Android resmi untuk mengakses semua fitur dari HP Anda.</p>
          </a>
        </div>
      </div>
    </section>
  `;

  const profileHeaderNotificationBtn = document.querySelector("#profileHeaderNotificationBtn");
  if (profileHeaderNotificationBtn) {
    profileHeaderNotificationBtn.addEventListener("click", () => {
      document.querySelector("#notificationBtn")?.click();
    });
  }

  // Attach event handlers for buying plans - redirect to VIP page
  document.querySelectorAll("[data-buy-plan]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      history.pushState({}, "", "/vip");
      renderRoute();
    });
  });

  // FAQ Button listener
  const openFaqBtn = document.querySelector("#openFaqBtn");
  const faqOverlay = document.querySelector("#faqDialogOverlay");
  const closeFaqBtn = document.querySelector("#closeFaqBtn");
  
  if (openFaqBtn && faqOverlay) {
    openFaqBtn.addEventListener("click", () => {
      faqOverlay.style.display = "flex";
      initFaqListeners();
    });
  }
  
  if (closeFaqBtn && faqOverlay) {
    closeFaqBtn.addEventListener("click", () => {
      faqOverlay.style.display = "none";
    });
  }
  
  // Live Chat Button listener
  const openChatBtn = document.querySelector("#openChatBtn");
  const chatOverlay = document.querySelector("#chatDialogOverlay");
  const closeChatBtn = document.querySelector("#closeChatBtn");
  
  if (openChatBtn && chatOverlay) {
    openChatBtn.addEventListener("click", () => {
      chatOverlay.style.display = "flex";
      initChatListeners(userId, fullName);
    });
  }
  
  if (closeChatBtn && chatOverlay) {
    closeChatBtn.addEventListener("click", () => {
      chatOverlay.style.display = "none";
      stopChatPolling();
    });
  }

  // Admin Ticket Panel – probe API to check if current user is admin, then show button
  const openAdminTicketBtn = document.querySelector("#openAdminTicketBtn");
  if (openAdminTicketBtn) {
    const tgId = String(user.id);
    // Silently probe the admin endpoint
    fetch("/api/tickets/list?tgId=" + encodeURIComponent(tgId))
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          openAdminTicketBtn.style.display = "";
          openAdminTicketBtn.onclick = () => openAdminTicketPanel(tgId);
          if (new URLSearchParams(window.location.search).get("adminTickets") === "1") {
            openAdminTicketPanel(tgId);
          }
        }
      })
      .catch(() => {});
  }

  // Connect Telegram Account Login Listeners
  const startTelegramLoginBtn = document.querySelector("#startTelegramLoginBtn");
  const telegramSyncContainer = document.querySelector("#telegramSyncContainer");
  const telegramLogoutBtn = document.querySelector("#telegramLogoutBtn");

  if (startTelegramLoginBtn && telegramSyncContainer) {
    startTelegramLoginBtn.onclick = () => {
      telegramSyncContainer.innerHTML = `
        <h3 style="color: #fff; margin-bottom: 8px; font-size: 16px; text-align: center;">🔑 Hubungkan Akun Telegram</h3>
        <p style="font-size: 12px; color: rgba(255, 255, 255, 0.6); margin-bottom: 16px; text-align: center; line-height: 1.5; max-width: 360px; margin-left: auto; margin-right: auto;">
          1. Buka Bot Telegram kami di HP/desktop Anda.<br>
          2. Kirim perintah <b>/login</b> di chat bot.<br>
          3. Masukkan 6 digit kode yang diberikan bot di bawah ini:
        </p>
        <div style="display: flex; gap: 8px; max-width: 320px; margin: 0 auto; justify-content: center; align-items: center;">
          <input type="text" id="telegramLoginCodeInput" placeholder="6 digit kode" maxlength="6" style="flex: 1; padding: 10px 14px; border-radius: 20px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); color: #fff; text-align: center; font-size: 15px; font-weight: bold; letter-spacing: 2px; outline: none; width: 140px;">
          <button id="submitTelegramLoginBtn" style="padding: 10px 20px; border-radius: 20px; background: #e9a300; color: #000; font-weight: bold; border: none; cursor: pointer; font-size: 13px;">Masuk</button>
        </div>
        <p id="telegramLoginError" style="color: #ef4444; font-size: 12px; text-align: center; margin-top: 10px; display: none;"></p>
        <div style="text-align: center; margin-top: 12px;">
          <button id="cancelTelegramLoginBtn" style="background: none; border: none; color: rgba(255,255,255,0.4); font-size: 12px; cursor: pointer; text-decoration: underline;">Batal</button>
        </div>
      `;

      const submitTelegramLoginBtn = telegramSyncContainer.querySelector("#submitTelegramLoginBtn");
      const cancelTelegramLoginBtn = telegramSyncContainer.querySelector("#cancelTelegramLoginBtn");
      const codeInput = telegramSyncContainer.querySelector("#telegramLoginCodeInput");
      const errorEl = telegramSyncContainer.querySelector("#telegramLoginError");

      if (cancelTelegramLoginBtn) {
        cancelTelegramLoginBtn.onclick = () => {
          renderProfile();
        };
      }

      if (submitTelegramLoginBtn && codeInput) {
        submitTelegramLoginBtn.onclick = async () => {
          const code = codeInput.value.trim();
          if (!code || code.length !== 6) {
            errorEl.textContent = "Masukkan 6 digit kode login!";
            errorEl.style.display = "block";
            return;
          }

          submitTelegramLoginBtn.disabled = true;
          submitTelegramLoginBtn.textContent = "Memproses...";
          errorEl.style.display = "none";

          try {
            const res = await fetch("/api/auth/login-code", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code })
            });
            const data = await res.json();
            if (data.ok) {
              localStorage.setItem("TEAMDLUserId", data.userId);
              localStorage.setItem("TEAMDLTelegramId", data.telegramId || "");
              localStorage.setItem("TEAMDLUserFirstName", data.firstName || "");
              localStorage.setItem("TEAMDLUserLastName", data.lastName || "");
              localStorage.setItem("TEAMDLUserUsername", data.username || "");
              localStorage.setItem("TEAMDLWatchPartyName", (data.firstName + " " + data.lastName).trim() || data.username || "User Telegram");
              alert("Akun Telegram berhasil terhubung!");
              location.reload();
            } else {
              errorEl.textContent = data.error || "Kode login salah atau kedaluwarsa.";
              errorEl.style.display = "block";
              submitTelegramLoginBtn.disabled = false;
              submitTelegramLoginBtn.textContent = "Masuk";
            }
          } catch (err) {
            errorEl.textContent = "Gagal menghubungi server.";
            errorEl.style.display = "block";
            submitTelegramLoginBtn.disabled = false;
            submitTelegramLoginBtn.textContent = "Masuk";
          }
        };
      }
    };
  }

  if (telegramLogoutBtn) {
    telegramLogoutBtn.onclick = () => {
      if (confirm("Apakah Anda yakin ingin keluar dari akun Telegram ini di browser ini?")) {
        localStorage.removeItem("TEAMDLUserId");
        localStorage.removeItem("TEAMDLWatchPartyName");
        localStorage.removeItem("TEAMDLTelegramId");
        localStorage.removeItem("TEAMDLUserFirstName");
        localStorage.removeItem("TEAMDLUserLastName");
        localStorage.removeItem("TEAMDLUserUsername");
        location.reload();
      }
    };
  }

  // Asynchronously fetch profile from server to refresh cache
  if (userId.startsWith("tg-") && !telegram?.initDataUnsafe?.user) {
    fetch(`/api/user/profile?userId=${encodeURIComponent(userId)}`)
      .then(res => res.json())
      .then(data => {
        if (data.ok && data.user) {
          const freshFirst = data.user.first_name || "";
          const freshLast = data.user.last_name || "";
          const freshUser = data.user.username || "";
          const freshTgId = String(data.user.id || "");

          const currFirst = localStorage.getItem("TEAMDLUserFirstName") || "";
          const currLast = localStorage.getItem("TEAMDLUserLastName") || "";
          const currUser = localStorage.getItem("TEAMDLUserUsername") || "";
          const currTgId = localStorage.getItem("TEAMDLTelegramId") || "";

          if (freshFirst !== currFirst || freshLast !== currLast || freshUser !== currUser || freshTgId !== currTgId) {
            localStorage.setItem("TEAMDLUserFirstName", freshFirst);
            localStorage.setItem("TEAMDLUserLastName", freshLast);
            localStorage.setItem("TEAMDLUserUsername", freshUser);
            localStorage.setItem("TEAMDLTelegramId", freshTgId);
            
            // Re-render only if the profile page is still open
            if (location.pathname === "/profile") {
              renderProfile();
            }
          }
        }
      })
      .catch(() => {});
  }

  const apkDownloadCard = document.querySelector(".apk-download-card");
  if (apkDownloadCard) {
    apkDownloadCard.addEventListener("click", (e) => {
      const telegram = window.Telegram?.WebApp;
      if (telegram && typeof telegram.openLink === "function") {
        e.preventDefault();
        const downloadUrl = new URL("/app-release.apk", window.location.origin).toString();
        telegram.openLink(downloadUrl);
      }
    });
  }
}

function checkAndShowMaintenanceNotification() {
  if (!allSources || !Array.isArray(allSources)) return;
  if (location.pathname.startsWith("/watch/")) {
    document.querySelector("#maintenanceNotificationBanner")?.remove();
    document.body.classList.remove("has-maintenance-banner");
    return;
  }
  const unavailablePlatforms = allSources.filter(source => source.status && source.status !== "active");
  if (unavailablePlatforms.length === 0) {
    const existing = document.querySelector("#maintenanceNotificationBanner");
    if (existing) existing.remove();
    document.body.classList.remove("has-maintenance-banner");
    return;
  }
  
  const message = unavailablePlatforms
    .map((source) => `${source.platform}: ${String(source.status).toUpperCase()}`)
    .join("   |   ");
  const bannerId = "maintenanceNotificationBanner";
  let banner = document.querySelector(`#${bannerId}`);
  if (!banner) {
    banner = document.createElement("div");
    banner.id = bannerId;
    banner.className = "maintenance-banner";
    const siteNav = document.querySelector("#siteNav");
    if (siteNav) {
      siteNav.parentNode.insertBefore(banner, siteNav.nextSibling);
    } else {
      document.body.insertBefore(banner, document.body.firstChild);
    }
  }
  
  banner.innerHTML = `
    <div class="maintenance-banner-content">
      <div class="maintenance-marquee" aria-label="Pengumuman status platform">
        <span>Pengumuman Platform: ${escapeHtml(message)}   |   Platform OFF/MAINTENANCE tidak dapat digunakan sementara.</span>
      </div>
      <button class="close-banner-btn" type="button" aria-label="Tutup pengumuman">x</button>
    </div>
  `;
  document.body.classList.add("has-maintenance-banner");
  banner.querySelector(".close-banner-btn")?.addEventListener("click", () => {
    banner.remove();
    document.body.classList.remove("has-maintenance-banner");
  });
}

let faqInitialized = false;
function initFaqListeners() {
  if (faqInitialized) return;
  faqInitialized = true;
  
  const faqQuestions = document.querySelectorAll(".faq-question");
  faqQuestions.forEach(q => {
    q.addEventListener("click", () => {
      const item = q.parentElement;
      const answer = item.querySelector(".faq-answer");
      
      // Close other active items
      document.querySelectorAll(".faq-item").forEach(otherItem => {
        if (otherItem !== item) {
          otherItem.classList.remove("active");
          const otherAns = otherItem.querySelector(".faq-answer");
          if (otherAns) otherAns.style.display = "none";
        }
      });
      
      item.classList.toggle("active");
      if (item.classList.contains("active")) {
        if (answer) answer.style.display = "block";
      } else {
        if (answer) answer.style.display = "none";
      }
    });
  });
  
  const searchInput = document.querySelector("#faqSearchInput");
  searchInput?.addEventListener("input", (e) => {
    const term = e.target.value.toLowerCase();
    document.querySelectorAll(".faq-item").forEach(item => {
      const questionText = item.querySelector(".faq-question").textContent.toLowerCase();
      const answerText = item.querySelector(".faq-answer").textContent.toLowerCase();
      if (questionText.includes(term) || answerText.includes(term)) {
        item.style.display = "block";
      } else {
        item.style.display = "none";
      }
    });
  });
}

let chatPollInterval = null;
let lastChatLength = 0;
let chatInitialized = false;
let chatRenderedIds = new Set();

function initChatListeners(userId, userName) {
  const form = document.querySelector("#chatInputForm");
  const input = document.querySelector("#chatMessageInput");
  const messagesList = document.querySelector("#chatMessagesList");
  
  if (messagesList) messagesList.scrollTop = messagesList.scrollHeight;
  chatRenderedIds = new Set([...messagesList.querySelectorAll(".chat-bubble[data-msg-id]")].map((item) => item.dataset.msgId));
  
  // 1. Initial fetch
  fetchMessages(userId);
  
  // 2. Poll every 3 seconds
  if (chatPollInterval) clearInterval(chatPollInterval);
  chatPollInterval = setInterval(() => {
    fetchMessages(userId);
  }, 3000);
  
  // Handle click on quick replies
  messagesList?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".quick-reply-btn");
    if (!btn) return;
    
    const topic = btn.dataset.topic;
    if (!topic) return;
    
    // Hide quick replies
    const quickReplies = messagesList.querySelector(".chat-quick-replies");
    if (quickReplies) quickReplies.style.display = "none";
    
    // Render user bubble immediately
    appendChatBubble({ sender: "user", text: topic, timestamp: Date.now() });
    
    // Show AI typing indicator
    const indicator = document.querySelector("#chatTypingIndicator");
    if (indicator) indicator.style.display = "flex";
    messagesList.scrollTop = messagesList.scrollHeight;
    
    try {
      await fetch("/api/tickets/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, userName, message: topic })
      });
      
      setTimeout(() => {
        fetchMessages(userId);
      }, 1600);
      
    } catch (err) {
      console.error("Gagal mengirim topik bantuan:", err);
    }
  });

  // Handle click on open ticket button
  messagesList?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".open-ticket-btn");
    if (!btn) return;
    
    btn.disabled = true;
    btn.textContent = "Membuka Tiket...";
    
    // Retrieve Telegram WebApp user details
    const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user || {};
    const telegramId = tgUser.id || "";
    const telegramUsername = tgUser.username || "";
    
    try {
      const response = await fetch("/api/tickets/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          userName,
          telegramId,
          telegramUsername
        })
      });
      const data = await response.json();
      if (data.ok) {
        // Force immediate fetch to get the system confirmation bubble
        setTimeout(() => {
          fetchMessages(userId);
        }, 500);
      } else {
        btn.textContent = "Gagal membuka tiket";
        btn.disabled = false;
      }
    } catch (err) {
      console.error("Gagal membuka tiket:", err);
      btn.textContent = "Error membuka tiket";
      btn.disabled = false;
    }
  });

  // Handle image upload input
  const fileInput = document.querySelector("#chatImageFileInput");
  fileInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    fileInput.value = ""; // reset file input
    
    const reader = new FileReader();
    reader.onload = async () => {
      const base64Data = reader.result;
      
      // Optimistically render message bubble with image
      appendChatBubble({
        sender: "user",
        text: "[Mengirim Gambar...]",
        imageUrl: base64Data,
        timestamp: Date.now()
      });
      
      // Show AI typing indicator
      const indicator = document.querySelector("#chatTypingIndicator");
      if (indicator) indicator.style.display = "flex";
      if (messagesList) messagesList.scrollTop = messagesList.scrollHeight;
      
      try {
        await fetch("/api/tickets/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId,
            userName,
            message: "[Gambar]",
            image: base64Data
          })
        });
        
        setTimeout(() => {
          fetchMessages(userId);
        }, 1600);
      } catch (err) {
        console.error("Gagal mengirim gambar:", err);
      }
    };
    
    reader.readAsDataURL(file);
  });

  // 3. Form submit
  if (chatInitialized) return;
  chatInitialized = true;
  
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msgText = input?.value?.trim();
    if (!msgText) return;
    
    if (input) input.value = "";
    
    // Render immediately
    appendChatBubble({ sender: "user", text: msgText, timestamp: Date.now() });
    
    // Show AI typing indicator
    const indicator = document.querySelector("#chatTypingIndicator");
    if (indicator) indicator.style.display = "flex";
    if (messagesList) messagesList.scrollTop = messagesList.scrollHeight;
    
    try {
      await fetch("/api/tickets/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, userName, message: msgText })
      });
      
      setTimeout(() => {
        fetchMessages(userId);
      }, 1600);
      
    } catch (err) {
      console.error("Gagal mengirim pesan tiket:", err);
    }
  });
}

function stopChatPolling() {
  if (chatPollInterval) {
    clearInterval(chatPollInterval);
    chatPollInterval = null;
  }
}


// ─── Admin Ticket Panel ───────────────────────────────────────────────
let adminChatPollInterval = null;
let adminRenderedIds = new Set();
let adminRenderedTargetId = "";

function openAdminTicketPanel(tgId) {
  const overlay = document.querySelector("#adminTicketOverlay");
  if (!overlay) return;
  overlay.style.display = "flex";
  const closeBtn = document.querySelector("#closeAdminTicketBtn");
  if (closeBtn) closeBtn.onclick = () => { overlay.style.display = "none"; stopAdminChatPolling(); };
  const backBtn = document.querySelector("#adminBackToListBtn");
  if (backBtn) backBtn.onclick = () => showAdminTicketList(tgId);
  showAdminTicketList(tgId);
}

async function showAdminTicketList(tgId) {
  const listView = document.querySelector("#adminTicketListView");
  const chatView = document.querySelector("#adminTicketChatView");
  const ticketList = document.querySelector("#adminTicketList");
  const countEl = document.querySelector("#adminTicketCount");
  stopAdminChatPolling();
  if (listView) listView.style.display = "block";
  if (chatView) chatView.style.display = "none";
  if (ticketList) ticketList.innerHTML = "<div class='admin-ticket-loading'>Memuat tiket...</div>";
  try {
    const res = await fetch("/api/tickets/list?tgId=" + encodeURIComponent(tgId));
    const data = await res.json();
    if (!data.ok) { if (ticketList) ticketList.innerHTML = "<div class='admin-ticket-empty'>Akses ditolak.</div>"; return; }
    const tickets = data.tickets || [];
    if (countEl) countEl.textContent = tickets.length + " tiket masuk";
    if (tickets.length === 0) { if (ticketList) ticketList.innerHTML = "<div class='admin-ticket-empty'>Belum ada tiket masuk.</div>"; return; }
    if (ticketList) {
      ticketList.innerHTML = tickets.map(function(t) {
        var ts = t.createdAt ? new Date(t.createdAt).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" }) : "-";
        var top = t.topic && t.topic.length > 55 ? t.topic.slice(0, 55) + "\u2026" : (t.topic || "-");
        return "<div class='admin-ticket-item' data-userid='" + escapeHtml(t.userId) + "' data-ticketcode='" + escapeHtml(t.ticketCode) + "' data-username='" + escapeHtml(t.userName) + "'>" +
          "<div class='admin-ticket-top'><span class='admin-ticket-code'>" + escapeHtml(t.ticketCode) + "</span><span class='admin-ticket-status status-open'>Open</span></div>" +
          "<div class='admin-ticket-user'><span class='ticket-field-label'>User</span><strong>" + escapeHtml(t.userName) + "</strong><span class='admin-ticket-uid'>" + escapeHtml(t.userId) + "</span></div>" +
          "<div class='admin-ticket-topic'><span class='ticket-field-label'>Kasus</span><span>" + escapeHtml(top) + "</span></div>" +
          "<div class='admin-ticket-time'><span class='ticket-field-label'>Masuk</span><span>" + ts + "</span></div></div>";
      }).join("");
      ticketList.querySelectorAll(".admin-ticket-item").forEach(function(item) {
        item.onclick = function() { showAdminTicketChat(tgId, item.dataset.userid, item.dataset.ticketcode, item.dataset.username); };
      });
    }
  } catch (err) { if (ticketList) ticketList.innerHTML = "<div class='admin-ticket-empty'>Gagal memuat tiket.</div>"; }
}

async function showAdminTicketChat(tgId, targetUserId, ticketCode, userName) {
  const listView = document.querySelector("#adminTicketListView");
  const chatView = document.querySelector("#adminTicketChatView");
  const ticketInfo = document.querySelector("#adminChatTicketInfo");
  if (listView) listView.style.display = "none";
  if (chatView) chatView.style.display = "flex";
  if (ticketInfo) {
    ticketInfo.innerHTML = "<strong>" + escapeHtml(ticketCode) + "</strong> \u2014 " + escapeHtml(userName) +
      "<button class='admin-ticket-done-btn' type='button' id='adminTicketDoneBtn'>Selesai</button>";
    const doneBtn = ticketInfo.querySelector("#adminTicketDoneBtn");
    if (doneBtn) {
      doneBtn.onclick = async function() {
        if (doneBtn.disabled) return;
        doneBtn.disabled = true;
        doneBtn.textContent = "Menutup...";
        try {
          const res = await fetch("/api/tickets/close", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetUserId, ticketCode, tgId: Number(tgId) })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            throw new Error(data.error || "Gagal menutup tiket");
          }
          stopAdminChatPolling();
          adminRenderedTargetId = "";
          adminRenderedIds = new Set();
          showAdminTicketList(tgId);
        } catch (error) {
          doneBtn.disabled = false;
          doneBtn.textContent = "Selesai";
          alert(error.message);
        }
      };
    }
  }
  if (adminRenderedTargetId !== targetUserId) {
    adminRenderedTargetId = targetUserId;
    adminRenderedIds = new Set();
    const chatMessages = document.querySelector("#adminChatMessages");
    if (chatMessages) chatMessages.innerHTML = "";
  }
  await loadAdminChatMessages(tgId, targetUserId);
  stopAdminChatPolling();
  adminChatPollInterval = setInterval(function() { loadAdminChatMessages(tgId, targetUserId); }, 3000);
  const oldForm = document.querySelector("#adminReplyForm");
  if (oldForm) {
    const newForm = oldForm.cloneNode(true);
    oldForm.parentNode.replaceChild(newForm, oldForm);
    newForm.onsubmit = async function(e) {
      e.preventDefault();
      const inp = newForm.querySelector("#adminReplyInput");
      const txt = inp ? inp.value.trim() : "";
      if (!txt) return;
      inp.value = ""; inp.disabled = true;
      try {
        await fetch("/api/tickets/admin-reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetUserId: targetUserId, replyText: txt, tgId: Number(tgId) })
        });
        await loadAdminChatMessages(tgId, targetUserId);
      } catch(e2) { console.error("Gagal kirim balasan:", e2); }
      finally { inp.disabled = false; inp.focus(); }
    };
  }
}

async function loadAdminChatMessages(tgId, targetUserId) {
  const chatMessages = document.querySelector("#adminChatMessages");
  if (!chatMessages) return;
  try {
    const res = await fetch("/api/tickets/chat?tgId=" + encodeURIComponent(tgId) + "&userId=" + encodeURIComponent(targetUserId));
    const data = await res.json();
    if (!data.ok) return;
    const msgs = data.messages || [];
    const atBottom = chatMessages.scrollHeight - chatMessages.scrollTop <= chatMessages.clientHeight + 60;
    if (msgs.length === 0 && adminRenderedIds.size === 0) {
      chatMessages.innerHTML = "<div style='text-align:center;padding:24px;opacity:0.5;'>Belum ada pesan dalam sesi ini.</div>";
    } else {
      const empty = chatMessages.querySelector(".admin-ticket-empty, [style*='Belum ada pesan']");
      if (empty) empty.remove();
      msgs.forEach((msg) => appendAdminChatBubble(msg));
    }
    if (atBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
  } catch(e) { console.error("Gagal memuat chat:", e); }
}

function stopAdminChatPolling() {
  if (adminChatPollInterval) { clearInterval(adminChatPollInterval); adminChatPollInterval = null; }
}
// ─────────────────────────────────────────────────────────────────────

async function fetchMessages(userId) {
  const indicator = document.querySelector("#chatTypingIndicator");
  
  try {
    const res = await fetch(`/api/tickets/messages?userId=${userId}`);
    const data = await res.json();
    if (res.ok && data.messages) {
      if (data.messages.length !== lastChatLength || data.messages.some((msg) => !chatRenderedIds.has(String(msg.id || `${msg.sender}-${msg.timestamp}-${msg.text}`)))) {
        if (indicator) indicator.style.display = "none";
        lastChatLength = data.messages.length;
        appendNewMessages(data.messages);
      }
    }
  } catch (err) {
    console.error("Gagal fetch pesan tiket:", err);
  }
}

function renderMessages(messages) {
  const messagesList = document.querySelector("#chatMessagesList");
  if (!messagesList) return;
  
  const systemWelcome = messagesList.querySelector(".chat-bubble.system");
  messagesList.innerHTML = "";
  chatRenderedIds = new Set();
  if (systemWelcome) {
    messagesList.appendChild(systemWelcome);
    const quickReplies = systemWelcome.querySelector(".chat-quick-replies");
    if (quickReplies) {
      quickReplies.style.display = messages.length > 0 ? "none" : "flex";
    }
  }
  
  messages.forEach(msg => {
    appendChatBubble(msg);
  });
  
  messagesList.scrollTop = messagesList.scrollHeight;
}

function appendNewMessages(messages) {
  const messagesList = document.querySelector("#chatMessagesList");
  if (!messagesList) return;

  const systemWelcome = messagesList.querySelector(".chat-bubble.system");
  if (systemWelcome) {
    const quickReplies = systemWelcome.querySelector(".chat-quick-replies");
    if (quickReplies) {
      quickReplies.style.display = messages.length > 0 ? "none" : "flex";
    }
  }

  const atBottom = messagesList.scrollHeight - messagesList.scrollTop <= messagesList.clientHeight + 80;
  messages.forEach((msg) => appendChatBubble(msg));
  if (atBottom) {
    messagesList.scrollTop = messagesList.scrollHeight;
  }
}

function appendChatBubble(msg) {
  const messagesList = document.querySelector("#chatMessagesList");
  if (!messagesList) return;
  const msgId = String(msg.id || `${msg.sender}-${msg.timestamp}-${msg.text}`);
  if (chatRenderedIds.has(msgId)) return;
  chatRenderedIds.add(msgId);
  
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${msg.sender}`;
  bubble.dataset.msgId = msgId;
  
  let label = "";
  if (msg.sender === "admin") label = "Admin";
  else if (msg.sender === "ai") label = "Virtual Assistant";
  else if (msg.sender === "user") label = "Anda";
  
  const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : "";
  
  bubble.innerHTML = `
    ${label ? `<span class="chat-sender-label">${label}</span>` : ""}
    ${msg.imageUrl ? `<img src="${msg.imageUrl}" style="max-width: 100%; border-radius: 8px; margin-bottom: 6px; display: block; max-height: 180px; object-fit: contain;">` : ""}
    <p>${escapeHtml(msg.text)}</p>
    ${msg.offerTicket ? `
      <div class="chat-ticket-offer" style="margin-top: 10px;">
        <button class="primary-btn purple-btn open-ticket-btn" type="button" style="width: 100%; min-height: 38px; font-size: 12px; font-weight: 700; margin-bottom: 4px;">Hubungi Admin (Buka Tiket)</button>
      </div>
    ` : ""}
    ${msg.offerButtons ? `
      <div class="chat-quick-replies" style="margin-top: 10px;">
        <button class="quick-reply-btn" type="button" data-topic="VIP Belum Aktif / Masuk">VIP Belum Aktif / Masuk</button>
        <button class="quick-reply-btn" type="button" data-topic="Video Loading Lama / Buffering">Video Loading Lama / Buffering</button>
        <button class="quick-reply-btn" type="button" data-topic="Video Error / Tidak Bisa Diputar">Video Error / Tidak Bisa Diputar</button>
        <button class="quick-reply-btn" type="button" data-topic="Tanya hal lain ke Admin">Tanya Hal Lain</button>
      </div>
    ` : ""}
    ${timeStr ? `<span class="chat-time">${timeStr}</span>` : ""}
  `;
  
  messagesList.appendChild(bubble);
}

function appendAdminChatBubble(msg) {
  const chatMessages = document.querySelector("#adminChatMessages");
  if (!chatMessages) return;
  const msgId = String(msg.id || `${msg.sender}-${msg.timestamp}-${msg.text}`);
  if (adminRenderedIds.has(msgId)) return;
  adminRenderedIds.add(msgId);

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble " + msg.sender;
  bubble.dataset.msgId = msgId;
  const lbl = msg.sender === "admin" ? "Admin (Anda)" : msg.sender === "ai" ? "AI" : msg.sender === "system" ? "Sistem" : "User";
  const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : "";
  const img = msg.imageUrl ? "<img src='" + msg.imageUrl + "' style='max-width:100%;border-radius:8px;margin-bottom:6px;display:block;max-height:160px;object-fit:contain;'>" : "";
  bubble.innerHTML = "<span class='chat-sender-label'>" + lbl + "</span>" + img + "<p>" + escapeHtml(msg.text) + "</p>" + (ts ? "<span class='chat-time'>" + ts + "</span>" : "");
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ==========================================
// MOVIEBOX INTEGRATION FRONTEND CONTROLLERS
// ==========================================

let movieboxSelectedTab = "home";
let movieboxHomeData = null;
let movieboxSearchResults = [];
let movieboxSearchQuery = "";
let movieboxDetailCache = new Map();
let movieboxSelectedSeason = 1;
let selectedMovieboxResolution = Number(localStorage.getItem("TEAMDLMovieboxResolution") || "360");

const MOVIEBOX_FILTER_OPTIONS = {
  genre: [
    "All", "Action", "Adventure", "Animation", "Biography", "Comedy", "Crime", "Documentary", 
    "Drama", "Family", "Fantasy", "Film-Noir", "Game-Show", "History", "Horror", "Music", 
    "Musical", "Mystery", "News", "Reality-TV", "Romance", "Sci-Fi", "Short", "Sport", 
    "Talk-Show", "Thriller", "War", "Western", "Other"
  ],
  country: [
    "All", "United States", "United Kingdom", "France", "Japan", "China", "Korea", "Other"
  ],
  seriesCountry: [
    "All", "United States", "United Kingdom", "Korea", "Japan", "Bangladesh", "China", "Egypt",
    "France", "Germany", "India", "Indonesia", "Iraq", "Italy", "Ivory Coast", "Kenya",
    "Lebanon", "Mexico", "Morocco", "Nigeria", "Pakistan", "Philippines", "Russia",
    "Saudi Arabia", "South Africa", "Spain", "Syria", "Thailand", "Malaysia", "Turkey", "Other"
  ],
  year: [
    "All", "2026", "2025", "2024", "2023", "2022", "2021", "2020", "2010s", "2000s", "1990s", "1980s", "Other"
  ],
  language: [
    "All", "English dub", "French dub", "Hindi dub", "Bengali dub", "Urdu dub", "Punjabi dub", 
    "Tamil dub", "Telugu dub", "Malayalam dub", "Kannada dub", "Arabic dub", "Arabic sub", 
    "Tagalog dub", "Indonesian dub", "Russian dub", "Kurdish sub", "Spanish dub", "Spanish sub", "SpanishLatam dub"
  ],
  sort: [
    "ForYou", "Hottest", "Latest", "Rating"
  ]
};

let movieboxFilters = {
  genre: "All",
  country: "All",
  year: "All",
  language: "All",
  sort: "ForYou"
};
let movieboxFilterPage = 1;
let movieboxFilterItems = [];
let movieboxFilterHasMore = false;
let movieboxFilterLoading = false;
let movieboxShortDramaPage = 1;
let movieboxShortDramaItems = [];
let movieboxShortDramaHasMore = false;
let movieboxShortDramaLoading = false;


// Render the filter panel rows
function renderMovieboxFilterPanel() {
  const isSeriesTab = movieboxSelectedTab === "series";
  const keys = isSeriesTab ? ["genre", "country", "year", "language", "sort"] : ["country", "year", "sort"];
  const labels = {
    genre: "Genre",
    country: "Country",
    year: "Year",
    language: "Language",
    sort: "Sort by"
  };

  let html = `<div class="moviebox-filter-panel" style="padding: 16px; display: flex; flex-direction: column; gap: 12px; background: rgba(255,255,255,0.02); border-radius: 12px; border: 1px solid rgba(255,255,255,0.05); margin: 0 16px 20px 16px;">`;
  
  for (const key of keys) {
    const options = isSeriesTab && key === "country" ? MOVIEBOX_FILTER_OPTIONS.seriesCountry : MOVIEBOX_FILTER_OPTIONS[key];
    const currentVal = movieboxFilters[key];
    
    html += `
      <div class="filter-row" style="display: flex; gap: 16px; align-items: flex-start; line-height: 28px;">
        <span class="filter-label" style="min-width: 80px; color: rgba(255,255,255,0.4); font-size: 14px; font-weight: 600; text-transform: capitalize;">${labels[key]}</span>
        <div class="filter-options" style="display: flex; flex-wrap: wrap; gap: 8px 16px; flex: 1;">
          ${options.map(opt => {
            const active = opt === currentVal;
            return `<button class="filter-pill-btn ${active ? 'active' : ''}" data-filter-key="${key}" data-filter-value="${escapeHtml(opt)}" style="background: none; border: none; color: ${active ? '#000' : 'rgba(255,255,255,0.7)'}; background-color: ${active ? '#fff' : 'transparent'}; padding: 4px 12px; border-radius: 20px; font-size: 14px; cursor: pointer; transition: all 0.2s; font-weight: ${active ? '700' : '400'}; line-height: 20px;">${escapeHtml(opt)}</button>`;
          }).join("")}
        </div>
      </div>
    `;
  }
  
  html += `</div>`;
  return html;
}

// Fetch the items based on filter parameters
async function fetchFilteredMovieboxItems(append = false) {
  if (movieboxFilterLoading) return;
  movieboxFilterLoading = true;
  
  const gridContainer = document.querySelector("#movieboxFilteredItemsGrid");
  const loadMoreBtn = document.querySelector("#movieboxLoadMoreFiltersBtn");
  
  if (!append) {
    movieboxFilterPage = 1;
    movieboxFilterItems = [];
    if (gridContainer) {
      gridContainer.innerHTML = loadingCatalogGrid(12);
    }
    if (loadMoreBtn) {
      loadMoreBtn.style.display = "none";
    }
  } else {
    if (loadMoreBtn) {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = "Memuat...";
    }
  }
  
  const isAnimeTab = movieboxSelectedTab === "anime";
  const isSeriesTab = movieboxSelectedTab === "series";
  const subjectType = isAnimeTab || isSeriesTab ? "2" : "1";
  const genre = isAnimeTab ? "Animation" : movieboxFilters.genre;
  const emptyLabel = isAnimeTab ? "anime" : isSeriesTab ? "series TV" : "film";

  try {
    const params = new URLSearchParams({
      page: String(movieboxFilterPage),
      perPage: "24",
      subjectType,
      genre,
      country: movieboxFilters.country,
      year: movieboxFilters.year,
      language: movieboxFilters.language,
      sort: movieboxFilters.sort,
      animeOnly: isAnimeTab ? "1" : "0",
      seriesOnly: isSeriesTab ? "1" : "0"
    });
    
    const res = await fetch(`/api/moviebox/filter?${params.toString()}`);
    const data = await res.json();
    
    const items = data.items || [];
    movieboxFilterHasMore = !!data.hasMore;
    
    if (append) {
      movieboxFilterItems = movieboxFilterItems.concat(items);
    } else {
      movieboxFilterItems = items;
    }
    
    if (gridContainer) {
      if (!append) {
        gridContainer.innerHTML = movieboxFilterItems.length 
          ? movieboxFilterItems.map(movieboxCard).join("") 
          : `<div class="empty-state" style="grid-column: 1/-1;">Tidak ada ${emptyLabel} yang cocok dengan filter.</div>`;
      } else {
        gridContainer.insertAdjacentHTML("beforeend", items.map(movieboxCard).join(""));
      }
    }
    
    if (loadMoreBtn) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = "Load More";
      loadMoreBtn.style.display = movieboxFilterHasMore ? "inline-block" : "none";
    }
  } catch (err) {
    console.error("Gagal memuat konten MovieBox terfilter:", err);
    if (gridContainer && !append) {
      gridContainer.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;">Gagal memuat konten. Silakan coba lagi.</div>`;
    }
  } finally {
    movieboxFilterLoading = false;
  }
}

// Render the grid structure under filter panel
function renderFilteredItemsGrid() {
  return `
    <div id="movieboxFilteredItemsGrid" class="catalog-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 16px; padding: 0 16px;">
      <!-- Loaded dynamically -->
    </div>
    <div style="text-align: center; margin: 24px 0 80px 0;">
      <button id="movieboxLoadMoreFiltersBtn" class="primary-btn" style="display: none; background: rgba(255,255,255,0.05); color: #fff; border: 1px solid rgba(255,255,255,0.1); border-radius: 30px; padding: 10px 24px; cursor: pointer; font-weight: bold; transition: all 0.2s;">Load More</button>
    </div>
  `;
}

async function fetchMovieboxShortDramaItems(append = false) {
  if (movieboxShortDramaLoading) return;
  movieboxShortDramaLoading = true;

  const gridContainer = document.querySelector("#movieboxFilteredItemsGrid");
  const loadMoreBtn = document.querySelector("#movieboxLoadMoreFiltersBtn");

  if (!append) {
    movieboxShortDramaPage = 1;
    movieboxShortDramaItems = [];
    if (gridContainer) {
      gridContainer.innerHTML = loadingCatalogGrid(12);
    }
    if (loadMoreBtn) {
      loadMoreBtn.style.display = "none";
    }
  } else if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Memuat...";
  }

  try {
    const params = new URLSearchParams({
      page: String(movieboxShortDramaPage),
      perPage: "24",
      id: "567783349092340776"
    });
    const res = await fetch(`/api/moviebox/short-drama?${params.toString()}`);
    const data = await res.json();
    const items = data.items || [];
    movieboxShortDramaHasMore = !!data.hasMore;

    if (append) {
      movieboxShortDramaItems = movieboxShortDramaItems.concat(items);
    } else {
      movieboxShortDramaItems = items;
    }

    if (gridContainer) {
      if (append) {
        gridContainer.insertAdjacentHTML("beforeend", items.map(movieboxCard).join(""));
      } else {
        gridContainer.innerHTML = movieboxShortDramaItems.length
          ? movieboxShortDramaItems.map(movieboxCard).join("")
          : `<div class="empty-state" style="grid-column: 1/-1;">Tidak ada short drama yang tersedia.</div>`;
      }
    }

    if (loadMoreBtn) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = "Load More";
      loadMoreBtn.style.display = movieboxShortDramaHasMore ? "inline-block" : "none";
    }
  } catch (err) {
    console.error("Gagal memuat Short Drama MovieBox:", err);
    if (gridContainer && !append) {
      gridContainer.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;">Gagal memuat Short Drama. Silakan coba lagi.</div>`;
    }
  } finally {
    movieboxShortDramaLoading = false;
  }
}


function renderMovieboxHeader(hasTopSpace = true) {
  return `
    <section class="explore-panel ${hasTopSpace ? 'top-space' : ''}" style="${hasTopSpace ? '' : 'padding-top: 16px;'}">
      <p style="color: #e9a300; font-weight: bold; letter-spacing: 2px; margin-bottom: 4px;">MOVIEBOX PLATFORM</p>
      <h1 style="margin-bottom: 20px;">Streaming Film, TV & Anime</h1>
      <div class="platform-chips" style="margin-bottom: 24px; display: flex; flex-wrap: wrap; gap: 8px;">
        <button class="tab-btn ${movieboxSelectedTab === 'home' ? 'active' : ''}" data-moviebox-tab="home" style="border-radius:20px; padding: 8px 16px; font-weight:600; cursor:pointer; background: ${movieboxSelectedTab === 'home' ? '#e9a300' : 'rgba(255,255,255,0.05)'}; color: ${movieboxSelectedTab === 'home' ? '#000' : '#fff'}; border: none; transition: all 0.2s;">🏠 Home</button>
        <button class="tab-btn ${movieboxSelectedTab === 'movies' ? 'active' : ''}" data-moviebox-tab="movies" style="border-radius:20px; padding: 8px 16px; font-weight:600; cursor:pointer; background: ${movieboxSelectedTab === 'movies' ? '#e9a300' : 'rgba(255,255,255,0.05)'}; color: ${movieboxSelectedTab === 'movies' ? '#000' : '#fff'}; border: none; transition: all 0.2s;">🎬 Movies</button>
        <button class="tab-btn ${movieboxSelectedTab === 'series' ? 'active' : ''}" data-moviebox-tab="series" style="border-radius:20px; padding: 8px 16px; font-weight:600; cursor:pointer; background: ${movieboxSelectedTab === 'series' ? '#e9a300' : 'rgba(255,255,255,0.05)'}; color: ${movieboxSelectedTab === 'series' ? '#000' : '#fff'}; border: none; transition: all 0.2s;">📺 TV Series</button>
        <button class="tab-btn ${movieboxSelectedTab === 'anime' ? 'active' : ''}" data-moviebox-tab="anime" style="border-radius:20px; padding: 8px 16px; font-weight:600; cursor:pointer; background: ${movieboxSelectedTab === 'anime' ? '#e9a300' : 'rgba(255,255,255,0.05)'}; color: ${movieboxSelectedTab === 'anime' ? '#000' : '#fff'}; border: none; transition: all 0.2s;">🌸 Anime</button>
        <button class="tab-btn ${movieboxSelectedTab === 'shortdrama' ? 'active' : ''}" data-moviebox-tab="shortdrama" style="border-radius:20px; padding: 8px 16px; font-weight:600; cursor:pointer; background: ${movieboxSelectedTab === 'shortdrama' ? '#e9a300' : 'rgba(255,255,255,0.05)'}; color: ${movieboxSelectedTab === 'shortdrama' ? '#000' : '#fff'}; border: none; transition: all 0.2s;">Short Drama</button>
        <button class="tab-btn ${movieboxSelectedTab === 'search' ? 'active' : ''}" data-moviebox-tab="search" style="border-radius:20px; padding: 8px 16px; font-weight:600; cursor:pointer; background: ${movieboxSelectedTab === 'search' ? '#e9a300' : 'rgba(255,255,255,0.05)'}; color: ${movieboxSelectedTab === 'search' ? '#000' : '#fff'}; border: none; transition: all 0.2s;">🔍 Search</button>
        <button class="tab-btn ${movieboxSelectedTab === 'join-room' ? 'active' : ''}" data-moviebox-tab="join-room" style="border-radius:20px; padding: 8px 16px; font-weight:600; cursor:pointer; background: ${movieboxSelectedTab === 'join-room' ? '#e9a300' : 'rgba(255,255,255,0.05)'}; color: ${movieboxSelectedTab === 'join-room' ? '#000' : '#fff'}; border: none; transition: all 0.2s;">👥 Gabung Room</button>
      </div>
    </section>
  `;
}

async function renderMovieboxHome(tab = null) {
  const params = new URLSearchParams(location.search);
  const urlTab = params.get("tab");
  if (tab) {
    movieboxSelectedTab = tab;
  } else if (urlTab) {
    movieboxSelectedTab = urlTab;
  }
  
  if (window.movieboxBannerInterval) {
    clearInterval(window.movieboxBannerInterval);
    window.movieboxBannerInterval = null;
  }

  if (movieboxSelectedTab === "search") {
    const headerHtml = renderMovieboxHeader(true);
    app.innerHTML = `
      ${headerHtml}
      <section class="page-section" style="max-width: 600px; margin: 0 auto 30px auto; padding: 0 16px;">
        <form id="movieboxSearchForm" style="display: flex; gap: 8px; width: 100%;">
          <input type="text" id="movieboxSearchInput" placeholder="Cari film, serial TV, anime..." value="${escapeHtml(movieboxSearchQuery)}" required style="flex: 1; padding: 12px 18px; border-radius: 30px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 16px; outline: none; transition: border-color 0.2s;">
          <button type="submit" style="padding: 12px 24px; border-radius: 30px; background: linear-gradient(135deg, #e9a300, #ff7b00); color: #000; font-weight: bold; border: none; cursor: pointer; transition: transform 0.2s;">Cari</button>
        </form>
      </section>
      <section class="page-section" id="movieboxSearchResultsSection" style="padding-bottom: 80px;">
        ${renderMovieboxSearchGrid()}
      </section>
    `;
    return;
  }

  if (movieboxSelectedTab === "join-room") {
    const headerHtml = renderMovieboxHeader(true);
    app.innerHTML = `
      ${headerHtml}
      <section class="page-section join-room-section">
        <div class="watch-party-join-card" style="background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); padding: 32px 24px; border-radius: 24px; text-align: center; box-shadow: 0 15px 35px rgba(0,0,0,0.3); backdrop-filter: blur(16px);">
          <p style="color: #e9a300; font-weight: 800; font-size: 13px; letter-spacing: 2px; margin-bottom: 8px; text-transform: uppercase;">Watch Party</p>
          <h2 style="font-size: 24px; margin-bottom: 20px; color: #fff; font-weight: 800;">Gabung Nonton Bareng</h2>
          <form id="movieboxJoinRoomForm" style="display: flex; flex-direction: column; gap: 16px;">
            <div style="text-align: left;">
              <label for="movieboxRoomCodeInput" style="display: block; font-size: 13px; color: rgba(255,255,255,0.6); margin-bottom: 8px; font-weight: 600;">Masukkan Kode Room</label>
              <input type="text" id="movieboxRoomCodeInput" placeholder="Contoh: ABC123" maxlength="8" required autocomplete="off" style="width: 100%; padding: 14px 18px; border-radius: 30px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 16px; outline: none; transition: border-color 0.2s; box-sizing: border-box; text-align: center; text-transform: uppercase; font-weight: bold; letter-spacing: 1px;">
            </div>
            <button type="submit" style="padding: 14px 24px; border-radius: 30px; background: linear-gradient(135deg, #e9a300, #ff7b00); color: #000; font-weight: bold; border: none; cursor: pointer; transition: transform 0.2s; font-size: 15px;">Gabung Room</button>
          </form>
        </div>

        <div class="active-rooms-container" style="background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); padding: 24px; border-radius: 24px; box-shadow: 0 15px 35px rgba(0,0,0,0.3); backdrop-filter: blur(16px);">
          <h3 style="font-size: 18px; color: #fff; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; justify-content: space-between;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span>🌐 Room yang Sedang Berjalan</span>
              <span class="active-dot" style="width: 8px; height: 8px; background: #22c55e; border-radius: 50%; display: inline-block; animation: pulse 2s infinite;"></span>
            </div>
            <button onclick="fetchActiveWatchPartyRooms()" style="background: none; border: none; color: #e9a300; font-size: 13px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 4px;">🔄 Refresh</button>
          </h3>
          <div id="activeRoomsList" style="display: flex; flex-direction: column; gap: 12px;">
            <div style="text-align: center; padding: 20px; color: rgba(255,255,255,0.4);">Memuat daftar room...</div>
          </div>
        </div>
      </section>
    `;
    fetchActiveWatchPartyRooms();
    return;
  }

  if (!movieboxHomeData) {
    const headerHtml = renderMovieboxHeader(true);
    app.innerHTML = `
      ${headerHtml}
      ${loadingHero("catalog")}
      <section class="page-section">
        <div class="section-head"><h2>Memuat konten MovieBox...</h2></div>
        ${loadingCatalogGrid(12)}
      </section>
    `;
    try {
      const res = await fetch(`/api/moviebox/home?t=${Date.now()}`);
      movieboxHomeData = await res.json();
      renderMovieboxHome();
    } catch (err) {
      console.error(err);
      const headerHtmlErr = renderMovieboxHeader(true);
      app.innerHTML = `
        ${headerHtmlErr}
        <section class="page-section">
          <div class="empty-state">Gagal memuat data dari server. Harap coba lagi nanti.</div>
        </section>
      `;
    }
    return;
  }

  if (movieboxSelectedTab === "home") {
    const banner = movieboxHomeData.banner || [];
    const trending = movieboxHomeData.trending || [];
    const movies = movieboxHomeData.latest_movies || [];
    const series = movieboxHomeData.latest_series || [];
    const anime = movieboxHomeData.latest_anime || [];
    
    // Combine banner & trending for slideshow
    const bannerList = banner.length ? banner : (trending.length ? trending.slice(0, 5) : movies.slice(0, 5));
    
    let heroHtml = "";
    const hasBanner = bannerList.length > 0;
    
    if (hasBanner) {
      heroHtml = `
        <section id="movieboxHeroBanner" class="hero hero-gold" style="position: relative; overflow: hidden; border-radius: 16px; margin: 16px; background: #111; min-height: 280px; padding: 0; transition: opacity 0.3s ease-in-out; opacity: 1;">
          <!-- Slides loaded dynamically -->
        </section>
      `;
    }

    const headerHtml = renderMovieboxHeader(false);

    app.innerHTML = `
      <div class="top-space" style="display: flex; flex-direction: column;">
        ${heroHtml}
        ${headerHtml}
        <div style="padding-bottom: 80px;">
          ${trending.length ? movieboxSection("Trending Sekarang 🔥", trending) : ""}
          ${movies.length ? movieboxSection("Movies Rekomendasi 🎬", movies) : ""}
          ${series.length ? movieboxSection("TV Series Terbaru 📺", series) : ""}
          ${anime.length ? movieboxSection("Anime Terpopuler 🌸", anime) : ""}
        </div>
      </div>
    `;

    // Initialize auto slideshow
    if (hasBanner) {
      const bannerContainer = document.querySelector("#movieboxHeroBanner");
      if (bannerContainer) {
        let currentIndex = 0;
        const updateSlide = () => {
          const hero = bannerList[currentIndex];
          if (!hero) return;
          
          bannerContainer.style.opacity = "0.7";
          setTimeout(() => {
            bannerContainer.innerHTML = `
              <div class="hero-art" style="position: absolute; inset:0; z-index:1; opacity:0.4; filter: blur(2px); background-size: cover; background-position: center; background-image: url('${hero.poster}');"></div>
              <div class="hero-shade" style="position: absolute; inset:0; z-index:2; background: linear-gradient(to top, rgba(0,0,0,0.95), transparent);"></div>
              <div class="hero-copy" style="position: relative; z-index:3; padding: 80px 30px 40px 30px; max-width: 600px;">
                <div class="meta-line" style="display:flex; gap: 8px; align-items:center; margin-bottom: 12px; font-size:12px; color: #e9a300;">
                  <span class="badge" style="background: rgba(233, 163, 0, 0.2); padding: 4px 8px; border-radius:4px; font-weight:bold;">TRENDING #${currentIndex + 1}</span>
                  ${hero.year ? `<span>${hero.year}</span>` : ""}
                  ${hero.rating ? `<span>⭐ ${hero.rating}</span>` : ""}
                </div>
                <h1 style="font-size: 32px; font-weight: 800; line-height: 1.2; margin-bottom: 16px; text-shadow: 0 2px 4px rgba(0,0,0,0.5);">${escapeHtml(hero.title)}</h1>
                <div class="button-row" style="display:flex; gap:12px; margin-top:20px;">
                  <a class="primary-btn" href="/moviebox/detail/${hero.id}" style="background: linear-gradient(135deg, #e9a300, #ff7b00); color:#000; font-weight:bold; border-radius:30px; padding:10px 24px; text-decoration:none; display:inline-block; transition: transform 0.2s;">Detail Info</a>
                </div>
              </div>
            `;
            bannerContainer.style.opacity = "1";
          }, 300);
          
          currentIndex = (currentIndex + 1) % bannerList.length;
        };
        
        updateSlide();
        window.movieboxBannerInterval = setInterval(updateSlide, 5000);
      }
    }
  } else if (movieboxSelectedTab === "movies") {
    const headerHtml = renderMovieboxHeader(true);
    app.innerHTML = `
      ${headerHtml}
      <section class="page-section" style="padding-bottom: 20px;">
        ${renderMovieboxFilterPanel()}
      </section>
      <section class="page-section">
        ${renderFilteredItemsGrid()}
      </section>
    `;
    fetchFilteredMovieboxItems(false);
  } else if (movieboxSelectedTab === "series") {
    const headerHtml = renderMovieboxHeader(true);
    app.innerHTML = `
      ${headerHtml}
      <section class="page-section" style="padding-bottom: 20px;">
        ${renderMovieboxFilterPanel()}
      </section>
      <section class="page-section">
        ${renderFilteredItemsGrid()}
      </section>
    `;
    fetchFilteredMovieboxItems(false);
  } else if (movieboxSelectedTab === "anime") {
    const headerHtml = renderMovieboxHeader(true);
    app.innerHTML = `
      ${headerHtml}
      <section class="page-section" style="padding-bottom: 20px;">
        ${renderMovieboxFilterPanel()}
      </section>
      <section class="page-section">
        ${renderFilteredItemsGrid()}
      </section>
    `;
    fetchFilteredMovieboxItems(false);
  } else if (movieboxSelectedTab === "shortdrama") {
    const headerHtml = renderMovieboxHeader(true);
    app.innerHTML = `
      ${headerHtml}
      <section class="page-section" style="padding-bottom: 20px;">
        <div class="section-head" style="padding: 0 16px 12px 16px;">
          <div>
            <h2>Short Drama</h2>
            <p class="muted">Ranking Short TV dari MovieBox.</p>
          </div>
        </div>
      </section>
      <section class="page-section">
        ${renderFilteredItemsGrid()}
      </section>
    `;
    fetchMovieboxShortDramaItems(false);
  }
}

window.switchMovieboxTab = function(tab) {
  movieboxSelectedTab = tab;
  renderMovieboxHome();
};

window.handleMovieboxSearch = async function(event) {
  event.preventDefault();
  const input = document.querySelector("#movieboxSearchInput");
  if (!input) return;
  movieboxSearchQuery = input.value.trim();
  
  const gridSection = document.querySelector("#movieboxSearchResultsSection");
  if (gridSection) {
    gridSection.innerHTML = `
      <div class="section-head"><h2>Mencari "${escapeHtml(movieboxSearchQuery)}"...</h2></div>
      ${loadingCatalogGrid(6)}
    `;
  }

  try {
    const res = await fetch(`/api/moviebox/search?q=${encodeURIComponent(movieboxSearchQuery)}`);
    const json = await res.json();
    movieboxSearchResults = json.results || [];
  } catch (err) {
    console.error(err);
    movieboxSearchResults = [];
  }

  if (gridSection) {
    gridSection.innerHTML = renderMovieboxSearchGrid();
  }
};

function renderMovieboxSearchGrid() {
  if (!movieboxSearchQuery) {
    return `<div class="empty-state" style="padding: 40px 16px;">Ketik kata kunci pencarian di atas untuk memulai.</div>`;
  }
  if (!movieboxSearchResults.length) {
    return `<div class="empty-state" style="padding: 40px 16px;">Tidak ada hasil ditemukan untuk "${escapeHtml(movieboxSearchQuery)}".</div>`;
  }
  return `
    <div class="section-head" style="padding: 0 16px 12px 16px;"><h2>Hasil Pencarian</h2></div>
    ${movieboxGrid(movieboxSearchResults)}
  `;
}

function movieboxSection(title, items) {
  return `
    <section class="page-section" style="margin-bottom: 24px;">
      <div class="section-head" style="padding: 0 16px 8px 16px;">
        <h2>${title}</h2>
      </div>
      <div class="platform-rail" style="display:flex; overflow-x: auto; gap: 16px; padding: 10px 16px; scrollbar-width: none;">
        ${items.map(movieboxCard).join("")}
      </div>
    </section>
  `;
}

function movieboxGrid(items) {
  if (!items.length) return `<div class="empty-state">Belum ada judul yang tersedia saat ini.</div>`;
  return `
    <div class="catalog-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 16px; padding: 0 16px;">
      ${items.map(movieboxCard).join("")}
    </div>
  `;
}

function movieboxCard(item) {
  const detailId = item.detailPath || item.id || item.subjectId;
  if (!detailId) return "";
  return `
    <a class="drama-card poster-card" href="/moviebox/detail/${encodeURIComponent(detailId)}" style="text-decoration:none; display:flex; flex-direction:column; gap:6px; flex-shrink: 0; width: 130px;">
      <div class="poster" style="position:relative; aspect-ratio: 2/3; border-radius:8px; overflow:hidden; background:#222; box-shadow: 0 4px 10px rgba(0,0,0,0.3);">
        <img src="${item.poster}" alt="${escapeHtml(item.title)}" referrerpolicy="no-referrer" loading="lazy" style="width:100%; height:100%; object-fit:cover;">
        ${item.rating ? `<span class="rating-tag" style="position:absolute; top:8px; right:8px; background: rgba(0,0,0,0.8); padding: 2px 6px; border-radius:4px; font-size:10px; color:#e9a300; font-weight:bold; z-index: 2; display: inline-flex; align-items: center; gap: 2px; line-height: 1; max-width: none;">⭐ ${item.rating}</span>` : ""}
      </div>
      <strong style="font-size:14px; font-weight: 600; color: #fff; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height:1.2;">${escapeHtml(item.title)}</strong>
      ${item.year ? `<small style="font-size:12px; color:rgba(255,255,255,0.5);">${item.year}</small>` : ""}
    </a>
  `;
}

async function renderMovieboxDetail(id, forceSeason = null) {
  if (forceSeason !== null) {
    movieboxSelectedSeason = forceSeason;
  } else {
    const cached = movieboxDetailCache.get(id);
    if (!cached || cached.selectedSeason === undefined) {
      movieboxSelectedSeason = 1;
    } else {
      movieboxSelectedSeason = cached.selectedSeason;
    }
  }

  app.innerHTML = `
    <section class="detail-shell loading-detail">
      <div class="detail-poster skeleton-block"></div>
      <div class="detail-copy">
        <div class="skeleton-line short"></div>
        <div class="skeleton-line title"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line wide"></div>
      </div>
    </section>
    <section class="episodes-panel">
      <div class="section-head"><h2>Episodes</h2></div>
      ${loadingEpisodeGrid(40)}
    </section>
  `;

  try {
    const res = await fetch(`/api/moviebox/detail/${encodeURIComponent(id)}?se=${movieboxSelectedSeason}&t=${Date.now()}`);
    const data = await res.json();
    if (data.error) {
      app.innerHTML = `
        <section class="page-section top-space">
          <div class="empty-state">
            <h1>Error</h1>
            <p>${escapeHtml(data.error)}</p>
            <a class="primary-btn" href="/moviebox" style="margin-top:20px; background: linear-gradient(135deg, #e9a300, #ff7b00); color:#000; text-decoration:none; display:inline-block; border-radius:30px; padding:10px 24px;">Kembali ke MovieBox</a>
          </div>
        </section>
      `;
      return;
    }

    movieboxDetailCache.set(id, { ...data, selectedSeason: movieboxSelectedSeason });

    const genresText = data.genres && data.genres.length ? data.genres.join(", ") : "MovieBox Catalog";
    const seasons = data.seasons || [];

    let seasonDropdownHtml = "";
    if (seasons.length > 1) {
      seasonDropdownHtml = `
        <div class="season-selector" style="margin-top:16px;">
          <label for="movieboxSeasonSelect" style="font-size:14px; color:rgba(255,255,255,0.6); margin-right:8px;">Season:</label>
          <select id="movieboxSeasonSelect" data-detail-id="${id}" style="background:#222; color:#fff; border:1px solid rgba(255,255,255,0.15); padding:6px 12px; border-radius:4px; cursor:pointer;">
            ${seasons.map(s => `<option value="${s.se}" ${Number(s.se) === Number(movieboxSelectedSeason) ? 'selected' : ''}>Season ${s.se} (${s.maxEp || s.epNum} Episode)</option>`).join("")}
          </select>
        </div>
      `;
    }

    const episodesList = data.episodes || [];
    let episodesMarkup = "";
    if (episodesList.length === 0) {
      episodesMarkup = `<div class="empty-state">Belum ada episode yang diunggah untuk season ini.</div>`;
    } else {
      episodesMarkup = `
        <div class="episode-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 12px; padding: 0 16px 80px 16px;">
          ${episodesList.map(ep => {
            const watchUrl = `/moviebox/watch/${id}?se=${movieboxSelectedSeason}&ep=${ep.episode_number}&resourceId=${ep.resourceId}`;
            return `<a class="episode-link" href="${watchUrl}" style="display:flex; justify-content:center; align-items:center; height:45px; border-radius:6px; background: rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); color:#fff; font-weight:600; text-decoration:none; transition:all 0.2s;">Ep ${ep.episode_number}</a>`;
          }).join("")}
        </div>
      `;
    }

    const isFav = !!localFavorites[id];
    const favText = isFav ? "Favorit" : "Tambah Favorit";
    const favStyle = `border-radius:30px; padding:10px 24px; min-height:42px; cursor:pointer; font-family:inherit; box-sizing:border-box; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; ${isFav ? 'border-color:#e9a300; color:#e9a300; background:rgba(233,163,0,0.1); font-weight:bold;' : ''}`;

    app.innerHTML = `
      <section class="detail-shell">
        <div class="detail-poster" style="position:relative; aspect-ratio: 2/3; border-radius:12px; overflow:hidden; background:#222; box-shadow:0 8px 24px rgba(0,0,0,0.5);">
          <img src="${data.poster}" alt="${escapeHtml(data.title)}" referrerpolicy="no-referrer" style="width:100%; height:100%; object-fit:cover;">
        </div>
        <div class="detail-copy">
          <div class="meta-line gold" style="display:flex; gap:10px; align-items:center; font-size:13px; color:#e9a300; margin-bottom:12px;">
            <span>MOVIEBOX</span>
            ${data.rating ? `<span>⭐ ${data.rating}</span>` : ""}
            ${data.year ? `<span>${data.year}</span>` : ""}
          </div>
          <h1 style="font-size:32px; font-weight:800; line-height:1.2; margin-bottom:12px;">${escapeHtml(data.title)}</h1>
          <p class="genre" style="font-size:14px; color:rgba(255,255,255,0.5); margin-bottom:16px;">${escapeHtml(genresText)}</p>
          <p style="font-size:15px; line-height:1.5; color:rgba(255,255,255,0.8); margin-bottom:20px;">${escapeHtml(data.description)}</p>
          ${seasonDropdownHtml}
          <div class="button-row detail-actions moviebox-detail-actions" style="margin-top:24px; display:flex; gap:12px; flex-wrap:wrap; align-items:center; width:100%; max-width:none;">
            ${episodesList.length > 0 ? `<a class="primary-btn gold-btn" href="/moviebox/watch/${id}?se=${movieboxSelectedSeason}&ep=1&resourceId=${episodesList[0].resourceId}" style="background: linear-gradient(135deg, #e9a300, #ff7b00); color:#000; font-weight:bold; border-radius:30px; padding:10px 24px; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; min-height:42px; box-sizing:border-box;">Watch Now</a>` : ""}
            ${episodesList.length > 0 ? `<a class="watch-together" href="/watch-party/${id}?se=${movieboxSelectedSeason}&ep=1&resourceId=${episodesList[0].resourceId}" style="box-sizing:border-box; min-height:42px;">Nonton Bareng</a>` : ""}
            <button class="glass-btn" id="movieboxFavBtn" style="${favStyle}">${favText}</button>
            <button class="glass-btn" id="movieboxShareBtn" style="border-radius:30px; padding:10px 24px; min-height:42px; cursor:pointer; font-family:inherit; box-sizing:border-box; text-decoration:none; display:inline-flex; align-items:center; justify-content:center;">Share</button>
            <a class="glass-btn" href="/moviebox" style="border-radius:30px; padding:10px 24px; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; min-height:42px; box-sizing:border-box;">Back to Catalog</a>
          </div>
        </div>
      </section>

      <section class="episodes-panel" style="margin-top:40px; border-top:1px solid rgba(255,255,255,0.05); padding-top:30px;">
        <div class="section-head" style="padding:0 16px 16px 16px;">
          <h2>Daftar Episode</h2>
        </div>
        ${episodesMarkup}
      </section>
    `;

    const favBtn = document.querySelector("#movieboxFavBtn");
    if (favBtn) {
      favBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        const favoriteObject = {
          id: id,
          title: data.title,
          poster: data.poster,
          platform: "MovieBox"
        };
        await toggleFavoriteDrama(favoriteObject);
        const isNowFav = !!localFavorites[id];
        favBtn.textContent = isNowFav ? "Favorit" : "Tambah Favorit";
        if (isNowFav) {
          favBtn.style.borderColor = "#e9a300";
          favBtn.style.color = "#e9a300";
          favBtn.style.background = "rgba(233, 163, 0, 0.1)";
          favBtn.style.fontWeight = "bold";
        } else {
          favBtn.style.borderColor = "";
          favBtn.style.color = "";
          favBtn.style.background = "";
          favBtn.style.fontWeight = "";
        }
      });
    }

    const shareBtn = document.querySelector("#movieboxShareBtn");
    if (shareBtn) {
      shareBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (navigator.share) {
          navigator.share({
            title: data.title,
            text: data.description,
            url: window.location.href
          }).catch(() => {});
        } else {
          navigator.clipboard.writeText(window.location.href);
          showWatchPartyToast("Link MovieBox telah disalin ke clipboard!");
        }
      });
    }

    window.handleMovieboxSeasonChange = function(event, detailId) {
      const selected = Number(event.target.value);
      renderMovieboxDetail(detailId, selected);
    };

  } catch (err) {
    console.error(err);
    app.innerHTML = `
      <section class="page-section top-space">
        <div class="empty-state">Gagal memuat detail drama. Harap coba lagi nanti.</div>
      </section>
    `;
  }
}

async function renderWatchPartyRoom(segment) {
  const params = new URLSearchParams(location.search);
  const isRoomCode = /^[A-Z0-9]{6,8}$/.test(String(segment || ""));
  const se = params.get("se") || "1";
  const ep = params.get("ep") || "1";
  const resourceId = params.get("resourceId") || "";

  app.innerHTML = `
    <section class="watch-party-page">
      <div class="watch-party-loading">
        <span class="inline-dot-loader" aria-label="Memuat"></span>
        <p>Menyiapkan Watch Party Room...</p>
      </div>
    </section>
  `;

  try {
    const userName = getWatchPartyUserName();
    const currentUserId = userId;
    let payload = null;

    if (isRoomCode) {
      const roomRes = await fetch(`/api/watch-party/room/${segment}?userId=${encodeURIComponent(currentUserId)}`);
      const roomData = await roomRes.json();
      if (!roomData.room) {
        app.innerHTML = renderWatchPartyJoinForm(segment);
        return;
      }
      const joinRes = await fetch("/api/watch-party/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomCode: segment, userId: currentUserId, userName })
      });
      payload = await joinRes.json();
      if (payload.error) {
        app.innerHTML = renderWatchPartyJoinForm(segment, payload.error);
        return;
      }
    } else {
      let detail = movieboxDetailCache.get(segment);
      if (!detail?.subjectId) {
        const detailRes = await fetch(`/api/moviebox/detail/${encodeURIComponent(segment)}?se=${se}&t=${Date.now()}`);
        detail = await detailRes.json();
      }
      if (detail?.error) {
        detail = {
          id: segment,
          title: "MovieBox Watch Party",
          episodes: [{ episode_number: ep, resourceId }],
          seasons: [{ se, maxEp: 1 }]
        };
      } else {
        movieboxDetailCache.set(segment, { ...detail, selectedSeason: Number(se) });
      }
      const episode = (detail.episodes || []).find((item) => String(item.episode_number) === String(ep)) || detail.episodes?.[0] || {};
      const createRes = await fetch("/api/watch-party/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          movieId: segment,
          episodeId: resourceId || episode.resourceId || ep,
          hostId: currentUserId,
          hostName: userName,
          title: detail.title,
          season: se,
          episode: ep
        })
      });
      payload = await createRes.json();
      history.replaceState({}, "", `/watch-party/${payload.room.room_code}`);
    }

    await mountWatchPartyPayload(payload);
  } catch (err) {
    console.error(err);
    app.innerHTML = `
      <section class="page-section top-space">
        <div class="empty-state">
          <h1>Watch Party gagal dibuka</h1>
          <p>${escapeHtml(err.message || "Silakan coba lagi nanti.")}</p>
          <a class="primary-btn" href="/moviebox">Kembali ke MovieBox</a>
        </div>
      </section>
    `;
  }
}

function renderWatchPartyJoinForm(roomCode = "", error = "") {
  return `
    <section class="watch-party-join-page">
      <form class="watch-party-join-card" id="watchPartyJoinForm">
        <p class="watch-party-kicker">Watch Party Room</p>
        <h1>Gabung Nonton Bareng</h1>
        ${error ? `<div class="watch-party-error">${escapeHtml(error)}</div>` : ""}
        <label for="watchPartyCodeInput">Masukkan Kode Room</label>
        <input id="watchPartyCodeInput" value="${escapeHtml(roomCode)}" maxlength="8" placeholder="ABC123" autocomplete="off" required>
        <button type="submit">Gabung</button>
        <a href="/moviebox?tab=join-room" onclick="event.preventDefault(); history.pushState({}, '', '/moviebox?tab=join-room'); renderRoute();" style="margin-top: 16px; display: inline-block; color: #e9a300; text-decoration: none; font-size: 14px; font-weight: 600; text-align: center; width: 100%;">← Kembali ke Daftar Room</a>
      </form>
    </section>
  `;
}

async function mountWatchPartyPayload(payload) {
  watchPartyState = payload;
  const room = payload.room;
  let detail = movieboxDetailCache.get(room.movie_id);
  if (!detail?.subjectId) {
    try {
      const detailRes = await fetch(`/api/moviebox/detail/${encodeURIComponent(room.movie_id)}?se=${room.season || 1}`);
      detail = await detailRes.json();
    } catch {
      detail = null;
    }
  }
  if (!detail || detail.error) {
    detail = {
      id: room.movie_id,
      subjectId: "",
      title: room.title || "MovieBox Watch Party",
      poster: "",
      backdrop: "",
      episodes: [{ episode_number: room.episode || 1, resourceId: room.episode_id || "" }],
      seasons: [{ se: room.season || 1, maxEp: 1 }]
    };
  }
  movieboxDetailCache.set(room.movie_id, { ...detail, selectedSeason: Number(room.season || 1) });
  const episodesList = detail.episodes || [];
  const currentEpisode = episodesList.find((item) => String(item.episode_number) === String(room.episode)) || episodesList[0] || {};
  const seasonInfo = detail.seasons?.find((item) => Number(item.se) === Number(room.season || 1)) || {};
  const availableResolutions = seasonInfo.resolutions?.map((item) => item.resolution || item) || [360, 480, 720];
  let watchData = { streams: [], subtitles: [] };
  if (detail.subjectId) {
    try {
      const watchRes = await fetch(`/api/moviebox/watch?subjectId=${detail.subjectId}&resourceId=${currentEpisode.resourceId || room.episode_id || ""}&se=${room.season || 1}&ep=${room.episode || 1}&resolution=${selectedMovieboxResolution}`);
      watchData = await watchRes.json();
    } catch {
      watchData = { streams: [], subtitles: [] };
    }
  }
  const streamUrl = watchData.streams?.[0]?.url || "";
  const mappedSubtitles = (watchData.subtitles || []).map((sub) => ({
    lang: sub.code || sub.language || "en",
    label: sub.language || sub.code || "English",
    url: sub.url
  }));

  app.innerHTML = `
    <section class="watch-party-page">
      <div class="watch-party-main">
        <header class="watch-party-topbar">
          <a class="moviebox-back-btn" href="/moviebox/detail/${room.movie_id}?se=${room.season || 1}">&larr; <span>Detail</span></a>
          <div class="watch-party-room-code">Kode Room <strong>${escapeHtml(room.room_code)}</strong></div>
        </header>
        <div class="moviebox-video-wrapper watch-party-video-wrapper">
          <div class="moviebox-video-stage" id="playerShell">
            <video class="moviebox-video-element" data-src="${escapeHtml(streamUrl)}" data-subtitles="${escapeHtml(JSON.stringify(mappedSubtitles))}" poster="${escapeHtml(detail.backdrop || detail.poster || "")}" playsinline preload="metadata" autoplay></video>
            <button class="player-fullscreen-back hide" id="fullscreenBackBtn" type="button" aria-label="Kembali">&larr;</button>
            <button class="player-play-toggle" id="playToggleBtn" type="button" data-play-toggle aria-label="Play/Pause"><span class="play-icon"></span></button>
            <div class="player-controls-bar hide" id="playerControlsBar">
              <div class="controls-left">
                <button class="control-btn" id="playBtn" type="button" data-play-toggle aria-label="Play/Pause"><span class="play-icon"></span></button>
                <button class="control-btn" id="watchPartySeekBack" type="button" data-watch-party-seek="-10">-10</button>
                <button class="control-btn" id="watchPartySeekForward" type="button" data-watch-party-seek="10">+10</button>
              </div>
              <div class="controls-center"><div class="progress-container" id="progressContainer"><div class="progress-bar" id="progressBar"></div></div></div>
              <div class="controls-right">
                <span class="time-display" id="timeDisplay">0:00 / 0:00</span>
                <button class="control-btn fullscreen-action" type="button" data-fullscreen aria-label="Fullscreen"><span></span></button>
              </div>
            </div>
            <div class="subtitle-overlay" id="subtitleOverlay" aria-live="polite"></div>
            <div class="video-message" id="videoMessage"><span class="inline-dot-loader" aria-label="Memuat"></span></div>
          </div>
        </div>
        <div class="watch-party-host-tools">
          <div class="moviebox-header-actions" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            ${movieboxQualityControl(availableResolutions, selectedMovieboxResolution)}
            ${movieboxSubtitleControl(mappedSubtitles)}
            ${movieboxEpisodeControl(episodesList, room.episode, payload.isHost)}
          </div>
          <button class="watch-party-share-btn" type="button" data-watch-party-share>Bagikan Room</button>
        </div>
      </div>
      <aside class="watch-party-sidebar">
        ${watchPartySidebarMarkup(payload, detail, room)}
      </aside>
    </section>
  `;

  mountMovieboxVideoPlayer();
  watchPartyAutoJoinedVoice = false;
  updateWatchPartyVoiceDebug();
  refreshWatchPartyVoiceDevices();
  connectWatchPartySocket(room.room_code);
  setTimeout(() => {
    const video = document.querySelector("video.moviebox-video-element");
    if (video) {
      video.currentTime = Number(room.current_time || 0);
      if (room.is_playing || payload.isHost) {
        video.play().catch(() => {});
      }
      attachWatchPartyVideoSync(video);
    }
  }, 350);
}

function watchPartySidebarMarkup(payload, detail, room) {
  const showControlTab = !!(payload.isHost || payload.isAdmin);
  return `
    <div class="watch-party-panel">
      <div class="watch-party-title">
        <p>Watch Party Room</p>
        <h2>${escapeHtml(detail.title || room.title)}</h2>
      </div>
      <div class="watch-party-stats">
        <span>Episode <strong>Season ${escapeHtml(String(room.season || 1))} Episode ${escapeHtml(String(room.episode || 1))}</strong></span>
        <span>Host <strong>@${escapeHtml(room.host_name || "Host")}</strong></span>
        <span>Member <strong data-watch-party-member-count>${payload.members.length} Orang</strong></span>
      </div>
      <div class="watch-party-share-options">
        <button type="button" data-watch-party-share-option="link">Copy Link</button>
        <button type="button" data-watch-party-share-option="code">Copy Room Code</button>
      </div>
      <div class="watch-party-tabs">
        <button class="active" type="button" data-watch-party-tab="chat">Chat <small data-unread-count></small></button>
        <button type="button" data-watch-party-tab="members">Anggota</button>
        ${showControlTab ? `<button type="button" data-watch-party-tab="control" style="color: #ff3b30; font-weight: bold;">Admin</button>` : ""}
      </div>
      <div class="watch-party-tab-panel active" data-watch-party-panel="chat">
        <div class="watch-party-chat" id="watchPartyChat">${watchPartyChatMarkup(payload.chat)}</div>
        <div class="watch-party-typing" id="watchPartyTyping"></div>
        <form class="watch-party-chat-form" id="watchPartyChatForm">
          <div class="chat-input-wrapper">
            <!-- Voice action button -->
            <div class="input-action-dropdown" id="watchPartyVoiceDropdown">
              <button type="button" class="input-action-btn voice-btn" id="voiceToggleTrigger" title="Voice Chat">
                <span class="icon">🎙️</span>
                <span class="voice-active-dot"></span>
              </button>
              ${renderWatchPartyVoiceMenu()}
            </div>

            <!-- Emoji stickers dropdown -->
            <div class="input-action-dropdown" id="watchPartyEmojiDropdown">
              <button type="button" class="input-action-btn emoji-btn" id="emojiToggleTrigger" title="Stickers/Emojis">
                <span class="icon">😊</span>
              </button>
              <div class="dropdown-menu dropup-menu stickers-dropup" id="emojiDropupMenu">
                ${["\u{1F602}", "\u{1F525}", "\u{1F62D}", "\u2764\uFE0F", "\u{1F44F}", "\u{1F60D}", "\u{1F631}", "\u{1F389}"].map((emoji) => `<button type="button" data-watch-party-sticker="${emoji}">${emoji}</button>`).join("")}
              </div>
            </div>

            <input id="watchPartyChatInput" placeholder="Tulis pesan..." autocomplete="off">
          </div>
          <button type="submit">Kirim</button>
        </form>
      </div>
      <div class="watch-party-tab-panel" data-watch-party-panel="members">
        <div class="watch-party-members" id="watchPartyMembers">${watchPartyMembersMarkup(payload.members)}</div>
      </div>
      ${showControlTab ? `
      <div class="watch-party-tab-panel" data-watch-party-panel="control" style="padding: 16px; gap: 12px;">
        ${renderWatchPartyVoiceDebug()}
        <div style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 16px; padding: 20px 16px; text-align: center; display: flex; flex-direction: column; gap: 12px;">
          <h4 style="color: #ff3b30; font-size: 15px; font-weight: 700; margin: 0;">Bubarkan Room Nonton Bareng</h4>
          <p style="font-size: 12px; color: rgba(255,255,255,0.6); margin: 0; line-height: 1.5;">
            Tindakan ini akan menghentikan pemutaran, mengeluarkan seluruh anggota room, dan menutup room ini secara permanen.
          </p>
          <button id="closeWatchPartyRoomBtn" style="padding: 12px 20px; border-radius: 30px; background: #ef4444; color: #fff; font-weight: bold; border: none; cursor: pointer; transition: background 0.2s; font-size: 13px;">Bubarkan / Offkan Room</button>
        </div>
      </div>
      ` : ""}
    </div>
  `;
}

function watchPartyChatMarkup(chat = []) {
  if (!chat.length) {
    return `<div class="watch-party-empty">Belum ada chat. Mulai ngobrol saat nonton.</div>`;
  }
  return chat.map((item) => {
    const role = item.role || "guest";
    const avatarUrl = item.avatar || "";
    const name = item.user || "Guest";
    const initials = name.slice(0, 2).toUpperCase();
    
    let avatarBg = "linear-gradient(135deg, #7f8c8d, #34495e)";
    let avatarBorder = "rgba(255, 255, 255, 0.1)";
    let tagText = "GUEST";
    let tagStyle = "background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.1);";
    
    if (role === "admin") {
      avatarBg = "linear-gradient(135deg, #ef4444, #990000)";
      avatarBorder = "#ff4d4d";
      tagText = "ADMIN";
      tagStyle = "background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3);";
    } else if (role === "vip") {
      avatarBg = "linear-gradient(135deg, #f39c12, #d35400)";
      avatarBorder = "#f5b041";
      tagText = "VIP";
      tagStyle = "background: rgba(245, 176, 65, 0.15); color: #f5b041; border: 1px solid rgba(245, 176, 65, 0.3);";
    }

    return `
      <div class="watch-party-message ${item.type === "sticker" ? "sticker" : ""}" style="display: flex; gap: 10px; align-items: flex-start; width: 100%; margin-bottom: 10px; box-sizing: border-box; background: none !important; border: none !important; padding: 0 !important; box-shadow: none !important;">
        <div class="chat-avatar" style="width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold; flex-shrink: 0; background: ${avatarBg}; color: #fff; border: 1px solid ${avatarBorder}; overflow: hidden; position: relative; box-sizing: border-box;">
          ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'; this.parentElement.textContent='${escapeHtml(initials)}';">` : initials}
        </div>
        <div class="message-bubble" style="display: flex; flex-direction: column; gap: 4px; padding: 10px 14px; border-radius: 14px; background: rgba(0,0,0,0.24); border: 1px solid rgba(255,255,255,0.06); width: fit-content; max-width: 80%; box-shadow: 0 2px 8px rgba(0,0,0,0.15); box-sizing: border-box; text-align: left;">
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <strong style="color: #fff; font-size: 13px; font-weight: 700;">${escapeHtml(name)}</strong>
            <span style="font-size: 8px; font-weight: bold; padding: 1px 5px; border-radius: 6px; text-transform: uppercase; ${tagStyle}">${tagText}</span>
            <span style="font-size: 9px; color: rgba(255,255,255,0.35); margin-left: 8px;">${escapeHtml(item.time || "")}</span>
          </div>
          <p style="margin: 4px 0 0 0; color: rgba(255,255,255,0.85); font-size: ${item.type === "sticker" ? "28px" : "13px"}; line-height: 1.45; word-break: break-word; font-weight: 400;">${escapeHtml(item.message || "")}</p>
        </div>
      </div>
    `;
  }).join("");
}

function watchPartyMembersMarkup(members = []) {
  const isHost = watchPartyState?.isHost;
  
  return members.map((member) => {
    const isLocal = member.user_id === userId;
    const voiceInfo = watchPartyState?.voice?.find((v) => v.user_id === member.user_id && v.status === "joined");
    const isInVoice = !!voiceInfo;
    const isMuted = voiceInfo ? voiceInfo.is_muted : false;
    const isSpeaking = watchPartySpeakingUsers.has(member.user_id);
    const volume = watchPartyUserVolumes.get(member.user_id) ?? 80;
    
    let adminButtons = "";
    if (isHost && !isLocal && isInVoice) {
      adminButtons = `
        <div class="voice-admin-actions" style="margin-top: 4px; border: 0; padding: 0;">
          <button type="button" class="voice-admin-btn mute-btn" data-voice-admin-action="${isMuted ? 'unmute' : 'mute'}" data-voice-admin-target="${member.user_id}">
            ${isMuted ? '🔇' : '🎙️'}
          </button>
          <button type="button" class="voice-admin-btn kick-btn" data-voice-admin-action="remove" data-voice-admin-target="${member.user_id}">
            🚪
          </button>
        </div>
      `;
    }
    
    let volumeControl = "";
    if (isInVoice && !isLocal) {
      volumeControl = `
        <div class="voice-member-volume" style="margin-top: 4px; padding: 4px 8px;">
          <span class="volume-label" style="min-width: 45px; font-size: 10px;">Vol: ${volume}%</span>
          <input type="range" min="0" max="100" value="${volume}" data-voice-volume-target="${member.user_id}" class="volume-slider">
        </div>
      `;
    }
    
    let statusText = member.online ? "Online" : "Offline";
    if (isInVoice) {
      statusText += ` (🎤 Voice ${isMuted ? 'Muted' : (isSpeaking ? 'Speaking' : 'Active')})`;
    }
    
    return `
      <div class="watch-party-member ${isSpeaking ? 'speaking-glow' : ''}" data-voice-member-id="${member.user_id}" style="display: flex; flex-direction: column; gap: 4px; padding: 10px; margin-bottom: 8px;">
        <div class="member-header-row" style="display: flex; align-items: center; gap: 10px;">
          <div class="watch-party-avatar" style="${isSpeaking ? 'box-shadow: 0 0 8px #22c55e;' : ''}">${escapeHtml(member.avatar || member.username?.slice(0, 1) || "U")}</div>
          <div style="flex: 1;">
            <strong>${member.is_host ? "Host " : ""}${escapeHtml(member.username || "Guest")}</strong>
            <div style="font-size: 11px; color: rgba(255,255,255,0.48); display: flex; align-items: center; gap: 4px;">
              <span class="speaking-indicator ${isSpeaking ? 'speaking' : ''}" style="margin: 0; width: 6px; height: 6px; display: ${isInVoice ? 'inline-block' : 'none'};"></span>
              <span>${statusText}</span>
            </div>
          </div>
        </div>
        ${volumeControl}
        ${adminButtons}
      </div>
    `;
  }).join("");
}

function watchPartyVoiceMarkup(voice = []) {
  if (!voice.length) {
    return `<div class="watch-party-empty">Belum ada yang join voice.</div>`;
  }
  return voice.map((item) => `
    <div class="watch-party-voice-user">
      <span>${item.is_muted ? "Muted" : "Speaking"}</span>
      <strong>${escapeHtml(item.username || "Guest")}</strong>
      <input type="range" min="0" max="100" value="80" aria-label="Volume ${escapeHtml(item.username || "Guest")}">
    </div>
  `).join("");
}


function muteMicLocally(muted) {
  watchPartyVoiceMuted = muted;
  watchPartyVoiceStream?.getAudioTracks().forEach((track) => track.enabled = !muted);
  sendWatchPartyEvent(muted ? "voice:mute" : "voice:unmute");
  updateVoiceTriggerUI(true, muted);
  updateWatchPartyVoiceDebug({ sendingAudio: muted ? "Muted" : "Yes", audioTrack: watchPartyVoiceStream ? "Active" : "Inactive" });
  
  const micBtn = document.querySelector("#voiceMicToggle");
  if (micBtn) {
    micBtn.textContent = muted ? "🎤 Mic Off" : "🎤 Mic On";
    micBtn.classList.toggle("muted", muted);
  }
}

function toggleSpeakerLocally() {
  watchPartySpeakerMuted = !watchPartySpeakerMuted;
  const speakerBtn = document.querySelector("#voiceSpeakerToggle");
  if (speakerBtn) {
    speakerBtn.textContent = watchPartySpeakerMuted ? "🎧 Speaker Off" : "🎧 Speaker On";
    speakerBtn.classList.toggle("muted", watchPartySpeakerMuted);
  }
  document.querySelectorAll("audio[data-watch-party-audio]").forEach((audio) => {
    const targetUserId = audio.dataset.watchPartyAudio;
    const vol = watchPartyUserVolumes.get(targetUserId) ?? 80;
    audio.volume = watchPartySpeakerMuted ? 0 : vol / 100;
  });
}

function startLocalVoiceDetection(stream) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    
    const audioCtx = new AudioContextClass();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    
    localAudioAnalyser = analyser;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    function checkAudioLevel() {
      if (!watchPartyVoiceStream) return;
      if (watchPartyVoiceMuted || (watchPartyVoiceMode === "ptt" && !watchPartyPttActive)) {
        if (isLocalCurrentlySpeaking) {
          setLocalSpeakingState(false);
        }
        setTimeout(checkAudioLevel, 100);
        return;
      }
      
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;
      const isSpeaking = average > 18;
      
      if (isSpeaking !== isLocalCurrentlySpeaking) {
        setLocalSpeakingState(isSpeaking);
      }
      
      setTimeout(checkAudioLevel, 100);
    }
    
    checkAudioLevel();
  } catch (err) {
    console.warn("Failed to initialize voice detection:", err);
  }
}

function setLocalSpeakingState(isSpeaking) {
  isLocalCurrentlySpeaking = isSpeaking;
  sendWatchPartyEvent("voice:speaking", { isSpeaking });
  if (isSpeaking) {
    watchPartySpeakingUsers.add(userId);
  } else {
    watchPartySpeakingUsers.delete(userId);
  }
  
  const memberCard = document.querySelector(`.watch-party-member[data-voice-member-id="${userId}"]`);
  if (memberCard) {
    memberCard.classList.toggle("speaking-glow", isSpeaking);
    const indicator = memberCard.querySelector(".speaking-indicator");
    if (indicator) indicator.classList.toggle("speaking", isSpeaking);
    const avatar = memberCard.querySelector(".watch-party-avatar");
    if (avatar) avatar.style.boxShadow = isSpeaking ? "0 0 8px #22c55e" : "";
  }
}

function startPttTalk() {
  if (!watchPartyVoiceStream || watchPartyVoiceMode !== "ptt") return;
  watchPartyPttActive = true;
  watchPartyVoiceStream.getAudioTracks().forEach((track) => track.enabled = true);
  sendWatchPartyEvent("voice:unmute");
  const pttBtn = document.querySelector("#voicePttBtn");
  if (pttBtn) {
    pttBtn.textContent = "🎙️ Berbicara...";
    pttBtn.classList.add("active");
  }
}

function stopPttTalk() {
  if (!watchPartyVoiceStream || watchPartyVoiceMode !== "ptt") return;
  watchPartyPttActive = false;
  watchPartyVoiceStream.getAudioTracks().forEach((track) => track.enabled = false);
  sendWatchPartyEvent("voice:mute");
  const pttBtn = document.querySelector("#voicePttBtn");
  if (pttBtn) {
    pttBtn.textContent = "🎙️ Tahan untuk Bicara";
    pttBtn.classList.remove("active");
  }
}

async function fetchActiveWatchPartyRooms() {
  const container = document.querySelector("#activeRoomsList");
  if (!container) return;

  try {
    const res = await fetch("/api/watch-party/list");
    const data = await res.json();
    if (!data.ok || !data.rooms || data.rooms.length === 0) {
      container.innerHTML = `<div style="text-align: center; padding: 20px; color: rgba(255,255,255,0.4); font-size: 14px;">Tidak ada room aktif saat ini. Buat room baru dari detail drama/film!</div>`;
      return;
    }

    // Check if user is admin
    let isUserAdminOnFrontend = false;
    try {
      const adminToken = localStorage.getItem("adminToken") || "";
      const adminProbe = await fetch(`/api/watch-party/check-admin?userId=${encodeURIComponent(userId)}&adminToken=${encodeURIComponent(adminToken)}`);
      const adminProbeData = await adminProbe.json();
      isUserAdminOnFrontend = !!adminProbeData.isAdmin;
    } catch (e) {}

    container.innerHTML = data.rooms.map((room) => {
      const lockIcon = room.is_private ? "🔒 " : "";
      const adminOffBtn = isUserAdminOnFrontend 
        ? `<button class="admin-close-room-btn" data-room-code="${room.room_code}" style="padding: 6px 12px; border-radius: 20px; background: #ef4444; color: #fff; font-size: 12px; font-weight: bold; border: none; cursor: pointer; margin-left: auto;">Offkan Room</button>`
        : "";

      return `
        <div class="active-room-card" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-radius: 16px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255,255,255,0.05); transition: background 0.2s;">
          <div style="flex: 1; text-align: left; display: flex; flex-direction: column; gap: 4px;">
            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              <span style="font-weight: 700; color: #fff; font-size: 15px;">${lockIcon}${escapeHtml(room.title)}</span>
              <span style="font-size: 11px; background: rgba(233, 163, 0, 0.15); color: #e9a300; padding: 2px 8px; border-radius: 12px; font-weight: 600;">Code: ${escapeHtml(room.room_code)}</span>
            </div>
            <div style="font-size: 12px; color: rgba(255,255,255,0.5); display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
              <span>🎙️ Host: <strong>@${escapeHtml(room.host_name)}</strong></span>
              <span>👥 Aktif: <strong>${room.active_members} Orang</strong></span>
              <span>Ep ${room.episode}</span>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <button class="join-room-card-btn" data-room-code="${room.room_code}" style="padding: 8px 16px; border-radius: 20px; background: #e9a300; color: #000; font-size: 13px; font-weight: bold; border: none; cursor: pointer; transition: transform 0.2s;">Gabung</button>
            ${adminOffBtn}
          </div>
        </div>
      `;
    }).join("");

    // Attach click events for join buttons
    container.querySelectorAll(".join-room-card-btn").forEach((btn) => {
      btn.onclick = () => {
        const roomCode = btn.dataset.roomCode;
        history.pushState({}, "", `/watch-party/${roomCode}`);
        renderRoute();
      };
    });

    // Attach click events for admin close buttons
    container.querySelectorAll(".admin-close-room-btn").forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const roomCode = btn.dataset.roomCode;
        if (confirm(`Apakah Anda yakin ingin mematikan Room ${roomCode} secara paksa?`)) {
          btn.disabled = true;
          btn.textContent = "Menutup...";
          try {
            const currentUserId = userId;
            const adminToken = localStorage.getItem("adminToken") || "";
            const res = await fetch("/api/watch-party/close", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ roomCode, userId: currentUserId, adminToken })
            });
            const resData = await res.json();
            if (resData.ok) {
              showWatchPartyToast(`Room ${roomCode} berhasil dimatikan.`);
              fetchActiveWatchPartyRooms();
            } else {
              showWatchPartyToast(`Gagal mematikan room: ${resData.error}`);
              btn.disabled = false;
              btn.textContent = "Matikan Room";
            }
          } catch (err) {
            showWatchPartyToast(`Error: ${err.message}`);
            btn.disabled = false;
            btn.textContent = "Matikan Room";
          }
        }
      };
    });

  } catch (err) {
    container.innerHTML = `<div style="text-align: center; padding: 20px; color: #ef4444; font-size: 14px;">Gagal memuat list room: ${err.message}</div>`;
  }
}

function connectWatchPartySocket(roomCode) {
  if (watchPartySocket && watchPartySocket.readyState === WebSocket.OPEN && watchPartySocket.roomCode === roomCode) {
    return;
  }
  if (watchPartySocket) {
    watchPartyReconnectPaused = true;
    watchPartySocket.close();
  }
  watchPartyReconnectPaused = false;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const avatarUrl = window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url || localStorage.getItem("TEAMDLUserPhotoUrl") || "";
  const wsUrl = `${protocol}//${location.host}/api/watch-party/socket?room=${encodeURIComponent(roomCode)}&userId=${encodeURIComponent(userId)}&name=${encodeURIComponent(getWatchPartyUserName())}&avatar=${encodeURIComponent(avatarUrl)}`;
  const socket = new WebSocket(wsUrl);
  socket.roomCode = roomCode;
  watchPartySocket = socket;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    handleWatchPartySocketMessage(message.event, message.payload);
  });
  socket.addEventListener("close", () => {
    if (watchPartyReconnectPaused || watchPartySocket !== socket) return;

    // Verify if the room is still open
    fetch(`/api/watch-party/room/${roomCode}?userId=${encodeURIComponent(userId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.room || data.room.status !== "open") {
          showWatchPartyToast("Room ini telah ditutup.");
          watchPartyReconnectPaused = true;
          setTimeout(() => {
            history.pushState({}, "", "/moviebox?tab=join-room");
            renderRoute();
          }, 2000);
          return;
        }

        // Room is still open, try to reconnect
        const typing = document.querySelector("#watchPartyTyping");
        if (typing) typing.textContent = "Koneksi room terputus. Mencoba sambung ulang...";
        setTimeout(() => {
          if (location.pathname.startsWith("/watch-party/")) {
            connectWatchPartySocket(roomCode);
          }
        }, 2500);
      })
      .catch(() => {
        // Fallback to reconnect on temporary fetch error
        const typing = document.querySelector("#watchPartyTyping");
        if (typing) typing.textContent = "Koneksi room terputus. Mencoba sambung ulang...";
        setTimeout(() => {
          if (location.pathname.startsWith("/watch-party/")) {
            connectWatchPartySocket(roomCode);
          }
        }, 2500);
      });
  });
}

function handleWatchPartySocketMessage(event, payload) {
  if (event === "room:close") {
    showWatchPartyToast("Room telah ditutup oleh host atau admin.");
    watchPartyReconnectPaused = true;
    if (watchPartySocket) {
      try { watchPartySocket.close(); } catch(e) {}
    }
    setTimeout(() => {
      history.pushState({}, "", "/moviebox?tab=join-room");
      renderRoute();
    }, 2000);
    return;
  }

  if (!payload) return;
  if (payload.room) {
    watchPartyState = payload;
    updateWatchPartySidebar(payload);
    if (!watchPartyVoiceStream && !watchPartyAutoJoinedVoice) {
      watchPartyAutoJoinedVoice = true;
      updateWatchPartyVoiceDebug({
        micPermission: "Click Mic",
        microphone: "Waiting",
        audioTrack: "Inactive",
        sendingAudio: "No"
      });
    } else if (watchPartyVoiceStream) {
      startWatchPartyPeerMesh();
    }
  }
  if (event === "video:next_episode") {
    mountWatchPartyPayload(payload);
    showWatchPartyToast(`Episode diganti ke Episode ${payload.room?.episode || 1}`);
  } else if (event.startsWith("video:")) {
    applyWatchPartyVideoEvent(event, payload.room || {});
  }
  if (event === "voice:signal") {
    handleWatchPartyVoiceSignal(payload);
  }
  if (event === "voice:speaking") {
    const { userId: speakerId, isSpeaking } = payload;
    if (isSpeaking) {
      watchPartySpeakingUsers.add(speakerId);
    } else {
      watchPartySpeakingUsers.delete(speakerId);
    }
    
    const memberCard = document.querySelector(`.watch-party-member[data-voice-member-id="${speakerId}"]`);
    if (memberCard) {
      memberCard.classList.toggle("speaking-glow", isSpeaking);
      const indicator = memberCard.querySelector(".speaking-indicator");
      if (indicator) indicator.classList.toggle("speaking", isSpeaking);
      const avatar = memberCard.querySelector(".watch-party-avatar");
      if (avatar) avatar.style.boxShadow = isSpeaking ? "0 0 8px #22c55e" : "";
    }
  }
  if (event === "voice:admin_action") {
    const { action, targetUserId } = payload;
    if (targetUserId === userId) {
      if (action === "mute") {
        muteMicLocally(true);
        showWatchPartyToast("Mikrofon Anda dimute oleh Host.");
      } else if (action === "unmute") {
        muteMicLocally(false);
        showWatchPartyToast("Mikrofon Anda diunmute oleh Host.");
      } else if (action === "remove") {
        handleWatchPartyVoiceAction("leave");
        showWatchPartyToast("Anda dikeluarkan dari Voice Channel.");
      }
    }
  }
  if (event === "chat:typing") {
    const typing = document.querySelector("#watchPartyTyping");
    if (typing) {
      typing.textContent = `${escapeHtml(payload.user || "Teman")} sedang mengetik...`;
      clearTimeout(watchPartyTypingTimer);
      watchPartyTypingTimer = setTimeout(() => typing.textContent = "", 1400);
    }
  }
}

function updateWatchPartySidebar(payload) {
  const chat = document.querySelector("#watchPartyChat");
  const members = document.querySelector("#watchPartyMembers");
  const voice = document.querySelector("#watchPartyVoice");
  const count = document.querySelector("[data-watch-party-member-count]");
  if (chat) {
    chat.innerHTML = watchPartyChatMarkup(payload.chat || []);
    chat.scrollTop = chat.scrollHeight;
  }
  if (members) members.innerHTML = watchPartyMembersMarkup(payload.members || []);
  if (voice) voice.innerHTML = watchPartyVoiceMarkup(payload.voice || []);
  if (count) count.textContent = `${payload.members?.length || 0} Orang`;
}

function attachWatchPartyVideoSync(video) {
  if (video.dataset.watchPartySync === "true") return;
  video.dataset.watchPartySync = "true";
  video.addEventListener("play", () => sendWatchPartyVideoEvent("video:play", video));
  video.addEventListener("pause", () => sendWatchPartyVideoEvent("video:pause", video));
  video.addEventListener("seeked", () => sendWatchPartyVideoEvent("video:seek", video));
}

function sendWatchPartyVideoEvent(event, video) {
  if (watchPartyLocalAction || !watchPartyState?.isHost) return;
  sendWatchPartyEvent(event, { currentTime: video.currentTime, isPlaying: !video.paused });
}

function applyWatchPartyVideoEvent(event, room) {
  if (watchPartyState?.isHost) return;
  const video = document.querySelector("video.moviebox-video-element");
  if (!video) return;
  watchPartyLocalAction = true;
  if (Number.isFinite(Number(room.current_time)) && Math.abs(video.currentTime - Number(room.current_time)) > 1.2) {
    video.currentTime = Number(room.current_time);
  }
  if (event === "video:play") {
    video.play().catch(() => {});
  }
  if (event === "video:pause" || (event === "video:seek" && !room.is_playing)) {
    video.pause();
  }
  if (event === "video:seek" && room.is_playing) {
    video.play().catch(() => {});
  }
  syncPlayButton(video);
  setTimeout(() => watchPartyLocalAction = false, 300);
}

function sendWatchPartyEvent(event, payload = {}) {
  if (watchPartySocket?.readyState === WebSocket.OPEN) {
    watchPartySocket.send(JSON.stringify({ event, payload }));
  }
}

function getWatchPartyUserName() {
  const tgUser = telegram?.initDataUnsafe?.user;
  return tgUser?.username || [tgUser?.first_name, tgUser?.last_name].filter(Boolean).join(" ") || localStorage.getItem("TEAMDLWatchPartyName") || "Guest User";
}

function updateVoiceTriggerUI(isActive, isMuted) {
  const trigger = document.querySelector("#voiceToggleTrigger");
  if (!trigger) return;
  const icon = trigger.querySelector(".icon");
  const dot = trigger.querySelector(".voice-active-dot");
  if (isActive) {
    if (dot) {
      dot.style.display = "block";
      dot.style.backgroundColor = isMuted ? "#ef4444" : "#22c55e";
      dot.style.boxShadow = isMuted ? "0 0 4px #ef4444" : "0 0 4px #22c55e";
    }
    if (isMuted) {
      icon.textContent = "🔇";
      trigger.style.background = "rgba(239, 68, 68, 0.25)";
      trigger.style.borderColor = "rgba(239, 68, 68, 0.4)";
      trigger.style.color = "#ef4444";
      trigger.title = "Voice Chat (Muted)";
    } else {
      icon.textContent = "🎙️";
      trigger.style.background = "rgba(34, 197, 94, 0.25)";
      trigger.style.borderColor = "rgba(34, 197, 94, 0.4)";
      trigger.style.color = "#22c55e";
      trigger.title = "Voice Chat (Active)";
    }
  } else {
    if (dot) {
      dot.style.display = "none";
    }
    icon.textContent = "🎙️";
    trigger.style.background = "";
    trigger.style.borderColor = "";
    trigger.style.color = "";
    trigger.title = "Voice Chat";
  }
}

function updateWatchPartyVoiceDebug(patch = {}) {
  watchPartyDebugState = { ...watchPartyDebugState, ...patch };
  const status = document.querySelector("#watchPartyVoiceStatusText");
  if (status) {
    status.textContent = voiceStatusText();
    status.className = `voice-status-text ${voiceStatusClass()}`;
  }
  const menuStatus = document.querySelector("#voiceMenuStatus");
  if (menuStatus) {
    menuStatus.textContent = voiceStatusText();
  }
  const micBtn = document.querySelector("#voiceMicToggle");
  if (micBtn) {
    micBtn.textContent = watchPartyVoiceMuted || !watchPartyVoiceStream ? "Mic On" : "Mic Off";
    micBtn.classList.toggle("muted", watchPartyVoiceMuted || !watchPartyVoiceStream);
  }
  const debug = document.querySelector("#watchPartyVoiceDebug");
  if (debug) {
    debug.innerHTML = Object.entries(watchPartyDebugState)
      .map(([key, value]) => `<span>${escapeHtml(voiceDebugLabel(key))}: <strong>${escapeHtml(String(value))}</strong></span>`)
      .join("");
  }
}

function voiceStatusText() {
  if (watchPartyDebugState.micPermission === "Denied") return "Permission Ditolak";
  if (watchPartyDebugState.micPermission === "Click Mic") return "Klik Mic untuk Bicara";
  if (!watchPartyVoiceStream) return "Mic Nonaktif";
  return watchPartyVoiceMuted ? "Mic Nonaktif" : "Mic Aktif";
}

function voiceStatusClass() {
  if (watchPartyDebugState.micPermission === "Denied") return "denied";
  if (!watchPartyVoiceStream || watchPartyVoiceMuted) return "muted";
  return "active";
}

function voiceDebugLabel(key) {
  return {
    micPermission: "Mic Permission",
    microphone: "Microphone",
    audioTrack: "Audio Track",
    peerConnection: "Peer Connection",
    iceState: "ICE State",
    remoteUsers: "Remote Users",
    receivingAudio: "Receiving Audio",
    sendingAudio: "Sending Audio"
  }[key] || key;
}

function renderWatchPartyVoiceDebug() {
  return `
    <div class="watch-party-voice-status">
      <div class="voice-status-main">
        <span id="watchPartyVoiceStatusText" class="voice-status-text ${voiceStatusClass()}">${escapeHtml(voiceStatusText())}</span>
        <button type="button" id="watchPartyVoiceDebugToggle">Debug</button>
      </div>
      <div class="watch-party-voice-debug" id="watchPartyVoiceDebug" hidden></div>
    </div>
  `;
}

function renderWatchPartyVoiceMenu() {
  return `
    <div class="dropdown-menu dropup-menu voice-dropup" id="voiceDropupMenu">
      <div class="voice-menu-status" id="voiceMenuStatus">${escapeHtml(voiceStatusText())}</div>
      <div class="voice-menu-actions">
        <button type="button" id="voiceMicToggle">Mic On/Off</button>
        <button type="button" data-watch-party-voice="leave">Leave Voice</button>
      </div>
      <label class="voice-menu-label" for="watchPartyMicSelect">Pilih Mikrofon</label>
      <select id="watchPartyMicSelect">
        <option value="">Default Microphone</option>
      </select>
      <button type="button" id="watchPartyAllowMicBtn">Izinkan Mikrofon</button>
      <button type="button" id="watchPartySpeakerTestBtn">Speaker Test</button>
      <small>Jika permission ditolak, klik ikon gembok di address bar lalu izinkan Microphone.</small>
    </div>
  `;
}

async function refreshWatchPartyVoiceDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    watchPartyMicDevices = devices.filter((device) => device.kind === "audioinput");
    const select = document.querySelector("#watchPartyMicSelect");
    if (select) {
      const current = watchPartySelectedMicId;
      select.innerHTML = `<option value="">Default Microphone</option>` + watchPartyMicDevices.map((device, index) => {
        const label = device.label || `Microphone ${index + 1}`;
        return `<option value="${escapeHtml(device.deviceId)}" ${device.deviceId === current ? "selected" : ""}>${escapeHtml(label)}</option>`;
      }).join("");
    }
  } catch (err) {
    console.warn("Failed to enumerate microphones:", err);
  }
}

async function unlockWatchPartyAudioPlayback() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      if (!watchPartyAudioContext) {
        watchPartyAudioContext = new AudioContextClass();
      }
      if (watchPartyAudioContext.state === "suspended") {
        await watchPartyAudioContext.resume();
      }
    }
  } catch (err) {
    console.warn("AudioContext unlock failed:", err);
  }

  document.querySelectorAll("audio[data-watch-party-audio]").forEach((audio) => {
    audio.muted = false;
    audio.play().catch(() => {});
  });
}

async function playWatchPartySpeakerTest() {
  try {
    await unlockWatchPartyAudioPlayback();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const ctx = watchPartyAudioContext || new AudioContextClass();
    watchPartyAudioContext = ctx;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.5);
    showWatchPartyToast("Speaker test diputar.");
  } catch (err) {
    showWatchPartyToast("Speaker test gagal diputar.");
  }
}

async function handleWatchPartyVoiceAction(action, options = {}) {
  if (action === "join") {
    try {
      await unlockWatchPartyAudioPlayback();
      const audioConstraint = watchPartySelectedMicId
        ? { deviceId: { exact: watchPartySelectedMicId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      watchPartyVoiceStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false });
      const startMuted = options.startMuted ?? true;
      const audioTrack = watchPartyVoiceStream.getAudioTracks()[0];
      updateWatchPartyVoiceDebug({
        micPermission: "Granted",
        microphone: audioTrack?.label || "Connected",
        audioTrack: audioTrack?.readyState === "live" ? "Active" : "Inactive",
        sendingAudio: startMuted ? "Muted" : "Yes"
      });
      audioTrack?.addEventListener("ended", () => {
        updateWatchPartyVoiceDebug({ microphone: "Disconnected", audioTrack: "Ended", sendingAudio: "No" });
        updateVoiceTriggerUI(false, false);
      });

      // Apply initial mute state to the audio tracks
      watchPartyVoiceStream.getAudioTracks().forEach((track) => track.enabled = !startMuted);

      sendWatchPartyEvent("voice:join", { muted: startMuted });
      await refreshWatchPartyVoiceDevices();
      try {
        const iceRes = await fetch("/api/watch-party/ice-servers");
        if (iceRes.ok) {
          const iceServers = await iceRes.json();
          if (Array.isArray(iceServers) && iceServers.length > 0) {
            watchPartyIceServers = iceServers;
          }
        }
      } catch (e) {
        console.warn("Failed to fetch ICE servers, using default:", e);
      }
      startWatchPartyPeerMesh();
      if (!options.silent) {
        showWatchPartyToast(startMuted ? "Masuk ke Voice Chat (Mikrofon Muted)." : "Voice chat aktif.");
      }
      updateVoiceTriggerUI(true, startMuted);
      updateWatchPartyVoiceDebug({ remoteUsers: watchPartyPeers.size, peerConnection: watchPartyPeers.size ? "Connecting" : "Waiting" });
      
      // Initialize controls state
      watchPartyVoiceMuted = startMuted;
      watchPartySpeakerMuted = false;
      watchPartyVoiceMode = "open";
      
      // Update toggle buttons if they exist
      const micBtn = document.querySelector("#voiceMicToggle");
      if (micBtn) {
        micBtn.textContent = startMuted ? "🎤 Mic Off" : "🎤 Mic On";
        micBtn.classList.toggle("muted", startMuted);
      }
      const speakerBtn = document.querySelector("#voiceSpeakerToggle");
      if (speakerBtn) {
        speakerBtn.textContent = "🎧 Speaker On";
        speakerBtn.classList.remove("muted");
      }
      
      // Start voice activity detection
      startLocalVoiceDetection(watchPartyVoiceStream);
      flushWatchPartyPendingVoiceSignals();
    } catch (err) {
      console.warn("Microphone access failed:", err);
      const denied = err.name === "NotAllowedError" || err.name === "PermissionDeniedError";
      updateWatchPartyVoiceDebug({
        micPermission: denied ? "Denied" : "Error",
        microphone: "Disconnected",
        audioTrack: "Inactive",
        sendingAudio: "No"
      });
      let errMsg = "";
      if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
        errMsg = "Gagal: Voice Chat memerlukan koneksi aman (HTTPS). Silakan akses via HTTPS.";
      } else if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        errMsg = "Izin Mic ditolak. Klik ikon gembok 🔒 di address bar browser Anda untuk mengizinkan Microphone.";
        if (window.Telegram?.WebApp || window.Telegram?.WebApp?.initData) {
          errMsg += " Jika membuka via Telegram, klik menu kanan atas (•••) dan pilih 'Open in Browser'.";
        }
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        errMsg = "Microphone tidak ditemukan. Harap colokkan mic/headset Anda.";
      } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
        errMsg = "Microphone sedang digunakan oleh aplikasi lain (Zoom, OBS, Discord, Google Meet). Harap tutup aplikasi tersebut.";
      } else {
        errMsg = `Gagal akses Mic: ${err.message || err.name || "Izin ditolak/diblokir"}`;
      }
      if (!options.silent) {
        showWatchPartyToast(errMsg);
      }
    }
    return;
  }
  if (action === "leave") {
    watchPartyVoiceStream?.getTracks().forEach((track) => track.stop());
    watchPartyVoiceStream = null;
    closeWatchPartyPeers();
    sendWatchPartyEvent("voice:leave");
    if (!options.silent) {
      showWatchPartyToast("Keluar dari voice chat.");
    }
    updateVoiceTriggerUI(false, false);
    updateWatchPartyVoiceDebug({
      microphone: "Disconnected",
      audioTrack: "Inactive",
      peerConnection: "Idle",
      iceState: "Closed",
      remoteUsers: 0,
      receivingAudio: "No",
      sendingAudio: "No"
    });
    
    // Clean up local speaking state
    if (isLocalCurrentlySpeaking) {
      setLocalSpeakingState(false);
    }
    return;
  }
  if (action === "mute" || action === "unmute") {
    const muted = action === "mute";
    muteMicLocally(muted);
  }
}

function showWatchPartyToast(message) {
  let toast = document.querySelector("#watchPartyToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "watchPartyToast";
    toast.className = "watch-party-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(window.__watchPartyToastTimer);
  window.__watchPartyToastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function handleWatchPartyShareOption(option) {
  const code = watchPartyState?.room?.room_code || "";
  const shareLink = `${location.origin}/watch-party/${code}`;
  if (option === "code") {
    navigator.clipboard?.writeText(code).catch(() => {});
    showWatchPartyToast(`Kode room disalin: ${code}`);
    return;
  }
  if (option === "link") {
    navigator.clipboard?.writeText(shareLink).catch(() => {});
    showWatchPartyToast("Link room disalin.");
  }
}

function startWatchPartyPeerMesh() {
  if (!watchPartyVoiceStream || !watchPartyState?.members) return;
  watchPartyState.members
    .filter((member) => member.user_id !== userId && member.online)
    .forEach((member) => {
      if (String(userId) < String(member.user_id)) {
        getWatchPartyPeer(member.user_id, true);
      }
    });
}

function getWatchPartyPeer(remoteUserId, shouldOffer = false) {
  if (watchPartyPeers.has(remoteUserId)) {
    return watchPartyPeers.get(remoteUserId);
  }
  const peer = new RTCPeerConnection({
    iceServers: watchPartyIceServers
  });
  watchPartyVoiceStream?.getTracks().forEach((track) => peer.addTrack(track, watchPartyVoiceStream));
  updateWatchPartyVoiceDebug({ peerConnection: "Connecting", remoteUsers: watchPartyPeers.size + 1 });
  peer.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendWatchPartyEvent("voice:signal", { to: remoteUserId, candidate: event.candidate });
    }
  });
  peer.addEventListener("track", (event) => {
    const stream = event.streams[0];
    if (!stream) return;
    let audio = document.querySelector(`audio[data-watch-party-audio="${remoteUserId}"]`);
    if (!audio) {
      audio = document.createElement("audio");
      audio.dataset.watchPartyAudio = remoteUserId;
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    audio.muted = false;
    audio.playsInline = true;
    // Apply local volume configuration for remote user
    const vol = watchPartyUserVolumes.get(remoteUserId) ?? 80;
    audio.volume = watchPartySpeakerMuted ? 0 : vol / 100;
    updateWatchPartyVoiceDebug({ receivingAudio: "Yes" });

    // Explicitly play to bypass autoplay restrictions
    audio.play().catch((err) => {
      console.warn("Autoplay blocked/failed for remote audio:", err);
      const playOnGesture = () => {
        audio.play().catch(() => {});
        document.removeEventListener("click", playOnGesture);
        document.removeEventListener("touchstart", playOnGesture);
      };
      document.addEventListener("click", playOnGesture);
      document.addEventListener("touchstart", playOnGesture);
    });
  });

  peer.addEventListener("iceconnectionstatechange", () => {
    console.log(`ICE Connection state for user ${remoteUserId}: ${peer.iceConnectionState}`);
    updateWatchPartyVoiceDebug({ iceState: peer.iceConnectionState, peerConnection: peer.connectionState || peer.iceConnectionState });
    if (peer.iceConnectionState === "failed") {
      showWatchPartyToast("Koneksi suara gagal. Coba hubungkan ulang atau gunakan Wi-Fi.");
      restartWatchPartyPeer(remoteUserId);
    }
  });
  peer.addEventListener("connectionstatechange", () => {
    updateWatchPartyVoiceDebug({ peerConnection: peer.connectionState, remoteUsers: watchPartyPeers.size });
    if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
      setTimeout(() => restartWatchPartyPeer(remoteUserId), 1200);
    }
  });
  watchPartyPeers.set(remoteUserId, peer);
  if (shouldOffer) {
    peer.createOffer()
      .then((offer) => peer.setLocalDescription(offer))
      .then(() => sendWatchPartyEvent("voice:signal", { to: remoteUserId, description: peer.localDescription }))
      .catch(() => {});
  }
  return peer;
}

async function handleWatchPartyVoiceSignal(signal) {
  if (!signal || signal.to !== userId) return;
  if (!watchPartyVoiceStream) {
    watchPartyPendingVoiceSignals.push(signal);
    return;
  }
  const peer = getWatchPartyPeer(signal.from, false);
  try {
    if (signal.description) {
      await peer.setRemoteDescription(signal.description);
      await flushWatchPartyPendingIce(signal.from, peer);
      if (signal.description.type === "offer") {
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        sendWatchPartyEvent("voice:signal", { to: signal.from, description: peer.localDescription });
      }
    }
    if (signal.candidate) {
      if (peer.remoteDescription) {
        await peer.addIceCandidate(signal.candidate);
      } else {
        const pending = watchPartyPendingIceCandidates.get(signal.from) || [];
        pending.push(signal.candidate);
        watchPartyPendingIceCandidates.set(signal.from, pending);
      }
    }
  } catch (err) {
    console.warn("Watch party voice signal failed:", err);
    updateWatchPartyVoiceDebug({ peerConnection: "Signal Error" });
  }
}

function flushWatchPartyPendingVoiceSignals() {
  const queued = watchPartyPendingVoiceSignals.splice(0, watchPartyPendingVoiceSignals.length);
  queued.forEach((signal) => {
    handleWatchPartyVoiceSignal(signal);
  });
}

async function flushWatchPartyPendingIce(remoteUserId, peer) {
  const pending = watchPartyPendingIceCandidates.get(remoteUserId) || [];
  watchPartyPendingIceCandidates.delete(remoteUserId);
  for (const candidate of pending) {
    try {
      await peer.addIceCandidate(candidate);
    } catch (err) {
      console.warn("Failed to add queued ICE candidate:", err);
    }
  }
}

function restartWatchPartyPeer(remoteUserId) {
  if (!watchPartyVoiceStream || !watchPartyState?.members?.some((member) => member.user_id === remoteUserId && member.online)) {
    return;
  }
  const existing = watchPartyPeers.get(remoteUserId);
  if (existing && !["failed", "disconnected", "closed"].includes(existing.connectionState) && !["failed", "disconnected", "closed"].includes(existing.iceConnectionState)) {
    return;
  }
  existing?.close();
  watchPartyPeers.delete(remoteUserId);
  watchPartyPendingIceCandidates.delete(remoteUserId);
  if (String(userId) < String(remoteUserId)) {
    getWatchPartyPeer(remoteUserId, true);
  }
}

function closeWatchPartyPeers() {
  watchPartyPeers.forEach((peer) => peer.close());
  watchPartyPeers.clear();
  watchPartyPendingIceCandidates.clear();
  watchPartyPendingVoiceSignals.splice(0, watchPartyPendingVoiceSignals.length);
  document.querySelectorAll("audio[data-watch-party-audio]").forEach((audio) => audio.remove());
  updateWatchPartyVoiceDebug({ peerConnection: "Idle", iceState: "Closed", remoteUsers: 0, receivingAudio: "No" });
}

async function renderMovieboxPlayer(id) {
  const params = new URLSearchParams(location.search);
  const se = params.get("se") || "1";
  const ep = params.get("ep") || "1";
  const resourceId = params.get("resourceId") || "";

  app.innerHTML = `
    <section class="moviebox-watch-page">
      <div class="moviebox-player-container">
        <header class="moviebox-player-header">
          <span class="back-pill skeleton-muted">&larr;</span>
          <div><div class="skeleton-line title small-title"></div><div class="skeleton-line short"></div></div>
        </header>
        <div class="moviebox-video-wrapper">${loadingVideoStage()}</div>
      </div>
      <aside class="moviebox-sidebar-container">
        <div class="moviebox-sidebar-header"><h2>Daftar Episode</h2><span>...</span></div>
        ${loadingEpisodeGrid(40, true)}
      </aside>
    </section>
  `;

  try {
    let cached = movieboxDetailCache.get(id);
    if (!cached || !cached.subjectId) {
      const detailRes = await fetch(`/api/moviebox/detail/${encodeURIComponent(id)}?se=${se}`);
      const detailData = await detailRes.json();
      movieboxDetailCache.set(id, { ...detailData, selectedSeason: Number(se) });
      cached = detailData;
    }

    const subjectId = cached.subjectId;
    const episodesList = cached.episodes || [];
    const currentSeasonNum = Number(se);
    const seasonInfo = cached.seasons?.find(s => Number(s.se) === currentSeasonNum) || {};
    const availableResolutions = seasonInfo.resolutions?.map(r => r.resolution || r) || [360, 480, 720];
    
    const watchRes = await fetch(`/api/moviebox/watch?subjectId=${subjectId}&resourceId=${resourceId}&se=${se}&ep=${ep}&resolution=${selectedMovieboxResolution}`);
    const watchData = await watchRes.json();

    if (watchData.error || !watchData.streams || !watchData.streams[0]) {
      app.innerHTML = `
        <section class="page-section top-space">
          <div class="empty-state">
            <h1>Playback Error</h1>
            <p>Video streaming tidak tersedia saat ini. Silakan coba episode lain atau refresh halaman.</p>
            <a class="primary-btn" href="/moviebox/detail/${id}" style="margin-top:20px; background: linear-gradient(135deg, #e9a300, #ff7b00); color:#000; text-decoration:none; display:inline-block; border-radius:30px; padding:10px 24px;">Kembali ke Detail</a>
          </div>
        </section>
      `;
      return;
    }

    const streamUrl = watchData.streams[0].url;
    const mappedSubtitles = (watchData.subtitles || []).map(sub => ({
      lang: sub.code || sub.language || "en",
      label: sub.language || sub.code || "English",
      url: sub.url
    }));

    const currentEpIndex = episodesList.findIndex(e => String(e.episode_number) === String(ep));
    const nextEpObj = currentEpIndex !== -1 && episodesList[currentEpIndex + 1];
    const nextUrl = nextEpObj ? `/moviebox/watch/${id}?se=${se}&ep=${nextEpObj.episode_number}&resourceId=${nextEpObj.resourceId}` : "";

    const episodeButtons = episodesList.map(item => {
      const activeClass = String(item.episode_number) === String(ep) ? "active" : "";
      const watchUrl = `/moviebox/watch/${id}?se=${se}&ep=${item.episode_number}&resourceId=${item.resourceId}`;
      return `<a class="episode-link ${activeClass}" href="${watchUrl}">Ep ${item.episode_number}</a>`;
    }).join("");

    app.innerHTML = `
      <section class="moviebox-watch-page">
        <div class="moviebox-player-container">
          <header class="moviebox-player-header">
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
              <a class="moviebox-back-btn" href="/moviebox/detail/${id}?se=${se}" aria-label="Kembali">&larr; <span>Back to Details</span></a>
              <div class="moviebox-header-actions" style="display: flex; align-items: center; gap: 12px;">
                ${movieboxQualityControl(availableResolutions, selectedMovieboxResolution)}
                ${movieboxSubtitleControl(mappedSubtitles)}
              </div>
            </div>
            <div class="moviebox-player-title" style="margin-top: 8px;">
              <h1>${escapeHtml(cached.title)}</h1>
              <p>${escapeHtml(watchData.title || `Episode ${ep}`)}</p>
            </div>
          </header>
          <div class="moviebox-video-wrapper">
            <div class="moviebox-video-stage" id="playerShell">
              <video class="moviebox-video-element" data-src="${escapeHtml(streamUrl)}" data-subtitles="${escapeHtml(JSON.stringify(mappedSubtitles))}" poster="${escapeHtml(cached.backdrop || cached.poster)}" data-next-url="${nextUrl}" playsinline preload="metadata" autoplay></video>
              <button class="player-fullscreen-back hide" id="fullscreenBackBtn" type="button" aria-label="Kembali">&larr;</button>
              <button class="player-play-toggle" id="playToggleBtn" type="button" data-play-toggle aria-label="Play/Pause"><span class="play-icon"></span></button>
              
              <div class="player-controls-bar hide" id="playerControlsBar">
                <div class="controls-left">
                  <button class="control-btn" id="stopBtn" type="button" aria-label="Stop"><span class="stop-icon"></span></button>
                  <button class="control-btn" id="playBtn" type="button" data-play-toggle aria-label="Play/Pause"><span class="play-icon"></span></button>
                  <a class="control-btn ${nextUrl ? '' : 'disabled'}" id="nextBtn" href="${nextUrl || '#'}" aria-label="Next Episode"><span class="next-icon"></span></a>
                </div>
                <div class="controls-center">
                  <div class="progress-container" id="progressContainer">
                    <div class="progress-bar" id="progressBar"></div>
                  </div>
                </div>
                <div class="controls-right">
                  <span class="time-display" id="timeDisplay">0:00 / 0:00</span>
                  <button class="control-btn fullscreen-action" type="button" data-fullscreen style="margin-left: 8px;" aria-label="Fullscreen"><span></span></button>
                </div>
              </div>

              <div class="subtitle-overlay" id="subtitleOverlay" aria-live="polite"></div>
              <div class="video-message" id="videoMessage"><span class="inline-dot-loader" aria-label="Memuat"></span></div>
            </div>
          </div>
        </div>

        <aside class="moviebox-sidebar-container">
          <div class="moviebox-sidebar-header">
            <h2>Daftar Episode</h2>
            <span>Season ${se} &bull; ${episodesList.length} Episode</span>
          </div>
          <div class="moviebox-episodes-list">${episodeButtons}</div>
          <div class="moviebox-details-info">
            <h3>Deskripsi</h3>
            <p>${escapeHtml(cached.description)}</p>
          </div>
        </aside>
      </section>
    `;

    mountMovieboxVideoPlayer();
    mountWatchPlayer(
      { id: id, title: cached.title, platform: "MovieBox" },
      { videoUrl: streamUrl, subtitles: mappedSubtitles, number: Number(ep) },
      Number(ep),
      allSources,
      platformApi,
      secureFetch,
      "off"
    );

    const backBtn = document.querySelector("#fullscreenBackBtn");
    if (backBtn) {
      backBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          history.pushState({}, "", `/moviebox/detail/${id}?se=${se}`);
          renderRoute();
        }
      });
    }

  } catch (err) {
    console.error(err);
    app.innerHTML = `
      <section class="page-section top-space">
        <div class="empty-state">Gagal membuka player. Harap coba lagi nanti.</div>
      </section>
    `;
  }
}

async function mountMovieboxVideoPlayer() {
  const video = document.querySelector("video.moviebox-video-element[data-src]");
  if (!video || video.dataset.mounted === "true") {
    return;
  }
  cleanupActivePlayer(video);

  const mountId = ++activeVideoMountId;
  video.dataset.mounted = "true";
  const src = video.dataset.src;
  const message = document.querySelector("#videoMessage");
  window.__TEAMDLVideoState = { src, mode: "starting", events: [] };
  mountSubtitleOverlay(video);

  const stage = document.querySelector("#playerShell");
  const backBtn = document.querySelector("#fullscreenBackBtn");
  const controlsBar = document.querySelector("#playerControlsBar");
  const progressBar = document.querySelector("#progressBar");
  const timeDisplay = document.querySelector("#timeDisplay");
  const progressContainer = document.querySelector("#progressContainer");
  const stopBtn = document.querySelector("#stopBtn");

  if (stage) {
    let controlsTimeout = null;

    const showControls = () => {
      if (backBtn) backBtn.classList.remove("hide");
      if (controlsBar) controlsBar.classList.remove("hide");
      if (controlsTimeout) clearTimeout(controlsTimeout);

      if (!video.paused) {
        controlsTimeout = setTimeout(() => {
          if (backBtn) backBtn.classList.add("hide");
          if (controlsBar) controlsBar.classList.add("hide");
        }, 4000);
      }
    };

    const showSeekIndicator = (labelText, side) => {
      let indicator = stage.querySelector(`.double-tap-indicator.${side}`);
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.className = `double-tap-indicator ${side}`;
        indicator.innerHTML = `
          <div class="double-tap-circle">
            <span class="double-tap-icon">${side === 'right' ? '&#9654;&#9654;' : '&#9664;&#9664;'}</span>
            <span class="double-tap-label">${labelText}</span>
          </div>
        `;
        stage.appendChild(indicator);
      } else {
        indicator.querySelector(".double-tap-label").textContent = labelText;
      }

      indicator.classList.remove("animate");
      void indicator.offsetWidth; // Force reflow
      indicator.classList.add("animate");
    };

    let clickTimeout = null;
    stage.addEventListener("click", (e) => {
      if (e.target.closest("#fullscreenBackBtn") || e.target.closest("#playerControlsBar") || e.target.closest("#playToggleBtn") || e.target.closest("#subtitleControl") || e.target.closest("#qualityControl")) {
        return;
      }
      if (location.pathname.startsWith("/watch-party/") && !watchPartyState?.isHost) {
        e.preventDefault();
        showControls();
        showWatchPartyToast("Kontrol video hanya untuk host.");
        return;
      }

      const now = Date.now();
      const delay = 300;
      if (video.dataset.lastClick && (now - Number(video.dataset.lastClick)) < delay) {
        if (clickTimeout) {
          clearTimeout(clickTimeout);
          clickTimeout = null;
        }

        const rect = stage.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const halfWidth = rect.width / 2;

        if (clickX > halfWidth) {
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
          showSeekIndicator("+10s", "right");
        } else {
          video.currentTime = Math.max(0, video.currentTime - 10);
          showSeekIndicator("-10s", "left");
        }
        video.dataset.lastClick = "0";
        showControls();
      } else {
        video.dataset.lastClick = String(now);
        clickTimeout = setTimeout(() => {
          if (video.paused) {
            video.play().catch(() => {});
          } else {
            video.pause();
          }
          syncPlayButton(video);
          showControls();
          clickTimeout = null;
        }, delay);
      }
    });

    stage.addEventListener("mousemove", () => {
      showControls();
    });

    document.addEventListener("fullscreenchange", () => {
      showControls();
    });

    if (stopBtn) {
      stopBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        video.pause();
        video.currentTime = 0;
        syncPlayButton(video);
        updateTimeDisplay(0, video.duration);
        showControls();
      });
    }

    if (progressContainer) {
      progressContainer.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (location.pathname.startsWith("/watch-party/") && !watchPartyState?.isHost) {
          showWatchPartyToast("Seek hanya untuk host.");
          return;
        }
        const rect = progressContainer.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const width = rect.width;
        if (width > 0 && video.duration > 0) {
          const percent = clickX / width;
          video.currentTime = percent * video.duration;
          updateTimeDisplay(video.currentTime, video.duration);
        }
      });
    }

    const formatTime = (seconds) => {
      if (isNaN(seconds) || seconds === Infinity) return "0:00";
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
    };

    const updateTimeDisplay = (currentTime, duration) => {
      if (timeDisplay) {
        timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
      }
      if (progressBar && duration > 0) {
        const percent = (currentTime / duration) * 100;
        progressBar.style.width = `${percent}%`;
      }
    };

    video.addEventListener("timeupdate", () => {
      updateTimeDisplay(video.currentTime, video.duration);
    });

    video.addEventListener("durationchange", () => {
      updateTimeDisplay(video.currentTime, video.duration);
    });

    video.addEventListener("loadedmetadata", () => {
      updateTimeDisplay(video.currentTime, video.duration);
    });

    video.addEventListener("play", () => {
      showControls();
    });

    video.addEventListener("pause", () => {
      if (backBtn) backBtn.classList.remove("hide");
      if (controlsBar) controlsBar.classList.remove("hide");
      if (controlsTimeout) clearTimeout(controlsTimeout);
    });

    showControls();
  }

  const clearLoadingMessage = () => message?.remove();
  const loadingTimer = setTimeout(() => {
    if (isCurrentVideoMount(video, mountId) && video.readyState < 2) {
      showVideoMessage("Video belum bisa diputar. Coba episode lain atau refresh halaman.");
    }
  }, 12000);
  const clearLoadingTimer = () => clearTimeout(loadingTimer);
  
  video.addEventListener("loadedmetadata", clearLoadingTimer, { once: true });
  video.addEventListener("canplay", clearLoadingTimer, { once: true });
  video.addEventListener("playing", clearLoadingTimer, { once: true });
  video.addEventListener("error", (e) => {
    clearLoadingTimer();
    const err = video.error;
    const detail = err ? `Code ${err.code}: ${err.message || ""}` : "Unknown error";
    showVideoMessage(`Video gagal dimuat (${detail}). Coba episode lain.`);
  }, { once: true });

  let lastUpdateTime = Date.now();
  const handleTimeUpdate = () => {
    if (video.paused || video.ended || document.visibilityState !== "visible") {
      lastUpdateTime = Date.now();
      return;
    }
    const now = Date.now();
    const elapsedMs = now - lastUpdateTime;
    if (elapsedMs > 0 && elapsedMs < 5000) {
      accumulateWatchTime(elapsedMs / 1000);
    }
    lastUpdateTime = now;
  };

  video.addEventListener("timeupdate", handleTimeUpdate);
  video.addEventListener("play", () => {
    syncPlayButton(video);
    lastUpdateTime = Date.now();
  });
  video.addEventListener("pause", () => syncPlayButton(video));
}

function movieboxSubtitleControl(subtitles) {
  const active = subtitles.find(item => item.lang === selectedSubtitleLang);
  const label = active?.lang.toUpperCase() || "Off";
  return `
    <div class="subtitle-control" id="subtitleControl">
      <button class="caption-pill" type="button" data-subtitle-toggle aria-label="Subtitle">CC <span>${escapeHtml(label)}</span></button>
      <div class="subtitle-menu" role="menu">
        <button class="${selectedSubtitleLang === 'off' ? 'active' : ''}" type="button" data-subtitle-lang="off">Off${selectedSubtitleLang === 'off' ? '<span>OK</span>' : ''}</button>
        ${subtitles.map(item => `
          <button class="${item.lang === selectedSubtitleLang ? 'active' : ''}" type="button" data-subtitle-lang="${escapeHtml(item.lang)}">${escapeHtml(item.lang.toUpperCase())}${item.lang === selectedSubtitleLang ? '<span>OK</span>' : ''}</button>
        `).join("")}
        ${subtitles.length ? "" : '<button type="button" disabled>Subtitle belum tersedia</button>'}
      </div>
    </div>
  `;
}

function movieboxEpisodeControl(episodes, currentEp, isHost) {
  const label = `Ep ${currentEp}`;
  if (!isHost) {
    return `
      <div class="quality-control" id="episodeControl">
        <button class="caption-pill disabled" type="button" style="cursor: default;" aria-label="Episode">Ep <span>${escapeHtml(label)}</span></button>
      </div>
    `;
  }
  return `
    <div class="quality-control" id="episodeControl">
      <button class="caption-pill" type="button" data-episode-toggle aria-label="Episode">Ep <span>${escapeHtml(label)}</span></button>
      <div class="quality-menu episode-menu" role="menu" style="display: none; max-height: 240px; overflow-y: auto;">
        ${episodes.map(ep => {
          const active = String(ep.episode_number) === String(currentEp);
          return `
            <button class="${active ? 'active' : ''}" type="button" data-watch-party-episode-num="${ep.episode_number}" data-watch-party-episode-res-id="${ep.resourceId || ''}">
              Episode ${ep.episode_number}${active ? ' <span style="float: right; color: #e9a300;">OK</span>' : ''}
            </button>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function movieboxQualityControl(resolutions, selected) {
  const label = `${selected}P`;
  return `
    <div class="quality-control" id="qualityControl">
      <button class="caption-pill" type="button" data-quality-toggle aria-label="Quality">Res <span>${escapeHtml(label)}</span></button>
      <div class="quality-menu" role="menu" style="display: none;">
        ${resolutions.map(r => {
          const active = Number(r) === Number(selected);
          return `
            <button class="${active ? 'active' : ''}" type="button" data-quality-res="${r}">
              ${r}p${active ? ' <span style="float: right; color: #e9a300;">OK</span>' : ''}
            </button>
          `;
        }).join("")}
      </div>
    </div>
  `;
}


async function changeMovieboxVideoResolution(resolution, resumeTime = 0, resumePaused = false) {
  const video = document.querySelector("video.moviebox-video-element");
  const message = document.querySelector("#videoMessage");
  if (!video) return;

  const id = location.pathname.split("/").pop();
  const params = new URLSearchParams(location.search);
  const se = params.get("se") || "1";
  const ep = params.get("ep") || "1";
  const resourceId = params.get("resourceId") || "";

  // Show loading indicator
  if (message) {
    message.style.display = "flex";
    message.innerHTML = '<span class="inline-dot-loader" aria-label="Memuat"></span>';
  }

  try {
    let cached = movieboxDetailCache.get(id);
    if (!cached || !cached.subjectId) {
      const detailRes = await fetch(`/api/moviebox/detail/${encodeURIComponent(id)}?se=${se}`);
      cached = await detailRes.json();
      movieboxDetailCache.set(id, { ...cached, selectedSeason: Number(se) });
    }

    const subjectId = cached.subjectId;
    const watchRes = await fetch(`/api/moviebox/watch?subjectId=${subjectId}&resourceId=${resourceId}&se=${se}&ep=${ep}&resolution=${resolution}`);
    const watchData = await watchRes.json();

    if (watchData.error || !watchData.streams || !watchData.streams[0]) {
      showVideoMessage("Gagal memuat kualitas video ini. Silakan coba kualitas lain.");
      return;
    }

    const streamUrl = watchData.streams[0].url;
    
    // Update active mount ID to cancel older loads
    const mountId = ++activeVideoMountId;
    video.dataset.mounted = "true";
    video.src = streamUrl;
    
    // Resume playback state
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = resumeTime;
      if (!resumePaused) {
        video.play().catch(() => {});
      }
      message?.remove();
    }, { once: true });
    
    // Update the quality toggle label in UI
    const qualityLabel = document.querySelector("#qualityControl button span");
    if (qualityLabel) {
      qualityLabel.textContent = `${resolution}P`;
    }
    // Update active class in quality menu buttons
    document.querySelectorAll("[data-quality-res]").forEach(btn => {
      const btnRes = Number(btn.dataset.qualityRes);
      const active = btnRes === Number(resolution);
      btn.className = active ? "active" : "";
      if (active) {
        btn.innerHTML = `${btnRes}p <span style="float: right; color: #e9a300;">OK</span>`;
      } else {
        btn.innerHTML = `${btnRes}p`;
      }
    });

  } catch (err) {
    console.error(err);
    showVideoMessage("Gagal mengganti kualitas video.");
  }
}

document.addEventListener("click", (event) => {
  // Voice Toggle Trigger Click
  const voiceToggle = event.target.closest("#voiceToggleTrigger");
  if (voiceToggle) {
    event.preventDefault();
    const otherMenu = document.querySelector("#emojiDropupMenu");
    if (otherMenu) otherMenu.classList.remove("show");
    const menu = document.querySelector("#voiceDropupMenu");
    
    if (!watchPartyVoiceStream) {
      // If auto-join didn't happen or failed, click to join unmuted
      handleWatchPartyVoiceAction("join", { startMuted: false });
    } else {
      muteMicLocally(!watchPartyVoiceMuted);
      unlockWatchPartyAudioPlayback();
    }
    if (menu) {
      menu.classList.toggle("show");
      refreshWatchPartyVoiceDevices();
      updateWatchPartyVoiceDebug();
    }
    return;
  }

  const voiceDebugToggle = event.target.closest("#watchPartyVoiceDebugToggle");
  if (voiceDebugToggle) {
    event.preventDefault();
    const debug = document.querySelector("#watchPartyVoiceDebug");
    if (debug) {
      debug.hidden = !debug.hidden;
      updateWatchPartyVoiceDebug();
    }
    return;
  }

  const allowMic = event.target.closest("#watchPartyAllowMicBtn");
  if (allowMic) {
    event.preventDefault();
    handleWatchPartyVoiceAction("join", { startMuted: false });
    return;
  }

  const speakerTest = event.target.closest("#watchPartySpeakerTestBtn");
  if (speakerTest) {
    event.preventDefault();
    playWatchPartySpeakerTest();
    return;
  }

  // Emoji Toggle Trigger Click
  const emojiToggle = event.target.closest("#emojiToggleTrigger");
  if (emojiToggle) {
    event.preventDefault();
    const menu = document.querySelector("#emojiDropupMenu");
    const otherMenu = document.querySelector("#voiceDropupMenu");
    if (otherMenu) otherMenu.classList.remove("show");
    if (menu) menu.classList.toggle("show");
    return;
  }

  // Close dropup menus if clicking outside of them
  if (!event.target.closest("#watchPartyVoiceDropdown")) {
    const menu = document.querySelector("#voiceDropupMenu");
    if (menu) menu.classList.remove("show");
  }
  if (!event.target.closest("#watchPartyEmojiDropdown")) {
    const menu = document.querySelector("#emojiDropupMenu");
    if (menu) menu.classList.remove("show");
  }

  const partyTab = event.target.closest("[data-watch-party-tab]");
  if (partyTab) {
    event.preventDefault();
    const tab = partyTab.dataset.watchPartyTab;
    document.querySelectorAll("[data-watch-party-tab]").forEach((button) => button.classList.toggle("active", button === partyTab));
    document.querySelectorAll("[data-watch-party-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.watchPartyPanel === tab));
    return;
  }

  const closeRoomBtn = event.target.closest("#closeWatchPartyRoomBtn");
  if (closeRoomBtn && watchPartyState?.room) {
    event.preventDefault();
    const roomCode = watchPartyState.room.room_code;
    if (confirm("Apakah Anda yakin ingin mematikan room nonton bareng ini secara permanen?")) {
      closeRoomBtn.disabled = true;
      closeRoomBtn.textContent = "Menutup...";
      
      const adminToken = localStorage.getItem("adminToken") || "";
      fetch("/api/watch-party/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomCode, userId: userId, adminToken })
      })
      .then(res => res.json())
      .then(data => {
        if (data.ok) {
          showWatchPartyToast("Room berhasil ditutup.");
        } else {
          showWatchPartyToast(`Gagal menutup room: ${data.error}`);
          closeRoomBtn.disabled = false;
          closeRoomBtn.textContent = "Bubarkan / Offkan Room";
        }
      })
      .catch(err => {
        showWatchPartyToast(`Error: ${err.message}`);
        closeRoomBtn.disabled = false;
        closeRoomBtn.textContent = "Matikan Room Sekarang";
      });
    }
    return;
  }

  const partyShare = event.target.closest("[data-watch-party-share]");
  if (partyShare && watchPartyState?.room) {
    event.preventDefault();
    const code = watchPartyState.room.room_code;
    const shareLink = `${location.origin}/watch-party/${code}`;
    navigator.clipboard?.writeText(shareLink).catch(() => {});
    showWatchPartyToast(`Link room disalin: ${code}`);
    return;
  }

  const partyShareOption = event.target.closest("[data-watch-party-share-option]");
  if (partyShareOption && watchPartyState?.room) {
    event.preventDefault();
    handleWatchPartyShareOption(partyShareOption.dataset.watchPartyShareOption);
    return;
  }

  const partySticker = event.target.closest("[data-watch-party-sticker]");
  if (partySticker) {
    event.preventDefault();
    sendWatchPartyEvent("sticker:send", { sticker: partySticker.dataset.watchPartySticker });
    const menu = document.querySelector("#emojiDropupMenu");
    if (menu) menu.classList.remove("show");
    return;
  }

  const partyVoice = event.target.closest("[data-watch-party-voice]");
  if (partyVoice) {
    event.preventDefault();
    handleWatchPartyVoiceAction(partyVoice.dataset.watchPartyVoice);
    const menu = document.querySelector("#voiceDropupMenu");
    if (menu) menu.classList.remove("show");
    return;
  }

  const voiceMicToggle = event.target.closest("#voiceMicToggle");
  if (voiceMicToggle) {
    event.preventDefault();
    muteMicLocally(!watchPartyVoiceMuted);
    return;
  }

  const voiceSpeakerToggle = event.target.closest("#voiceSpeakerToggle");
  if (voiceSpeakerToggle) {
    event.preventDefault();
    toggleSpeakerLocally();
    return;
  }

  const voiceAdminAction = event.target.closest("[data-voice-admin-action]");
  if (voiceAdminAction) {
    event.preventDefault();
    const action = voiceAdminAction.dataset.voiceAdminAction;
    const targetUserId = voiceAdminAction.dataset.voiceAdminTarget;
    sendWatchPartyEvent("voice:admin_action", { action, targetUserId });
    return;
  }
});

document.addEventListener("change", (event) => {
  const micSelect = event.target.closest("#watchPartyMicSelect");
  if (micSelect) {
    watchPartySelectedMicId = micSelect.value || "";
    localStorage.setItem("TEAMDLWatchPartyMicId", watchPartySelectedMicId);
    if (watchPartyVoiceStream) {
      handleWatchPartyVoiceAction("leave", { silent: true });
      setTimeout(() => handleWatchPartyVoiceAction("join", { startMuted: watchPartyVoiceMuted, silent: false }), 250);
    }
    return;
  }

  const modeSelect = event.target.closest("#voiceModeSelect");
  if (modeSelect) {
    watchPartyVoiceMode = modeSelect.value;
    const pttBtn = document.querySelector("#voicePttBtn");
    if (watchPartyVoiceMode === "ptt") {
      // PTT default is muted
      watchPartyVoiceStream?.getAudioTracks().forEach((track) => track.enabled = false);
      sendWatchPartyEvent("voice:mute");
      if (pttBtn) pttBtn.classList.remove("hide");
    } else {
      // Open Mic state
      watchPartyVoiceStream?.getAudioTracks().forEach((track) => track.enabled = !watchPartyVoiceMuted);
      sendWatchPartyEvent(watchPartyVoiceMuted ? "voice:mute" : "voice:unmute");
      if (pttBtn) pttBtn.classList.add("hide");
    }
  }
});

document.addEventListener("input", (event) => {
  const volumeSlider = event.target.closest("[data-voice-volume-target]");
  if (volumeSlider) {
    const targetUserId = volumeSlider.dataset.voiceVolumeTarget;
    const volValue = Number(volumeSlider.value);
    watchPartyUserVolumes.set(targetUserId, volValue);
    
    const audio = document.querySelector(`audio[data-watch-party-audio="${targetUserId}"]`);
    if (audio) {
      audio.volume = watchPartySpeakerMuted ? 0 : volValue / 100;
    }
    
    const parentCard = volumeSlider.closest(".voice-member-card");
    if (parentCard) {
      const label = parentCard.querySelector(".volume-label");
      if (label) label.textContent = `Vol: ${volValue}%`;
    }
  }
});

document.addEventListener("mousedown", (e) => {
  const ptt = e.target.closest("#voicePttBtn");
  if (ptt) {
    e.preventDefault();
    startPttTalk();
  }
});
document.addEventListener("mouseup", (e) => {
  const ptt = e.target.closest("#voicePttBtn");
  if (ptt) {
    e.preventDefault();
    stopPttTalk();
  }
});
document.addEventListener("touchstart", (e) => {
  const ptt = e.target.closest("#voicePttBtn");
  if (ptt) {
    e.preventDefault();
    startPttTalk();
  }
}, { passive: false });
document.addEventListener("touchend", (e) => {
  const ptt = e.target.closest("#voicePttBtn");
  if (ptt) {
    e.preventDefault();
    stopPttTalk();
  }
});

document.addEventListener("click", (event) => {
  // MovieBox Episode Dropdown Toggle
  const episodeToggle = event.target.closest("[data-episode-toggle]");
  if (episodeToggle) {
    event.preventDefault();
    const menu = episodeToggle.closest(".quality-control")?.querySelector(".episode-menu");
    if (menu) {
      const isOpen = menu.style.display === "block";
      document.querySelectorAll(".quality-menu").forEach(m => {
        if (m !== menu) m.style.display = "none";
      });
      menu.style.display = isOpen ? "none" : "block";
    }
    return;
  }

  // MovieBox Episode Selection Click
  const episodeOption = event.target.closest("[data-watch-party-episode-num]");
  if (episodeOption) {
    event.preventDefault();
    const epNum = episodeOption.dataset.watchPartyEpisodeNum;
    const epResId = episodeOption.dataset.watchPartyEpisodeResId || "";
    
    if (location.pathname.startsWith("/watch-party/") && !watchPartyState?.isHost) {
      showWatchPartyToast("Episode hanya diatur host.");
      episodeOption.closest(".episode-menu").style.display = "none";
      return;
    }
    
    episodeOption.closest(".episode-menu").style.display = "none";
    
    // Send to WebSocket
    sendWatchPartyEvent("video:next_episode", { episode: epNum, episodeId: epResId });
    
    // Host transitions locally
    if (watchPartyState) {
      watchPartyState.room.episode = epNum;
      watchPartyState.room.episode_id = epResId;
      mountWatchPartyPayload(watchPartyState);
    }
    return;
  }

  const partySeek = event.target.closest("[data-watch-party-seek]");
  if (partySeek) {
    event.preventDefault();
    const video = document.querySelector("video.moviebox-video-element");
    if (video && watchPartyState?.isHost) {
      video.currentTime = Math.max(0, video.currentTime + Number(partySeek.dataset.watchPartySeek || 0));
      sendWatchPartyEvent("video:seek", { currentTime: video.currentTime, isPlaying: !video.paused });
    }
    return;
  }

  // 1. MovieBox Tab Buttons
  const tabBtn = event.target.closest("[data-moviebox-tab]");
  if (tabBtn) {
    event.preventDefault();
    const tab = tabBtn.dataset.movieboxTab;
    movieboxSelectedTab = tab;
    
    const params = new URLSearchParams(location.search);
    params.set("tab", tab);
    history.pushState({}, "", `${location.pathname}?${params.toString()}`);
    
    if (tab === "movies" || tab === "series" || tab === "anime") {
      movieboxFilters = {
        genre: "All",
        country: "All",
        year: "All",
        language: "All",
        sort: "ForYou"
      };
      movieboxFilterPage = 1;
      movieboxFilterItems = [];
      movieboxFilterHasMore = false;
    }
    if (tab === "shortdrama") {
      movieboxShortDramaPage = 1;
      movieboxShortDramaItems = [];
      movieboxShortDramaHasMore = false;
    }
    renderMovieboxHome();
    return;
  }

  // 1b. MovieBox Filter Pill Button Clicks
  const filterBtn = event.target.closest("[data-filter-key]");
  if (filterBtn) {
    event.preventDefault();
    const key = filterBtn.dataset.filterKey;
    const value = filterBtn.dataset.filterValue;
    movieboxFilters[key] = value;
    
    // Quick inline styling sync
    const row = filterBtn.closest(".filter-options");
    if (row) {
      row.querySelectorAll(".filter-pill-btn").forEach(btn => {
        const active = btn.dataset.filterValue === value;
        btn.classList.toggle("active", active);
        btn.style.color = active ? "#000" : "rgba(255,255,255,0.7)";
        btn.style.backgroundColor = active ? "#fff" : "transparent";
        btn.style.fontWeight = active ? "700" : "400";
      });
    }
    
    fetchFilteredMovieboxItems(false);
    return;
  }

  // 1c. MovieBox Load More Filters Clicks
  const loadMoreFiltersBtn = event.target.closest("#movieboxLoadMoreFiltersBtn");
  if (loadMoreFiltersBtn) {
    event.preventDefault();
    if (movieboxSelectedTab === "shortdrama") {
      movieboxShortDramaPage++;
      fetchMovieboxShortDramaItems(true);
      return;
    }
    movieboxFilterPage++;
    fetchFilteredMovieboxItems(true);
    return;
  }

  // 2. MovieBox Quality Toggle
  const qualityToggle = event.target.closest("[data-quality-toggle]");
  if (qualityToggle) {
    event.preventDefault();
    const menu = qualityToggle.closest(".quality-control")?.querySelector(".quality-menu");
    if (menu) {
      const isOpen = menu.style.display === "block";
      document.querySelectorAll(".quality-menu").forEach(m => {
        if (m !== menu) m.style.display = "none";
      });
      menu.style.display = isOpen ? "none" : "block";
    }
    return;
  }

  // 3. MovieBox Quality Selection
  const qualityOption = event.target.closest("[data-quality-res]");
  if (qualityOption) {
    event.preventDefault();
    const res = Number(qualityOption.dataset.qualityRes);
    if (location.pathname.startsWith("/watch-party/") && !watchPartyState?.isHost) {
      showWatchPartyToast("Kualitas video hanya diatur host.");
      qualityOption.closest(".quality-menu").style.display = "none";
      return;
    }
    const video = document.querySelector("video.moviebox-video-element");
    if (video) {
      const currentTime = video.currentTime;
      const isPaused = video.paused;
      selectedMovieboxResolution = res;
      localStorage.setItem("TEAMDLMovieboxResolution", String(res));
      qualityOption.closest(".quality-menu").style.display = "none";
      changeMovieboxVideoResolution(res, currentTime, isPaused);
      if (location.pathname.startsWith("/watch-party/") && watchPartyState?.isHost) {
        sendWatchPartyEvent("video:change_quality", { quality: `${res}p`, currentTime });
      }
    }
    return;
  }

  // 4. Subtitle CC Toggle (handling it programmatically for click outside)
  const ccToggle = event.target.closest("[data-subtitle-toggle]");
  if (ccToggle) {
    document.querySelectorAll(".quality-menu").forEach(m => m.style.display = "none");
  }

  // 5. Close menus when clicking outside
  if (!event.target.closest(".quality-control") && !event.target.closest(".subtitle-control")) {
    document.querySelectorAll(".quality-menu").forEach(m => m.style.display = "none");
    document.querySelectorAll(".subtitle-control.open").forEach(m => m.classList.remove("open"));
  }
});

document.addEventListener("change", (event) => {
  // 2. MovieBox Season Dropdown Selector
  const select = event.target.closest("#movieboxSeasonSelect");
  if (select) {
    event.preventDefault();
    const detailId = select.dataset.detailId;
    const selected = Number(select.value);
    renderMovieboxDetail(detailId, selected);
  }
});

document.addEventListener("submit", (event) => {
  const joinForm = event.target.closest("#watchPartyJoinForm");
  if (joinForm) {
    event.preventDefault();
    const code = document.querySelector("#watchPartyCodeInput")?.value.trim().toUpperCase();
    if (code) {
      history.pushState({}, "", `/watch-party/${code}`);
      renderRoute();
    }
    return;
  }

  const movieboxJoinForm = event.target.closest("#movieboxJoinRoomForm");
  if (movieboxJoinForm) {
    event.preventDefault();
    const code = document.querySelector("#movieboxRoomCodeInput")?.value.trim().toUpperCase();
    if (code) {
      history.pushState({}, "", `/watch-party/${code}`);
      renderRoute();
    }
    return;
  }

  const chatForm = event.target.closest("#watchPartyChatForm");
  if (chatForm) {
    event.preventDefault();
    const input = document.querySelector("#watchPartyChatInput");
    const message = input?.value.trim();
    if (message) {
      sendWatchPartyEvent("chat:send", { message });
      input.value = "";
    }
    return;
  }

  // 3. MovieBox Search Form Submission
  const form = event.target.closest("#movieboxSearchForm");
  if (form) {
    event.preventDefault();
    if (typeof window.handleMovieboxSearch === "function") {
      window.handleMovieboxSearch(event);
    }
  }
});

document.addEventListener("input", (event) => {
  if (event.target.closest("#watchPartyChatInput")) {
    sendWatchPartyEvent("chat:typing", { user: getWatchPartyUserName() });
  }
});

// ============ USER NOTIFICATION CENTER IMPLEMENTATION ============
function getLocalNotifications() {
  let list = JSON.parse(localStorage.getItem("TEAMDL_user_notifications") || "null");
  if (!list) {
    list = [
      {
        id: "n-1",
        type: "admin",
        title: "Pesan dari Admin",
        message: "Selamat datang di TEAMDL! Hubungi kami via Live Chat jika Anda menemukan kendala saat memutar drama.",
        date: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
        read: false
      }
    ];
    localStorage.setItem("TEAMDL_user_notifications", JSON.stringify(list));
  } else {
    const cleaned = list.filter(n => {
      const isLegacyDemo = ["n-2", "n-3", "n-4"].includes(n.id)
        && !n.key
        && ["vip_success", "proof_sent", "vip_warning"].includes(n.type);
      return !isLegacyDemo;
    });
    if (cleaned.length !== list.length) {
      list = cleaned;
      localStorage.setItem("TEAMDL_user_notifications", JSON.stringify(list));
    }
  }
  return list;
}

function saveLocalNotifications(list) {
  localStorage.setItem("TEAMDL_user_notifications", JSON.stringify(list));
  updateNotificationBadge();
  updateProfileNotificationCard();
}

function addLocalNotification(type, title, message, options = {}) {
  const list = getLocalNotifications();
  if (options.key && list.some(n => n.key === options.key)) {
    return null;
  }
  const newNotif = {
    id: "n-" + Date.now(),
    type,
    title,
    message,
    date: new Date().toISOString(),
    read: false,
    key: options.key || null
  };
  list.unshift(newNotif);
  saveLocalNotifications(list);
  
  const badge = document.getElementById("navNotifBadge");
  if (badge) {
    badge.style.display = "block";
    badge.animate([
      { transform: 'scale(1)' },
      { transform: 'scale(1.4)' },
      { transform: 'scale(1)' }
    ], { duration: 300, iterations: 2 });
  }
  return newNotif;
}

function updateNotificationBadge() {
  const list = getLocalNotifications();
  const unreadCount = list.filter(n => !n.read).length;
  const badge = document.getElementById("navNotifBadge");
  if (badge) {
    badge.style.display = unreadCount > 0 ? "block" : "none";
  }
}

function updateProfileNotificationCard() {
  const list = getLocalNotifications();
  const unreadCount = list.filter(n => !n.read).length;
  const latest = list[0];
  const card = document.getElementById("profileNotificationCard");
  const countEl = document.getElementById("profileNotificationUnreadCount");
  const latestEl = document.getElementById("profileNotificationLatest");
  const metaEl = document.getElementById("profileNotificationMeta");
  const headerBtn = document.getElementById("profileHeaderNotificationBtn");
  const headerBadge = document.getElementById("profileHeaderNotificationBadge");

  if (card) card.classList.toggle("has-unread", unreadCount > 0);
  if (headerBtn) headerBtn.classList.toggle("has-unread", unreadCount > 0);
  if (headerBadge) headerBadge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
  if (countEl) countEl.textContent = String(unreadCount > 0 ? unreadCount : list.length);
  if (latestEl) latestEl.textContent = latest ? shortTitle(latest.title, 42) : "Belum ada notifikasi masuk.";
  if (metaEl) metaEl.textContent = unreadCount > 0 ? `${unreadCount} belum dibaca` : "Semua sudah dibaca";
}

function syncVipNotifications(vip, active, labels = {}) {
  if (!vip) return;
  const list = getLocalNotifications();
  let changed = false;

  const saveOnce = () => {
    if (changed) saveLocalNotifications(list);
  };

  const hasKey = (key) => list.some(n => n.key === key);
  const pushNotification = (type, title, message, key) => {
    if (key && hasKey(key)) return;
    list.unshift({
      id: "n-" + Date.now() + "-" + Math.random().toString(16).slice(2, 7),
      type,
      title,
      message,
      date: new Date().toISOString(),
      read: false,
      key: key || null
    });
    changed = true;
  };

  if (active && vip.expiresAt) {
    const expiresLabel = labels.expiresDateFormatted || new Date(vip.expiresAt).toLocaleDateString("id-ID");
    const planLabel = labels.vipDurationText || "VIP Premium";
    const successKey = `vip-active:${vip.expiresAt}`;
    pushNotification(
      "vip_success",
      "VIP Aktif",
      `${planLabel} Anda aktif sampai ${expiresLabel}. Semua episode premium sudah terbuka.`,
      successKey
    );
  }

  if (!active && vip.expiresAt && new Date(vip.expiresAt) <= new Date()) {
    const expiresLabel = labels.expiresDateFormatted || new Date(vip.expiresAt).toLocaleDateString("id-ID");
    pushNotification(
      "vip_warning",
      "Masa VIP Berakhir",
      `Masa VIP Anda sudah berakhir pada ${expiresLabel}. Perpanjang paket untuk membuka kembali episode premium.`,
      `vip-expired:${vip.expiresAt}`
    );
  }

  saveOnce();
}

function checkVipExpiryNotifications(vip, active) {
  if (!active || !vip || !vip.expiresAt) return;
  const expires = new Date(vip.expiresAt);
  const now = new Date();
  const diffTime = expires - now;
  const daysLeft = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
  
  if (daysLeft <= 3 && daysLeft > 0) {
    const list = getLocalNotifications();
    const todayStr = new Date().toDateString();
    const hasWarnToday = list.some(n => n.type === "vip_warning" && new Date(n.date).toDateString() === todayStr);
    
    if (!hasWarnToday) {
      addLocalNotification(
        "vip_warning",
        "Peringatan Masa VIP Akan Habis",
        `Masa aktif VIP Anda tinggal ${daysLeft} hari lagi (berlaku s.d ${new Date(vip.expiresAt).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}). Silakan perbarui paket Anda.`,
        { key: `vip-warning:${new Date().toDateString()}:${vip.expiresAt}` }
      );
    }
  }
}

function timeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);
  
  if (seconds < 60) return "Baru saja";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Kemarin";
  return `${days} hari lalu`;
}

function renderNotificationsList() {
  const list = getLocalNotifications();
  const container = document.getElementById("notifList");
  if (!container) return;
  
  if (list.length === 0) {
    container.innerHTML = `
      <div class="notif-list-empty">
        <div class="notif-empty-icon">✉️</div>
        <p>Belum ada notifikasi masuk</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = list.map(n => {
    let icon = "✉️";
    if (n.type === "vip_success") icon = "💎";
    else if (n.type === "proof_sent") icon = "📤";
    else if (n.type === "vip_warning") icon = "⚠️";
    
    return `
      <div class="notif-item ${n.type} ${n.read ? '' : 'unread'}" data-notif-id="${n.id}">
        <div class="notif-item-icon">${icon}</div>
        <div class="notif-item-details">
          <strong>${n.title}</strong>
          <p>${n.message}</p>
          <small>${timeAgo(n.date)}</small>
        </div>
      </div>
    `;
  }).join("");
}

function initNotifications() {
  let overlay = document.getElementById("notifOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "notifOverlay";
    overlay.className = "notif-overlay";
    overlay.innerHTML = `
      <div class="notif-backdrop" id="notifBackdrop"></div>
      <div class="notif-card">
        <div class="notif-header">
          <h2>📢 Notifikasi</h2>
          <div class="notif-header-actions">
            <button id="notifMarkAllBtn" class="notif-text-btn">Tandai Dibaca</button>
            <button id="notifCloseBtn" class="notif-close-x">&times;</button>
          </div>
        </div>
        <div class="notif-body" id="notifList"></div>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  
  const notifBtn = document.getElementById("notificationBtn");
  notifBtn?.addEventListener("click", () => {
    renderNotificationsList();
    overlay.classList.add("show");
    document.body.style.overflow = "hidden";
  });
  
  const close = () => {
    overlay.classList.remove("show");
    document.body.style.overflow = "";
    updateNotificationBadge();
  };
  
  document.getElementById("notifBackdrop")?.addEventListener("click", close);
  document.getElementById("notifCloseBtn")?.addEventListener("click", close);
  
  document.getElementById("notifMarkAllBtn")?.addEventListener("click", () => {
    const list = getLocalNotifications();
    list.forEach(n => n.read = true);
    saveLocalNotifications(list);
    renderNotificationsList();
  });
  
  document.getElementById("notifList")?.addEventListener("click", (e) => {
    const item = e.target.closest(".notif-item");
    if (!item) return;
    const id = item.dataset.notifId;
    const list = getLocalNotifications();
    const found = list.find(n => n.id === id);
    if (found && !found.read) {
      found.read = true;
      saveLocalNotifications(list);
      item.classList.remove("unread");
    }
  });
  
  updateNotificationBadge();
}

