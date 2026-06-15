import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import crypto from "node:crypto";
import * as jose from "jose";

dns.setDefaultResultOrder('ipv4first');

import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { botUserSummary, setBotUserStatus, listBotUsers } from "../../shared/bot-users.js";
import { loadPlatformSources, loadPublicPlatformSources } from "../../shared/platform-sources.js";
import { SecurityError, createSecurityContext } from "./security.js";
import {
  loadSettings,
  saveSettings,
  loadTargets,
  saveTargets,
  loadLogs,
  saveLogs,
  loadQueue,
  saveQueue,
  loadDetectedDramas,
  saveDetectedDramas
} from "../../shared/notifications-db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const publicDir = path.join(__dirname, "public");
const env = loadEnv(path.join(rootDir, ".env"));
const port = Number(process.env.PORT || env.PORT || 3000);
const sharedPlatformToken = envValue("PLATFORM_TOKEN")
  || envValue("PLATFORM_CODE")
  || envValue("PLATFORM_KEY")
  || "A8D6AB170F7B89F2182561D3B32F390D";
const firebaseConfigPath = path.join(rootDir, "shared", "firebase", "firebase.config.json");
const sourceStatePath = path.join(rootDir, "storage", "source-state.json");
const platformPlayabilityPath = path.join(rootDir, "storage", "platform-playability.json");
const security = createSecurityContext({ rootDir, env, firebaseConfigPath });
const endpointAliasSecret = env.SECURITY_SECRET || env.SESSION_SECRET || "TEAMDL-dev-change-this-secret";
const platformFetchTimeoutMs = Number(env.PLATFORM_FETCH_TIMEOUT_MS || 15000);
const platformEpisodeConfig = {
  dramabox: { episodesEndpoint: 7, idParam: "bookId", episodeField: "videoUrl" },
  melolo: { episodesEndpoint: 2, idParam: "id", episodeField: "videoUrl", streamEndpoint: 4, episodeParam: "ep", streamEpisodeMode: "number" },
  goodshort: { episodesEndpoint: 8, idParam: "id", episodeField: "videoUrl" },
  cubetv: { episodesEndpoint: 5, idParam: "videoid", episodeField: "videoUrl" },
  dramawave: { episodesEndpoint: 5, idParam: "id", episodeField: "m3u8_path" },
  microdrama: {
    episodesEndpoint: 4,
    idParam: "id",
    episodeField: "videoUrl",
    streamEndpoint: 5,
    streamIdParam: "dramaId",
    streamEpisodeParam: "episodeNo",
    streamEpisodeMode: "number"
  },
  pinedrama: { episodesEndpoint: 16, idParam: "id", episodeField: "videoUrl" },
  moboreels: { episodesEndpoint: 3, idParam: "seriesId", episodeField: "mediaUrl" },
  dramabite: { episodesEndpoint: 6, idParam: "cid", episodeField: "url" },
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
  serialplus: { episodesEndpoint: 5, idParam: "id", episodeField: "videoUrl" },
  serial: { episodesEndpoint: 5, idParam: "id", episodeField: "videoUrl" }
};

// MovieBox Homepage Memory Cache
let movieBoxHomeCache = null;
let movieBoxHomeCacheTime = 0;
const MOVIEBOX_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

// Admin login 2FA and password config
const activeLoginSessions = new Map();
const activeTokens = new Set();
const activeTokensPath = path.join(rootDir, "storage", "security", "active-tokens.json");

function loadActiveTokens() {
  try {
    if (fs.existsSync(activeTokensPath)) {
      const data = JSON.parse(fs.readFileSync(activeTokensPath, "utf8"));
      if (Array.isArray(data)) {
        data.forEach((t) => activeTokens.add(t));
      }
    }
  } catch (err) {
    console.error("Error loading active tokens:", err);
  }
}

function saveActiveTokens() {
  try {
    fs.mkdirSync(path.dirname(activeTokensPath), { recursive: true });
    fs.writeFileSync(activeTokensPath, JSON.stringify([...activeTokens], null, 2), "utf8");
  } catch (err) {
    console.error("Error saving active tokens:", err);
  }
}

loadActiveTokens();

const botToken = process.env.BOT_TOKEN || env.BOT_TOKEN;
const adminIdStr = process.env.ADMIN_ID || env.ADMIN_ID;
const adminId = adminIdStr ? Number(adminIdStr) : 0;

let adminConfig = { password: "Bayulebo20" };
const adminConfigPath = path.join(rootDir, "storage", "security", "admin-config.json");
try {
  if (fs.existsSync(adminConfigPath)) {
    adminConfig = JSON.parse(fs.readFileSync(adminConfigPath, "utf8"));
  } else {
    fs.mkdirSync(path.dirname(adminConfigPath), { recursive: true });
    fs.writeFileSync(adminConfigPath, JSON.stringify(adminConfig, null, 2), "utf8");
  }
} catch (err) {
  console.error("Error initializing admin password config:", err);
}

const ticketsPath = path.join(rootDir, "storage", "tickets.json");
const ticketsMetaPath = path.join(rootDir, "storage", "tickets-meta.json");
const watchPartyPath = path.join(rootDir, "storage", "watch-party.json");
const watchPartyClients = new Map();
const watchPartyRateLimits = new Map();
const pendingAutoTickets = new Map();
const AUTO_TICKET_DELAY_MS = 5 * 60 * 1000;

// Stream error notification sliding window store
const recentStreamErrors = [];
const lastAlertSentAt = new Map(); // key -> timestamp
const STREAM_ALERT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const STREAM_ALERT_THRESHOLD = 5; // 5 errors
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes cooldown per key

function trackStreamErrorAndNotify(errorData) {
  const now = Date.now();
  
  // Clean up errors older than STREAM_ALERT_WINDOW_MS
  while (recentStreamErrors.length > 0 && (now - recentStreamErrors[0].time > STREAM_ALERT_WINDOW_MS)) {
    recentStreamErrors.shift();
  }
  
  // Add new error
  recentStreamErrors.push({
    time: now,
    dramaTitle: errorData.dramaTitle || "Unknown",
    episodeName: errorData.episodeName || "Unknown",
    errorType: errorData.errorType || "MEDIA_ERROR",
    cdn: errorData.cdn || "Unknown",
    userId: errorData.userId
  });
  
  // Check episode failures
  const epKey = `ep:${errorData.dramaTitle}:${errorData.episodeName}`;
  const epErrors = recentStreamErrors.filter(e => e.dramaTitle === errorData.dramaTitle && e.episodeName === errorData.episodeName);
  const epUniqueUsers = new Set(epErrors.map(e => e.userId)).size;
  
  // Check CDN failures
  const cdnKey = `cdn:${errorData.cdn}`;
  const cdnErrors = recentStreamErrors.filter(e => e.cdn === errorData.cdn);
  const cdnUniqueUsers = new Set(cdnErrors.map(e => e.userId)).size;
  
  // Helper to send the Telegram message
  const triggerTelegramAlert = async (type, name, errorCount, affectedUsers) => {
    const lastAlert = lastAlertSentAt.get(type === "episode" ? epKey : cdnKey) || 0;
    if (now - lastAlert < ALERT_COOLDOWN_MS) {
      return; // Cooldown active, skip to prevent spam
    }
    
    lastAlertSentAt.set(type === "episode" ? epKey : cdnKey, now);
    
    // Format timestamp
    const dateStr = new Date().toISOString().replace("T", " ").substring(0, 16);
    
    let text = `🚨 <b>STREAM ALERT</b>\n\n`;
    if (type === "episode") {
      text += `<b>Drama:</b> ${errorData.dramaTitle}\n`;
      text += `<b>Episode:</b> ${errorData.episodeName}\n`;
    } else {
      text += `<b>CDN/Host Error Spike:</b> <code>${errorData.cdn}</code>\n`;
    }
    text += `<b>Error Type:</b> ${errorData.errorType || "Playback Error"}\n`;
    if (errorData.cdn) {
      text += `<b>CDN:</b> ${errorData.cdn}\n`;
    }
    text += `<b>Recent Failures:</b> ${errorCount} (in 5 mins)\n`;
    text += `<b>Affected Users:</b> ${affectedUsers}\n\n`;
    text += `<b>Time:</b> ${dateStr}`;
    
    if (adminId) {
      await sendTelegramMessage(adminId, text);
    }
  };
  
  // If count exceeds threshold, alert
  if (epErrors.length >= STREAM_ALERT_THRESHOLD) {
    triggerTelegramAlert("episode", epKey, epErrors.length, epUniqueUsers);
  }
  if (cdnErrors.length >= STREAM_ALERT_THRESHOLD && errorData.cdn && errorData.cdn !== "Unknown") {
    triggerTelegramAlert("cdn", cdnKey, cdnErrors.length, cdnUniqueUsers);
  }
}

function readTickets() {
  try {
    if (fs.existsSync(ticketsPath)) {
      return JSON.parse(fs.readFileSync(ticketsPath, "utf8"));
    }
  } catch (err) {
    console.error("Error reading tickets:", err);
  }
  return {};
}

function writeTickets(tickets) {
  try {
    fs.mkdirSync(path.dirname(ticketsPath), { recursive: true });
    fs.writeFileSync(ticketsPath, JSON.stringify(tickets, null, 2), "utf8");
  } catch (err) {
    console.error("Error writing tickets:", err);
  }
}

function isAutoTicketTopic(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("vip belum aktif")
    || text.includes("video loading lama")
    || text.includes("buffering")
    || text.includes("video error")
    || text.includes("tidak bisa diputar");
}

function isManualTicketTopic(message) {
  return String(message || "").toLowerCase().includes("tanya hal lain");
}

function autoTicketNotice() {
  return "\n\nLaporan Anda sudah masuk ke antrean bantuan. Jika kendala masih terjadi, pesan ini akan terkirim otomatis ke Admin dalam 5 menit. Anda tidak perlu membuka tiket berulang.";
}

function scheduleAutoTicket({ userId, userName, telegramId = "", telegramUsername = "" }) {
  if (!userId || pendingAutoTickets.has(userId)) {
    return;
  }

  const timer = setTimeout(async () => {
    pendingAutoTickets.delete(userId);
    try {
      const tickets = readTickets();
      const userHistory = tickets[userId] || [];
      const alreadyOpened = userHistory.some((msg) => msg.autoTicketOpened);
      if (alreadyOpened) {
        return;
      }

      const ticket = await createAdminTicket({
        userId,
        userName,
        telegramId,
        telegramUsername,
        mode: "auto",
        resetConversation: false
      });

      const currentTickets = readTickets();
      if (!currentTickets[userId]) currentTickets[userId] = [];
      currentTickets[userId].push({
        id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        sender: "system",
        text: `Laporan Anda telah otomatis terkirim ke Admin. Kode tiket: ${ticket.ticketCode}. Silakan tunggu balasan Admin di chat ini.`,
        timestamp: Date.now(),
        autoTicketOpened: true
      });
      writeTickets(currentTickets);
    } catch (err) {
      console.error("Gagal membuka tiket otomatis:", err);
    }
  }, AUTO_TICKET_DELAY_MS);

  pendingAutoTickets.set(userId, timer);
}

async function createAdminTicket({ userId, userName, telegramId = "", telegramUsername = "", mode = "manual", resetConversation = true }) {
  const tickets = readTickets();
  const userHistory = tickets[userId] || [];
  const firstUserMsg = userHistory.find((msg) => msg.sender === "user");
  const topicText = firstUserMsg ? firstUserMsg.text : "Tidak diketahui";
  const ticketCode = "#TKT-" + Math.floor(100000 + Math.random() * 900000);
  const userDisplayName = userName || "Guest User";
  const displayTelegramId = telegramId || userId || "-";
  const displayTelegramUsername = telegramUsername ? `@${telegramUsername.replace("@", "")}` : "-";
  const modeLabel = mode === "auto" ? "TIKET OTOMATIS MASUK" : "TIKET BARU MASUK";

  const telegramText = `<b>${modeLabel}</b>\n\n` +
                       `<b>Kode Tiket:</b> <code>${ticketCode}</code>\n` +
                       `<b>Nama:</b> ${escapeHtmlTelegram(userDisplayName)}\n` +
                       `<b>User ID:</b> <code>${userId}</code>\n` +
                       `<b>Kasus:</b> ${escapeHtmlTelegram(topicText)}\n\n` +
                       `Buka panel Admin di website untuk membalas tiket ini.`;
  await sendTelegramMessage(adminId, telegramText);

  let ticketsMeta = [];
  try {
    if (fs.existsSync(ticketsMetaPath)) {
      ticketsMeta = JSON.parse(fs.readFileSync(ticketsMetaPath, "utf8"));
    }
  } catch (err) {
    ticketsMeta = [];
  }
  ticketsMeta.unshift({
    ticketCode,
    userId,
    userName: userDisplayName,
    telegramId: displayTelegramId,
    telegramUsername: displayTelegramUsername,
    topic: topicText,
    createdAt: Date.now(),
    status: "open",
    mode
  });
  ticketsMeta = ticketsMeta.slice(0, 200);
  fs.mkdirSync(path.dirname(ticketsMetaPath), { recursive: true });
  fs.writeFileSync(ticketsMetaPath, JSON.stringify(ticketsMeta, null, 2), "utf8");

  if (resetConversation) {
    tickets[userId] = [
      {
        id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        sender: "system",
        text: `Tiket laporan resmi Anda telah berhasil dibuka dengan Kode: ${ticketCode}. Pemberitahuan telah dikirimkan ke Admin. Sesi sebelumnya ditutup, dan sesi baru telah dimulai.`,
        timestamp: Date.now(),
        autoTicketOpened: mode === "auto"
      }
    ];
    writeTickets(tickets);
  }

  return { ticketCode };
}

function getLocalAiResponse(userMessage) {
  const msg = userMessage.toLowerCase();
  
  // Specific check for VIP not entering / active issues
  if (msg.includes("belum masuk") || msg.includes("tidak masuk") || msg.includes("tidak aktif") || msg.includes("belum aktif") || msg.includes("ga masuk") || msg.includes("gak masuk")) {
    if (msg.includes("vip") || msg.includes("bayar") || msg.includes("qris") || msg.includes("beli")) {
      return "Subjek: Masalah Aktivasi / Login Akun VIP\n\nHalo! Jika Anda sudah melakukan pembayaran tetapi status VIP belum aktif, atau Anda kesulitan masuk ke akun VIP, silakan ikuti langkah-langkah berikut:\n\n1. Pastikan Akun Sudah Benar: Masuk (Login) menggunakan metode yang sama saat Anda mendaftar atau melakukan transaksi (Email/Nomor HP/Google Log In).\n2. Refresh Sistem: Coba keluar (Log Out) terlebih dahulu dari aplikasi/situs, kemudian masuk kembali untuk memperbarui status akun Anda.\n3. Kirim Bukti Transfer: Jika status tetap belum aktif setelah 5-10 menit, kirimkan Bukti Pembayaran beserta ID Pengguna/Email Anda ke admin melalui fitur chat.\n\nTim kami akan segera memeriksa dan mengaktifkan status VIP Anda secara manual!" + autoTicketNotice();
    }
  }

  // Specific check for video loading slow / buffering
  if (msg.includes("loading") || msg.includes("lama") || msg.includes("buffering") || msg.includes("lemot") || msg.includes("puter lama") || msg.includes("putar lama") || msg.includes("loding")) {
    return "Subjek: Solusi Video Buffering / Lemot\n\nHalo! Kenyamanan menonton Anda adalah prioritas kami. Jika video mengalami buffering atau pemuatan lama, Anda bisa mencoba beberapa tips berikut:\n\n1. Ganti Kualitas Video: Turunkan resolusi video (misalnya dari 1080p ke 720p atau 480p) pada ikon pengaturan di pemutar video untuk menyesuaikan dengan kecepatan internet Anda.\n2. Cek Koneksi Internet: Pastikan jaringan internet Anda stabil. Coba ubah koneksi dari paket data seluler ke Wi-Fi, atau sebaliknya.\n3. Bersihkan Cache: Hapus cache pada aplikasi atau peramban (browser) yang Anda gunakan, lalu muat ulang (refresh) halaman video.\n4. Ganti Server/Garis Putar (Jika Tersedia): Jika ada pilihan server alternatif, silakan klik tombol server lain di bawah pemutar video." + autoTicketNotice();
  }

  // Specific check for video error / cannot play
  if (msg.includes("error") || msg.includes("tidak bisa diputar") || msg.includes("tidak bisa di putar") || msg.includes("ga bisa diputar") || msg.includes("gagal putar") || msg.includes("rusak") || msg.includes("blank") || msg.includes("eror")) {
    return "Subjek: Laporan Video Rusak / Error\n\nMohon maaf atas ketidaknyamanan ini. Jika video sama sekali tidak bisa diputar atau muncul pesan error, silakan lakukan pengecekan cepat ini:\n\n1. Muat Ulang Halaman: Tekan tombol refresh pada browser atau tutup dan buka kembali aplikasi Anda.\n2. Ganti Browser/Gunakan Aplikasi Terbaru: Jika Anda menonton lewat situs web, cobalah menggunakan browser lain (disarankan Google Chrome atau Safari). Jika lewat aplikasi, pastikan sudah diperbarui ke versi terbaru.\n3. Laporkan Judul & Episode: Jika langkah di atas gagal, kemungkinan ada gangguan pada file video kami. Silakan balas pesan ini dengan format:\n\nJudul Drama/Film:\nEpisode:\nTangkapan Layar (Screenshot) Error:\n\nTim teknis kami akan langsung melakukan perbaikan dalam waktu maksimal 1x24 jam. Terima kasih atas laporannya!" + autoTicketNotice();
  }
  
  if (msg.includes("vip") || msg.includes("langganan") || msg.includes("beli") || msg.includes("bayar") || msg.includes("qris")) {
    return "Halo! Untuk mengaktifkan status VIP, silakan masuk ke halaman Profil Anda di website, lalu pilih paket VIP yang diinginkan (30 Hari / 365 Hari) dan lakukan pembayaran. Setelah selesai, status VIP Anda akan langsung aktif secara otomatis! Jika masih terkendala, silakan tunggu admin kami merespon.";
  }
  
  if (msg.includes("kunci") || msg.includes("episode 13") || msg.includes("bayar") || msg.includes("episode") || msg.includes("lock")) {
    return "Halo! TEAMDL memberlakukan kebijakan bahwa Episode 1 s.d 12 dari setiap drama dapat ditonton secara GRATIS. Namun, untuk Episode 13 ke atas, Anda memerlukan status VIP aktif untuk membukanya. Silakan lakukan pembelian VIP melalui halaman Profil Anda.";
  }
  
  if (msg.includes("video") || msg.includes("putar") || msg.includes("macet") || msg.includes("tidak bisa") || msg.includes("blank")) {
    return "Halo! Jika video mengalami masalah pemutaran atau macet, Anda dapat mencoba langkah-langkah berikut:\n1. Segarkan/refresh halaman browser Anda.\n2. Jika Anda membuka dari Telegram, disarankan menyalin tautan dan membukanya di browser eksternal seperti Chrome, Safari, atau Edge.\n3. Bersihkan cache browser Anda atau gunakan tab Samaran (Incognito).\n4. Pastikan koneksi internet Anda stabil.";
  }
  
  if (msg.includes("sandi") || msg.includes("password") || msg.includes("login") || msg.includes("masuk")) {
    return "Halo! Untuk login ke panel admin, Anda dapat menggunakan ID Telegram Anda (yang memicu persetujuan 2FA) ATAU langsung memasukkan Kata Sandi Admin untuk masuk instan. Pastikan kredensial yang Anda masukkan sudah benar.";
  }
  
  if (msg.includes("level") || msg.includes("lvl") || msg.includes("menonton")) {
    return "Halo! Level menonton Anda dihitung secara otomatis berdasarkan total akumulasi durasi tontonan video Anda yang diputar di website TEAMDL. Semakin lama Anda menonton, level Anda akan terus meningkat progresif!";
  }

  return "Halo! Terima kasih telah menghubungi Pusat Bantuan TEAMDL. Pertanyaan Anda telah kami terima. Sembari menunggu Admin kami membalas pesan Anda secara langsung, asisten AI kami menyarankan Anda untuk menyegarkan (refresh) halaman jika terjadi kendala teknis pemutaran video, atau mengaktifkan VIP di Profil untuk membuka episode 13+.";
}

async function getAiResponse(userMessage) {
  const apiKey = adminConfig.geminiApiKey || "";
  
  const systemPrompt = `Anda adalah Asisten AI untuk TEAMDL, sebuah platform streaming drama pendek.
Website ini memiliki aturan:
1. Episode 1 sampai 12 gratis untuk semua orang.
2. Episode 13 ke atas dikunci dan memerlukan akses VIP.
3. Masalah video tidak bisa diputar/macet biasanya diselesaikan dengan menyegarkan (refresh) halaman, menggunakan browser eksternal (Chrome/Safari) alih-alih in-app browser Telegram, membersihkan cache, atau memeriksa koneksi internet.
4. VIP dapat diaktifkan melalui halaman Profil di website.
5. Level menonton dihitung berdasarkan durasi menonton riil.
6. Jika pengguna mengeluh VIP belum aktif/belum masuk setelah melakukan pembayaran, berikan langkah pengecekan profil, sarankan refresh, dan beritahu bahwa laporan pembayaran telah diteruskan ke admin untuk dicek manual secepatnya.
7. Jika pengguna mengeluh video loading lama atau buffering, sarankan ganti browser, periksa koneksi internet, atau segarkan halaman.
8. Jika pengguna mengeluh video error atau eror tidak bisa diputar, berikan petunjuk refresh, periksa batas episode gratis (12), atau buka di browser Chrome/Safari eksternal.

Tugas Anda adalah membantu menjawab keluhan atau pertanyaan pengguna dengan ramah, informatif, dan ringkas dalam Bahasa Indonesia.`;

  if (apiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: [
            {
              role: "user",
              parts: [{ text: userMessage }]
            }
          ],
          generationConfig: {
            maxOutputTokens: 500,
            temperature: 0.7
          }
        })
      });
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text.trim();
    } catch (err) {
      console.error("Gemini API call failed, falling back to local engine:", err);
    }
  }

  return getLocalAiResponse(userMessage);
}

function checkAdminAuth(request) {
  const authHeader = request.headers["authorization"] || "";
  const token = authHeader.replace(/^Bearer\s+/, "").trim();
  if (!token) return false;
  return activeTokens.has(token);
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  if (!botToken) return null;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (err) {
    console.error("Error sending Telegram message:", err);
    return null;
  }
}

async function sendTelegramPhoto(chatId, filePath, caption = "") {
  if (!botToken) return null;
  const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("caption", caption);
  formData.append("parse_mode", "HTML");
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const fileBlob = new Blob([fileBuffer], { type: "image/png" });
    formData.append("photo", fileBlob, path.basename(filePath));
    const res = await fetch(url, {
      method: "POST",
      body: formData
    });
    return await res.json();
  } catch (err) {
    console.error("Error sending Telegram photo:", err);
    return null;
  }
}

async function editTelegramMessage(chatId, messageId, text) {
  if (!botToken) return null;
  const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML"
      })
    });
    return await res.json();
  } catch (err) {
    console.error("Error editing Telegram message:", err);
    return null;
  }
}

async function callTelegramBotApi(method, payload = {}) {
  if (!botToken) {
    return { ok: false, skipped: true, description: "BOT_TOKEN belum diisi." };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    return { ok: false, description: err.message };
  }
}

