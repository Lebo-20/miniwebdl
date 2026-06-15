import fs from "node:fs";
import path from "node:path";
import { catalogItems, platforms } from "./data/catalog.js";
import { backKeyboard, mainKeyboard, vipKeyboard, vipPaymentKeyboard, adminVipActionKeyboard } from "./keyboards.js";
import { isBotUserBlocked, recordBotUser, getBotUser } from "../../../shared/bot-users.js";

const lastMainMenuMessageIds = new Map();
const userVipStates = new Map();

export async function handleUpdate(update, context) {
  const user = recordBotUser(context.config.rootDir, update);
  if (user && isBotUserBlocked(context.config.rootDir, user.telegramId)) {
    await rejectBlockedUser(update, context);
    return;
  }

  if (update.message) {
    await handleMessage(update.message, context);
    return;
  }

  if (update.callback_query) {
    await handleCallback(update.callback_query, context);
  }
}

async function rejectBlockedUser(update, { telegram }) {
  if (update.callback_query) {
    await telegram("answerCallbackQuery", {
      callback_query_id: update.callback_query.id,
      text: "Akses bot Anda sedang dibatasi.",
      show_alert: true
    });
    return;
  }

  const chatId = update.message?.chat?.id;
  if (chatId) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "Akses bot Anda sedang dibatasi oleh admin."
    });
  }
}

