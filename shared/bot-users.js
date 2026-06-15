import fs from "node:fs";
import path from "node:path";

const DEFAULT_STATE = { users: {}, actions: [] };

export function recordBotUser(rootDir, update) {
  const payload = extractUserPayload(update);
  if (!payload?.telegramId) {
    return null;
  }

  const state = loadBotUserState(rootDir);
  const key = String(payload.telegramId);
  const existing = state.users[key] || {};
  const now = new Date().toISOString();

  state.users[key] = {
    ...existing,
    telegramId: payload.telegramId,
    userId: `tg-${payload.telegramId}`,
    firstName: payload.firstName || existing.firstName || "",
    lastName: payload.lastName || existing.lastName || "",
    username: payload.username || existing.username || "",
    languageCode: payload.languageCode || existing.languageCode || "",
    isBot: Boolean(payload.isBot),
    chatId: payload.chatId || existing.chatId || payload.telegramId,
    chatType: payload.chatType || existing.chatType || "private",
    firstSeenAt: existing.firstSeenAt || now,
    joinedAt: existing.joinedAt || now,
    lastActiveAt: now,
    lastCommand: payload.lastCommand || existing.lastCommand || "",
    messageCount: Number(existing.messageCount || 0) + 1,
    status: existing.status || "active",
    statusUpdatedAt: existing.statusUpdatedAt || now
  };

  saveBotUserState(rootDir, state);
  return state.users[key];
}

export function isBotUserBlocked(rootDir, telegramId) {
  const user = getBotUser(rootDir, telegramId);
  return user?.status === "banned" || user?.status === "kicked";
}

export function getBotUser(rootDir, telegramId) {
  const state = loadBotUserState(rootDir);
  return state.users[String(telegramId)] || null;
}

export function listBotUsers(rootDir) {
  const state = loadBotUserState(rootDir);
  return Object.values(state.users)
    .sort((a, b) => String(b.lastActiveAt || "").localeCompare(String(a.lastActiveAt || "")));
}

export function botUserSummary(rootDir) {
  const users = listBotUsers(rootDir);
  return {
    total: users.length,
    active: users.filter((user) => user.status === "active").length,
    banned: users.filter((user) => user.status === "banned").length,
    kicked: users.filter((user) => user.status === "kicked").length,
    users
  };
}

export function setBotUserStatus(rootDir, telegramId, status, meta = {}) {
  const state = loadBotUserState(rootDir);
  const key = String(telegramId || "").replace(/^tg-/, "");
  if (!key) {
    throw new Error("Telegram ID wajib diisi.");
  }

  const now = new Date().toISOString();
  const existing = state.users[key] || {
    telegramId: Number(key),
    userId: `tg-${key}`,
    firstSeenAt: now,
    joinedAt: now,
    messageCount: 0
  };

  state.users[key] = {
    ...existing,
    status,
    statusUpdatedAt: now,
    lastAdminActionAt: now,
    lastAdminAction: meta.action || status,
    penaltyReason: meta.reason || existing.penaltyReason || ""
  };

  state.actions = [
    {
      telegramId: Number(key),
      userId: `tg-${key}`,
      action: meta.action || status,
      status,
      reason: meta.reason || "",
      adminId: meta.adminId || "admin-panel",
      timestamp: now
    },
    ...(state.actions || [])
  ].slice(0, 200);

  saveBotUserState(rootDir, state);
  return state.users[key];
}

export function loadBotUserState(rootDir) {
  const filePath = botUsersPath(rootDir);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_STATE, users: {}, actions: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      users: parsed.users || {},
      actions: parsed.actions || []
    };
  } catch {
    return { ...DEFAULT_STATE, users: {}, actions: [] };
  }
}

function saveBotUserState(rootDir, state) {
  const filePath = botUsersPath(rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
}

function botUsersPath(rootDir) {
  return path.join(rootDir, "storage", "bot-users.json");
}

function extractUserPayload(update) {
  const message = update.message || update.edited_message || null;
  const callback = update.callback_query || null;
  const from = message?.from || callback?.from || null;
  if (!from?.id) {
    return null;
  }

  const text = message?.text || callback?.data || "";
  return {
    telegramId: Number(from.id),
    firstName: from.first_name || "",
    lastName: from.last_name || "",
    username: from.username || "",
    languageCode: from.language_code || "",
    isBot: from.is_bot || false,
    chatId: message?.chat?.id || callback?.message?.chat?.id || from.id,
    chatType: message?.chat?.type || callback?.message?.chat?.type || "private",
    lastCommand: text.startsWith("/") ? text.split(/\s+/)[0] : callback ? `callback:${callback.data}` : ""
  };
}