const server = http.createServer((request, response) => {
  security.secureHeaders(response);
  handleRequest(request, response).catch((error) => {
    if (error instanceof SecurityError) {
      return security.forbidden(response, error.code);
    }

    console.error(error);
    if (!response.headersSent) {
      return sendJson(response, { error: "Internal server error" }, 500);
    }
    response.end();
  });
});

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== "/api/watch-party/socket") {
    socket.destroy();
    return;
  }
  handleWatchPartyUpgrade(request, socket, url);
});

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": sameOrigin(request),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      "Access-Control-Max-Age": "86400"
    });
    response.end();
    return;
  }

  if (shouldRedirectToHttps(request, url)) {
    response.writeHead(301, {
      Location: `https://${url.host}${url.pathname}${url.search}`
    });
    response.end();
    return;
  }

  // Admin Authentication Filter
  if (url.pathname.startsWith("/api/admin/") || url.pathname === "/api/security/admin") {
    if (url.pathname !== "/api/admin/login" && 
        url.pathname !== "/api/admin/login/status" && 
        url.pathname !== "/api/admin/login/callback" && 
        url.pathname !== "/api/admin/login/cancel") {
      const authHeader = request.headers["authorization"] || "";
      const token = authHeader.replace(/^Bearer\s+/, "").trim();
      const isBot = (token === botToken || url.searchParams.get("token") === botToken) && botToken;
      
      if (!isBot && !checkAdminAuth(request)) {
        return sendJson(response, { error: "Unauthorized" }, 401);
      }
    }
  }

  // Admin Login Endpoints
  if (url.pathname === "/api/admin/login" && request.method === "POST") {
    const body = await readJsonBody(request);
    let credential = String(body.credential || "").trim();
    
    // Fallback for older client parameter formats
    if (!credential) {
      if (body.password) {
        credential = String(body.password).trim();
      } else if (body.telegramId) {
        credential = String(body.telegramId).trim();
      }
    }
    
    if (!credential) {
      return sendJson(response, { error: "ID Telegram atau Kata Sandi wajib diisi!" }, 400);
    }
    
    // 1. Check if credential is the password for instant login
    if (credential === adminConfig.password) {
      const token = "token-" + Math.random().toString(36).slice(2, 15) + Math.random().toString(36).slice(2, 15);
      activeTokens.add(token);
      saveActiveTokens();
      return sendJson(response, { ok: true, status: "approved", token });
    }
    
    // 2. Check if credential is the Telegram ID for 2FA login
    if (credential === String(adminId)) {
      const sessionId = "sess-" + Math.random().toString(36).slice(2, 15) + Math.random().toString(36).slice(2, 15);
      const ip = request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown";
      const dateStr = new Date().toLocaleString("id-ID");
      
      const text = `⚠️ <b>Permintaan Login Admin Panel TEAMDL</b>\n\n` +
                   `<b>IP Address:</b> <code>${ip}</code>\n` +
                   `<b>Waktu:</b> ${dateStr}\n\n` +
                   `Apakah ini Anda? Silakan klik tombol di bawah untuk menyetujui (ACC) atau menolak.`;
                   
      const replyMarkup = {
        inline_keyboard: [
          [
            { text: "ACC (Setuju)", callback_data: `admin_login:acc:${sessionId}` },
            { text: "TOLAK", callback_data: `admin_login:rej:${sessionId}` }
          ]
        ]
      };
      
      const tgRes = await sendTelegramMessage(adminId, text, replyMarkup);
      const messageId = tgRes?.result?.message_id || null;
      
      activeLoginSessions.set(sessionId, {
        telegramId: credential,
        status: "pending",
        ip,
        createdAt: Date.now(),
        messageId
      });
      
      return sendJson(response, { ok: true, status: "pending", sessionId });
    }
    
    // 3. Neither password nor Telegram ID matched
    return sendJson(response, { error: "Kata sandi salah atau ID Telegram tidak dikenali!" }, 401);
  }

  if (url.pathname === "/api/admin/login/status" && request.method === "GET") {
    const sessionId = url.searchParams.get("sessionId");
    const session = activeLoginSessions.get(sessionId);
    
    if (!session) {
      return sendJson(response, { error: "Session tidak ditemukan!" }, 404);
    }
    
    if (session.status === "approved") {
      const token = "token-" + Math.random().toString(36).slice(2, 15) + Math.random().toString(36).slice(2, 15);
      activeTokens.add(token);
      saveActiveTokens();
      activeLoginSessions.delete(sessionId);
      return sendJson(response, { ok: true, status: "approved", token });
    }
    
    if (session.status === "rejected") {
      activeLoginSessions.delete(sessionId);
      return sendJson(response, { ok: true, status: "rejected" });
    }
    
    return sendJson(response, { ok: true, status: "pending" });
  }

  if (url.pathname === "/api/admin/login/cancel" && request.method === "POST") {
    const body = await readJsonBody(request);
    const sessionId = body.sessionId;
    const session = activeLoginSessions.get(sessionId);
    
    if (session) {
      if (session.messageId) {
        await editTelegramMessage(adminId, session.messageId, `❌ <b>Permintaan Login Admin Panel TEAMDL Dibatalkan oleh Browser</b>`);
      }
      activeLoginSessions.delete(sessionId);
    }
    
    return sendJson(response, { ok: true });
  }

  if (url.pathname === "/api/admin/login/callback" && request.method === "POST") {
    const body = await readJsonBody(request);
    const { action, sessionId, adminId: callbackAdminId } = body;
    
    if (Number(callbackAdminId) !== adminId) {
      return sendJson(response, { error: "Forbidden" }, 403);
    }
    
    const session = activeLoginSessions.get(sessionId);
    if (!session) {
      return sendJson(response, { error: "Session tidak ditemukan!" }, 404);
    }
    
    session.status = action === "acc" ? "approved" : "rejected";
    activeLoginSessions.set(sessionId, session);
    
    return sendJson(response, { ok: true });
  }

  if (url.pathname === "/api/admin/change-password" && request.method === "POST") {
    const body = await readJsonBody(request);
    const { oldPassword, newPassword } = body;
    
    if (oldPassword !== adminConfig.password) {
      return sendJson(response, { error: "Sandi saat ini salah!" }, 400);
    }
    
    if (!newPassword || newPassword.trim().length < 4) {
      return sendJson(response, { error: "Sandi baru minimal harus 4 karakter!" }, 400);
    }
    
    adminConfig.password = newPassword.trim();
    fs.writeFileSync(adminConfigPath, JSON.stringify(adminConfig, null, 2), "utf8");
    
    // Notify admin Telegram
    await sendTelegramMessage(adminId, `⚠️ <b>Sandi Admin Panel Berhasil Dirubah!</b>\n\n<b>Sandi Baru:</b> <code>${adminConfig.password}</code>`);
    
    return sendJson(response, { ok: true });
  }

  if (url.pathname === "/api/admin/config" && request.method === "GET") {
    return sendJson(response, {
      ok: true,
      config: {
        geminiApiKey: adminConfig.geminiApiKey || ""
      }
    });
  }

  if (url.pathname === "/api/admin/save-config" && request.method === "POST") {
    const body = await readJsonBody(request);
    const { geminiApiKey } = body;
    adminConfig.geminiApiKey = (geminiApiKey || "").trim();
    fs.writeFileSync(adminConfigPath, JSON.stringify(adminConfig, null, 2), "utf8");
    return sendJson(response, { ok: true });
  }

  if (url.pathname === "/api/tickets/send" && request.method === "POST") {
    const body = await readJsonBody(request);
    const { userId, userName, message, image } = body;
    
    if (!userId || (!message && !image)) {
      return sendJson(response, { error: "User ID dan pesan wajib diisi!" }, 400);
    }
    
    const userDisplayName = userName || "Guest User";
    let tickets = readTickets();
    if (!tickets[userId]) tickets[userId] = [];
    
    const now = Date.now();
    let isReset = false;
    
    // 1. Inactivity Reset (5 minutes)
    if (tickets[userId].length > 0) {
      const lastMsg = tickets[userId][tickets[userId].length - 1];
      if (now - lastMsg.timestamp > 300000) {
        tickets[userId] = [];
        isReset = true;
      }
    }
    
    const cleanMsg = (message || "").trim().toLowerCase();
    const greetingWords = ["hallo", "halo", "hi", "helo", "hello", "p", "siang", "sore", "pagi", "malam", "assalamualaikum", "tanya", "ask"];
    const isGreeting = greetingWords.includes(cleanMsg);
    
    // 2. Greeting or Inactivity Welcome Response
    if (isReset || isGreeting) {
      if (message) {
        tickets[userId].push({
          id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
          sender: "user",
          userName: userDisplayName,
          text: message,
          timestamp: now
        });
      }
      
      tickets[userId].push({
        id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        sender: "ai",
        text: "Halo! Selamat datang di Pusat Bantuan TEAMDL. Silakan pilih salah satu kategori kendala di bawah, atau ketikkan pertanyaan Anda:",
        timestamp: Date.now() + 10,
        offerButtons: true
      });
      
      writeTickets(tickets);
      return sendJson(response, { ok: true });
    }
    
    // 3. Handle image uploads
    let imageUrlForStorage = null;
    let savedTempFilePath = null;
    
    if (image && image.startsWith("data:image/")) {
      try {
        const matches = image.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
          const ext = matches[1] === "jpeg" ? "jpg" : matches[1];
          const imageBuffer = Buffer.from(matches[2], "base64");
          
          const uploadsDir = path.join(publicDir, "uploads");
          if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
          }
          
          const filename = `upload_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}.${ext}`;
          savedTempFilePath = path.join(uploadsDir, filename);
          fs.writeFileSync(savedTempFilePath, imageBuffer);
          
          imageUrlForStorage = image; // Keep the base64 string in database
        }
      } catch (err) {
        console.error("Gagal memproses upload gambar:", err);
      }
    }
    
    // 4. Save User Message
    const userMsg = {
      id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      sender: "user",
      userName: userDisplayName,
      text: message || "[Gambar]",
      timestamp: now
    };
    if (imageUrlForStorage) {
      userMsg.imageUrl = imageUrlForStorage;
    }
    
    tickets[userId].push(userMsg);
    writeTickets(tickets);
    
    // 5. Send Image to Telegram Bot and Delete Immediately
    if (savedTempFilePath) {
      const captionText = `📷 <b>GAMBAR TERKIRIM DARI USER</b>\n` +
                          `<b>User Name:</b> ${userDisplayName}\n` +
                          `<b>User ID:</b> <code>${userId}</code>\n\n` +
                          `[User ID: ${userId}]`;
      
      setTimeout(async () => {
        try {
          await sendTelegramPhoto(adminId, savedTempFilePath, captionText);
        } catch (err) {
          console.error("Gagal meneruskan gambar ke Telegram:", err);
        } finally {
          // Delete physical file from disk to avoid bloating local storage
          try {
            if (fs.existsSync(savedTempFilePath)) {
              fs.unlinkSync(savedTempFilePath);
              console.log("File gambar temp berhasil dihapus:", savedTempFilePath);
            }
          } catch (unlinkErr) {
            console.error("Gagal menghapus file gambar temp:", unlinkErr);
          }
        }
      }, 50);
    }
    
    // 6. Generate AI response in background
    const userSentCount = tickets[userId].filter(m => m.sender === "user").length;
    const shouldAutoTicket = userSentCount === 1 && isAutoTicketTopic(message);
    const shouldOfferManualTicket = userSentCount === 1 && isManualTicketTopic(message);
    if (shouldAutoTicket) {
      scheduleAutoTicket({ userId, userName: userDisplayName });
    }
    
    setTimeout(async () => {
      try {
        const currentTickets = readTickets();
        if (!currentTickets[userId]) currentTickets[userId] = [];
        
        let aiReplyText = "";
        let offerTicket = false;
        
        if (imageUrlForStorage && !message) {
          aiReplyText = "Terima kasih atas kiriman gambarnya. Laporan Anda sudah masuk ke antrean bantuan dan akan terkirim otomatis ke Admin dalam 5 menit.";
          scheduleAutoTicket({ userId, userName: userDisplayName });
        } else if (userSentCount === 1) {
          if (shouldOfferManualTicket) {
            aiReplyText = "Maaf solusi sebelumnya tidak berhasil menyelesaikan masalah Anda. Apakah Anda ingin membuka tiket laporan resmi agar Admin dapat membantu Anda secara langsung?";
            offerTicket = true;
          } else if (shouldAutoTicket) {
            aiReplyText = getLocalAiResponse(message);
          } else {
            aiReplyText = await getAiResponse(message);
          }
        } else {
          aiReplyText = "Kendala Anda sudah dicatat di sistem kami. Jika termasuk laporan kendala, pesan akan diteruskan otomatis ke Admin dalam 5 menit. Harap tunggu balasan Admin di sini.";
        }
        
        currentTickets[userId].push({
          id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
          sender: "ai",
          text: aiReplyText,
          timestamp: Date.now(),
          offerTicket
        });
        writeTickets(currentTickets);
      } catch (err) {
        console.error("AI response generation failed:", err);
      }
    }, 1500);
    
    return sendJson(response, { ok: true });
  }
  
  if (url.pathname === "/api/tickets/open" && request.method === "POST") {
    const body = await readJsonBody(request);
    const { userId, userName, telegramId, telegramUsername } = body;
    
    if (!userId) {
      return sendJson(response, { error: "User ID wajib diisi!" }, 400);
    }

    const ticket = await createAdminTicket({
      userId,
      userName,
      telegramId,
      telegramUsername,
      mode: "manual",
      resetConversation: true
    });
    return sendJson(response, { ok: true, ticketCode: ticket.ticketCode });
    
    const tickets = readTickets();
    const userHistory = tickets[userId] || [];
    
    // Detect the topic the user chose (first user message)
    const firstUserMsg = userHistory.find(m => m.sender === "user");
    const topicText = firstUserMsg ? firstUserMsg.text : "Tidak diketahui";
    
    const ticketCode = "#TKT-" + Math.floor(100000 + Math.random() * 900000);
    
    // Send BRIEF notification to Telegram (no full conversation history)
    const userDisplayName = userName || "Guest User";
    const displayTelegramId = telegramId || userId || "-";
    const displayTelegramUsername = telegramUsername ? `@${telegramUsername.replace("@", "")}` : "-";
    
    const telegramText = `🎟️ <b>TIKET BARU MASUK!</b>\n\n` +
                         `<b>Kode Tiket:</b> <code>${ticketCode}</code>\n` +
                         `<b>Nama:</b> ${escapeHtmlTelegram(userDisplayName)}\n` +
                         `<b>User ID:</b> <code>${userId}</code>\n` +
                         `<b>Kasus:</b> ${escapeHtmlTelegram(topicText)}\n\n` +
                         `Buka panel Admin di website untuk membalas tiket ini.`;
                          
    await sendTelegramMessage(adminId, telegramText);
    
    // Store ticket metadata separately for admin panel listing
    const ticketsMetaPath = path.join(rootDir, "storage", "tickets-meta.json");
    let ticketsMeta = [];
    try {
      if (fs.existsSync(ticketsMetaPath)) {
        ticketsMeta = JSON.parse(fs.readFileSync(ticketsMetaPath, "utf8"));
      }
    } catch (err) { ticketsMeta = []; }
    ticketsMeta.unshift({
      ticketCode,
      userId,
      userName: userDisplayName,
      telegramId: displayTelegramId,
      telegramUsername: displayTelegramUsername,
      topic: topicText,
      createdAt: Date.now(),
      status: "open"
    });
    // Keep max 200 tickets in meta
    ticketsMeta = ticketsMeta.slice(0, 200);
    fs.mkdirSync(path.dirname(ticketsMetaPath), { recursive: true });
    fs.writeFileSync(ticketsMetaPath, JSON.stringify(ticketsMeta, null, 2), "utf8");
    
    // Close the previous session and start a new session with only the confirmation message
    tickets[userId] = [
      {
        id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        sender: "system",
        text: `🎟️ Tiket laporan resmi Anda telah berhasil dibuka dengan Kode: ${ticketCode}! Pemberitahuan telah dikirimkan ke Admin. Sesi sebelumnya ditutup, dan sesi baru telah dimulai.`,
        timestamp: Date.now()
      }
    ];
    writeTickets(tickets);
    
    return sendJson(response, { ok: true, ticketCode });
  }

  if (url.pathname === "/api/tickets/messages" && request.method === "GET") {
    const userId = url.searchParams.get("userId");
    if (!userId) {
      return sendJson(response, { error: "User ID wajib diisi!" }, 400);
    }
    const tickets = readTickets();
    return sendJson(response, { ok: true, messages: tickets[userId] || [] });
  }

  // Admin: list all open tickets (verify by Telegram ID header or query param)
  if (url.pathname === "/api/tickets/list" && request.method === "GET") {
    const callerTgId = url.searchParams.get("tgId");
    if (!callerTgId || Number(callerTgId) !== adminId) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    const ticketsMetaPath = path.join(rootDir, "storage", "tickets-meta.json");
    let ticketsMeta = [];
    try {
      if (fs.existsSync(ticketsMetaPath)) {
        ticketsMeta = JSON.parse(fs.readFileSync(ticketsMetaPath, "utf8"));
      }
    } catch (err) { ticketsMeta = []; }
    return sendJson(response, { ok: true, tickets: ticketsMeta });
  }

  // Admin: get chat history for a specific ticket userId (verify by Telegram ID)
  if (url.pathname === "/api/tickets/chat" && request.method === "GET") {
    const callerTgId = url.searchParams.get("tgId");
    const targetId = url.searchParams.get("userId");
    if (!callerTgId || Number(callerTgId) !== adminId) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    if (!targetId) {
      return sendJson(response, { error: "userId diperlukan" }, 400);
    }
    const tickets = readTickets();
    return sendJson(response, { ok: true, messages: tickets[targetId] || [] });
  }

  // Admin: reply to a ticket from web panel (verify by Telegram ID)
  if (url.pathname === "/api/tickets/admin-reply" && request.method === "POST") {
    const body = await readJsonBody(request);
    const { targetUserId, replyText, tgId } = body;
    if (!tgId || Number(tgId) !== adminId) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    if (!targetUserId || !replyText) {
      return sendJson(response, { error: "User ID dan pesan balasan wajib diisi!" }, 400);
    }
    const tickets = readTickets();
    if (!tickets[targetUserId]) tickets[targetUserId] = [];
    tickets[targetUserId].push({
      id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      sender: "admin",
      text: replyText,
      timestamp: Date.now()
    });
    writeTickets(tickets);
    return sendJson(response, { ok: true });
  }

  if (url.pathname === "/api/tickets/close" && request.method === "POST") {
    const body = await readJsonBody(request);
    const { targetUserId, ticketCode, tgId } = body;
    if (!tgId || Number(tgId) !== adminId) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    if (!targetUserId) {
      return sendJson(response, { error: "User ID diperlukan" }, 400);
    }

    const ticketsMetaPath = path.join(rootDir, "storage", "tickets-meta.json");
    let ticketsMeta = [];
    try {
      if (fs.existsSync(ticketsMetaPath)) {
        ticketsMeta = JSON.parse(fs.readFileSync(ticketsMetaPath, "utf8"));
      }
    } catch {
      ticketsMeta = [];
    }

    const now = Date.now();
    const filteredMeta = ticketsMeta.filter((item) => {
      if (ticketCode) {
        return item.ticketCode !== ticketCode;
      }
      return item.userId !== targetUserId;
    });
    fs.mkdirSync(path.dirname(ticketsMetaPath), { recursive: true });
    fs.writeFileSync(ticketsMetaPath, JSON.stringify(filteredMeta, null, 2), "utf8");

    const tickets = readTickets();
    tickets[targetUserId] = [
      ...(tickets[targetUserId] || []),
      {
        id: "msg-" + now + "-" + Math.random().toString(36).slice(2, 6),
        sender: "system",
        text: "Tiket sudah diselesaikan oleh Admin. Sesi bantuan ini telah ditutup.",
        timestamp: now
      }
    ];
    writeTickets(tickets);

    return sendJson(response, { ok: true, tickets: filteredMeta });
  }

  if (url.pathname === "/api/tickets/reply" && request.method === "POST") {
    const body = await readJsonBody(request);
    const { targetUserId, replyText, token } = body;
    
    // Verify bot token
    if (token !== botToken) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    
    if (!targetUserId || !replyText) {
      return sendJson(response, { error: "User ID dan pesan balasan wajib diisi!" }, 400);
    }
    
    const tickets = readTickets();
    if (!tickets[targetUserId]) tickets[targetUserId] = [];
    
    tickets[targetUserId].push({
      id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      sender: "admin",
      text: replyText,
      timestamp: Date.now()
    });
    
    writeTickets(tickets);
    return sendJson(response, { ok: true });
  }

  if (url.pathname === "/api/auth/login-code" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const code = String(body.code || "").trim();
      if (!code || code.length !== 6) {
        return sendJson(response, { error: "Kode login wajib 6 digit!" }, 400);
      }

      const loginCodesPath = path.join(rootDir, "storage", "security", "login-codes.json");
      let codes = [];
      if (fs.existsSync(loginCodesPath)) {
        try {
          codes = JSON.parse(fs.readFileSync(loginCodesPath, "utf8"));
        } catch (err) {
          console.error("Error reading login codes file:", err);
        }
      }

      const matchIndex = codes.findIndex((c) => String(c.code) === code && c.expiresAt > Date.now());
      if (matchIndex === -1) {
        return sendJson(response, { error: "Kode login tidak valid atau sudah kadaluarsa!" }, 400);
      }

      const matchedCodeObj = codes[matchIndex];
      
      // Load detailed profile from storage/bot-users.json
      let firstName = "";
      let lastName = "";
      let username = matchedCodeObj.username || "";
      try {
        const botUsersPath = path.join(rootDir, "storage", "bot-users.json");
        if (fs.existsSync(botUsersPath)) {
          const botUsersData = JSON.parse(fs.readFileSync(botUsersPath, "utf8"));
          const userObj = botUsersData.users?.[String(matchedCodeObj.telegramId)];
          if (userObj) {
            firstName = userObj.firstName || "";
            lastName = userObj.lastName || "";
            username = userObj.username || username;
          }
        }
      } catch (err) {
        console.error("Error loading profile from bot-users in login code:", err);
      }

      // Remove it so it is single-use
      codes.splice(matchIndex, 1);
      try {
        fs.mkdirSync(path.dirname(loginCodesPath), { recursive: true });
        fs.writeFileSync(loginCodesPath, JSON.stringify(codes, null, 2), "utf8");
      } catch (err) {
        console.error("Error writing login codes file:", err);
      }

      return sendJson(response, {
        ok: true,
        userId: `tg-${matchedCodeObj.telegramId}`,
        telegramId: String(matchedCodeObj.telegramId),
        firstName: firstName || username || "User",
        lastName: lastName || "",
        username: username
      });
    } catch (error) {
      console.error("Error during login code verification:", error);
      return sendJson(response, { error: "Internal Server Error" }, 500);
    }
  }

  if (url.pathname === "/api/user/profile" && request.method === "GET") {
    const userId = url.searchParams.get("userId") || "";
    const tgId = userId.replace(/^tg-/, "");
    if (!tgId || !userId.startsWith("tg-")) {
      return sendJson(response, { error: "ID User tidak valid" }, 400);
    }

    let firstName = "";
    let lastName = "";
    let username = "";

    try {
      const botUsersPath = path.join(rootDir, "storage", "bot-users.json");
      if (fs.existsSync(botUsersPath)) {
        const botUsersData = JSON.parse(fs.readFileSync(botUsersPath, "utf8"));
        const userObj = botUsersData.users?.[tgId];
        if (userObj) {
          firstName = userObj.firstName || "";
          lastName = userObj.lastName || "";
          username = userObj.username || "";
        }
      }
    } catch (err) {
      console.error("Error loading user profile:", err);
    }

    return sendJson(response, {
      ok: true,
      user: {
        first_name: firstName || username || "User",
        last_name: lastName || "",
        username: username || `user_${tgId}`,
        id: Number(tgId) || tgId
      }
    });
  }

  // POST /api/stream/launch/refresh
  if (url.pathname === "/api/stream/launch/refresh" && request.method === "POST") {
    const body = await readJsonBody(request).catch(() => ({}));
    const token = body.token || "";
    return sendCorsJson(request, response, {
      data: {
        launchKey: token
      }
    });
  }

  // POST /api/stream/token
  if (url.pathname === "/api/stream/token" && request.method === "POST") {
    const body = await readJsonBody(request).catch(() => ({}));
    const launchKey = body.launchKey || "";
    const episodeId = body.episodeId || "1";

    let resolvedSlug = "";

    // 1. Try to decrypt JWE token if encrypted
    if (launchKey.startsWith("ct_")) {
      const jweToken = launchKey.slice(3);
      const secret = env.JWE_SECRET || process.env.JWE_SECRET;
      if (secret) {
        try {
          const key = crypto.createHash("sha256").update(secret).digest();
          const { plaintext } = await jose.compactDecrypt(jweToken, key);
          const decrypted = new TextDecoder().decode(plaintext);
          
          // If payload is JSON, extract id/slug
          if (decrypted.startsWith("{")) {
            const parsed = JSON.parse(decrypted);
            resolvedSlug = parsed.slug || parsed.id || parsed.dramaId || "";
          } else {
            resolvedSlug = decrypted.trim();
          }
        } catch (err) {
          console.warn("[Stream API] JWE decryption failed, falling back to raw slug parse:", err.message);
        }
      } else {
        console.warn("[Stream API] JWE_SECRET is not defined in .env, falling back to raw slug parse.");
      }
    }

    // 2. Fallback to raw slug parsing
    if (!resolvedSlug) {
      // Strip any ct_ prefix if it exists but failed decryption
      resolvedSlug = launchKey.replace(/^ct_/, "");
    }

    // 3. Extract platform slug and drama ID
    // Expected slug format: platform-dramaId (e.g. goodshort-31001100586)
    const match = resolvedSlug.match(/^([a-z0-9]+)-(.+)$/i);
    if (!match) {
      return sendCorsJson(request, response, { error: "Invalid drama identifier format" }, 400);
    }

    const platformSlug = match[1];
    const dramaId = match[2];

    const streamUrl = `/watch/${platformSlug}-${dramaId}?ep=${episodeId}`;
    return sendCorsJson(request, response, {
      data: {
        streamUrl
      }
    });
  }

  if (url.pathname === "/api/security/session" && request.method === "POST") {
    return security.issueSession(request, response, await readJsonBody(request));
  }

  if (url.pathname === "/api/security/logout" && request.method === "POST") {
    return security.destroySession(request, response);
  }

  if (url.pathname === "/api/security/report" && request.method === "POST") {
    return security.reportViolation(request, response, await readJsonBody(request));
  }

  if (url.pathname === "/api/security/log-stream-error" && request.method === "POST") {
    const body = await readJsonBody(request);
    
    let cdn = body.cdn || "";
    if (!cdn && body.url) {
      try {
        cdn = new URL(body.url).hostname;
      } catch (e) {}
    }
    if (!cdn) cdn = "Unknown";

    const errorDetails = {
      userId: body.userId || "guest",
      ipAddress: request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown",
      userAgent: request.headers["user-agent"] || "unknown",
      deviceId: body.deviceId || "unknown",
      episodeId: body.episodeId || "media",
      episodeName: body.episodeName || "",
      dramaTitle: body.dramaTitle || "",
      url: body.url || "",
      status: "Error",
      details: body.error || "Client-side video playback error",
      errorType: body.errorType || null,
      httpCode: body.httpCode || null,
      responseTime: body.responseTime || null,
      device: body.device || null,
      browser: body.browser || null,
      cdn: cdn
    };

    security.logStreamPlay(errorDetails);
    
    // Check for rate spikes and send Telegram notification
    try {
      trackStreamErrorAndNotify(errorDetails);
    } catch (e) {
      console.error("Error in stream error notification tracker:", e);
    }

    return sendJson(response, { ok: true });
  }

  if (url.pathname === "/api/security/admin") {
    return sendJson(response, security.securitySummary());
  }

  if (url.pathname === "/api/admin/security/stream-logs" && request.method === "GET") {
    return sendJson(response, security.getStreamLogs());
  }

  if (url.pathname === "/api/admin/stream-analytics" && request.method === "GET") {
    const logs = security.getStreamLogs() || [];
    
    let totalStreams = logs.length;
    let totalErrors = 0;
    
    const errorTypes = {};
    const brokenEpisodes = {};
    const brokenCDNs = {};
    const deviceErrors = {};
    
    // Grouping for charts
    const hourlyErrors = {};
    const dailyErrors = {};
    const dramaErrors = {};
    const cdnErrors = {};
    
    const now = Date.now();
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    
    logs.forEach(log => {
      const isError = String(log.status).toLowerCase() === "error";
      if (isError) {
        totalErrors++;
        
        // Error Type
        const errType = log.errorType || log.details || "Unknown Error";
        const errTypeClean = errType.length > 40 ? errType.substring(0, 37) + "..." : errType;
        errorTypes[errTypeClean] = (errorTypes[errTypeClean] || 0) + 1;
        
        // Broken Episode
        if (log.dramaTitle) {
          const epKey = `${log.dramaTitle} - ${log.episodeName || 'Ep'}`;
          brokenEpisodes[epKey] = (brokenEpisodes[epKey] || 0) + 1;
          dramaErrors[log.dramaTitle] = (dramaErrors[log.dramaTitle] || 0) + 1;
        }
        
        // Broken CDN
        let cdn = log.cdn || "";
        if (!cdn && log.url) {
          try {
            cdn = new URL(log.url).hostname;
          } catch(e) {}
        }
        if (!cdn) cdn = "Unknown CDN";
        brokenCDNs[cdn] = (brokenCDNs[cdn] || 0) + 1;
        cdnErrors[cdn] = (cdnErrors[cdn] || 0) + 1;
        
        // Device Error
        let device = log.device;
        if (!device && log.userAgent) {
          if (/android/i.test(log.userAgent)) device = "Android";
          else if (/ipad|iphone|ipod/i.test(log.userAgent)) device = "iOS";
          else if (/windows/i.test(log.userAgent)) device = "Windows";
          else if (/macintosh/i.test(log.userAgent)) device = "macOS";
          else if (/linux/i.test(log.userAgent)) device = "Linux";
          else device = "Other";
        }
        if (!device) device = "Unknown";
        deviceErrors[device] = (deviceErrors[device] || 0) + 1;
        
        // Time groupings
        const logTime = new Date(log.timestamp).getTime();
        if (logTime >= twentyFourHoursAgo) {
          const hourStr = new Date(logTime).getHours() + ":00";
          hourlyErrors[hourStr] = (hourlyErrors[hourStr] || 0) + 1;
        }
        if (logTime >= sevenDaysAgo) {
          const dayStr = new Date(logTime).toLocaleDateString("id-ID", { weekday: "short" });
          dailyErrors[dayStr] = (dailyErrors[dayStr] || 0) + 1;
        }
      }
    });
    
    // Sort helper
    const sortMapToSortedArray = (map, labelKey, limit = 5) => {
      return Object.entries(map)
        .map(([key, count]) => ({ [labelKey]: key, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    };
    
    return sendJson(response, {
      ok: true,
      totalStreams,
      totalErrors,
      errorRate: totalStreams > 0 ? Number(((totalErrors / totalStreams) * 100).toFixed(1)) : 0,
      topErrorTypes: sortMapToSortedArray(errorTypes, "type", 5),
      topBrokenEpisodes: sortMapToSortedArray(brokenEpisodes, "episode", 5),
      topBrokenCDNs: sortMapToSortedArray(brokenCDNs, "cdn", 5),
      topDeviceErrors: sortMapToSortedArray(deviceErrors, "device", 5),
      charts: {
        hourly: Object.entries(hourlyErrors).map(([hour, count]) => ({ hour, count })),
        daily: Object.entries(dailyErrors).map(([day, count]) => ({ day, count })),
        drama: sortMapToSortedArray(dramaErrors, "drama", 5),
        cdn: sortMapToSortedArray(cdnErrors, "cdn", 5)
      }
    });
  }

  if (url.pathname === "/api/admin/security/stream-logs/clear" && request.method === "POST") {
    security.clearStreamLogs();
    return sendJson(response, { ok: true });
  }

  if (url.pathname === "/api/security/unban" && request.method === "POST") {
    return security.unban(request, response, await readJsonBody(request));
  }

  if (url.pathname === "/api/vip/purchase" && request.method === "POST") {
    const body = await readJsonBody(request);
    const userId = body.userId || "guest";
    const planDays = Number(body.plan || 30);
    const vipInfo = security.purchaseVip(userId, planDays);
    logPayment(userId, planDays, "QRIS", "success");
    return sendJson(response, { ok: true, vip: vipInfo });
  }

  // Web VIP proof upload endpoint
  if (url.pathname === "/api/vip/upload-proof" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const userId = body.userId || "guest";
      const planDays = Number(body.planDays || 30);
      const price = Number(body.price || planDays * 1000);
      const image = body.image;

      if (!image || !image.startsWith("data:image/")) {
        return sendJson(response, { error: "Bukti transfer (gambar) diperlukan" }, 400);
      }

      // Save proof image to disk
      const uploadsDir = path.join(publicDir, "uploads");
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }

      const matches = image.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
      if (!matches || matches.length < 3) {
        return sendJson(response, { error: "Format gambar tidak valid" }, 400);
      }

      const ext = matches[1] === "jpeg" ? "jpg" : matches[1];
      const imageBuffer = Buffer.from(matches[2], "base64");
      const filename = `vip_proof_${userId.replace(/[^a-zA-Z0-9_-]/g, "")}_${Date.now()}.${ext}`;
      const localFilePath = path.join(uploadsDir, filename);
      fs.writeFileSync(localFilePath, imageBuffer);

      // Log the pending payment
      logPayment(userId, planDays, "QRIS (Web - Pending)", "pending", {
        source: "Website VIP Page",
        total: price,
        proofUrl: `/uploads/${filename}`,
        proofFile: `/uploads/${filename}`
      });

      // Send proof to admin via Telegram
      if (botToken && adminId) {
        const priceFormatted = price.toLocaleString("id-ID");
        const caption = [
          `🔔 <b>BUKTI PEMBAYARAN VIP (WEB)</b>`,
          ``,
          `👤 <b>User:</b> ${userId}`,
          `📦 <b>Paket:</b> ${planDays} Hari`,
          `💰 <b>Total:</b> Rp ${priceFormatted}`,
          `📅 <b>Tanggal:</b> ${new Date().toLocaleString("id-ID")}`,
          `🌐 <b>Sumber:</b> Website VIP Page`
        ].join("\n");

        const replyMarkup = {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `vip_approve_${userId}_${planDays}` },
              { text: "❌ Reject", callback_data: `vip_reject_${userId}_${planDays}` }
            ]
          ]
        };

        try {
          // Send photo with approve/reject buttons
          const tgFormData = new FormData();
          tgFormData.append("chat_id", adminId);
          tgFormData.append("caption", caption);
          tgFormData.append("parse_mode", "HTML");
          tgFormData.append("reply_markup", JSON.stringify(buildAdminVipActionMarkup(userId, planDays)));
          const fileBlob = new Blob([imageBuffer], { type: `image/${ext}` });
          tgFormData.append("photo", fileBlob, filename);

          await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
            method: "POST",
            body: tgFormData
          });
        } catch (tgErr) {
          console.error("Failed to send VIP proof to admin via Telegram:", tgErr);
        }
      }

      return sendJson(response, { ok: true, message: "Bukti pembayaran berhasil dikirim ke admin untuk verifikasi." });
    } catch (err) {
      console.error("Error processing VIP proof upload:", err);
      return sendJson(response, { error: "Gagal memproses bukti transfer: " + err.message }, 500);
    }
  }

  if (url.pathname === "/api/admin/vip" && request.method === "GET") {
    return sendJson(response, security.getVipUsers());
  }

  if (url.pathname === "/api/admin/vip/modify" && request.method === "POST") {
    const body = await readJsonBody(request);
    const userId = body.userId;
    const planDays = Number(body.planDays || 30);
    const action = body.action || "add";
    
    if (!userId) {
      return sendJson(response, { error: "User ID is required" }, 400);
    }
    
    if (action === "add") {
      const vipInfo = security.purchaseVip(userId, planDays);
      if (body.paymentSource === "proof") {
        updateLatestPaymentStatus(userId, planDays, "success");
      } else {
        logPayment(userId, planDays, "Manual Admin", "success");
      }
      return sendJson(response, { ok: true, vip: vipInfo });
    } else if (action === "remove") {
      const vipInfo = security.removeVip(userId);
      logPayment(userId, 0, "Manual Admin (Cabut)", "success");
      return sendJson(response, { ok: true, vip: vipInfo });
    } else {
      return sendJson(response, { error: "Invalid action" }, 400);
    }
  }

  if (url.pathname === "/api/admin/payments" && request.method === "GET") {
    return sendJson(response, loadPaymentHistory());
  }

  if (url.pathname === "/api/admin/payments/upload-gdrive" && request.method === "POST") {
    const history = loadPaymentHistory();
    const csvLines = ["User ID,Paket,Metode,Status,Tanggal"];
    history.forEach(item => {
      csvLines.push(`${item.userId},${item.plan},${item.method},${item.status},${item.date}`);
    });
    const csvContent = csvLines.join("\n");
    
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const fileName = `TEAMDL_Payment_Recap_${dateStr}.csv`;
    const fileId = `gdrive-mock-file-${Math.random().toString(36).slice(2, 11)}`;
    const viewUrl = `https://drive.google.com/open?id=${fileId}`;
    
    console.log(`[Google Drive Mock] Uploaded ${fileName} to Drive with ID ${fileId}`);
    return sendJson(response, {
      ok: true,
      fileName,
      fileId,
      viewUrl,
      recordsCount: history.length
    });
  }

  if (url.pathname === "/api/admin/bot-users" && request.method === "GET") {
    return sendJson(response, botUserSummary(rootDir));
  }

  if (url.pathname === "/api/admin/bot-users/action" && request.method === "POST") {
    const body = await readJsonBody(request);
    return handleBotUserAction(body, response);
  }

  if (url.pathname === "/api/admin/broadcast" && request.method === "POST") {
    if (!checkAdminAuth(request)) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    const body = await readJsonBody(request);
    const text = String(body.text || "").trim();
    if (!text) {
      return sendJson(response, { error: "Pesan broadcast tidak boleh kosong." }, 400);
    }
    const users = listBotUsers(rootDir).filter(u => u.status === "active");
    let count = 0;
    for (const u of users) {
      try {
        await callTelegramBotApi("sendMessage", {
          chat_id: u.chatId || Number(u.telegramId),
          text,
          parse_mode: "HTML"
        });
        count++;
      } catch (err) {
        console.error(`Gagal kirim broadcast ke ${u.telegramId}:`, err.message);
      }
    }
    return sendJson(response, { ok: true, count });
  }

  if (url.pathname === "/api/menu") {
    return sendJson(response, JSON.parse(fs.readFileSync(path.join(rootDir, "shared/menu.config.json"), "utf8")));
  }

  if (url.pathname === "/api/firebase-config") {
    return sendJson(response, JSON.parse(fs.readFileSync(firebaseConfigPath, "utf8")));
  }

  if (url.pathname === "/api/platforms") {
    return sendJson(response, loadClientPlatformSources());
  }

  if (url.pathname === "/api/sources") {
    if (!checkAdminAuth(request)) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    return sendJson(response, loadPublicSources());
  }

  if (url.pathname === "/api/sources/files") {
    if (!checkAdminAuth(request)) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    return sendJson(response, listSourceFiles());
  }

  if (url.pathname === "/api/sources/history") {
    if (!checkAdminAuth(request)) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    return sendJson(response, sourceHistory());
  }

  if (url.pathname === "/api/admin/platform-notifications") {
    if (!checkAdminAuth(request)) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    return sendJson(response, buildPlatformNotifications());
  }

  if (url.pathname === "/api/admin/platform-playability" && request.method === "GET") {
    if (!checkAdminAuth(request)) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    try {
      return sendJson(response, await runPlatformPlayabilityCheck());
    } catch (error) {
      console.error("Platform playability check failed:", error);
      return sendJson(response, { ok: false, error: error.message || "Platform playability check failed." }, 500);
    }
  }

  if (url.pathname === "/api/sources/upload" && request.method === "POST") {
    if (!checkAdminAuth(request)) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    return uploadSourceFile(request, response);
  }

  if (url.pathname === "/api/sources/status" && request.method === "POST") {
    if (!checkAdminAuth(request)) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    return updateSourceStatus(request, response);
  }

  if (url.pathname.startsWith("/api/sources/")) {
    if (!checkAdminAuth(request)) {
      return sendJson(response, { error: "Unauthorized" }, 401);
    }
    const slug = url.pathname.split("/").pop();
    const source = loadPublicSources().find((item) => item.slug === slug);
    return sendJson(response, source || { error: "Platform source not found" }, source ? 200 : 404);
  }

  // --- TELEGRAM AUTO NOTIFICATION CENTER API ENDPOINTS ---
  if (url.pathname === "/api/admin/notifications/stats" && request.method === "GET") {
    const stats = calculateNotificationStats();
    return sendJson(response, stats);
  }

  if (url.pathname === "/api/admin/notifications/targets" && request.method === "GET") {
    return sendJson(response, loadTargets(rootDir));
  }

  if (url.pathname === "/api/admin/notifications/targets" && request.method === "POST") {
    const body = await readJsonBody(request);
    const targets = loadTargets(rootDir);
    const newTarget = {
      id: targets.length ? Math.max(...targets.map(t => t.id)) + 1 : 1,
      name: body.name || "Target Baru",
      channel_id: body.channel_id || "",
      topic_id: body.topic_id || "",
      type: body.type || "Drama Baru",
      status: body.status || "Aktif"
    };
    targets.push(newTarget);
    saveTargets(rootDir, targets);
    return sendJson(response, newTarget);
  }

  if (url.pathname === "/api/admin/notifications/targets" && request.method === "PUT") {
    const body = await readJsonBody(request);
    const targets = loadTargets(rootDir);
    const idx = targets.findIndex(t => t.id === Number(body.id));
    if (idx === -1) {
      return sendJson(response, { error: "Target tidak ditemukan" }, 404);
    }
    targets[idx] = {
      ...targets[idx],
      name: body.name || targets[idx].name,
      channel_id: body.channel_id || targets[idx].channel_id,
      topic_id: body.topic_id !== undefined ? body.topic_id : targets[idx].topic_id,
      type: body.type || targets[idx].type,
      status: body.status || targets[idx].status
    };
    saveTargets(rootDir, targets);
    return sendJson(response, targets[idx]);
  }

  if (url.pathname === "/api/admin/notifications/targets" && request.method === "DELETE") {
    const body = await readJsonBody(request);
    const targets = loadTargets(rootDir);
    const newTargets = targets.filter(t => t.id !== Number(body.id));
    saveTargets(rootDir, newTargets);
    return sendJson(response, { ok: true });
  }

  if (url.pathname === "/api/admin/notifications/targets/test" && request.method === "POST") {
    const body = await readJsonBody(request);
    const targets = loadTargets(rootDir);
    const target = targets.find(t => t.id === Number(body.id));
    if (!target) {
      return sendJson(response, { error: "Target tidak ditemukan" }, 404);
    }
    const result = await sendTelegramTestMessage(target);
    return sendJson(response, result);
  }

  if (url.pathname === "/api/admin/notifications/settings" && request.method === "GET") {
    return sendJson(response, loadSettings(rootDir));
  }

  if (url.pathname === "/api/admin/notifications/settings" && request.method === "POST") {
    const body = await readJsonBody(request);
    const current = loadSettings(rootDir);
    const updated = { ...current, ...body };
    saveSettings(rootDir, updated);
    
    // Restart scheduler if interval changed
    if (current.interval !== updated.interval) {
      initNotificationCenter();
    }
    return sendJson(response, updated);
  }

  if (url.pathname === "/api/admin/notifications/queue" && request.method === "GET") {
    return sendJson(response, loadQueue(rootDir));
  }

  if (url.pathname === "/api/admin/notifications/queue/action" && request.method === "POST") {
    const body = await readJsonBody(request);
    const action = body.action;
    const itemId = body.id;
    let queue = loadQueue(rootDir);
    
    if (action === "clear") {
      queue = [];
    } else if (action === "pause") {
      isQueuePaused = true;
    } else if (action === "resume") {
      isQueuePaused = false;
      setTimeout(runQueueProcessor, 100);
    } else if (action === "retry") {
      if (itemId) {
        const item = queue.find(q => q.id === Number(itemId));
        if (item) {
          item.status = "Pending";
          item.retry_count = 0;
        }
      } else {
        queue.forEach(item => {
          if (item.status === "Failed" || item.status === "Retry") {
            item.status = "Pending";
            item.retry_count = 0;
          }
        });
      }
      setTimeout(runQueueProcessor, 100);
    }
    
    saveQueue(rootDir, queue);
    return sendJson(response, { queue, isQueuePaused });
  }

  if (url.pathname === "/api/admin/notifications/logs" && request.method === "GET") {
    const page = Number(url.searchParams.get("page") || 1);
    const limit = Number(url.searchParams.get("limit") || 10);
    const search = url.searchParams.get("search") || "";
    const type = url.searchParams.get("type") || "";
    
    let allLogs = loadLogs(rootDir);
    
    if (search) {
      const q = search.toLowerCase();
      allLogs = allLogs.filter(l => 
        (l.title && l.title.toLowerCase().includes(q)) ||
        (l.drama_id && l.drama_id.toLowerCase().includes(q)) ||
        (l.channel_id && l.channel_id.toLowerCase().includes(q))
      );
    }
    
    if (type) {
      allLogs = allLogs.filter(l => l.type === type);
    }
    
    const start = (page - 1) * limit;
    const paginatedLogs = allLogs.slice(start, start + limit);
    
    return sendJson(response, {
      logs: paginatedLogs,
      total: allLogs.length,
      page,
      limit
    });
  }

  if (url.pathname === "/api/admin/notifications/logs/export" && request.method === "GET") {
    const allLogs = loadLogs(rootDir);
    let csv = "\uFEFFTanggal,Jam,Drama,Jenis,Channel,Topic,Status,Response Telegram,Message ID\n";
    for (const log of allLogs) {
      const dateObj = new Date(log.sent_at);
      const dateStr = dateObj.toLocaleDateString("id-ID");
      const timeStr = dateObj.toLocaleTimeString("id-ID");
      const titleClean = String(log.title || "").replace(/"/g, '""');
      const responseClean = String(log.response || "").replace(/"/g, '""');
      csv += `"${dateStr}","${timeStr}","${titleClean}","${log.type}","${log.channel_id}","${log.topic_id || ''}","${log.status}","${responseClean}","${log.telegram_message_id || ''}"\n`;
    }
    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=notification-logs.csv"
    });
    response.end(csv);
    return;
  }

  if (url.pathname === "/api/admin/notifications/detected" && request.method === "GET") {
    return sendJson(response, loadDetectedDramas(rootDir));
  }

  if (url.pathname === "/api/admin/notifications/detect/trigger" && request.method === "POST") {
    runNotificationDetectionCycle();
    return sendJson(response, { ok: true, message: "Detection triggered in background" });
  }

  if (url.pathname === "/api/sync-plan") {
    const sources = loadPlatformSources(rootDir);
    return sendJson(response, {
      firebaseProjectId: JSON.parse(fs.readFileSync(firebaseConfigPath, "utf8")).projectId,
      collections: {
        platformSources: sources.map((source) => source.slug),
        sourceEndpoints: sources.reduce((total, source) => total + source.endpoints.length, 0)
      },
      note: "Client sync writes metadata only. Real server-side Firestore writes need service account credentials."
    });
  }

  if (url.pathname === "/api/search") {
    return sendJson(response, searchContent(url.searchParams.get("q") || ""));
  }

  if (url.pathname === "/api/watch-party/create" && request.method === "POST") {
    const body = await readJsonBody(request);
    try {
      const room = createWatchPartyRoom({
        movieId: body.movieId,
        episodeId: body.episodeId,
        hostId: body.hostId,
        hostName: body.hostName,
        title: body.title,
        season: body.season,
        episode: body.episode,
        isPrivate: body.isPrivate,
        password: body.password
      });
      return sendJson(response, watchPartyRoomPayload(room.room_code, room.host_id));
    } catch (err) {
      return sendJson(response, { error: err.message }, 400);
    }
  }

  if (url.pathname === "/api/watch-party/join" && request.method === "POST") {
    const body = await readJsonBody(request);
    const joined = joinWatchPartyRoom({
      roomCode: body.roomCode,
      userId: body.userId,
      userName: body.userName,
      password: body.password
    });
    if (!joined.ok) {
      return sendJson(response, { error: joined.error }, joined.status || 400);
    }
    return sendJson(response, watchPartyRoomPayload(joined.room.room_code, body.userId));
  }

  if (url.pathname.startsWith("/api/watch-party/room/") && request.method === "GET") {
    const roomCode = decodeURIComponent(url.pathname.replace(/^\/api\/watch-party\/room\//, ""));
    const userId = url.searchParams.get("userId") || "";
    const payload = watchPartyRoomPayload(roomCode, userId);
    if (!payload.room) {
      return sendJson(response, { error: "Room tidak ditemukan" }, 404);
    }
    return sendJson(response, payload);
  }

  if (url.pathname === "/api/watch-party/ice-servers" && request.method === "GET") {
    const iceServers = getWatchPartyIceServers();
    return sendJson(response, iceServers);
  }

  if (url.pathname === "/api/watch-party/check-admin" && request.method === "GET") {
    const userId = url.searchParams.get("userId") || "";
    const adminToken = url.searchParams.get("adminToken") || "";
    const isAdmin = isUserAdmin(userId) || (adminToken && activeTokens.has(adminToken));
    return sendJson(response, { ok: true, isAdmin: !!isAdmin });
  }

  if (url.pathname === "/api/watch-party/list" && request.method === "GET") {
    const store = readWatchPartyStore();
    const activeRooms = store.rooms
      .filter((room) => room.status === "open")
      .map((room) => {
        const clients = watchPartyClients.get(room.room_code) || new Set();
        return {
          room_code: room.room_code,
          title: room.title,
          host_name: room.host_name,
          host_id: room.host_id,
          is_private: room.is_private,
          movie_id: room.movie_id,
          season: room.season,
          episode: room.episode,
          active_members: clients.size,
          created_at: room.created_at
        };
      });
    return sendJson(response, { ok: true, rooms: activeRooms });
  }

  if (url.pathname === "/api/watch-party/close" && request.method === "POST") {
    const body = await readJsonBody(request);
    const roomCode = String(body.roomCode || "").trim().toUpperCase();
    const userId = String(body.userId || "").trim();
    const adminToken = String(body.adminToken || "").trim();

    const store = readWatchPartyStore();
    const room = store.rooms.find((item) => item.room_code === roomCode && item.status === "open");
    if (!room) {
      return sendJson(response, { error: "Room tidak ditemukan atau sudah ditutup." }, 404);
    }

    const isHost = room.host_id === userId;
    const isAdmin = isUserAdmin(userId) || (adminToken && activeTokens.has(adminToken));

    if (!isHost && !isAdmin) {
      return sendJson(response, { error: "Hanya host atau admin yang dapat menutup room." }, 403);
    }

    room.status = "closed";
    writeWatchPartyStore(store);

    broadcastWatchParty(roomCode, "room:close", { closed: true, closedBy: isAdmin ? "admin" : "host" });

    return sendJson(response, { ok: true });
  }

  // MovieBox Subtitle Proxy
  if (url.pathname === "/api/moviebox/subtitles" && request.method === "GET") {
    const subUrl = url.searchParams.get("url");
    if (!subUrl) {
      response.writeHead(400);
      response.end("Missing url");
      return;
    }
    try {
      const subRes = await httpsFetch(subUrl);
      if (subRes.ok) {
        const text = await subRes.text();
        response.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        });
        response.end(text);
      } else {
        response.writeHead(subRes.status);
        response.end();
      }
    } catch (err) {
      response.writeHead(500);
      response.end(err.message);
    }
    return;
  }

  // MovieBox Integration Endpoints
  if (url.pathname === "/api/moviebox/home" && request.method === "GET") {
    const now = Date.now();
    if (movieBoxHomeCache && (now - movieBoxHomeCacheTime) < MOVIEBOX_CACHE_TTL_MS) {
      return sendJson(response, movieBoxHomeCache);
    }

    try {
      const webRes = await fetch("https://h5-api.aoneroom.com/wefeed-h5api-bff/home?host=moviebox.ph", {
        headers: {
          "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
          "Accept-Language": "en-US,en;q=0.5",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      const webJson = await webRes.json();
      const banner = [];
      const trending = [];
      const latest_movies = [];
      const latest_series = [];
      const latest_anime = [];

      if (webJson.code === 0 && webJson.data && webJson.data.operatingList) {
        for (const op of webJson.data.operatingList) {
          const title = (op.title || "").toLowerCase();
          let items = [];
          if (op.banner && Array.isArray(op.banner.items)) {
            items = op.banner.items;
          } else if (Array.isArray(op.subjects) && op.subjects.length > 0) {
            items = op.subjects;
          } else {
            items = op.subjects || [];
          }

          const mappedItems = items.map(item => {
            const subj = item.subject || {};
            return {
              id: item.detailPath || subj.detailPath || item.id,
              subjectId: item.subjectId || subj.subjectId,
              title: item.title || item.postTitle || subj.title || "",
              poster: (item.cover && item.cover.url) || (item.image && item.image.url) || (subj.cover && subj.cover.url) || "",
              rating: item.imdbRatingValue || subj.imdbRatingValue || "",
              year: item.releaseDate ? item.releaseDate.split("-")[0] : (subj.releaseDate ? subj.releaseDate.split("-")[0] : ""),
              subjectType: item.subjectType || subj.subjectType
            };
          });

          if (title.includes("banner") || op.type === "BANNER") {
            banner.push(...mappedItems);
          } else {
            const isTrending = title.includes("trending");
            for (const item of mappedItems) {
              if (isTrending) {
                trending.push(item);
              }
              const type = Number(item.subjectType);
              if (type === 1) {
                latest_movies.push(item);
              } else if (type === 2) {
                latest_series.push(item);
              } else if (type === 7) {
                latest_anime.push(item);
              } else {
                if (title.includes("anime") || title.includes("cartoon") || title.includes("animation")) {
                  latest_anime.push(item);
                } else if (title.includes("movie") || title.includes("film")) {
                  latest_movies.push(item);
                } else {
                  latest_series.push(item);
                }
              }
            }
          }
        }
      }

      const uniq = (arr) => {
        const seen = new Set();
        return arr.filter(item => {
          const key = item.id || item.subjectId;
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };

      const resultPayload = {
        banner: uniq(banner),
        trending: uniq(trending),
        latest_movies: uniq(latest_movies),
        latest_series: uniq(latest_series),
        latest_anime: uniq(latest_anime)
      };

      // Populate memory cache
      movieBoxHomeCache = resultPayload;
      movieBoxHomeCacheTime = Date.now();

      return sendJson(response, resultPayload);
    } catch (err) {
      console.error("Error fetching MovieBox home:", err);
      return sendJson(response, { error: err.message }, 500);
    }
  }

  if (url.pathname === "/api/moviebox/search" && request.method === "GET") {
    const q = url.searchParams.get("q") || "";
    const type = url.searchParams.get("type") || "all";
    let subjectType = 0;
    if (type === "movies") subjectType = 1;
    else if (type === "series") subjectType = 2;
    else if (type === "anime") subjectType = 7;

    try {
      const payload = {
        keyword: q,
        page: 1,
        perPage: 20,
        subjectType
      };
      const data = await fetchMovieBoxApi("POST", "/wefeed-mobile-bff/subject-api/search", JSON.stringify(payload));
      const results = (data && data.items) || [];
      const mapped = results.map(item => ({
        id: item.detailPath || item.subjectId || item.id,
        detailPath: item.detailPath || "",
        subjectId: item.subjectId,
        title: item.title,
        poster: item.cover ? item.cover.url : "",
        rating: item.imdbRatingValue || "",
        year: item.releaseDate ? item.releaseDate.split("-")[0] : "",
        subjectType: item.subjectType
      }));
      return sendJson(response, { results: mapped });
    } catch (err) {
      console.error("Error searching MovieBox:", err);
      return sendJson(response, { results: [] });
    }
  }

  if (url.pathname === "/api/moviebox/filter" && request.method === "GET") {
    const page = Number(url.searchParams.get("page") || "1");
    const perPage = Number(url.searchParams.get("perPage") || "24");
    const subjectType = Number(url.searchParams.get("subjectType") || "1");
    const genre = url.searchParams.get("genre") || "All";
    const country = url.searchParams.get("country") || "All";
    const year = url.searchParams.get("year") || "All";
    const language = url.searchParams.get("language") || "All";
    const sort = url.searchParams.get("sort") || "ForYou";
    const animeOnly = url.searchParams.get("animeOnly") === "1";
    const seriesOnly = url.searchParams.get("seriesOnly") === "1";

    try {
      const payload = {
        page,
        perPage,
        subjectType
      };

      if (animeOnly) {
        payload.genre = "Animation";
      } else if (genre !== "All") {
        payload.genre = genre;
      }
      if (country !== "All") payload.country = country;
      if (year !== "All") payload.year = year;
      if (language !== "All") payload.language = language;
      if (sort !== "ForYou") payload.sort = sort;

      const res = await fetch("https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/filter", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
          "Accept-Language": "en-US,en;q=0.5",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        body: JSON.stringify(payload)
      });
      const webJson = await res.json();
      const items = (webJson && webJson.data && webJson.data.items) || [];
      const pager = (webJson && webJson.data && webJson.data.pager) || { hasMore: false };

      const scopedItems = items.filter((item) => {
        if (animeOnly) {
          return String(item.genre || "").toLowerCase().split(",").map(part => part.trim()).includes("animation");
        }
        if (seriesOnly) {
          return Number(item.subjectType) === 2;
        }
        return true;
      });

      const mapped = scopedItems.map(item => ({
        id: item.detailPath || item.subjectId || item.id,
        detailPath: item.detailPath || "",
        subjectId: item.subjectId,
        title: item.title,
        poster: item.cover ? item.cover.url : "",
        rating: item.imdbRatingValue || "",
        year: item.releaseDate ? item.releaseDate.split("-")[0] : "",
        subjectType: item.subjectType,
        genre: item.genre || ""
      }));

      return sendJson(response, { items: mapped, hasMore: pager.hasMore });
    } catch (err) {
      console.error("Error filtering MovieBox:", err);
      return sendJson(response, { items: [], hasMore: false });
    }
  }

  if (url.pathname === "/api/moviebox/short-drama" && request.method === "GET") {
    const page = Number(url.searchParams.get("page") || "1");
    const perPage = Number(url.searchParams.get("perPage") || "24");
    const rankingId = url.searchParams.get("id") || "567783349092340776";

    try {
      const res = await fetch(`https://h5-api.aoneroom.com/wefeed-h5api-bff/ranking-list/content?id=${encodeURIComponent(rankingId)}&page=${page}&perPage=${perPage}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
          "Accept-Language": "en-US,en;q=0.5",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      const webJson = await res.json();
      const items = (webJson && webJson.data && webJson.data.subjectList) || [];
      const pager = (webJson && webJson.data && webJson.data.pager) || { hasMore: false };

      const mapped = items.map(item => ({
        id: item.detailPath || item.subjectId || item.id,
        detailPath: item.detailPath || "",
        subjectId: item.subjectId,
        title: item.title,
        poster: item.cover ? item.cover.url : "",
        rating: item.imdbRatingValue || "",
        year: item.releaseDate ? item.releaseDate.split("-")[0] : "",
        subjectType: item.subjectType,
        genre: item.genre || "Short Drama",
        description: item.description || ""
      }));

      return sendJson(response, { items: mapped, hasMore: !!pager.hasMore, title: webJson.data?.title || "Short Drama" });
    } catch (err) {
      console.error("Error fetching MovieBox short drama:", err);
      return sendJson(response, { items: [], hasMore: false, title: "Short Drama" });
    }
  }

  if (url.pathname.startsWith("/api/moviebox/detail/") && request.method === "GET") {
    const detailPath = decodeURIComponent(url.pathname.replace(/^\/api\/moviebox\/detail\//, ""));
    const se = url.searchParams.get("se") || "1";
    try {
      // Step 1: Web detail
      const detailParam = /^\d+$/.test(detailPath)
        ? `subjectId=${encodeURIComponent(detailPath)}`
        : `detailPath=${encodeURIComponent(detailPath)}`;
      const webRes = await fetch(`https://h5-api.aoneroom.com/wefeed-h5api-bff/detail?${detailParam}`, {
        headers: {
          "X-Client-Info": '{"timezone":"Africa/Nairobi"}',
          "Accept-Language": "en-US,en;q=0.5",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      const webJson = await webRes.json();
      if (webJson.code !== 0 || !webJson.data || !webJson.data.subject) {
        return sendJson(response, { error: "Detail drama tidak ditemukan" }, 404);
      }

      const subject = webJson.data.subject;
      const subjectId = subject.subjectId;

      // Step 2: Signed mobile api request for episode resources
      const resourceData = await fetchMovieBoxApi("GET", `/wefeed-mobile-bff/subject-api/resource?subjectId=${subjectId}&se=${se}&ep=1`);
      const episodes = (resourceData && resourceData.list) || [];
      
      const mappedEpisodes = episodes.map(ep => ({
        episode: `Episode ${ep.ep || ep.episode}`,
        episode_number: ep.ep || ep.episode,
        stream_url: ep.resourceLink,
        resourceId: ep.resourceId,
        subjectId: subjectId,
        se: ep.se || Number(se)
      }));

      // Seasons mapping from web json
      const seasons = (webJson.data.resource && webJson.data.resource.seasons) || [
        { se: 1, maxEp: mappedEpisodes.length || 1 }
      ];

      return sendJson(response, {
        id: subject.detailPath || detailPath,
        detailPath: subject.detailPath || "",
        subjectId,
        title: subject.title,
        poster: subject.cover ? subject.cover.url : "",
        backdrop: subject.cover ? subject.cover.url : "",
        rating: subject.imdbRatingValue || "",
        year: subject.releaseDate ? subject.releaseDate.split("-")[0] : "",
        genres: subject.genre ? subject.genre.split(",") : [],
        description: subject.description || "",
        episodes: mappedEpisodes,
        seasons
      });
    } catch (err) {
      console.error("Error fetching MovieBox detail:", err);
      return sendJson(response, { error: err.message }, 500);
    }
  }

  if (url.pathname === "/api/moviebox/watch" && request.method === "GET") {
    const subjectId = url.searchParams.get("subjectId");
    const resourceId = url.searchParams.get("resourceId");
    const se = url.searchParams.get("se") || "1";
    const ep = url.searchParams.get("ep") || "1";
    const resolution = url.searchParams.get("resolution") || "360";

    if (!subjectId) {
      return sendJson(response, { error: "subjectId is required" }, 400);
    }

    try {
      // Fetch dynamic stream url
      let streamUrl = "";
      let episodeTitle = `Episode ${ep}`;
      const resourceData = await fetchMovieBoxApi("GET", `/wefeed-mobile-bff/subject-api/resource?subjectId=${subjectId}&se=${se}&ep=${ep}&resolution=${resolution}`);
      const episodeList = (resourceData && resourceData.list) || [];
      const targetEp = episodeList.find(e => String(e.ep || e.episode) === String(ep));
      if (targetEp) {
        streamUrl = targetEp.resourceLink;
        episodeTitle = targetEp.title || `Episode ${ep}`;
      }

      // Fetch subtitles if resourceId is provided
      let subtitles = [];
      if (resourceId) {
        try {
          const captionData = await fetchMovieBoxApi("GET", `/wefeed-mobile-bff/subject-api/get-ext-captions?subjectId=${subjectId}&resourceId=${resourceId}`);
          const captionList = (captionData && (captionData.extCaptions || captionData.list)) || [];
          subtitles = captionList.map(sub => ({
            language: sub.lanName || sub.lan,
            code: sub.lan,
            url: `/api/moviebox/subtitles?url=${encodeURIComponent(sub.url)}`
          }));
        } catch (subErr) {
          console.error("Failed to fetch captions:", subErr);
        }
      }

      return sendJson(response, {
        title: episodeTitle,
        streams: [
          {
            quality: "Auto",
            url: streamUrl ? `/api/moviebox/proxy-stream?url=${encodeURIComponent(streamUrl)}` : "",
            type: "mp4"
          }
        ],
        subtitles
      });
    } catch (err) {
      console.error("Error fetching MovieBox watch data:", err);
      return sendJson(response, { error: err.message }, 500);
    }
  }

  if (url.pathname === "/api/moviebox/proxy-stream" && request.method === "GET") {
    const streamUrl = url.searchParams.get("url");
    if (!streamUrl) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Missing url");
      return;
    }
    try {
      const headers = {
        "User-Agent": request.headers["user-agent"] || "",
        "Accept": request.headers["accept"] || "*/*",
        "Connection": "keep-alive"
      };
      if (request.headers["range"]) {
        headers["Range"] = request.headers["range"];
      }
      const upstream = await fetch(streamUrl, {
        method: "GET",
        headers,
        redirect: "follow"
      });
      const responseHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS"
      };
      const copyHeaders = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"];
      for (const h of copyHeaders) {
        const val = upstream.headers.get(h);
        if (val) {
          responseHeaders[h] = val;
        }
      }
      response.writeHead(upstream.status, responseHeaders);
      if (!upstream.body) {
        response.end();
        return;
      }
      const reader = upstream.body.getReader();
      const pipe = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            response.write(value);
          }
        } catch (err) {
          // Ignore connection aborts by client
        } finally {
          response.end();
        }
      };
      pipe();
    } catch (err) {
      console.error("Stream proxy failed:", err);
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(err.message);
    }
    return;
  }

  if (url.pathname === "/api/media") {
    return security.forbidden(response, "DIRECT_MEDIA_DISABLED");
  }

  if (url.pathname.startsWith("/api/secure-media/")) {
    let token = decodeURIComponent(url.pathname.replace(/^\/api\/secure-media\//, ""));
    token = token.replace(/\.(m3u8|mpd|mp4)$/i, "");
    return security.proxySecureMedia(request, response, token, proxyMedia);
  }

  if (url.pathname === "/api/transmux") {
    return security.forbidden(response, "DIRECT_TRANSMUX_DISABLED");
  }

  const endpointAlias = resolveEndpointAlias(url.pathname);
  if (endpointAlias) {
    return handlePlatformApi(request, response, url, endpointAlias);
  }

  if (url.pathname.startsWith("/api/platform/")) {
    return handlePlatformApi(request, response, url);
  }

  const filePath = resolveFile(url.pathname);
  if (!filePath) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Cache-Control": "no-store, no-cache, must-revalidate"
  });
  fs.createReadStream(filePath).pipe(response);
}