async function handleMessage(message, { config, telegram }) {
  const text = message.text || "";
  const chatId = message.chat.id;
  const userId = message.from?.id || 0;

  const userState = userVipStates.get(userId);
  if (userState?.state === "waiting_for_proof") {
    if (text.startsWith("/")) {
      // Cancel state if user sends a command
      userVipStates.delete(userId);
    } else if (message.photo) {
      const duration = userState.duration;
      try {
        const statusMsg = await telegram("sendMessage", {
          chat_id: chatId,
          text: "⏳ Sedang memproses dan mengunggah bukti transfer Anda..."
        });

        const photo = message.photo[message.photo.length - 1];
        const fileId = photo.file_id;
        const fileInfo = await telegram("getFile", { file_id: fileId });
        const remoteFilePath = fileInfo.result.file_path;
        
        const downloadUrl = `https://api.telegram.org/file/bot${config.botToken}/${remoteFilePath}`;
        const downloadRes = await fetch(downloadUrl);
        if (!downloadRes.ok) throw new Error("Gagal mengunduh foto bukti dari Telegram");
        const buffer = Buffer.from(await downloadRes.arrayBuffer());
        
        const uploadsDir = path.join(config.rootDir, "apps/web/public/uploads");
        fs.mkdirSync(uploadsDir, { recursive: true });
        const localFileName = `proof_${userId}_${Date.now()}.jpg`;
        const localFilePath = path.join(uploadsDir, localFileName);
        fs.writeFileSync(localFilePath, buffer);
        
        userVipStates.delete(userId);
        
        try {
          await telegram("deleteMessage", { chat_id: chatId, message_id: statusMsg.result.message_id });
        } catch {}

        const priceFormatted = (duration * 1000).toLocaleString("id-ID");
        const userRecord = getBotUser(config.rootDir, userId);
        const displayName = userRecord ? `${userRecord.firstName} ${userRecord.lastName}`.trim() : `tg-${userId}`;
        const usernameText = userRecord?.username ? `@${userRecord.username}` : "-";
        const proofUrl = `${config.publicUrl}/uploads/${localFileName}`;
        logBotPayment(config.rootDir, {
          userId: `tg-${userId}`,
          planDays: duration,
          method: "QRIS (Bot - Pending)",
          status: "pending",
          source: "Telegram Bot",
          proofUrl,
          proofFile: `/uploads/${localFileName}`,
          telegramId: userId,
          telegramUsername: userRecord?.username || "",
          userName: displayName,
          total: duration * 1000
        });
        
        const adminCaption = [
          `🔔 <b>BUKTI PEMBAYARAN VIP REGULAR</b>`,
          ``,
          `👤 <b>User:</b> tg-${userId} (${displayName} | ${usernameText})`,
          `🆔 <b>Telegram ID:</b> <code>${userId}</code>`,
          `📦 <b>Paket:</b> ${duration} Hari`,
          `💰 <b>Total:</b> Rp ${priceFormatted}`,
          `📅 <b>Tanggal:</b> ${new Date().toLocaleString("id-ID")}`,
          `🖼 <b>Bukti:</b> ${proofUrl}`
        ].join("\n");
        
        await telegram("sendPhoto", {
          chat_id: config.adminId,
          photo: localFilePath,
          caption: adminCaption,
          parse_mode: "HTML",
          reply_markup: adminVipActionKeyboard(`tg-${userId}`, duration)
        });
        
        await telegram("sendMessage", {
          chat_id: chatId,
          text: "Terima kasih! Bukti transfer Anda telah dikirim ke admin untuk verifikasi. Maksimal proses 1x24 jam.",
          reply_markup: backKeyboard(config.publicUrl)
        });
      } catch (err) {
        console.error("Gagal mengunggah bukti transfer:", err);
        await telegram("sendMessage", {
          chat_id: chatId,
          text: `❌ Terjadi kesalahan saat mengunggah bukti transfer: ${err.message}. Silakan coba lagi.`
        });
      }
      return;
    } else {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: "Harap kirimkan foto (screenshot) bukti transfer QRIS Anda untuk melanjutkan."
      });
      return;
    }
  }

  // Handle reply message from Admin
  if (message.reply_to_message && userId === config.adminId) {
    const repliedText = message.reply_to_message.text || message.reply_to_message.caption || "";
    const match = repliedText.match(/\[User ID:\s*([a-zA-Z0-9_-]+)\]/);
    if (match) {
      const targetUserId = match[1];
      try {
        const response = await fetch(`${config.publicUrl}/api/tickets/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetUserId,
            replyText: text,
            token: config.botToken
          })
        });
        const data = await response.json();
        if (data.ok) {
          await telegram("sendMessage", {
            chat_id: chatId,
            text: `✅ Balasan terkirim ke User ${targetUserId}.`
          });
        } else {
          await telegram("sendMessage", {
            chat_id: chatId,
            text: `❌ Gagal mengirim balasan: ${data.error || "Terjadi kesalahan"}`
          });
        }
      } catch (err) {
        console.error("Error sending reply to server:", err);
        await telegram("sendMessage", {
          chat_id: chatId,
          text: `❌ Gagal menghubungi server web: ${err.message}`
        });
      }
      return;
    }
  }

  if (text.startsWith("/start")) {
    await sendMainMenu(chatId, userId, { config, telegram });
    return;
  }

  if (text.startsWith("/cari")) {
    await sendSearchResults(chatId, text.replace("/cari", "").trim(), { config, telegram });
    return;
  }

  if (text.startsWith("/vip")) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: vipText(),
      reply_markup: vipKeyboard(config.publicUrl)
    });
    return;
  }

  if (text.startsWith("/login")) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const loginCodesPath = path.join(config.rootDir, "storage", "security", "login-codes.json");
    
    let codes = [];
    try {
      if (fs.existsSync(loginCodesPath)) {
        codes = JSON.parse(fs.readFileSync(loginCodesPath, "utf8"));
      }
    } catch (e) {
      console.error("Error reading login codes:", e);
    }

    codes = codes.filter((c) => c.expiresAt > Date.now());

    const userRecord = getBotUser(config.rootDir, userId);
    const displayName = userRecord ? `${userRecord.firstName} ${userRecord.lastName}`.trim() : `tg-${userId}`;
    const username = userRecord?.username || displayName;

    codes.push({
      code,
      telegramId: userId,
      username,
      expiresAt: Date.now() + 5 * 60 * 1000
    });

    try {
      fs.mkdirSync(path.dirname(loginCodesPath), { recursive: true });
      fs.writeFileSync(loginCodesPath, JSON.stringify(codes, null, 2), "utf8");
    } catch (e) {
      console.error("Error writing login codes:", e);
    }

    const responseText = [
      `🔑 <b>KODE LOGIN MINIWEB</b>`,
      ``,
      `Gunakan kode di bawah ini untuk menghubungkan akun Telegram Anda di browser eksternal:`,
      ``,
      `<code>${code}</code>`,
      ``,
      `<i>Kode ini hanya berlaku selama 5 menit. Harap jangan berikan kode ini kepada orang lain.</i>`
    ].join("\n");

    await telegram("sendMessage", {
      chat_id: chatId,
      text: responseText,
      parse_mode: "HTML"
    });
    return;
  }

  await sendMainMenu(chatId, userId, { config, telegram });
}

async function handleCallback(query, { config, telegram }) {
  const chatId = query.message.chat.id;
  const userId = query.from?.id || 0;
  const isAdmin = userId === config.adminId;

  await telegram("answerCallbackQuery", { callback_query_id: query.id });

  if (query.data.startsWith("admin_login:")) {
    const [, action, sessionId] = query.data.split(":");
    try {
      const response = await fetch(`${config.publicUrl}/api/admin/login/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sessionId, adminId: userId })
      });
      const data = await response.json();
      if (data.ok) {
        const text = action === "acc" ? "✅ Login Disetujui (ACC)" : "❌ Login Ditolak (Tolak)";
        await telegram("editMessageText", {
          chat_id: chatId,
          message_id: query.message.message_id,
          text: `${query.message.text}\n\n<b>Status: ${text}</b>`,
          parse_mode: "HTML"
        });
      } else {
        await telegram("sendMessage", {
          chat_id: chatId,
          text: `Gagal memproses otorisasi: ${data.error || "Terjadi kesalahan"}`
        });
      }
    } catch (err) {
      console.error(err);
      await telegram("sendMessage", {
        chat_id: chatId,
        text: `Error menghubungi server web: ${err.message}`
      });
    }
    return;
  }

  if (query.data === "main_menu") {
    await sendMainMenu(chatId, userId, { config, telegram });
    return;
  }

  if (query.data === "buy_vip") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: vipText(),
      reply_markup: vipKeyboard(),
      parse_mode: "HTML"
    });
    return;
  }

  if (query.data.startsWith("buy_vip_duration:")) {
    const duration = Number(query.data.split(":")[1]);
    const priceFormatted = (duration * 1000).toLocaleString("id-ID");
    const photoPath = path.join(config.rootDir, "apps/web/public/assets/qris.png");

    await telegram("sendPhoto", {
      chat_id: chatId,
      photo: photoPath,
      caption: [
        `💳 <b>PEMBAYARAN VIP REGULAR</b>`,
        ``,
        `📦 Paket: ${duration} Hari (Full Akses)`,
        `💰 Total: Rp ${priceFormatted}`,
        ``,
        `📌 <b>Cara Pembayaran:</b>`,
        `1️⃣ Scan QRIS`,
        `2️⃣ Transfer sesuai total`,
        `3️⃣ Screenshot bukti`,
        `4️⃣ Klik Upload Bukti QRIS`,
        ``,
        `⏳ Maksimal 1x24 jam`
      ].join("\n"),
      parse_mode: "HTML",
      reply_markup: vipPaymentKeyboard(duration)
    });
    return;
  }

  if (query.data.startsWith("upload_proof:")) {
    const duration = Number(query.data.split(":")[1]);
    userVipStates.set(userId, { state: "waiting_for_proof", duration });
    
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "Silakan kirimkan screenshot bukti transfer QRIS Anda ke chat ini."
    });
    return;
  }

  if (query.data.startsWith("admin_vip_action:") || query.data.startsWith("vip_approve_") || query.data.startsWith("vip_reject_")) {
    let action = "";
    let targetUserId = "";
    let durationStr = "";
    if (query.data.startsWith("admin_vip_action:")) {
      [, action, targetUserId, durationStr] = query.data.split(":");
    } else {
      action = query.data.startsWith("vip_approve_") ? "approve" : "reject";
      const prefix = action === "approve" ? "vip_approve_" : "vip_reject_";
      const payload = query.data.slice(prefix.length);
      const lastUnderscore = payload.lastIndexOf("_");
      targetUserId = lastUnderscore >= 0 ? payload.slice(0, lastUnderscore) : payload;
      durationStr = lastUnderscore >= 0 ? payload.slice(lastUnderscore + 1) : "30";
    }
    const duration = Number(durationStr);
    const targetTelegramId = targetUserId.replace(/^tg-/, "");
    
    if (action === "approve") {
      try {
        const response = await fetch(`${config.publicUrl}/api/admin/vip/modify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.botToken}`
          },
          body: JSON.stringify({
            userId: targetUserId,
            planDays: duration,
            action: "add",
            paymentSource: "proof"
          })
        });
        const data = await response.json();
        
        if (response.ok) {
          await telegram("sendMessage", {
            chat_id: chatId,
            text: `✅ VIP untuk ${targetUserId} selama ${duration} Hari berhasil diaktifkan.`
          });
          
          if (/^\d+$/.test(targetTelegramId)) {
            try {
            await telegram("sendMessage", {
              chat_id: Number(targetTelegramId),
              text: `🎉 <b>Selamat!</b> VIP Anda selama <b>${duration} Hari</b> telah diaktifkan oleh admin. Terima kasih atas dukungan Anda!\n\nSilakan buka menu utama atau segarkan aplikasi untuk menikmati akses VIP.`,
              parse_mode: "HTML"
            });
            } catch (e) {
              console.warn(`Gagal mengirim notifikasi ke user ${targetTelegramId}:`, e.message);
            }
          }
          
          await telegram("editMessageCaption", {
            chat_id: chatId,
            message_id: query.message.message_id,
            caption: `${query.message.caption}\n\n<b>Status: Disetujui (Approved) ✅</b>`,
            parse_mode: "HTML"
          });
        } else {
          await telegram("sendMessage", {
            chat_id: chatId,
            text: `❌ Gagal mengaktifkan VIP: ${data.error || "Terjadi kesalahan"}`
          });
        }
      } catch (err) {
        console.error(err);
        await telegram("sendMessage", {
          chat_id: chatId,
          text: `❌ Error menghubungi server web: ${err.message}`
        });
      }
    } else if (action === "reject") {
      updateBotPaymentStatus(config.rootDir, targetUserId, duration, "failed");
      await telegram("sendMessage", {
        chat_id: chatId,
        text: `❌ Permintaan VIP untuk ${targetUserId} telah ditolak.`
      });
      
      if (/^\d+$/.test(targetTelegramId)) {
        try {
        await telegram("sendMessage", {
          chat_id: Number(targetTelegramId),
          text: `❌ <b>Mohon maaf.</b> Pembayaran VIP Anda sebesar Rp ${(duration * 1000).toLocaleString("id-ID")} ditolak oleh admin. Pastikan bukti transfer valid dan hubungi bantuan jika terjadi kesalahan.`,
          parse_mode: "HTML"
        });
        } catch (e) {
          console.warn(`Gagal mengirim notifikasi ke user ${targetTelegramId}:`, e.message);
        }
      }
      
      await telegram("editMessageCaption", {
        chat_id: chatId,
        message_id: query.message.message_id,
        caption: `${query.message.caption}\n\n<b>Status: Ditolak (Rejected) ❌</b>`,
        parse_mode: "HTML"
      });
    }
    return;
  }

  if (query.data === "all_platform") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: platformText(),
      reply_markup: backKeyboard(config.publicUrl)
    });
    return;
  }

  if (query.data === "admin_panel") {
    if (!isAdmin) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: "Akses admin hanya untuk admin."
      });
      return;
    }

    await telegram("sendMessage", {
      chat_id: chatId,
      text: adminText(),
      reply_markup: backKeyboard(config.publicUrl)
    });
    return;
  }
}

function checkVipStatus(rootDir, telegramId) {
  const filePath = path.join(rootDir, "storage", "security", "security-state.json");
  if (!fs.existsSync(filePath)) return { active: false, expiresAt: null };
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const vipUsers = data.vipUsers || {};
    const key = `tg-${telegramId}`;
    const vip = vipUsers[key] || vipUsers[key.toLowerCase()];
    if (!vip || !vip.active) {
      return { active: false, expiresAt: null };
    }
    const now = new Date();
    const expiresAt = vip.expiresAt ? new Date(vip.expiresAt) : null;
    if (expiresAt && expiresAt < now) {
      return { active: false, expiresAt };
    }
    return { active: true, expiresAt };
  } catch (e) {
    return { active: false, expiresAt: null };
  }
}

function checkAdminTicketStatus(rootDir, telegramId) {
  const filePath = path.join(rootDir, "storage", "tickets.json");
  if (!fs.existsSync(filePath)) return "Tidak ada tiket bantuan 🎟️";
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const key = `tg-${telegramId}`;
    const history = data[key] || [];
    if (history.length === 0) {
      return "Tidak ada tiket bantuan 🎟️";
    }
    
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.sender === "admin") {
        return "Ada Balasan Admin (Baru) 📬";
      }
      if (msg.sender === "user") {
        return "Menunggu Balasan Admin ⏳";
      }
      if (msg.sender === "system" && msg.text.includes("ditutup")) {
        return "Tidak ada tiket aktif (Selesai) ✅";
      }
    }
    return "Tidak ada tiket bantuan 🎟️";
  } catch (e) {
    return "Tidak ada tiket bantuan 🎟️";
  }
}