function shouldRedirectToHttps(request, url) {
  const host = String(request.headers.host || "").split(":")[0].toLowerCase();
  const publicHosts = new Set(["teamdlbot.biz.id", "www.teamdlbot.biz.id"]);
  if (!publicHosts.has(host)) {
    return false;
  }

  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").toLowerCase();
  if (forwardedProto === "http") {
    return true;
  }

  const cfVisitor = String(request.headers["cf-visitor"] || "");
  return /"scheme"\s*:\s*"http"/i.test(cfVisitor);
}

server.listen(port, () => {
  console.log(`TEAMDL aktif di http://localhost:${port}`);
  initNotificationCenter();
});

function resolveFile(urlPath) {
  const cleanPath = routeFile(urlPath);
  const filePath = path.normalize(path.join(publicDir, cleanPath));

  if (!filePath.startsWith(publicDir)) {
    return null;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return filePath;
  }

  if (cleanPath.endsWith(".apk")) {
    return null;
  }

  return path.join(publicDir, "index.html");
}

function routeFile(urlPath) {
  if (urlPath === "/") {
    return "/index.html";
  }

  if (urlPath === "/admin" || urlPath.startsWith("/admin/")) {
    return "/admin.html";
  }

  return urlPath;
}

function searchContent(keyword) {
  const q = keyword.toLowerCase().trim();
  const items = [
    { type: "Drama", title: "Hidden Moon", path: "/detail/hidden-moon" },
    { type: "Drama", title: "City of Stars", path: "/detail/city-of-stars" },
    { type: "Movie", title: "Midnight Signal", path: "/detail/midnight-signal" },
    { type: "Episode", title: "Hidden Moon Episode 12", path: "/watch/hidden-moon-12" },
    { type: "Platform", title: "Platform Manager", path: "/platform" },
    { type: "Source", title: "Source Manager", path: "/source" },
    { type: "VIP", title: "Paket VIP Bulanan", path: "/vip" }
  ];

  if (!q) {
    return items;
  }

  return items.filter((item) => `${item.type} ${item.title}`.toLowerCase().includes(q));
}