async function sendMainMenu(chatId, userId, { config, telegram }) {
  const isAdmin = userId === config.adminId;
  const userRecord = getBotUser(config.rootDir, userId);
  
  const displayName = userRecord ? `${userRecord.firstName} ${userRecord.lastName}`.trim() : "Pengguna";
  const usernameText = userRecord?.username ? `@${userRecord.username}` : "-";
  
  const vip = checkVipStatus(config.rootDir, userId);
  let vipStatusText = "FREE (Non-VIP) ❌";
  if (vip.active) {
    const expDate = vip.expiresAt ? new Date(vip.expiresAt).toLocaleDateString("id-ID") : "Lifetime";
    vipStatusText = `VIP Aktif sampai: ${expDate} 👑`;
  }
  
  const ticketStatus = checkAdminTicketStatus(config.rootDir, userId);

  const text = [
    `👋 <b>Halo, ${displayName}! Selamat datang di TEAMDL</b>`,
    `Platform drama pendek terbaik dan tercepat.`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📋 <b>PROFIL ANDA:</b>`,
    `• <b>Nama / USN:</b> ${displayName} (${usernameText})`,
    `• <b>ID User:</b> <code>tg-${userId}</code>`,
    `• <b>Status VIP:</b> ${vipStatusText}`,
    `• <b>Tiket Bantuan:</b> ${ticketStatus}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `👉 <b>PANDUAN MENUBAR:</b>`,
    `Klik tombol menu di bawah untuk menggunakan fitur:`,
    `• <b>BUKA TEAMDL</b> - Membuka Mini App utama untuk menonton drama.`,
    `• <b>BELI VIP</b> - Berlangganan VIP untuk membuka episode premium.`,
    `• <b>JUDUL BARU</b> - Melihat daftar drama terbaru yang dirilis.`,
    `• <b>CARI JUDUL</b> - Mencari drama berdasarkan nama/kategori.`,
    `• <b>ALL PLATFORM</b> - Melihat katalog platform streaming partner.`,
    `• <b>Koneksi Browser</b> - Kirim /login untuk mendapatkan kode masuk di browser luar.`
  ].join("\n");

  await deletePreviousMainMenu(chatId, telegram);

  const response = await telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: mainKeyboard(isAdmin, config.publicUrl)
  });

  const messageId = response?.result?.message_id;
  if (messageId) {
    lastMainMenuMessageIds.set(chatId, messageId);
  }
}