function escapeHtmlTelegram(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sendJson(response, data, statusCode = 200) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function sendCorsJson(request, response, data, statusCode = 200) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": sameOrigin(request),
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  response.end(JSON.stringify(data));
}

let watchPartyCleanupIntervalId = null;
const emptyRoomsSince = new Map();

function startWatchPartyCleanupJob() {
  if (watchPartyCleanupIntervalId) {
    clearInterval(watchPartyCleanupIntervalId);
  }

  watchPartyCleanupIntervalId = setInterval(() => {
    try {
      const store = readWatchPartyStore();
      let hasChanges = false;
      const now = Date.now();

      for (const room of store.rooms) {
        if (room.status !== "open") {
          continue;
        }

        const clients = watchPartyClients.get(room.room_code) || new Set();
        if (clients.size === 0) {
          if (!emptyRoomsSince.has(room.room_code)) {
            emptyRoomsSince.set(room.room_code, now);
          } else {
            const emptyDuration = now - emptyRoomsSince.get(room.room_code);
            if (emptyDuration >= 5 * 60 * 1000) {
              console.log(`[WatchParty] Auto-closing empty room: ${room.room_code}`);
              room.status = "closed";
              hasChanges = true;
              emptyRoomsSince.delete(room.room_code);
              broadcastWatchParty(room.room_code, "room:close", { closed: true, closedBy: "system_timeout" });
            }
          }
        } else {
          if (emptyRoomsSince.has(room.room_code)) {
            emptyRoomsSince.delete(room.room_code);
          }
        }
      }

      if (hasChanges) {
        writeWatchPartyStore(store);
      }
    } catch (err) {
      console.error("[WatchParty] Cleanup job error:", err);
    }
  }, 30000);
}

function readWatchPartyStore() {
  try {
    if (fs.existsSync(watchPartyPath)) {
      const parsed = JSON.parse(fs.readFileSync(watchPartyPath, "utf8"));
      return {
        rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [],
        members: Array.isArray(parsed.members) ? parsed.members : [],
        chat: Array.isArray(parsed.chat) ? parsed.chat : [],
        voice: Array.isArray(parsed.voice) ? parsed.voice : []
      };
    }
  } catch (err) {
    console.error("Error reading watch-party store:", err);
  }
  return { rooms: [], members: [], chat: [], voice: [] };
}

function writeWatchPartyStore(store) {
  fs.mkdirSync(path.dirname(watchPartyPath), { recursive: true });
  fs.writeFileSync(watchPartyPath, JSON.stringify(store, null, 2), "utf8");
}

function generateWatchPartyCode(existingCodes = new Set()) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let attempt = 0; attempt < 30; attempt++) {
    const length = 6 + Math.floor(Math.random() * 3);
    let code = "";
    for (let i = 0; i < length; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!existingCodes.has(code)) {
      return code;
    }
  }
  return `ROOM${Math.floor(1000 + Math.random() * 9000)}`;
}

function createWatchPartyRoom(input) {
  const store = readWatchPartyStore();
  const activeRooms = store.rooms.filter((room) => room.status === "open");
  if (activeRooms.length >= 5) {
    throw new Error("Batas maksimum room aktif (5 room) telah tercapai. Harap tunggu room lain ditutup atau hubungi admin untuk mematikannya.");
  }
  const roomCode = generateWatchPartyCode(new Set(store.rooms.map((room) => room.room_code)));
  const now = new Date().toISOString();
  const hostId = normalizeWatchPartyUserId(input.hostId);
  const room = {
    id: crypto.randomUUID(),
    room_code: roomCode,
    movie_id: String(input.movieId || "").trim(),
    episode_id: String(input.episodeId || input.episode || "1").trim(),
    host_id: hostId,
    host_name: String(input.hostName || "Host").trim().slice(0, 60) || "Host",
    title: String(input.title || "MovieBox Watch Party").trim().slice(0, 160),
    season: String(input.season || "1"),
    episode: String(input.episode || "1"),
    is_private: !!input.isPrivate,
    password_hash: input.password ? crypto.createHash("sha256").update(String(input.password)).digest("hex") : "",
    created_at: now,
    updated_at: now,
    status: "open",
    current_time: 0,
    is_playing: false,
    quality: "Auto",
    subtitle: "off"
  };
  store.rooms.unshift(room);
  upsertWatchPartyMember(store, room, hostId, input.hostName || "Host", true);
  writeWatchPartyStore(store);
  return room;
}

function joinWatchPartyRoom(input) {
  const store = readWatchPartyStore();
  const roomCode = String(input.roomCode || "").trim().toUpperCase();
  const room = store.rooms.find((item) => item.room_code === roomCode && item.status === "open");
  if (!room) {
    return { ok: false, error: "Kode room tidak ditemukan atau sudah ditutup.", status: 404 };
  }
  if (room.password_hash) {
    const hash = crypto.createHash("sha256").update(String(input.password || "")).digest("hex");
    if (hash !== room.password_hash) {
      return { ok: false, error: "Password room salah.", status: 403 };
    }
  }
  upsertWatchPartyMember(store, room, normalizeWatchPartyUserId(input.userId), input.userName || "Guest", false);
  writeWatchPartyStore(store);
  return { ok: true, room };
}

function upsertWatchPartyMember(store, room, userId, userName, isHost, avatarUrl = "") {
  const existing = store.members.find((item) => item.room_id === room.id && item.user_id === userId);
  if (existing) {
    existing.username = String(userName || existing.username || "Guest").slice(0, 60);
    existing.is_host = !!(existing.is_host || isHost);
    existing.online = true;
    existing.last_seen = new Date().toISOString();
    if (avatarUrl) {
      existing.avatar_url = avatarUrl;
    }
    return existing;
  }
  const member = {
    id: crypto.randomUUID(),
    room_id: room.id,
    user_id: userId,
    username: String(userName || "Guest").slice(0, 60),
    avatar: String(userName || "G").slice(0, 1).toUpperCase(),
    avatar_url: avatarUrl || "",
    joined_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    is_host: !!isHost,
    online: true,
    voice_status: "idle"
  };
  store.members.push(member);
  return member;
}

function normalizeWatchPartyUserId(value) {
  return String(value || `guest-${crypto.randomUUID()}`).trim().slice(0, 90);
}

function isUserAdmin(userId) {
  if (!userId) return false;
  const match = String(userId).match(/^tg-(\d+)$/);
  if (match) {
    return Number(match[1]) === adminId;
  }
  return false;
}

function getUserRoleAndAvatar(userId, defaultName) {
  const isAdm = isUserAdmin(userId);
  if (isAdm) {
    return {
      role: "admin",
      avatar: ""
    };
  }
  
  let isVip = false;
  try {
    const vipStatus = security.getVipStatus(userId);
    isVip = !!vipStatus?.active;
  } catch (err) {
    console.error("Error checking VIP status for role:", err);
  }
  
  return {
    role: isVip ? "vip" : "guest",
    avatar: ""
  };
}

function watchPartyRoomPayload(roomCode, viewerId = "") {
  const store = readWatchPartyStore();
  const room = store.rooms.find((item) => item.room_code === String(roomCode || "").toUpperCase());
  if (!room) {
    return { room: null };
  }
  const clients = watchPartyClients.get(room.room_code) || new Set();
  const liveIds = new Set([...clients].map((client) => client.userId));
  
  const members = store.members
    .filter((item) => item.room_id === room.id)
    .map((item) => {
      const roleInfo = getUserRoleAndAvatar(item.user_id, item.username);
      return {
        ...item,
        role: roleInfo.role,
        avatar_url: item.avatar_url || roleInfo.avatar || "",
        online: liveIds.has(item.user_id) || item.online === true
      };
    });

  const chatList = store.chat
    .filter((item) => item.room_id === room.id)
    .slice(-80)
    .map((chatItem) => {
      const roleInfo = getUserRoleAndAvatar(chatItem.user_id, chatItem.user);
      const memberObj = members.find((m) => m.user_id === chatItem.user_id);
      return {
        ...chatItem,
        role: chatItem.role || roleInfo.role,
        avatar: chatItem.avatar || memberObj?.avatar_url || ""
      };
    });

  return {
    room: sanitizeWatchPartyRoom(room),
    members,
    chat: chatList,
    voice: store.voice.filter((item) => item.room_id === room.id),
    isHost: String(viewerId || "") === room.host_id,
    isAdmin: isUserAdmin(viewerId),
    shareUrl: `/watch-party/${room.room_code}`
  };
}

function sanitizeWatchPartyRoom(room) {
  const { password_hash, ...safeRoom } = room;
  return safeRoom;
}

function getWatchPartyIceServers() {
  const turnUrl = process.env.TURN_URL || env.TURN_URL;
  const turnSecret = process.env.TURN_SECRET || env.TURN_SECRET;
  const turnUsername = process.env.TURN_USERNAME || env.TURN_USERNAME;
  const turnPassword = process.env.TURN_PASSWORD || env.TURN_PASSWORD;

  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
  ];

  if (turnUrl) {
    if (turnSecret) {
      const unixTime = Math.floor(Date.now() / 1000) + 24 * 3600;
      const username = `${unixTime}:teamdl-user`;
      const hmac = crypto.createHmac("sha1", turnSecret);
      hmac.update(username);
      const password = hmac.digest("base64");

      iceServers.push({
        urls: turnUrl,
        username: username,
        credential: password
      });
    } else if (turnUsername && turnPassword) {
      iceServers.push({
        urls: turnUrl,
        username: turnUsername,
        credential: turnPassword
      });
    }
  }

  return iceServers;
}

function persistWatchPartyEvent(roomCode, event, payload, client) {
  const store = readWatchPartyStore();
  const room = store.rooms.find((item) => item.room_code === roomCode);
  if (!room) {
    return null;
  }
  const now = new Date().toISOString();
  const isHost = client?.userId === room.host_id;

  if (["video:play", "video:pause", "video:seek", "video:next_episode", "video:change_quality", "video:change_subtitle"].includes(event) && !isHost) {
    return { error: "Hanya host yang dapat mengontrol video." };
  }

  if (event === "video:play" || event === "video:pause" || event === "video:seek") {
    room.current_time = Number(payload?.currentTime || payload?.time || room.current_time || 0);
    room.is_playing = event === "video:play" ? true : event === "video:pause" ? false : !!payload?.isPlaying;
    room.updated_at = now;
  }
  if (event === "video:change_quality") {
    room.quality = String(payload?.quality || room.quality || "Auto");
    room.updated_at = now;
  }
  if (event === "video:change_subtitle") {
    room.subtitle = String(payload?.subtitle || "off");
    room.updated_at = now;
  }
  if (event === "video:next_episode") {
    room.episode = String(payload?.episode || Number(room.episode || 1) + 1);
    room.episode_id = String(payload?.episodeId || room.episode);
    room.current_time = 0;
    room.is_playing = false;
    room.updated_at = now;
  }

  if (event === "chat:send") {
    if (isWatchPartyRateLimited(`${roomCode}:${client.userId}:chat`, 1200)) {
      return { error: "Chat terlalu cepat. Coba lagi sebentar." };
    }
    const roleInfo = getUserRoleAndAvatar(client.userId, client.name);
    store.chat.push({
      id: crypto.randomUUID(),
      room_id: room.id,
      user_id: client.userId,
      user: client.name,
      avatar: client.avatar || "",
      role: roleInfo.role,
      message: String(payload?.message || "").trim().slice(0, 500),
      created_at: now,
      time: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })
    });
  }

  if (event === "sticker:send") {
    if (isWatchPartyRateLimited(`${roomCode}:${client.userId}:sticker`, 1800)) {
      return { error: "Stiker terlalu cepat. Coba lagi sebentar." };
    }
    const roleInfo = getUserRoleAndAvatar(client.userId, client.name);
    store.chat.push({
      id: crypto.randomUUID(),
      room_id: room.id,
      user_id: client.userId,
      user: client.name,
      avatar: client.avatar || "",
      role: roleInfo.role,
      message: String(payload?.sticker || payload?.emoji || "").slice(0, 40),
      type: "sticker",
      created_at: now,
      time: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })
    });
  }

  if (event === "voice:join" || event === "voice:leave" || event === "voice:mute" || event === "voice:unmute") {
    const muted = event === "voice:mute" ? true : event === "voice:unmute" ? false : false;
    const existing = store.voice.find((item) => item.room_id === room.id && item.user_id === client.userId);
    if (existing) {
      existing.is_muted = muted;
      existing.status = event === "voice:leave" ? "left" : "joined";
      existing.updated_at = now;
    } else {
      store.voice.push({
        id: crypto.randomUUID(),
        room_id: room.id,
        user_id: client.userId,
        username: client.name,
        is_muted: muted,
        status: event === "voice:leave" ? "left" : "joined",
        updated_at: now
      });
    }
    const member = store.members.find((item) => item.room_id === room.id && item.user_id === client.userId);
    if (member) {
      member.voice_status = event === "voice:leave" ? "idle" : (muted ? "muted" : "speaking");
    }
  }

  if (event === "voice:admin_action" && isHost) {
    const targetUserId = payload?.targetUserId;
    const action = payload?.action;
    if (targetUserId) {
      if (action === "mute" || action === "unmute") {
        const muted = action === "mute";
        const existing = store.voice.find((item) => item.room_id === room.id && item.user_id === targetUserId);
        if (existing) {
          existing.is_muted = muted;
          existing.updated_at = now;
        }
        const member = store.members.find((item) => item.room_id === room.id && item.user_id === targetUserId);
        if (member) {
          member.voice_status = muted ? "muted" : "speaking";
        }
      } else if (action === "remove") {
        const existing = store.voice.find((item) => item.room_id === room.id && item.user_id === targetUserId);
        if (existing) {
          existing.status = "left";
          existing.updated_at = now;
        }
        const member = store.members.find((item) => item.room_id === room.id && item.user_id === targetUserId);
        if (member) {
          member.voice_status = "idle";
        }
      }
    }
  }

  if (event === "room:close" && isHost) {
    room.status = "closed";
  }

  writeWatchPartyStore(store);
  return watchPartyRoomPayload(roomCode, client?.userId);
}

function isWatchPartyRateLimited(key, ms) {
  const now = Date.now();
  const last = watchPartyRateLimits.get(key) || 0;
  watchPartyRateLimits.set(key, now);
  return now - last < ms;
}

function handleWatchPartyUpgrade(request, socket, url) {
  const key = request.headers["sec-websocket-key"];
  const roomCode = String(url.searchParams.get("room") || "").trim().toUpperCase();
  const userId = normalizeWatchPartyUserId(url.searchParams.get("userId"));
  const name = String(url.searchParams.get("name") || "Guest").trim().slice(0, 60) || "Guest";
  const avatar = String(url.searchParams.get("avatar") || "").trim();
  const store = readWatchPartyStore();
  const room = store.rooms.find((item) => item.room_code === roomCode && item.status === "open");

  if (!key || !room) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  upsertWatchPartyMember(store, room, userId, name, userId === room.host_id, avatar);
  writeWatchPartyStore(store);

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const client = { socket, roomCode, userId, name, avatar };
  if (!watchPartyClients.has(roomCode)) {
    watchPartyClients.set(roomCode, new Set());
  }
  watchPartyClients.get(roomCode).add(client);

  sendWatchPartySocket(client, {
    event: "room:ready",
    payload: watchPartyRoomPayload(roomCode, userId)
  });
  broadcastWatchParty(roomCode, "room:join", watchPartyRoomPayload(roomCode, userId));

  socket.on("data", (buffer) => {
    for (const message of decodeWebSocketFrames(buffer)) {
      if (message === "__close__") {
        socket.end();
        return;
      }
      try {
        const parsed = JSON.parse(message);
        const event = normalizeWatchPartyEvent(parsed.event);
        if (event === "chat:typing") {
          broadcastWatchParty(roomCode, event, { user: client.name }, client);
          continue;
        }
        if (event === "voice:signal") {
          broadcastWatchParty(roomCode, event, { ...parsed.payload, from: client.userId }, client);
          continue;
        }
        if (event === "voice:speaking") {
          broadcastWatchParty(roomCode, event, { userId: client.userId, isSpeaking: !!parsed.payload?.isSpeaking }, client);
          continue;
        }
        const result = persistWatchPartyEvent(roomCode, event, parsed.payload || {}, client);
        if (result?.error) {
          sendWatchPartySocket(client, { event: "room:error", payload: result });
          continue;
        }
        broadcastWatchParty(roomCode, event, {
          ...(result || watchPartyRoomPayload(roomCode, userId)),
          action: parsed.payload?.action,
          targetUserId: parsed.payload?.targetUserId
        }, client);
      } catch (err) {
        sendWatchPartySocket(client, { event: "room:error", payload: { error: err.message } });
      }
    }
  });

  socket.on("close", () => removeWatchPartyClient(client));
  socket.on("error", () => removeWatchPartyClient(client));
}

function normalizeWatchPartyEvent(event) {
  const aliases = {
    play: "video:play",
    pause: "video:pause",
    seek: "video:seek",
    next_episode: "video:next_episode",
    change_quality: "video:change_quality",
    change_subtitle: "video:change_subtitle"
  };
  return aliases[event] || event;
}

function removeWatchPartyClient(client) {
  const clients = watchPartyClients.get(client.roomCode);
  if (clients) {
    clients.delete(client);
    if (!clients.size) {
      watchPartyClients.delete(client.roomCode);
    }
  }
  const store = readWatchPartyStore();
  const room = store.rooms.find((item) => item.room_code === client.roomCode);
  const member = room && store.members.find((item) => item.room_id === room.id && item.user_id === client.userId);
  if (member) {
    member.online = false;
    member.last_seen = new Date().toISOString();
    writeWatchPartyStore(store);
  }
  broadcastWatchParty(client.roomCode, "room:leave", watchPartyRoomPayload(client.roomCode, client.userId));
}

function broadcastWatchParty(roomCode, event, payload, exceptClient = null) {
  const clients = watchPartyClients.get(roomCode);
  if (!clients) {
    return;
  }
  for (const client of clients) {
    if (client === exceptClient && event.startsWith("video:")) {
      continue;
    }
    sendWatchPartySocket(client, { event, payload });
  }
}

function sendWatchPartySocket(client, data) {
  if (client.socket.destroyed) {
    return;
  }
  try {
    client.socket.write(encodeWebSocketFrame(JSON.stringify(data)));
  } catch {
    removeWatchPartyClient(client);
  }
}

function encodeWebSocketFrame(message) {
  const payload = Buffer.from(message);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function decodeWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset++];
    const second = buffer[offset++];
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    if (length === 126) {
      if (offset + 2 > buffer.length) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const masked = (second & 0x80) === 0x80;
    let mask = null;
    if (masked) {
      if (offset + 4 > buffer.length) break;
      mask = buffer.slice(offset, offset + 4);
      offset += 4;
    }
    if (offset + length > buffer.length) break;
    const payload = Buffer.from(buffer.slice(offset, offset + length));
    offset += length;
    if (opcode === 0x8) {
      messages.push("__close__");
      continue;
    }
    if (opcode !== 0x1) {
      continue;
    }
    if (mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }
    messages.push(payload.toString("utf8"));
  }
  return messages;
}

const paymentHistoryPath = path.join(rootDir, "storage", "payment-history.json");

function loadPaymentHistory() {
  if (!fs.existsSync(paymentHistoryPath)) {
    const initialHistory = [
      { userId: "tg-8392019", plan: "30 Hari", method: "QRIS", status: "success", date: new Date(Date.now() - 3600000 * 5).toISOString() },
      { userId: "tg-9928102", plan: "365 Hari", method: "Dana", status: "success", date: new Date(Date.now() - 3600000 * 2).toISOString() },
      { userId: "guest-f1b29a", plan: "30 Hari", method: "OVO", status: "failed", date: new Date(Date.now() - 3600000).toISOString() },
      { userId: "tg-7729103", plan: "Lifetime", method: "Bank Transfer", status: "pending", date: new Date(Date.now() - 1800000).toISOString() }
    ];
    fs.mkdirSync(path.dirname(paymentHistoryPath), { recursive: true });
    fs.writeFileSync(paymentHistoryPath, JSON.stringify(initialHistory, null, 2), "utf8");
    return initialHistory;
  }
  try {
    return JSON.parse(fs.readFileSync(paymentHistoryPath, "utf8"));
  } catch (e) {
    return [];
  }
}