async function deletePreviousMainMenu(chatId, telegram) {
  const messageId = lastMainMenuMessageIds.get(chatId);
  if (!messageId) return;

  try {
    await telegram("deleteMessage", {
      chat_id: chatId,
      message_id: messageId
    });
  } catch {
    // Telegram may reject deletion for older messages or messages already removed.
  }

  lastMainMenuMessageIds.delete(chatId);
}

async function sendSearchResults(chatId, keyword, { config, telegram }) {
  if (!keyword) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "Ketik format: /cari nama judul",
      reply_markup: backKeyboard(config.publicUrl)
    });
    return;
  }

  const q = keyword.toLowerCase();
  const results = catalogItems.filter((item) => `${item.title} ${item.platform} ${item.type}`.toLowerCase().includes(q));
  const text = results.length
    ? results.map((item, index) => `${index + 1}. ${item.title}\n${item.type} | ${item.platform}`).join("\n\n")
    : "Judul tidak ditemukan.";

  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: backKeyboard(config.publicUrl)
  });
}

function vipText() {
  return [
    "💎 <b>VIP REGULAR</b>",
    "",
    "Harga: Rp 1,000/hari",
    "Akses penuh semua video VIP",
    "",
    "Pilih durasi:"
  ].join("\n");
}

function platformText() {
  return [
    "ALL PLATFORM",
    "",
    ...platforms.map((platform, index) => `${index + 1}. ${platform}`)
  ].join("\n");
}