function logPayment(userId, planDays, method, status, details = {}) {
  const history = loadPaymentHistory();
  const planName = planDays === 9999 ? "Lifetime" : `${planDays} Hari`;
  const record = {
    id: details.id || `pay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId,
    userName: details.userName || "",
    telegramId: details.telegramId ? String(details.telegramId) : "",
    telegramUsername: details.telegramUsername || "",
    plan: planName,
    planDays,
    method,
    status,
    source: details.source || "",
    total: details.total || planDays * 1000,
    proofUrl: details.proofUrl || "",
    proofFile: details.proofFile || "",
    date: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  history.unshift(record);
  fs.mkdirSync(path.dirname(paymentHistoryPath), { recursive: true });
  fs.writeFileSync(paymentHistoryPath, JSON.stringify(history, null, 2), "utf8");
}

function updateLatestPaymentStatus(userId, planDays, status) {
  const history = loadPaymentHistory();
  const normalizedPlanDays = Number(planDays);
  const item = history.find((payment) => {
    const paymentPlanDays = Number(payment.planDays || String(payment.plan || "").match(/\d+/)?.[0] || 0);
    return payment.userId === userId && paymentPlanDays === normalizedPlanDays && payment.status === "pending";
  });

  if (item) {
    item.status = status;
    item.updatedAt = new Date().toISOString();
  } else {
    logPayment(userId, planDays, "QRIS (Verified)", status);
    return;
  }

  fs.mkdirSync(path.dirname(paymentHistoryPath), { recursive: true });
  fs.writeFileSync(paymentHistoryPath, JSON.stringify(history, null, 2), "utf8");
}

function buildAdminVipActionMarkup(userId, planDays) {
  return {
    inline_keyboard: [[
      { text: "Approve", callback_data: `vip_approve_${userId}_${planDays}` },
      { text: "Reject", callback_data: `vip_reject_${userId}_${planDays}` }
    ]]
  };
}

async function handleBotUserAction(body, response) {
  const telegramId = String(body.telegramId || body.userId || "").replace(/^tg-/, "").trim();
  const action = String(body.action || "").toLowerCase();
  const reason = String(body.reason || "").trim();

  if (!telegramId || !/^\d+$/.test(telegramId)) {
    return sendJson(response, { error: "Telegram ID tidak valid." }, 400);
  }

  if (!["ban", "kick", "unban"].includes(action)) {
    return sendJson(response, { error: "Action harus ban, kick, atau unban." }, 400);
  }

  const status = action === "unban" ? "active" : action === "kick" ? "kicked" : "banned";
  const user = setBotUserStatus(rootDir, telegramId, status, { action, reason, adminId: "admin-panel" });
  const managedChatId = env.TELEGRAM_MANAGED_CHAT_ID || env.BOT_MANAGED_CHAT_ID || env.TELEGRAM_GROUP_ID || "";
  let telegramResult = {
    ok: false,
    skipped: true,
    description: "TELEGRAM_MANAGED_CHAT_ID belum diatur; aksi hanya berlaku di bot lokal."
  };

  if (managedChatId) {
    if (action === "unban") {
      telegramResult = await callTelegramBotApi("unbanChatMember", {
        chat_id: managedChatId,
        user_id: Number(telegramId),
        only_if_banned: true
      });
    } else {
      telegramResult = await callTelegramBotApi("banChatMember", {
        chat_id: managedChatId,
        user_id: Number(telegramId)
      });

      if (action === "kick" && telegramResult?.ok) {
        await callTelegramBotApi("unbanChatMember", {
          chat_id: managedChatId,
          user_id: Number(telegramId),
          only_if_banned: true
        });
      }
    }
  }

  return sendJson(response, {
    ok: true,
    user,
    telegram: telegramResult
  });
}

function loadPublicSources() {
  return applySourceState(loadPublicPlatformSources(rootDir));
}

function loadPrivateSources() {
  return applySourceState(loadPlatformSources(rootDir));
}

function loadClientPlatformSources() {
  return applySourceState(loadPlatformSources(rootDir)).map((source) => {
    const catalogEndpointIndex = selectCatalogEndpointIndexForSource(source);
    const catalogEndpoint = source.endpoints[catalogEndpointIndex - 1];
    const episodeConfig = platformEpisodeConfig[source.slug] || inferEpisodeConfig(source);
    const detailConfig = inferDetailConfig(source);
    return {
      platform: source.platform,
      slug: source.slug,
      status: source.status,
      mode: source.mode,
      computedStatus: source.computedStatus,
      statusUpdatedAt: source.statusUpdatedAt,
      playabilityStatus: source.playabilityStatus,
      playabilityMessage: source.playabilityMessage,
      playabilityCheckedAt: source.playabilityCheckedAt,
      endpointCount: source.endpoints.length,
      catalogEndpointIndex,
      catalogPath: catalogEndpointIndex > 0 ? endpointAliasPath(source.slug, catalogEndpointIndex) : "",
      routes: endpointAliasMap(source),
      catalogPageParam: getPageParamNameForEndpoint(catalogEndpoint),
      episode: episodeConfig ? {
        path: endpointAliasPath(source.slug, episodeConfig.episodesEndpoint),
        idParam: episodeConfig.idParam,
        episodeField: episodeConfig.episodeField,
        stream: episodeConfig.streamEndpoint ? {
          path: endpointAliasPath(source.slug, episodeConfig.streamEndpoint),
          idParam: episodeConfig.streamIdParam || episodeConfig.idParam,
          episodeParam: episodeConfig.streamEpisodeParam || "ep",
          episodeField: episodeConfig.streamEpisodeField || episodeConfig.episodeField || "videoUrl",
          episodeMode: episodeConfig.streamEpisodeMode || "number"
        } : null
      } : null,
      detail: detailConfig ? {
        path: endpointAliasPath(source.slug, detailConfig.detailEndpoint),
        idParam: detailConfig.idParam
      } : null,
      language: sourceLanguageForSource(source)
    };
  });
}

function endpointAliasMap(source) {
  return Object.fromEntries(source.endpoints.map((endpoint, index) => [String(index + 1), endpointAliasPath(source.slug, index + 1)]));
}

function endpointAliasPath(platformSlug, endpointIndex) {
  const code = crypto
    .createHmac("sha256", endpointAliasSecret)
    .update(`${platformSlug}:${endpointIndex}`)
    .digest("hex")
    .slice(0, 10);
  return `/api/${code}`;
}

function resolveEndpointAlias(pathname) {
  const match = pathname.match(/^\/api\/([a-f0-9]{10})$/);
  if (!match) {
    return null;
  }

  const codePath = `/api/${match[1]}`;
  for (const source of loadPrivateSources()) {
    for (let index = 1; index <= source.endpoints.length; index += 1) {
      if (endpointAliasPath(source.slug, index) === codePath) {
        return { platformSlug: source.slug, endpointIndex: index };
      }
    }
  }
  return null;
}

function selectCatalogEndpointIndexForSource(source) {
  const custom = {
    idrama: 3
  }[source.slug];
  if (custom && source.endpoints[custom - 1]) {
    return custom;
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

  for (const pattern of priorities) {
    const index = source.endpoints.findIndex((endpoint) => pattern.test(endpoint.path) && !blocked.test(endpoint.path));
    if (index >= 0) {
      return index + 1;
    }
  }

  const fallbackIndex = source.endpoints.findIndex((endpoint) => !blocked.test(endpoint.path));
  return fallbackIndex >= 0 ? fallbackIndex + 1 : 0;
}

function inferEpisodeConfig(source) {
  const endpoints = source.endpoints || [];
  const allEpisodesIndex = endpoints.findIndex((endpoint) => /\/allepisodes(?:$|\/|:)/i.test(endpoint.path) && isEpisodeListEndpoint(endpoint.path));
  const listIndex = allEpisodesIndex >= 0 ? allEpisodesIndex : endpoints.findIndex((endpoint) => isEpisodeListEndpoint(endpoint.path));
  const detailIndex = endpoints.findIndex((endpoint) => /\/(?:detail|drama|short|show)\/:[^/]+$/i.test(endpoint.path));
  const streamIndex = endpoints.findIndex((endpoint) => isEpisodeStreamEndpoint(endpoint.path));
  const selectedIndex = listIndex >= 0 ? listIndex : detailIndex;

  if (selectedIndex < 0 && streamIndex < 0) {
    return null;
  }

  const listEndpoint = endpoints[selectedIndex >= 0 ? selectedIndex : streamIndex];
  const streamEndpoint = endpoints[streamIndex] || null;
  const idParam = inferEndpointIdParam(listEndpoint) || inferEndpointIdParam(streamEndpoint) || "id";
  const config = {
    episodesEndpoint: (selectedIndex >= 0 ? selectedIndex : streamIndex) + 1,
    idParam,
    episodeField: "videoUrl"
  };

  if (streamEndpoint) {
    config.streamEndpoint = streamIndex + 1;
    config.streamIdParam = inferEndpointIdParam(streamEndpoint) || idParam;
    config.streamEpisodeParam = inferEndpointEpisodeParam(streamEndpoint) || "ep";
    config.streamEpisodeField = "videoUrl";
  }

  return config;
}

function inferDetailConfig(source) {
  const endpoints = source.endpoints || [];
  const detailIndex = endpoints.findIndex((endpoint) => /\/(?:detail|drama|short|show)\/:[^/]+$/i.test(endpoint.path));
  if (detailIndex < 0) {
    return null;
  }

  const endpoint = endpoints[detailIndex];
  return {
    detailEndpoint: detailIndex + 1,
    idParam: inferEndpointIdParam(endpoint) || "id"
  };
}

function isEpisodeListEndpoint(endpointPath) {
  return /(?:episodes?|chapters|allepisodes)(?:$|\/|:)/i.test(endpointPath)
    && !isEpisodeStreamEndpoint(endpointPath)
    && !/subtitle/i.test(endpointPath);
}

function isEpisodeStreamEndpoint(endpointPath) {
  return /(?:watch|play|stream|getstream|rawurl)(?:$|\/|:)/i.test(endpointPath)
    && !/subtitle/i.test(endpointPath);
}

function inferEndpointIdParam(endpoint) {
  if (!endpoint) {
    return "";
  }

  const pathNames = endpointPathParamNames(endpoint.path);
  const names = [
    ...pathNames,
    ...(endpoint.params || []).map((param) => normalizeParamName(param.name))
  ];
  const preferred = ["bookId", "videoid", "videoId", "dramaId", "drama_id", "seriesId", "cid", "shortId", "showId", "id"];
  return preferred.find((name) => names.some((item) => item.toLowerCase() === name.toLowerCase())) || pathNames[0] || "";
}

function inferEndpointEpisodeParam(endpoint) {
  if (!endpoint) {
    return "";
  }

  const names = [
    ...endpointPathParamNames(endpoint.path),
    ...(endpoint.params || []).map((param) => normalizeParamName(param.name))
  ];
  const preferred = ["ep", "episode", "episodeNo", "episodeNumber", "chapterNo", "vid"];
  return preferred.find((name) => names.some((item) => item.toLowerCase() === name.toLowerCase())) || "";
}

function getPageParamNameForEndpoint(endpoint) {
  const param = endpoint?.params?.find((item) => /(^|[-_])page$/i.test(item.name));
  return param ? param.name : "page";
}

function sourceLanguageForSource(source) {
  const langParam = source.endpoints
    .flatMap((endpoint) => endpoint.params || [])
    .find((param) => /(^|[-_])lang(uage)?$/i.test(param.name) && param.defaultValue);

  return normalizeContentLangServer(langParam?.defaultValue || "");
}

function normalizeContentLangServer(value) {
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

function applySourceState(sources) {
  const state = loadSourceState();
  const playability = loadPlatformPlayabilityState();
  return sources.map((source) => {
    const stored = state.platforms[source.slug];
    const playableState = playability.platforms[source.slug];
    const computedStatus = source.endpoints.length ? "active" : "maintenance";
    // Status is controlled by admin only — playability check is informational and does NOT auto-set maintenance
    const status = source.endpoints.length ? (stored?.status || computedStatus) : computedStatus;
    return {
      ...source,
      status,
      computedStatus,
      mode: status,
      statusUpdatedAt: playableState?.checkedAt || stored?.updatedAt || null,
      playabilityStatus: playableState?.status || "unknown",
      playabilityMessage: playableState?.message || "",
      playabilityCheckedAt: playableState?.checkedAt || null
    };
  });
}

function loadPlatformPlayabilityState() {
  if (!fs.existsSync(platformPlayabilityPath)) {
    return { checkedAt: null, platforms: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(platformPlayabilityPath, "utf8"));
    return {
      checkedAt: parsed.checkedAt || null,
      platforms: parsed.platforms || {}
    };
  } catch {
    return { checkedAt: null, platforms: {} };
  }
}

function savePlatformPlayabilityState(results, checkedAt = new Date().toISOString()) {
  const platforms = {};
  for (const item of results) {
    platforms[item.slug] = {
      status: item.status,
      message: item.message,
      sampleTitle: item.sampleTitle,
      episodeNumber: item.episodeNumber,
      httpStatus: item.httpStatus,
      contentType: item.contentType,
      checkedAt
    };
  }
  fs.mkdirSync(path.dirname(platformPlayabilityPath), { recursive: true });
  fs.writeFileSync(platformPlayabilityPath, JSON.stringify({ checkedAt, platforms }, null, 2), "utf8");
}

function loadSourceState() {
  if (!fs.existsSync(sourceStatePath)) {
    return { platforms: {}, uploads: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(sourceStatePath, "utf8"));
    return {
      platforms: parsed.platforms || {},
      uploads: parsed.uploads || []
    };
  } catch {
    return { platforms: {}, uploads: [] };
  }
}

function saveSourceState(state) {
  fs.mkdirSync(path.dirname(sourceStatePath), { recursive: true });
  fs.writeFileSync(sourceStatePath, JSON.stringify(state, null, 2), "utf8");
}

function listSourceFiles() {
  const sourcesDir = path.join(rootDir, "storage", "sources");
  if (!fs.existsSync(sourcesDir)) {
    return [];
  }

  return fs.readdirSync(sourcesDir)
    .filter((file) => /\.(txt|json)$/i.test(file))
    .map((file) => {
      const filePath = path.join(sourcesDir, file);
      const stats = fs.statSync(filePath);
      return {
        file,
        type: path.extname(file).slice(1).toLowerCase(),
        size: stats.size,
        updatedAt: stats.mtime.toISOString()
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

function sourceHistory() {
  const state = loadSourceState();
  const sources = loadPublicSources();
  const sourceByFile = new Map(sources.map((source) => [source.sourceFile, source]));

  const uploadRows = state.uploads.map((item) => {
    const source = sourceByFile.get(item.file);
    return {
      ...item,
      status: source?.computedStatus === "active" ? "active" : item.status,
      endpointCount: source?.endpoints.length || item.endpointCount || 0
    };
  });

  const knownFiles = new Set(uploadRows.map((item) => item.file));
  const existingRows = sources
    .filter((source) => !knownFiles.has(source.sourceFile))
    .map((source) => ({
      file: source.sourceFile,
      platform: source.platform,
      slug: source.slug,
      type: path.extname(source.sourceFile).slice(1).toLowerCase() || "txt",
      status: source.computedStatus === "active" ? "active" : "pending",
      endpointCount: source.endpoints.length,
      createdAt: source.scrapedAt || null,
      updatedAt: source.statusUpdatedAt || null
    }));

  return [...uploadRows, ...existingRows].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function buildPlatformNotifications() {
  const sources = loadPublicSources();
  const history = sourceHistory();
  const now = new Date().toISOString();
  const notifications = [];

  for (const source of sources) {
    if (!source.endpoints.length) {
      notifications.push({
        id: `source-empty-${source.slug}`,
        platform: source.platform,
        type: "endpoint_empty",
        tone: "critical",
        title: "Endpoint kosong",
        message: `${source.platform} belum punya endpoint aktif. Platform otomatis perlu dicek sebelum ditampilkan ke user.`,
        createdAt: source.statusUpdatedAt || source.scrapedAt || now
      });
      continue;
    }

    if (source.status === "off") {
      notifications.push({
        id: `source-off-${source.slug}`,
        platform: source.platform,
        type: "platform_off",
        tone: "critical",
        title: "Platform OFF",
        message: `${source.platform} sedang dimatikan dari panel admin.`,
        createdAt: source.statusUpdatedAt || now
      });
    } else if (source.status === "maintenance") {
      notifications.push({
        id: `source-maintenance-${source.slug}`,
        platform: source.platform,
        type: "platform_maintenance",
        tone: "warn",
        title: "Maintenance",
        message: `${source.platform} sedang maintenance dan akses user dibatasi.`,
        createdAt: source.statusUpdatedAt || now
      });
    }
  }

  for (const item of history.slice(0, 8)) {
    notifications.push({
      id: `source-history-${item.slug || item.file}`,
      platform: item.platform,
      type: "source_update",
      tone: item.status === "active" ? "ok" : "warn",
      title: item.status === "active" ? "Source aktif" : "Source perlu review",
      message: `${item.file} berisi ${item.endpointCount || 0} endpoint.`,
      createdAt: item.createdAt || item.updatedAt || now
    });
  }

  const priority = { critical: 0, warn: 1, ok: 2 };
  notifications.sort((a, b) => {
    const toneDiff = priority[a.tone] - priority[b.tone];
    if (toneDiff) return toneDiff;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });

  return {
    generatedAt: now,
    total: notifications.length,
    critical: notifications.filter((item) => item.tone === "critical").length,
    warning: notifications.filter((item) => item.tone === "warn").length,
    ok: notifications.filter((item) => item.tone === "ok").length,
    notifications: notifications.slice(0, 40)
  };
}

async function runPlatformPlayabilityCheck() {
  const startedAt = new Date().toISOString();
  const sources = loadPrivateSources().filter((source) => source.status === "active" && source.endpoints.length);
  const results = await mapWithConcurrency(sources, 4, (source) => checkPlatformPlayability(source));
  const checkedAt = new Date().toISOString();
  savePlatformPlayabilityState(results, checkedAt);

  return {
    ok: true,
    startedAt,
    checkedAt,
    total: results.length,
    playable: results.filter((item) => item.status === "playable").length,
    results
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      output[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return output;
}

async function checkPlatformPlayability(source) {
  const baseResult = {
    platform: source.platform,
    slug: source.slug,
    status: "error",
    message: "",
    sampleTitle: "",
    sampleId: "",
    episodeNumber: null,
    videoType: "",
    httpStatus: 0,
    contentType: ""
  };

  try {
    const catalogIndex = selectCatalogEndpointIndexForSource(source);
    if (catalogIndex <= 0) {
      return { ...baseResult, status: "no_catalog", message: "Endpoint katalog tidak ditemukan." };
    }

    const catalogPayload = await fetchPlatformJson(source, catalogIndex, new URLSearchParams());
    const catalogItems = parsePlatformCatalogResponse(source, catalogPayload).filter((item) => item.drama_id);
    const sample = catalogItems.find((item) => Number(item.episodes) > 0) || catalogItems[0];
    if (!sample) {
      return { ...baseResult, status: "no_catalog_item", message: "Katalog tidak mengembalikan judul sample." };
    }

    const episodeConfig = platformEpisodeConfig[source.slug] || inferEpisodeConfig(source);
    if (!episodeConfig?.episodesEndpoint || !episodeConfig.idParam) {
      return { ...baseResult, status: "no_episode_config", sampleTitle: sample.title, sampleId: sample.drama_id, message: "Endpoint episode belum bisa dipetakan." };
    }

    const episodeParams = new URLSearchParams();
    episodeParams.set(episodeConfig.idParam, sample.drama_id);
    const episodePayload = await fetchPlatformJson(source, episodeConfig.episodesEndpoint, episodeParams);
    const episodeObjects = collectCatalogObjects(episodePayload);
    let video = findPlayableVideoCandidate(episodeObjects, episodeConfig);

    if (!video.url && episodeConfig.streamEndpoint) {
      const streamVideo = await findStreamVideoCandidate(source, episodeConfig, sample, episodeObjects);
      if (streamVideo.url) {
        video = streamVideo;
      }
    }

    if (!video.url) {
      return {
        ...baseResult,
        status: "no_video_url",
        sampleTitle: sample.title,
        sampleId: sample.drama_id,
        episodeNumber: video.episodeNumber,
        message: "Episode ditemukan, tapi URL video/playlist tidak ditemukan."
      };
    }

    const probe = await probePlayableVideo(video.url, video.baseUrl);
    return {
      ...baseResult,
      status: probe.playable ? "playable" : "not_playable",
      message: probe.message,
      sampleTitle: sample.title,
      sampleId: sample.drama_id,
      episodeNumber: video.episodeNumber,
      videoType: probe.videoType,
      httpStatus: probe.httpStatus,
      contentType: probe.contentType
    };
  } catch (error) {
    return { ...baseResult, message: error.message || "Pemeriksaan gagal." };
  }
}

async function fetchPlatformJson(source, endpointIndex, searchParams) {
  const endpoint = source.endpoints[endpointIndex - 1];
  if (!endpoint) {
    throw new Error(`Endpoint ${endpointIndex} tidak ditemukan.`);
  }

  const target = buildEndpointUrl(source, endpoint, `/endpoint/${endpointIndex}`, searchParams);
  if (!target) {
    throw new Error("URL endpoint tidak valid.");
  }

  const response = await fetch(target, {
    headers: {
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "TEAMDL-Platform-Playability/1.0",
      "Referer": `${target.protocol}//${target.host}/`,
      "Origin": `${target.protocol}//${target.host}`
    },
    redirect: "follow",
    signal: AbortSignal.timeout(platformFetchTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`API status ${response.status}.`);
  }

  return response.json();
}

function findPlayableVideoCandidate(objects, config) {
  const keys = [...new Set([
    config.episodeField,
    config.streamEpisodeField,
    "videoUrl",
    "video_url",
    "mediaUrl",
    "media_url",
    "stream_url",
    "playUrl",
    "play_url",
    "url",
    "cdn_url",
    "m3u8_path",
    "m3u8_url",
    "m3u8",
    "mp4",
    "videoAddress",
    "external_audio_h264_m3u8",
    "external_audio_h265_m3u8"
  ].filter(Boolean))];

  for (const item of objects) {
    const direct = getObjectTextValue(item, keys);
    const nested = findNestedVideoUrl(item);
    const url = direct || nested;
    if (url && looksLikeVideoUrl(url)) {
      return {
        url,
        baseUrl: getObjectTextValue(item, ["baseUrl", "host", "domain"]),
        episodeNumber: Number(getObjectTextValue(item, ["episode", "episodeNum", "chapterNo", "chapterIndex", "index", "ep"]) || 1)
      };
    }
  }

  return { url: "", baseUrl: "", episodeNumber: null };
}

async function findStreamVideoCandidate(source, config, sample, episodeObjects) {
  const firstEpisode = episodeObjects.find((item) => item && typeof item === "object") || {};
  const episodeValue = streamEpisodeValue(firstEpisode, config);
  const streamParams = new URLSearchParams();
  streamParams.set(config.streamIdParam || config.idParam, sample.drama_id);
  streamParams.set(config.streamEpisodeParam || "ep", episodeValue);

  const payload = await fetchPlatformJson(source, config.streamEndpoint, streamParams);
  const candidate = findPlayableVideoCandidate(collectCatalogObjects(payload), config);
  return { ...candidate, episodeNumber: Number(episodeValue) || candidate.episodeNumber || 1 };
}

function streamEpisodeValue(item, config) {
  if (config.streamEpisodeMode === "sourceId") {
    return getObjectTextValue(item, ["chapterId", "chapter_id", "episodeId", "episode_id", "id", "sourceId"]) || "1";
  }
  return getObjectTextValue(item, [config.streamEpisodeParam || "ep", "episode", "episodeNum", "chapterNo", "chapterIndex", "index"]) || "1";
}

function findNestedVideoUrl(value) {
  if (!value || typeof value !== "object") {
    return "";
  }

  if (Array.isArray(value.videoUrls)) {
    const preferred = value.videoUrls.find((item) => /hd|720|1080/i.test(`${item.quality || ""} ${item.name || ""}`)) || value.videoUrls[0];
    const nested = getObjectTextValue(preferred || {}, ["url", "videoUrl", "video_url", "cdn_url", "stream_url", "playUrl", "play_url", "m3u8_url", "m3u8", "mp4"]);
    if (nested) {
      return nested;
    }
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const nested = findNestedVideoUrl(child);
      if (nested) {
        return nested;
      }
    }
  }

  return "";
}

function looksLikeVideoUrl(value) {
  return /^(https?:)?\/\//i.test(value) || /^\/[^/]/.test(value) || /\.(m3u8|mp4|webm|mov)(?:$|[?&#])/i.test(value);
}

async function probePlayableVideo(rawUrl, baseUrl = "") {
  const target = normalizeProbeUrl(rawUrl, baseUrl);
  if (!target) {
    return { playable: false, message: "URL video tidak valid.", videoType: "", httpStatus: 0, contentType: "" };
  }

  const response = await fetch(target, {
    headers: {
      "Accept": "*/*",
      "Range": "bytes=0-1",
      "User-Agent": "TEAMDL-Video-Probe/1.0",
      "Referer": `${target.protocol}//${target.host}/`,
      "Origin": `${target.protocol}//${target.host}`
    },
    redirect: "follow",
    signal: AbortSignal.timeout(platformFetchTimeoutMs)
  });

  const contentTypeHeader = response.headers.get("content-type") || contentType(target.pathname);
  const statusOk = response.ok || response.status === 206;
  if (isPlaylistResponse(contentTypeHeader, target)) {
    const text = await response.text();
    const segmentProbe = statusOk && /#EXTM3U/i.test(text) ? await probeHlsSegment(text, target) : null;
    const playable = Boolean(segmentProbe?.playable);
    return {
      playable,
      message: playable ? "Playlist HLS dan segment video pertama bisa diakses." : (segmentProbe?.message || "Playlist HLS tidak valid atau kosong."),
      videoType: "hls",
      httpStatus: segmentProbe?.httpStatus || response.status,
      contentType: segmentProbe?.contentType || contentTypeHeader
    };
  }

  const playable = statusOk && (/^video\//i.test(contentTypeHeader) || /octet-stream/i.test(contentTypeHeader) || Number(response.headers.get("content-length") || 0) > 0);
  return {
    playable,
    message: playable ? "File video merespons request byte range." : `Video tidak playable, status ${response.status}.`,
    videoType: "file",
    httpStatus: response.status,
    contentType: contentTypeHeader
  };
}

async function probeHlsSegment(playlistText, playlistUrl, depth = 0) {
  const urls = playlistText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (!urls.length) {
    return { playable: false, message: "Playlist HLS tidak berisi URL segment/variant.", httpStatus: 0, contentType: "" };
  }

  const firstUrl = new URL(urls[0], playlistUrl);
  const response = await fetch(firstUrl, {
    headers: {
      "Accept": "*/*",
      "Range": "bytes=0-1",
      "User-Agent": "TEAMDL-HLS-Segment-Probe/1.0",
      "Referer": `${playlistUrl.protocol}//${playlistUrl.host}/`,
      "Origin": `${playlistUrl.protocol}//${playlistUrl.host}`
    },
    redirect: "follow",
    signal: AbortSignal.timeout(platformFetchTimeoutMs)
  });
  const contentTypeHeader = response.headers.get("content-type") || contentType(firstUrl.pathname);

  if (isPlaylistResponse(contentTypeHeader, firstUrl) && depth < 2) {
    return probeHlsSegment(await response.text(), firstUrl, depth + 1);
  }

  const playable = (response.ok || response.status === 206)
    && (/^video\//i.test(contentTypeHeader) || /octet-stream|mp2t|mpegurl/i.test(contentTypeHeader) || /\.(ts|m4s|mp4)(?:$|[?&#])/i.test(firstUrl.pathname));

  return {
    playable,
    message: playable ? "Segment HLS pertama bisa diakses." : `Segment HLS gagal diakses, status ${response.status}.`,
    httpStatus: response.status,
    contentType: contentTypeHeader
  };
}

function normalizeProbeUrl(value, baseUrl = "") {
  try {
    if (/^\/\//.test(value)) {
      return new URL(`https:${value}`);
    }
    if (/^https?:\/\//i.test(value)) {
      return new URL(value);
    }
    if (baseUrl && /^https?:\/\//i.test(baseUrl)) {
      return new URL(value, baseUrl);
    }
  } catch {
    return null;
  }
  return null;
}

async function uploadSourceFile(request, response) {
  try {
    const body = await readJsonBody(request);
    const type = String(body.type || "").toLowerCase();
    const platform = String(body.platform || "").trim();
    const content = String(body.content || "");
    const originalName = String(body.filename || "").trim();

    if (!["txt", "json"].includes(type)) {
      return sendJson(response, { error: "Tipe source harus txt atau json." }, 400);
    }

    if (!platform && !originalName) {
      return sendJson(response, { error: "Nama platform atau nama file wajib diisi." }, 400);
    }

    if (!content.trim()) {
      return sendJson(response, { error: "Isi file source kosong." }, 400);
    }

    if (type === "json") {
      JSON.parse(content);
    }

    const sourcesDir = path.join(rootDir, "storage", "sources");
    fs.mkdirSync(sourcesDir, { recursive: true });

    const baseName = safeSourceBaseName(platform || path.basename(originalName, path.extname(originalName)));
    const fileName = `${baseName}_endpoints.${type}`;
    const filePath = path.join(sourcesDir, fileName);
    const normalizedPath = path.normalize(filePath);

    if (!normalizedPath.startsWith(sourcesDir)) {
      return sendJson(response, { error: "Nama file source tidak valid." }, 400);
    }

    fs.writeFileSync(normalizedPath, content, "utf8");
    recordSourceUpload(fileName, baseName, type);
    sendJson(response, {
      ok: true,
      file: fileName,
      path: `storage/sources/${fileName}`,
      files: listSourceFiles()
    });
  } catch (error) {
    sendJson(response, { error: "Source gagal disimpan.", detail: error.message }, 400);
  }
}

function recordSourceUpload(fileName, platform, type) {
  const state = loadSourceState();
  const sources = loadPublicSources();
  const slugValue = slug(platform);
  const source = sources.find((item) => item.sourceFile === fileName || item.slug === slugValue);
  const upload = {
    file: fileName,
    platform,
    slug: slugValue,
    type,
    status: source?.computedStatus === "active" ? "active" : "pending",
    endpointCount: source?.endpoints.length || 0,
    createdAt: new Date().toISOString()
  };

  state.uploads = [upload, ...state.uploads.filter((item) => item.file !== fileName)].slice(0, 80);
  if (source?.computedStatus === "active" && !state.platforms[source.slug]) {
    state.platforms[source.slug] = {
      status: "active",
      updatedAt: new Date().toISOString()
    };
  }
  saveSourceState(state);
}

async function updateSourceStatus(request, response) {
  try {
    const body = await readJsonBody(request);
    const slugValue = slug(String(body.slug || body.platform || ""));
    const status = String(body.status || "").toLowerCase();

    if (!slugValue) {
      return sendJson(response, { error: "Slug platform wajib diisi." }, 400);
    }

    if (!["active", "off", "maintenance"].includes(status)) {
      return sendJson(response, { error: "Status harus active, off, atau maintenance." }, 400);
    }

    const sources = loadPlatformSources(rootDir);
    const source = sources.find((item) => item.slug === slugValue);
    if (!source) {
      return sendJson(response, { error: "Platform source tidak ditemukan." }, 404);
    }

    const state = loadSourceState();
    state.platforms[slugValue] = {
      status,
      updatedAt: new Date().toISOString()
    };
    saveSourceState(state);

    sendJson(response, {
      ok: true,
      source: loadPublicSources().find((item) => item.slug === slugValue),
      history: sourceHistory()
    });
  } catch (error) {
    sendJson(response, { error: "Status source gagal disimpan.", detail: error.message }, 400);
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error("Ukuran file maksimal 5MB."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Body JSON tidak valid."));
      }
    });
    request.on("error", reject);
  });
}