function adminText() {
  return [
    "ADMIN PANEL",
    "",
    "Menu admin:",
    "1. Kelola judul",
    "2. Kelola platform",
    "3. Kelola VIP",
    "4. Kelola user",
    "5. Statistik bot"
  ].join("\n");
}

function logBotPayment(rootDir, payment) {
  const history = loadBotPaymentHistory(rootDir);
  history.unshift({
    id: `pay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: payment.userId,
    userName: payment.userName || "",
    telegramId: payment.telegramId ? String(payment.telegramId) : "",
    telegramUsername: payment.telegramUsername || "",
    plan: payment.planDays === 9999 ? "Lifetime" : `${payment.planDays} Hari`,
    planDays: payment.planDays,
    method: payment.method,
    status: payment.status,
    source: payment.source || "Telegram Bot",
    total: payment.total || payment.planDays * 1000,
    proofUrl: payment.proofUrl || "",
    proofFile: payment.proofFile || "",
    date: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  saveBotPaymentHistory(rootDir, history);
}

function updateBotPaymentStatus(rootDir, userId, planDays, status) {
  const history = loadBotPaymentHistory(rootDir);
  const item = history.find((payment) =>
    payment.userId === userId
    && Number(payment.planDays || String(payment.plan || "").match(/\d+/)?.[0] || 0) === Number(planDays)
    && payment.status === "pending"
  );
  if (item) {
    item.status = status;
    item.updatedAt = new Date().toISOString();
    saveBotPaymentHistory(rootDir, history);
  }
}

function loadBotPaymentHistory(rootDir) {
  const filePath = path.join(rootDir, "storage", "payment-history.json");
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.error("Gagal membaca riwayat pembayaran:", err);
  }
  return [];
}

function saveBotPaymentHistory(rootDir, history) {
  const filePath = path.join(rootDir, "storage", "payment-history.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(history, null, 2), "utf8");
}