function safeSourceBaseName(value) {
  const cleaned = value
    .replace(/\.[^.]+$/g, "")
    .replace(/_endpoints$/i, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return cleaned || "source";
}

let cachedDetectedDramas = null;
let lastCacheTime = 0;

function getDetectedDramas() {
  const now = Date.now();
  if (!cachedDetectedDramas || now - lastCacheTime > 30000) {
    try {
      cachedDetectedDramas = loadDetectedDramas(rootDir);
      lastCacheTime = now;
    } catch (err) {
      console.error("[Cache] Failed to load detected dramas:", err);
      if (!cachedDetectedDramas) {
        cachedDetectedDramas = [];
      }
    }
  }
  return cachedDetectedDramas;
}

async function handlePlatformApi(request, response, url, alias = null) {
  const match = alias ? null : url.pathname.match(/^\/api\/platform\/([^/]+)(?:\/(.*))?$/);
  const platformSlug = alias?.platformSlug || match?.[1];
  const routePath = alias ? `/endpoint/${alias.endpointIndex}` : `/${match?.[2] || ""}`.replace(/\/$/, "");
  const source = loadPrivateSources().find((item) => item.slug === platformSlug);

  if (!source) {
    return sendJson(response, { error: "Platform source tidak ditemukan." }, 404);
  }

  const auth = security.requireSession(request, response, { signed: true });
  if (!auth) {
    return;
  }

  if (!alias && !match?.[2] && !url.searchParams.get("endpoint")) {
    if (!checkAdminAuth(request)) {
      return security.forbidden(response, "PLATFORM_SUMMARY_ADMIN_ONLY");
    }
    return sendJson(response, platformSummary(source));
  }

  if (source.status !== "active") {
    return sendJson(response, {
      error: `Platform ${source.platform} sedang ${source.status}.`,
      status: source.status,
      platform: source.platform
    }, 503);
  }

  // 0.5 Auto-correct Case-Insensitive ID parameter from detected dramas database
  const idParamsToCorrect = ["bookId", "id", "seriesId", "dramaId", "drama_id", "videoid", "cid"];
  for (const param of idParamsToCorrect) {
    const val = url.searchParams.get(param);
    if (val) {
      const realDrama = getDetectedDramas().find((d) => {
        const dbId = String(d.drama_id);
        const dbSlug = String(d.slug || "");
        
        // Match exact or case-insensitive
        if (dbId === val || dbSlug === val) return true;
        if (dbId.toLowerCase() === val.toLowerCase() || dbSlug.toLowerCase() === val.toLowerCase()) return true;
        
        // Match without prefix (e.g. freereels-ibu-tiri... vs ibu-tiri...)
        const dbIdWithoutPrefix = dbId.replace(/^[a-z0-9]+-/i, "");
        const valWithoutPrefix = val.replace(/^[a-z0-9]+-/i, "");
        if (dbIdWithoutPrefix.toLowerCase() === valWithoutPrefix.toLowerCase()) return true;
        
        return false;
      });

      if (realDrama) {
        const dbId = String(realDrama.drama_id);
        if (dbId !== val) {
          console.log(`[Auto-Correct ID] Correcting param '${param}': '${val}' -> '${dbId}' for platform '${platformSlug}'`);
          url.searchParams.set(param, dbId);
        }
        break; // stop loop after first correction
      }
    }
  }

  // 1. Auto-resolve Vigloo seasonId if missing
  if (platformSlug === "vigloo" && (routePath === "/endpoint/6" || routePath.includes("/episodes")) && !url.searchParams.get("seasonId")) {
    const dramaId = url.searchParams.get("id");
    if (dramaId) {
      console.log(`[Vigloo Proxy] Fetching seasonId dynamically for drama: ${dramaId}`);
      try {
        const detailIndex = source.endpoints.findIndex((ep) => /\/(?:detail|drama|short|show)\/:[^/]+$/i.test(ep.path));
        const detailEndpoint = detailIndex >= 0 ? source.endpoints[detailIndex] : null;
        if (detailEndpoint) {
          const detailParams = new URLSearchParams();
          detailParams.set("id", dramaId);
          const detailTarget = buildEndpointUrl(source, detailEndpoint, "/endpoint/5", detailParams);
          if (detailTarget) {
            const detailRes = await fetch(detailTarget, {
              headers: apiRequestHeaders(request, detailTarget),
              redirect: "follow",
              signal: AbortSignal.timeout(platformFetchTimeoutMs)
            });
            if (detailRes.ok) {
              const detailJson = await detailRes.json();
              const season = detailJson?.data?.payload?.seasons?.[0];
              if (season && season.id) {
                console.log(`[Vigloo Proxy] Successfully resolved seasonId: ${season.id}`);
                url.searchParams.set("seasonId", String(season.id));
              }
            }
          }
        }
      } catch (err) {
        console.warn("[Vigloo Proxy] Failed to fetch seasonId dynamically:", err.message);
      }
      // Fallback: if seasonId still not resolved, use dramaId as seasonId
      // (Vigloo often uses the same ID for drama and its default season)
      if (!url.searchParams.get("seasonId")) {
        console.log(`[Vigloo Proxy] Using dramaId as fallback seasonId: ${dramaId}`);
        url.searchParams.set("seasonId", dramaId);
      }
    }
  }

  // 1.5 Auto-resolve FunDrama 13-digit coper ID to 19-digit dshame ID
  if (platformSlug === "fundrama") {
    const idParamVal = url.searchParams.get("id") || url.searchParams.get("dramaId");
    if (idParamVal && idParamVal.length === 13 && /^\d+$/.test(idParamVal)) {
      console.log(`[FunDrama Proxy] Detected 13-digit coper ID: ${idParamVal}. Resolving to dshame...`);
      try {
        const dramasCatalogEndpoint = source.endpoints[1];
        if (dramasCatalogEndpoint) {
          const catalogParams = new URLSearchParams();
          catalogParams.set("lang", "id");
          catalogParams.set("page", "1");
          catalogParams.set("limit", "100");
          const catalogTarget = buildEndpointUrl(source, dramasCatalogEndpoint, "/endpoint/2", catalogParams);
          if (catalogTarget) {
            const catRes = await fetch(catalogTarget, {
              headers: apiRequestHeaders(request, catalogTarget),
              redirect: "follow",
              signal: AbortSignal.timeout(platformFetchTimeoutMs)
            });
            if (catRes.ok) {
              const catJson = await catRes.json();
              const list = catJson?.data?.ddriv?.lsumm || [];
              const found = list.find(item => String(item.coper) === idParamVal);
              if (found && found.dshame) {
                console.log(`[FunDrama Proxy] Successfully resolved coper ${idParamVal} to dshame ${found.dshame}`);
                url.searchParams.set("id", String(found.dshame));
                if (url.searchParams.has("dramaId")) {
                  url.searchParams.set("dramaId", String(found.dshame));
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn("[FunDrama Proxy] Failed to resolve coper to dshame dynamically:", err.message);
      }
    }
  }


  // 2. Intercept mock/fallback drama requests
  const idParams = ["bookId", "id", "seriesId", "dramaId", "videoid", "cid"];
  let fallbackIdParam = null;
  let fallbackIdValue = null;

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

  for (const param of idParams) {
    const val = url.searchParams.get(param);
    if (val) {
      const isRealDrama = getDetectedDramas().some((d) => String(d.drama_id) === val || d.slug === val);
      const isFallback = !isRealDrama && (staticFallbackSlugs.has(val) || val.startsWith(`${platformSlug}-`));
      if (isFallback) {
        fallbackIdParam = param;
        fallbackIdValue = val;
        break;
      }
    }
  }

  if (fallbackIdValue) {
    console.log(`[handlePlatformApi] Intercepted mock/fallback request: ${fallbackIdParam}=${fallbackIdValue}`);
    const episodesList = [];
    const totalEpisodes = 40;
    for (let i = 1; i <= totalEpisodes; i++) {
      episodesList.push({
        episodeNumber: i,
        title: `Episode ${i}`,
        videoUrl: i % 2 === 0 
          ? "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
          : `https://${source.slug}.dramabos.online/video/fallback/${fallbackIdValue}/episode_${i}.m3u8`,
        locked: i > 12
      });
    }

    const payload = {
      total_episodes: totalEpisodes,
      totalEpisodes: totalEpisodes,
      data: {
        list: episodesList,
        episodes: episodesList
      }
    };

    const securedPayload = security.rewriteMediaUrls(payload, request, auth, "");
    return sendJson(response, securedPayload, 200);
  }

  const endpoint = findPlatformEndpoint(source, routePath, url.searchParams);
  if (!endpoint) {
    return sendJson(response, {
      error: "Endpoint platform tidak ditemukan."
    }, 404);
  }

  const target = buildEndpointUrl(source, endpoint, routePath, url.searchParams);
  if (!target) {
    return sendJson(response, { error: "URL upstream endpoint tidak valid." }, 400);
  }

  console.log(`[Upstream Fetch] Target: ${target.toString()}`);
  try {
    const upstream = await fetch(target, {
      headers: apiRequestHeaders(request, target),
      redirect: "follow",
      signal: AbortSignal.timeout(platformFetchTimeoutMs)
    });
    const contentTypeHeader = upstream.headers.get("content-type") || contentType(target.pathname);

    if (contentTypeHeader.includes("application/json") || contentTypeHeader.includes("+json")) {
      const payload = await upstream.json();
      const isCatalogEndpoint = /\/(home(?:page)?|list|dubbed|foryou|latest|recommend|hot|module|category|anime|search|series)(?:$|\?)/i.test(endpoint.path);
      if (isCatalogEndpoint) {
        return sendJson(response, payload, upstream.status);
      }
      const securedPayload = security.rewriteMediaUrls(payload, request, auth, "");
      return sendJson(response, securedPayload, upstream.status);
    }

    if (isPlaylistResponse(contentTypeHeader, target) || (isTextResponse(contentTypeHeader) && !isMediaPath(target.pathname))) {
      if (!auth.session.vip.active) {
        security.forbidden(response, "VIP_REQUIRED");
        return;
      }
      const text = await upstream.text();
      response.writeHead(upstream.status, {
        "Access-Control-Allow-Origin": sameOrigin(request),
        "Content-Type": contentTypeHeader
      });
      response.end(security.rewritePlaylist(text, target, request, auth));
      return;
    }

    if (!auth.session.vip.active) {
      security.forbidden(response, "VIP_REQUIRED");
      return;
    }
    response.writeHead(upstream.status, proxyResponseHeaders(upstream, target, request));
    if (!upstream.body) {
      response.end();
      return;
    }
    pipeUpstreamBody(upstream.body, response);
  } catch (error) {
    console.error(`[Upstream Fetch Error] Target: ${target.toString()}`, error);
    sendJson(response, { error: "Endpoint platform gagal dimuat." }, 502);
  }
}

function platformSummary(source) {
  return {
    platform: source.platform,
    slug: source.slug,
    status: source.status,
    endpoints: source.endpoints.map((endpoint, index) => ({
      index: index + 1,
      method: endpoint.method,
      path: endpoint.path,
      description: endpoint.description,
      proxyPath: `/api/platform/${source.slug}/endpoint/${index + 1}`,
      routePath: `/api/platform/${source.slug}${endpoint.path.replace(/:[^/]+/g, (param) => {
        const name = param.slice(1);
        return endpoint.params.find((item) => item.name === name || item.name.endsWith(`_${name}`))?.defaultValue || param;
      })}`
    }))
  };
}

function findPlatformEndpoint(source, routePath, searchParams) {
  const endpointParam = searchParams.get("endpoint");
  if (endpointParam) {
    const index = Number(endpointParam);
    if (Number.isInteger(index) && source.endpoints[index - 1]) {
      return source.endpoints[index - 1];
    }

    return source.endpoints.find((endpoint) => endpoint.path === endpointParam || endpoint.path.replace(/^\//, "") === endpointParam.replace(/^\//, ""));
  }

  const endpointMatch = routePath.match(/^\/endpoint\/(\d+)$/);
  if (endpointMatch) {
    return source.endpoints[Number(endpointMatch[1]) - 1];
  }

  return source.endpoints.find((endpoint) => matchEndpointPath(endpoint.path, routePath));
}

function buildEndpointUrl(source, endpoint, routePath, searchParams) {
  const rawTarget = endpoint.exampleUrl || endpoint.fullUrl;
  const target = parseEndpointTarget(rawTarget, source) || parseEndpointTarget(endpoint.fullUrl, source);
  if (!target) {
    return null;
  }

  const pathValues = routePath.startsWith("/endpoint/") ? {} : endpointPathValues(endpoint.path, routePath);
  for (const [name, value] of Object.entries(pathValues)) {
    target.pathname = target.pathname.replace(new RegExp(`/${escapeRegExp(endpointDefaultValue(endpoint, name))}(?=/|$)`), `/${encodeURIComponent(value)}`);
  }

  for (const name of endpointPathParamNames(endpoint.path)) {
    const value = searchParamAlias(searchParams, name);
    if (value) {
      const defaultValue = endpointDefaultValue(endpoint, name);
      target.pathname = target.pathname.replace(`:${name}`, encodeURIComponent(value));
      if (defaultValue) {
        target.pathname = target.pathname.replace(new RegExp(`/${escapeRegExp(defaultValue)}(?=/|$)`), `/${encodeURIComponent(value)}`);
      }
    }
  }

  for (const [key, value] of searchParams.entries()) {
    if (key === "endpoint" || /^url[_-]?\d*$/i.test(key)) {
      continue;
    }
    target.searchParams.set(normalizeParamName(key), value);
  }

  applyEndpointDefaults(endpoint, target);

  applyServerToken(source, target, endpoint);
  return target;
}

function parseEndpointTarget(value, source) {
  const publicUrl = parsePublicMediaUrl(value);
  if (publicUrl) {
    return publicUrl;
  }

  if (value?.startsWith("/")) {
    return new URL(value, `https://${source.slug}.dramabos.online`);
  }

  return null;
}

function endpointPathParamNames(pattern) {
  return [...pattern.matchAll(/:([^/]+)/g)].map((match) => match[1]);
}

function searchParamAlias(searchParams, name) {
  const normalizedName = normalizeParamName(name).toLowerCase();
  for (const [key, value] of searchParams.entries()) {
    if (normalizeParamName(key).toLowerCase() === normalizedName && value) {
      return value;
    }
  }

  return "";
}

function applyEndpointDefaults(endpoint, target) {
  let resolvedId = "";
  const idKeys = ["id", "dramaId", "drama_id", "seriesId", "bookId", "videoid", "cid"];
  for (const key of idKeys) {
    if (target.searchParams.has(key)) {
      resolvedId = target.searchParams.get(key);
      break;
    }
  }
  
  if (!resolvedId) {
    const lastSegment = target.pathname.split("/").pop();
    if (lastSegment && lastSegment !== ":id" && lastSegment !== "drama") {
      resolvedId = decodeURIComponent(lastSegment);
    }
  }

  for (const param of endpoint.params) {
    const name = normalizeParamName(param.name);
    if (!name || /^url[_-]?\d*$/i.test(name) || target.searchParams.has(name)) {
      continue;
    }

    if (endpointPathParamNames(endpoint.path).includes(name)) {
      continue;
    }

    let value = param.defaultValue;
    if (resolvedId && idKeys.includes(name)) {
      value = resolvedId;
    }

    if (value || /^(lang|page|count|size|scene|next|channel|quality|q|keyword)$/i.test(name)) {
      target.searchParams.set(name, value);
    }
  }
}

function normalizeParamName(name) {
  return String(name || "")
    .replace(/^p[-_]\d+[-_]/i, "")
    .trim();
}

function matchEndpointPath(pattern, routePath) {
  const route = routePath || "/";
  const regex = new RegExp(`^${pattern.replace(/\/:[^/]+/g, "/[^/]+")}$`);
  return regex.test(route);
}

function endpointPathValues(pattern, routePath) {
  const names = [...pattern.matchAll(/:([^/]+)/g)].map((match) => match[1]);
  if (!names.length || !matchEndpointPath(pattern, routePath)) {
    return {};
  }

  const values = routePath.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  return Object.fromEntries(patternParts
    .map((part, index) => part.startsWith(":") ? [part.slice(1), values[index]] : null)
    .filter(Boolean));
}

function endpointDefaultValue(endpoint, name) {
  return endpoint.params.find((param) => param.name === name || param.name.endsWith(`_${name}`))?.defaultValue || "";
}

function applyServerToken(source, target, endpoint = null) {
  for (const key of ["code", "token", "key", "api_key", "apikey", "secret"]) {
    const normalizedSlug = source.slug.replace(/-/g, "_").toUpperCase();
    const envKey = key.toUpperCase();
    const value = envValue(`${normalizedSlug}_${envKey}`)
      || envValue(`PLATFORM_${envKey}`)
      || envValue(`${normalizedSlug}_TOKEN`)
      || envValue("PLATFORM_TOKEN")
      || envValue(`SOURCE_${envKey}`)
      || sharedPlatformToken;

    const endpointNeedsKey = endpoint?.params?.some((param) => normalizeParamName(param.name).toLowerCase() === key)
      || new RegExp(`[?&]${key}=`, "i").test(endpoint?.exampleUrl || "")
      || new RegExp(`(?:^|\\s)${key}:`, "i").test(endpoint?.description || "");

    if (value && (target.searchParams.has(key) || endpointNeedsKey || key === "code")) {
      target.searchParams.set(key, value);
    }
  }
}

function apiRequestHeaders(request, target) {
  return {
    "Accept": request.headers.accept || "application/json, text/plain, */*",
    "User-Agent": request.headers["user-agent"] || "TEAMDL-Platform-API/1.0",
    "Referer": `${target.protocol}//${target.host}/`,
    "Origin": `${target.protocol}//${target.host}`
  };
}

function isMediaUrl(value) {
  try {
    const mediaUrl = new URL(value);
    return ["http:", "https:"].includes(mediaUrl.protocol) && isMediaPath(`${mediaUrl.pathname}${mediaUrl.search}`);
  } catch {
    return false;
  }
}

function isMediaPath(value) {
  return /\.(avif|gif|ico|jpe?g|m3u8|mov|mp4|ogg|png|srt|ts|vtt|webm|webp)(?:$|[?@&#/])/i.test(value)
    || /[?&]format=(srt|vtt)(?:$|[&])/i.test(value);
}

function isMediaFieldUrl(key, value) {
  if (!key || !/^(https?:)?\/\//i.test(value)) {
    return false;
  }

  return /(avatar|banner|best|cdn|cover|hls|image|m3u8|media|mp4|photo|play|poster|src|thumb|video)/i.test(key);
}

function isTextResponse(value) {
  return value.startsWith("text/") || value.includes("mpegurl") || value.includes("application/vnd.apple.mpegurl");
}

function isPlaylistResponse(contentTypeHeader, mediaUrl) {
  return contentTypeHeader.includes("mpegurl") || /\.m3u8(?:$|[?&#])/i.test(mediaUrl.pathname);
}

async function proxyMedia(request, response, rawUrl, auth) {
  let targetUrl = rawUrl;
  if (rawUrl && rawUrl.includes("/video/fallback/")) {
    if (rawUrl.includes("goodshort.dramabos.online")) {
      targetUrl = "https://acfs1.goodreels.com/ets/books/586/31001100586/532802/feq9iqyyoh/720p/bv7lect8tt_720p.m3u8";
    } else {
      targetUrl = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
    }
  }
  const mediaUrl = parsePublicMediaUrl(targetUrl);

  if (!mediaUrl) {
    if (auth) {
      security.logStreamPlay({
        userId: auth.session.userId,
        ipAddress: auth.context.ipAddress,
        userAgent: auth.context.userAgent,
        deviceId: auth.session.deviceId,
        episodeId: auth.mediaPayload?.episodeId,
        episodeName: auth.mediaPayload?.episodeName,
        dramaTitle: auth.mediaPayload?.dramaTitle,
        url: rawUrl,
        status: "Error",
        details: "Parameter URL media tidak valid"
      });
    }
    return sendJson(response, { error: "Parameter url media tidak valid." }, 400);
  }

  try {
    const upstream = await fetch(mediaUrl, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: proxyRequestHeaders(request, mediaUrl),
      redirect: "follow"
    });

    const contentTypeHeader = upstream.headers.get("content-type") || contentType(mediaUrl.pathname);

    if (isPlaylistResponse(contentTypeHeader, mediaUrl)) {
      response.writeHead(upstream.status, {
        "Access-Control-Allow-Origin": sameOrigin(request),
        "Cache-Control": upstream.headers.get("cache-control") || "public, max-age=3600",
        "Content-Type": contentTypeHeader
      });
      response.end(security.rewritePlaylist(await upstream.text(), mediaUrl, request, auth));
      security.logStreamPlay({
        userId: auth.session.userId,
        ipAddress: auth.context.ipAddress,
        userAgent: auth.context.userAgent,
        deviceId: auth.session.deviceId,
        episodeId: auth.mediaPayload?.episodeId,
        episodeName: auth.mediaPayload?.episodeName,
        dramaTitle: auth.mediaPayload?.dramaTitle,
        url: rawUrl,
        status: "Success",
        details: `Streaming HLS (.m3u8) berhasil diputar (Status ${upstream.status})`
      });
      return;
    }

    response.writeHead(upstream.status, proxyResponseHeaders(upstream, mediaUrl, request));

    if (request.method === "HEAD" || !upstream.body) {
      security.logStreamPlay({
        userId: auth.session.userId,
        ipAddress: auth.context.ipAddress,
        userAgent: auth.context.userAgent,
        deviceId: auth.session.deviceId,
        episodeId: auth.mediaPayload?.episodeId,
        episodeName: auth.mediaPayload?.episodeName,
        dramaTitle: auth.mediaPayload?.dramaTitle,
        url: rawUrl,
        status: "Success",
        details: `Streaming HEAD request berhasil (Status ${upstream.status})`
      });
      response.end();
      return;
    }

    pipeUpstreamBody(upstream.body, response);
    security.logStreamPlay({
      userId: auth.session.userId,
      ipAddress: auth.context.ipAddress,
      userAgent: auth.context.userAgent,
      deviceId: auth.session.deviceId,
      episodeId: auth.mediaPayload?.episodeId,
      episodeName: auth.mediaPayload?.episodeName,
      dramaTitle: auth.mediaPayload?.dramaTitle,
      url: rawUrl,
      status: "Success",
      details: `Streaming media berhasil diputar (Status ${upstream.status})`
    });
  } catch (error) {
    security.logStreamPlay({
      userId: auth.session.userId,
      ipAddress: auth.context.ipAddress,
      userAgent: auth.context.userAgent,
      deviceId: auth.session.deviceId,
      episodeId: auth.mediaPayload?.episodeId,
      episodeName: auth.mediaPayload?.episodeName,
      dramaTitle: auth.mediaPayload?.dramaTitle,
      url: rawUrl,
      status: "Error",
      details: `Gagal memuat media upstream: ${error.message}`
    });
    sendJson(response, { error: "Media gagal dimuat.", detail: error.message }, 502);
  }
}

function pipeUpstreamBody(body, response) {
  const stream = Readable.fromWeb(body);
  stream.on("error", () => {
    if (!response.destroyed) {
      response.end();
    }
  });
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}

function transmuxMedia(request, response, rawUrl) {
  const mediaUrl = parsePublicMediaUrl(rawUrl);

  if (!mediaUrl) {
    return sendJson(response, { error: "Parameter url video tidak valid." }, 400);
  }

  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-headers", `Referer: ${mediaUrl.protocol}//${mediaUrl.host}/\r\nOrigin: ${mediaUrl.protocol}//${mediaUrl.host}\r\nUser-Agent: ${request.headers["user-agent"] || "TEAMDL-Media-Proxy/1.0"}\r\n`,
    "-i", mediaUrl.toString(),
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c", "copy",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  let started = false;

  ffmpeg.stdout.on("data", (chunk) => {
    if (!started) {
      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": "video/mp4"
      });
    }
    started = true;
    response.write(chunk);
  });

  ffmpeg.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  ffmpeg.on("close", (code) => {
    if (!started) {
      sendJson(response, { error: "Video gagal diproses.", detail: stderr.trim() || `ffmpeg exit ${code}` }, 502);
      return;
    }

    response.end();
  });

  request.on("close", () => {
    ffmpeg.kill("SIGKILL");
  });
}

function parsePublicMediaUrl(value) {
  if (!value) {
    return null;
  }

  try {
    const mediaUrl = new URL(value);
    if (mediaUrl.protocol !== "http:" && mediaUrl.protocol !== "https:") {
      return null;
    }

    if (isPrivateHost(mediaUrl.hostname)) {
      return null;
    }

    return mediaUrl;
  } catch {
    return null;
  }
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();

  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }

  if (/^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
    return true;
  }

  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }

  return false;
}

function proxyRequestHeaders(request, mediaUrl) {
  const headers = {
    "Accept": request.headers.accept || "*/*",
    "User-Agent": request.headers["user-agent"] || "TEAMDL-Media-Proxy/1.0",
    "Referer": `${mediaUrl.protocol}//${mediaUrl.host}/`,
    "Origin": `${mediaUrl.protocol}//${mediaUrl.host}`
  };

  if (request.headers.range) {
    headers.Range = request.headers.range;
  }

  return headers;
}

function proxyResponseHeaders(upstream, mediaUrl, request) {
  const upstreamContentType = upstream.headers.get("content-type") || "";
  const headers = {
    "Access-Control-Allow-Origin": sameOrigin(request),
    "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
    "Cache-Control": upstream.headers.get("cache-control") || "public, max-age=3600",
    "Content-Type": mediaContentType(mediaUrl, upstreamContentType)
  };

  for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) {
      headers[toHeaderCase(name)] = value;
    }
  }

  return headers;
}

function sameOrigin(request) {
  return request.headers.origin || `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}`;
}

function mediaContentType(mediaUrl, upstreamContentType) {
  const localType = contentType(mediaUrl.pathname);
  if (localType !== "application/octet-stream" && (!upstreamContentType || /^(text\/plain|application\/octet-stream)/i.test(upstreamContentType))) {
    return localType;
  }

  return upstreamContentType || localType;
}

function toHeaderCase(value) {
  return value.replace(/(^|-)([a-z])/g, (match) => match.toUpperCase());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function envValue(name) {
  return process.env[name] || env[name] || "";
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ogg": "video/ogg",
    ".mov": "video/quicktime",
    ".m3u8": "application/vnd.apple.mpegurl",
    ".ts": "video/mp2t",
    ".vtt": "text/vtt; charset=utf-8",
    ".srt": "application/x-subrip; charset=utf-8"
  };

  return types[ext] || "application/octet-stream";
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return Object.fromEntries(
    fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      })
  );
}

// --- TELEGRAM AUTO NOTIFICATION CENTER ENGINE ---

let isDetectingDramas = false;
let isProcessingQueue = false;
let isQueuePaused = false;
let lastDetectionTime = null;
let notificationSchedulerIntervalId = null;
let queueProcessorIntervalId = null;

function collectCatalogObjects(value, list = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectCatalogObjects(item, list));
    return list;
  }
  if (!value || typeof value !== "object") {
    return list;
  }
  list.push(value);
  Object.values(value).forEach((item) => collectCatalogObjects(item, list));
  return list;
}

function getObjectTextValue(item, keys) {
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

function parsePlatformCatalogResponse(platform, payload) {
  const objects = collectCatalogObjects(payload);
  const dramas = [];
  
  for (let index = 0; index < objects.length; index++) {
    const item = objects[index];
    const nestedInfo = item.redirectConfig?.videoInfo || item.videoInfo || item.program || item.drama || item.series || item.book || item.extra || {};
    
    const title = getObjectTextValue(item, ["bookName", "bookTitle", "book_title", "title", "name", "dramaName", "videoName", "albumName", "seriesName", "shortPlayName", "short_play_name", "displayName", "contentName", "content_name", "dramaTitle", "nseri", "nfreed", "spsy", "sgui", "label"])
      || getObjectTextValue(nestedInfo, ["bookName", "bookTitle", "book_title", "title", "name", "dramaName", "videoName", "albumName", "seriesName", "shortPlayName", "short_play_name", "displayName", "contentName", "content_name", "dramaTitle", "nseri", "nfreed", "spsy", "sgui", "label"]);
      
    if (!title) continue;
    
    const rawPoster = getObjectTextValue(item, ["cover", "image", "poster", "thumb", "thumbnail", "bookCover", "coverUrl", "imgUrl", "bannerImg", "bannerImgUrl", "cover_url", "cover_img", "compress_cover_url", "big_cover", "pic", "imageUrl", "posterUrl", "poster_url", "verticalCover", "coverImage", "posterImg", "posterImgUrl", "coverWap", "contentCoverUrl", "pday", "puse"])
      || getObjectTextValue(nestedInfo, ["cover", "image", "poster", "thumb", "thumbnail", "bookCover", "coverUrl", "imgUrl", "bannerImg", "bannerImgUrl", "cover_url", "cover_img", "compress_cover_url", "big_cover", "pic", "imageUrl", "posterUrl", "poster_url", "verticalCover", "coverImage", "posterImg", "posterImgUrl", "coverWap", "contentCoverUrl", "pday", "puse"]);
      
    const id = getObjectTextValue(item, ["bookId", "book_id", "id", "videoid", "videoId", "video_id", "dramaId", "drama_id", "drama_intid", "seasonId", "season_id", "programId", "program_id", "playlet_id", "collection_id", "seriesId", "cid", "action", "shortPlayId", "shortPlayLibraryId", "albumId", "contentId", "content_id", "groupId", "fid", "dcup", "dbunch", "eaccou", "ecar", "dshame", "coper"])
      || getObjectTextValue(item.redirectConfig || {}, ["id", "videoId", "video_id", "dramaId", "drama_id"])
      || getObjectTextValue(nestedInfo, ["bookId", "book_id", "id", "videoid", "videoId", "video_id", "dramaId", "drama_id", "drama_intid", "seasonId", "season_id", "programId", "program_id", "playlet_id", "collection_id", "seriesId", "cid", "shortPlayId", "shortPlayLibraryId", "albumId", "contentId", "content_id", "groupId", "fid", "dshame", "coper"])
      || `${slug(platform.platform)}-${slug(title)}-${index}`;
      
    const episodes = Number(getObjectTextValue(item, ["chapterCount", "chapterNum", "episodeCount", "episode_count", "episodes", "chapters", "totalEpisode", "totalEpisodes", "total_episodes", "episode_num", "episNum", "total_episode", "lastChapterId", "episode", "episodeNum", "ewood", "ecur"])
      || getObjectTextValue(nestedInfo, ["chapterCount", "episodeCount", "episode_count", "episodes", "chapters", "totalEpisode", "totalEpisodes", "total_episodes", "totalEpisodeNum", "episNum", "total_episode", "episode", "episodeNum", "ewood", "ecur"])) || 0;
      
    const description = getObjectTextValue(item, ["introduction", "intro", "introduce", "description", "summary", "desc", "synopsis", "dwill", "dtas"])
      || getObjectTextValue(nestedInfo, ["introduction", "intro", "introduce", "description", "summary", "desc", "synopsis", "dwill", "dtas"])
      || `${title} dari ${platform.platform}.`;
      
    const genre = getObjectTextValue(item, ["category", "genre", "tagName", "tags", "attention"]) || "Drama";
    const country = getObjectTextValue(item, ["country", "lang"]) || "Global";
    const rating = getObjectTextValue(item, ["score", "rating"]) || "4.8";

    dramas.push({
      id: `${slug(platform.platform)}-${slug(id)}`,
      drama_id: String(id),
      title,
      poster: rawPoster,
      description,
      episodes,
      genre,
      country,
      rating,
      platform: platform.platform,
      slug: slug(title)
    });
  }
  
  return dramas;
}

async function runNotificationDetectionCycle() {
  if (isDetectingDramas) return;
  const settings = loadSettings(rootDir);
  if (!settings.autoDetectDrama && !settings.autoDetectEpisode) return;

  isDetectingDramas = true;
  console.log("Memulai deteksi drama/episode baru otomatis...");
  try {
    const platforms = loadPrivateSources();
    const detectedDramas = loadDetectedDramas(rootDir);
    const queue = loadQueue(rootDir);
    const now = new Date().toISOString();
    
    let newDramasCount = 0;
    let newEpisodesCount = 0;

    for (const source of platforms) {
      if (source.status !== "active") continue;
      
      const catalogIdx = selectCatalogEndpointIndexForSource(source);
      if (catalogIdx <= 0) continue;
      
      const endpoint = findPlatformEndpoint(source, `/endpoint/${catalogIdx}`, new URLSearchParams());
      if (!endpoint) continue;
      
      const targetUrl = buildEndpointUrl(source, endpoint, `/endpoint/${catalogIdx}`, new URLSearchParams());
      if (!targetUrl) continue;
      
      try {
        const headers = {
          "Accept": "application/json, text/plain, */*",
          "User-Agent": "TEAMDL-Platform-API/1.0",
          "Referer": `${targetUrl.protocol}//${targetUrl.host}/`,
          "Origin": `${targetUrl.protocol}//${targetUrl.host}`
        };
        
        const response = await fetch(targetUrl.toString(), { headers, redirect: "follow" });
        if (!response.ok) continue;
        
        const payload = await response.json();
        const items = parsePlatformCatalogResponse(source, payload);
        
        for (const item of items) {
          if (!item.title || !item.poster || !item.poster.startsWith("http")) {
            continue;
          }
          
          const itemHash = crypto.createHash("md5").update(`${item.id}:${item.title}:${item.episodes}:${item.poster}`).digest("hex");
          let existingIdx = detectedDramas.findIndex(d => d.drama_id === item.drama_id && d.platform === item.platform);
          
          if (existingIdx === -1) {
            const newRecord = {
              id: detectedDramas.length ? Math.max(...detectedDramas.map(d => d.id)) + 1 : 1,
              drama_id: item.drama_id,
              title: item.title,
              slug: item.slug,
              platform: item.platform,
              last_episode: item.episodes,
              last_notification: "Drama Baru",
              hash: itemHash,
              created_at: now
            };
            detectedDramas.push(newRecord);
            newDramasCount++;
            
            if (settings.autoDetectDrama && settings.autoNotification) {
              const payload = {
                type: "Drama Baru",
                title: item.title,
                description: item.description,
                genre: item.genre,
                country: item.country,
                rating: item.rating,
                episode: item.episodes,
                poster: item.poster,
                platform: item.platform,
                slug: item.slug
              };
              
              queue.push({
                id: Date.now() + Math.floor(Math.random() * 1000),
                drama_id: item.drama_id,
                type: "Drama Baru",
                payload,
                status: "Pending",
                retry_count: 0,
                created_at: now
              });
            }
          } else {
            const existing = detectedDramas[existingIdx];
            if (item.episodes > existing.last_episode) {
              newEpisodesCount++;
              
              if (settings.autoDetectEpisode && settings.autoNotification) {
                const payload = {
                  type: "Episode Baru",
                  title: item.title,
                  episode: item.episodes,
                  poster: item.poster,
                  platform: item.platform,
                  slug: item.slug
                };
                
                queue.push({
                  id: Date.now() + Math.floor(Math.random() * 1000),
                  drama_id: item.drama_id,
                  type: "Episode Baru",
                  payload,
                  status: "Pending",
                  retry_count: 0,
                  created_at: now
                });
              }
              
              existing.last_episode = item.episodes;
              existing.last_notification = "Episode Baru";
              existing.hash = itemHash;
            }
          }
        }
      } catch (err) {
        console.error(`Gagal melakukan scrap platform ${source.platform}:`, err.message);
      }
    }
    
    saveDetectedDramas(rootDir, detectedDramas);
    saveQueue(rootDir, queue);
    lastDetectionTime = now;
    console.log(`Deteksi otomatis selesai. Ditemukan: ${newDramasCount} drama baru, ${newEpisodesCount} episode baru.`);
    
    runQueueProcessor();
  } catch (err) {
    console.error("Gagal melakukan deteksi drama/episode:", err.message);
  } finally {
    isDetectingDramas = false;
  }
}

async function runQueueProcessor() {
  if (isProcessingQueue || isQueuePaused) return;
  const settings = loadSettings(rootDir);
  if (!settings.queueSystem) return;
  
  isProcessingQueue = true;
  try {
    const queue = loadQueue(rootDir);
    const logs = loadLogs(rootDir);
    const targets = loadTargets(rootDir).filter(t => t.status === "Aktif");
    const now = new Date().toISOString();
    
    const pendingItems = queue.filter(item => {
      if (item.status === "Pending") return true;
      if (item.status === "Retry" && item.next_retry_at && item.next_retry_at <= Date.now()) return true;
      return false;
    });
    
    if (pendingItems.length === 0) {
      isProcessingQueue = false;
      return;
    }
    
    for (const item of pendingItems) {
      item.status = "Processing";
      saveQueue(rootDir, queue);
      
      let matchingTargets = [];
      if (settings.topicRouting) {
        matchingTargets = targets.filter(t => {
          if (item.type === "Drama Baru" && t.type === "Drama Baru") return true;
          if (item.type === "Episode Baru" && t.type === "Episode Baru") return true;
          if (t.type === "Semua Notifikasi") return true;
          return false;
        });
      } else {
        matchingTargets = targets;
      }
      
      if (matchingTargets.length === 0) {
        item.status = "Failed";
        item.response = "No matching active targets found.";
        saveQueue(rootDir, queue);
        continue;
      }
      
      let successCount = 0;
      let failureResponse = "";
      
      for (const target of matchingTargets) {
        try {
          let text = "";
          if (item.type === "Drama Baru") {
            text = `📢 <b>DRAMA BARU</b>\n\n🎬 <b>${escapeHtmlTelegram(item.payload.title)}</b>\n\n📝 ${escapeHtmlTelegram(item.payload.description || '-')}\n\n📂 Genre: ${escapeHtmlTelegram(item.payload.genre || '-')}\n🌍 Negara: ${escapeHtmlTelegram(item.payload.country || '-')}\n⭐ Rating: ${item.payload.rating || '4.8'}\n📺 Total Episode: ${item.payload.episode || 1}\n\n━━━━━━━━━━━━━━\n\nTonton sekarang melalui Telegram Mini App.`;
          } else if (item.type === "Episode Baru") {
            text = `📢 <b>EPISODE BARU</b>\n\n🎬 <b>${escapeHtmlTelegram(item.payload.title)}</b>\n🆕 Episode ${item.payload.episode}\n\n━━━━━━━━━━━━━━\n\nEpisode terbaru telah tersedia.`;
          } else {
            text = `📢 <b>PEMBERITAHUAN</b>\n\n🎬 <b>${escapeHtmlTelegram(item.payload.title)}</b>\n\n${escapeHtmlTelegram(item.payload.description || '')}`;
          }
          
          const reply_markup = {
            inline_keyboard: []
          };
          
          if (settings.miniAppButton && settings.miniAppUrl) {
            reply_markup.inline_keyboard.push([
              {
                text: "▶️ Tonton Sekarang",
                url: settings.miniAppUrl
              }
            ]);
          }
          
          const result = await callTelegramBotApi("sendPhoto", {
            chat_id: target.channel_id,
            message_thread_id: target.topic_id ? Number(target.topic_id) : undefined,
            photo: item.payload.poster,
            caption: text,
            parse_mode: "HTML",
            reply_markup
          });
          
          if (result && result.ok) {
            successCount++;
            logs.unshift({
              id: Date.now() + Math.floor(Math.random() * 1000),
              drama_id: item.drama_id,
              title: item.payload.title,
              type: item.type,
              channel_id: target.channel_id,
              topic_id: target.topic_id || "",
              status: "Berhasil",
              telegram_message_id: String(result.result?.message_id || ""),
              response: "Success",
              sent_at: now
            });
          } else {
            throw new Error(result?.description || "Gagal mengirim via Bot API");
          }
        } catch (err) {
          console.error(`Gagal mengirim notifikasi ke target ${target.name}:`, err.message);
          failureResponse = err.message;
          logs.unshift({
            id: Date.now() + Math.floor(Math.random() * 1000),
            drama_id: item.drama_id,
            title: item.payload.title,
            type: item.type,
            channel_id: target.channel_id,
            topic_id: target.topic_id || "",
            status: "Gagal",
            telegram_message_id: "",
            response: err.message,
            sent_at: now
          });
        }
      }
      
      if (successCount === matchingTargets.length) {
        item.status = "Success";
      } else {
        if (settings.retryFailed && item.retry_count < 3) {
          item.retry_count++;
          item.status = "Retry";
          let delayMs = 30000;
          if (item.retry_count === 2) delayMs = 60000;
          if (item.retry_count === 3) delayMs = 300000;
          item.next_retry_at = Date.now() + delayMs;
        } else {
          item.status = "Failed";
          item.response = failureResponse || "Partial delivery failure";
        }
      }
      
      saveQueue(rootDir, queue);
      saveLogs(rootDir, logs);
    }
  } catch (err) {
    console.error("Gagal memproses antrian notifikasi:", err.message);
  } finally {
    isProcessingQueue = false;
  }
}

function calculateNotificationStats() {
  const settings = loadSettings(rootDir);
  const targets = loadTargets(rootDir);
  const queue = loadQueue(rootDir);
  const logs = loadLogs(rootDir);
  const detected = loadDetectedDramas(rootDir);
  
  const todayStr = new Date().toISOString().split("T")[0];
  
  const dramaToday = detected.filter(d => d.created_at && d.created_at.startsWith(todayStr)).length;
  const episodeToday = logs.filter(l => l.type === "Episode Baru" && l.sent_at && l.sent_at.startsWith(todayStr) && l.status === "Berhasil").length;
  
  const berhasil = logs.filter(l => l.status === "Berhasil").length;
  const gagal = logs.filter(l => l.status === "Gagal").length;
  
  const activeChannels = targets.filter(t => t.status === "Aktif" && t.channel_id).length;
  const activeTopics = targets.filter(t => t.status === "Aktif" && t.topic_id).length;
  
  const queueWaiting = queue.filter(q => q.status === "Pending" || q.status === "Retry").length;
  
  return {
    dramaToday,
    episodeToday,
    berhasil,
    gagal,
    activeChannels,
    activeTopics,
    queueWaiting,
    lastDetectionTime: lastDetectionTime || "-",
    isQueuePaused
  };
}

async function sendTelegramTestMessage(target) {
  const text = `🧪 <b>TEST NOTIFIKASI AUTO NOTIFICATION CENTER</b>\n\n<b>Nama Target:</b> ${escapeHtmlTelegram(target.name)}\n<b>Channel ID:</b> <code>${target.channel_id}</code>\n<b>Topic ID:</b> <code>${target.topic_id || "-"}</code>\n<b>Status:</b> ${target.status}\n\nJika Anda melihat pesan ini, bot Anda telah dikonfigurasi dengan benar untuk target ini!`;
  
  const settings = loadSettings(rootDir);
  const reply_markup = {
    inline_keyboard: []
  };
  
  if (settings.miniAppButton && settings.miniAppUrl) {
    reply_markup.inline_keyboard.push([
      {
        text: "▶️ Tonton Sekarang",
        url: settings.miniAppUrl
      }
    ]);
  }
  
  try {
    const result = await callTelegramBotApi("sendMessage", {
      chat_id: target.channel_id,
      message_thread_id: target.topic_id ? Number(target.topic_id) : undefined,
      text,
      parse_mode: "HTML",
      reply_markup
    });
    
    if (result && result.ok) {
      return { ok: true, messageId: result.result?.message_id };
    } else {
      return { ok: false, error: result.description || "Gagal mengirim ke Telegram API" };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function initNotificationCenter() {
  const settings = loadSettings(rootDir);
  
  if (notificationSchedulerIntervalId) clearInterval(notificationSchedulerIntervalId);
  if (queueProcessorIntervalId) clearInterval(queueProcessorIntervalId);
  
  const intervalTime = settings.interval || 60000;
  notificationSchedulerIntervalId = setInterval(runNotificationDetectionCycle, intervalTime);
  
  queueProcessorIntervalId = setInterval(runQueueProcessor, 10000);
  
  console.log(`Notification Center Initialized. Scraper interval: ${intervalTime}ms.`);
  
  // Run first detection cycle after 10s
  setTimeout(runNotificationDetectionCycle, 10000);
  
  // Start Watch Party idle cleanup job
  startWatchPartyCleanupJob();
}

// MovieBox Helpers and Signature Cryptography
const MOVIEBOX_SECRET_KEY_DEFAULT = "76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O";
const MOVIEBOX_SECRET_KEY_ALT = "Xqn2nnO41/L92o1iuXhSLHTbXvY4Z5ZZ62m8mSLA";

const MOVIEBOX_USER_AGENT = "com.community.oneroom/50020042 (Linux; U; Android 12; en_US; 2201117TG; Build/S1B.220414.015; Cronet/135.0.7012.3)";
const MOVIEBOX_CLIENT_INFO = JSON.stringify({
  package_name: "com.community.oneroom",
  version_name: "3.0.03.0529.03",
  version_code: 50020042,
  os: "android",
  os_version: "12",
  install_ch: "ps",
  device_id: "352cf5d064d1f2e4612301fa3829013c",
  install_store: "ps",
  gaid: "5b4a0f44-8cb3-4b67-8f51-2dfc33f20d7a",
  brand: "Redmi",
  model: "2201117TG",
  system_language: "en",
  net: "NETWORK_WIFI",
  region: "US",
  timezone: "Asia/Jakarta",
  sp_code: "40401",
  "X-Play-Mode": "2"
});

const MOVIEBOX_HOSTS = [
  "https://api6.aoneroom.com",
  "https://api5.aoneroom.com",
  "https://api4.aoneroom.com",
  "https://api.inmoviebox.com"
];

function mbMd5Hex(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

function mbB64Decode(value) {
  let padded = value;
  const padding = (4 - (value.length % 4)) % 4;
  if (padding > 0) {
    padded += "=".repeat(padding);
  }
  return Buffer.from(padded, 'base64');
}

function mbGenerateXClientToken(timestampMs) {
  const ts = String(timestampMs);
  const reversedTs = ts.split('').reverse().join('');
  const hashVal = mbMd5Hex(Buffer.from(reversedTs, 'utf-8'));
  return `${ts},${hashVal}`;
}

function mbSortedQueryString(urlStr) {
  const parsed = new URL(urlStr, "http://localhost");
  const keys = Array.from(parsed.searchParams.keys()).sort();
  if (keys.length === 0) return "";
  const parts = [];
  for (const key of keys) {
    const values = parsed.searchParams.getAll(key);
    for (const val of values) {
      parts.push(`${key}=${val}`);
    }
  }
  return parts.join("&");
}

function mbBuildCanonicalString(method, accept, contentType, urlStr, body, timestampMs) {
  const parsed = new URL(urlStr, "http://localhost");
  const path = parsed.pathname || "";
  const query = mbSortedQueryString(urlStr);
  const canonicalUrl = query ? `${path}?${query}` : path;

  let bodyHash = "";
  let bodyLength = "";
  if (body !== null && body !== undefined) {
    const bodyBytes = Buffer.from(body, 'utf-8');
    const truncated = bodyBytes.slice(0, 102400);
    bodyHash = mbMd5Hex(truncated);
    bodyLength = String(bodyBytes.length);
  }

  return [
    method.toUpperCase(),
    accept || "",
    contentType || "",
    bodyLength,
    String(timestampMs),
    bodyHash,
    canonicalUrl
  ].join("\n");
}

function mbGenerateXTrSignature(method, accept, contentType, urlStr, body = null, useAltKey = false, timestampMs = null) {
  const ts = timestampMs !== null ? timestampMs : Date.now();
  const canonical = mbBuildCanonicalString(method, accept, contentType, urlStr, body, ts);
  
  const secretB64 = useAltKey ? MOVIEBOX_SECRET_KEY_ALT : MOVIEBOX_SECRET_KEY_DEFAULT;
  const secretBytes = mbB64Decode(secretB64);
  
  const mac = crypto.createHmac('md5', secretBytes).update(Buffer.from(canonical, 'utf-8')).digest();
  const sigB64 = mac.toString('base64');
  
  return `${ts}|2|${sigB64}`;
}

function mbBuildSignedHeaders(method, urlStr, accept = "application/json", contentType = "application/json", body = null) {
  const ts = Date.now();
  return {
    "User-Agent": MOVIEBOX_USER_AGENT,
    "Accept": accept,
    "Content-Type": contentType,
    "Connection": "keep-alive",
    "X-Client-Token": mbGenerateXClientToken(ts),
    "x-tr-signature": mbGenerateXTrSignature(method, accept, contentType, urlStr, body, false, ts),
    "X-Client-Info": MOVIEBOX_CLIENT_INFO,
    "X-Client-Status": "0"
  };
}

function httpsFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const reqOptions = {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 15000
    };
    const req = transport.request(url, reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage,
          text: () => Promise.resolve(bodyBuffer.toString('utf8')),
          json: () => Promise.resolve(JSON.parse(bodyBuffer.toString('utf8')))
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function fetchMovieBoxApi(method, path, body = null) {
  let lastError = null;
  for (const host of MOVIEBOX_HOSTS) {
    const url = `${host}${path}`;
    const headers = mbBuildSignedHeaders(method, url, "application/json", "application/json", body);
    try {
      const response = await httpsFetch(url, {
        method,
        headers,
        body: body ? body : undefined
      });
      if (response.ok) {
        const json = await response.json();
        if (json.code === 0) {
          return json.data;
        } else {
          lastError = new Error(`MovieBox API error: ${json.message} (code ${json.code})`);
        }
      } else {
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("All MovieBox hosts failed");
}
