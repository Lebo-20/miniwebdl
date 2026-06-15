import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SESSION_TTL_MS = 30 * 60 * 1000;
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const API_TIMESTAMP_SKEW_MS = 90 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const ACCOUNT_LIMIT = 100;
const IP_LIMIT = 300;
const INSPECT_FIRST_BLOCK_MS = 60 * 60 * 1000;
const INSPECT_SECOND_BLOCK_MS = 24 * 60 * 60 * 1000;
const BOT_UA = /(curl|wget|postman|insomnia|burp|fiddler|charles|python-requests|go-http-client|httpclient|headless|selenium|puppeteer|playwright|phantomjs)/i;

export function createSecurityContext({ rootDir, env, firebaseConfigPath }) {
  const secret = env.SECURITY_SECRET || env.SESSION_SECRET || "miniweb-dev-change-this-secret";
  const securityDir = path.join(rootDir, "storage", "security");
  const statePath = path.join(securityDir, "security-state.json");
  const streamLogsPath = path.join(securityDir, "stream-logs.json");
  const firebaseConfig = safeReadJson(firebaseConfigPath, {});

  fs.mkdirSync(securityDir, { recursive: true });

  const sessions = new Map();
  const rateBuckets = new Map();
  const usedNonces = new Map();
  const mediaTokens = new Map();
  const state = loadState();

  function loadState() {
    const stored = safeReadJson(statePath, null);
    return stored || {
      logs: [],
      bannedIps: {},
      bannedAccounts: {},
      bannedDevices: {},
      violations: {},
      vipUsers: {
        "dev-vip": { active: true, expiresAt: "2099-12-31T23:59:59.000Z" }
      },
      revokedSessions: {}
    };
  }

  function safeWriteFileSync(filePath, content, encoding = "utf8") {
    let attempts = 5;
    while (attempts > 0) {
      try {
        fs.writeFileSync(filePath, content, encoding);
        return;
      } catch (err) {
        attempts--;
        if (attempts === 0) {
          throw err;
        }
        const start = Date.now();
        while (Date.now() - start < 50) {} // sync sleep 50ms
      }
    }
  }

  let stateLogQueue = Promise.resolve();

  function saveState() {
    stateLogQueue = stateLogQueue.then(() => {
      try {
        safeWriteFileSync(statePath, JSON.stringify({
          ...state,
          logs: state.logs.slice(-1000)
        }, null, 2), "utf8");
      } catch (err) {
        console.error("Gagal menulis security state:", err);
      }
    });
  }

  let streamLogQueue = Promise.resolve();

  function logStreamPlay({ userId, ipAddress, userAgent, deviceId, episodeId, episodeName, dramaTitle, url, status, details, errorType, httpCode, responseTime, device, browser, cdn }) {
    streamLogQueue = streamLogQueue.then(() => {
      try {
        const logs = safeReadJson(streamLogsPath, []);
        logs.push({
          userId: userId || "guest",
          ipAddress: ipAddress || "unknown",
          userAgent: userAgent || "unknown",
          deviceId: deviceId || "unknown",
          episodeId: episodeId || "media",
          episodeName: episodeName || "",
          dramaTitle: dramaTitle || "",
          url: url || "",
          status: status || "Success",
          details: details || "",
          errorType: errorType || null,
          httpCode: httpCode || null,
          responseTime: responseTime || null,
          device: device || null,
          browser: browser || null,
          cdn: cdn || null,
          timestamp: new Date().toISOString()
        });
        if (logs.length > 2000) {
          logs.splice(0, logs.length - 2000);
        }
        safeWriteFileSync(streamLogsPath, JSON.stringify(logs, null, 2), "utf8");
      } catch (err) {
        console.error("Gagal menulis log streaming:", err);
      }
    });
  }

  function getStreamLogs() {
    return safeReadJson(streamLogsPath, []);
  }

  function clearStreamLogs() {
    streamLogQueue = streamLogQueue.then(() => {
      try {
        safeWriteFileSync(streamLogsPath, JSON.stringify([], null, 2), "utf8");
      } catch (err) {
        console.error("Gagal menghapus log streaming:", err);
      }
    });
  }

  function issueSession(request, response, body = {}) {
    const context = requestContext(request);
    enforceDomain(request, context);
    enforceRate(context);

    const deviceId = cleanId(body.deviceId || request.headers["x-device-id"]);
    const fingerprint = cleanId(body.fingerprint || request.headers["x-device-fingerprint"]);
    if (!deviceId || !fingerprint) {
      return forbidden(response, "DEVICE_REQUIRED");
    }

    const userId = resolveUserId(request, body);
    if (state.bannedAccounts[userId] || state.bannedDevices[deviceId]) {
      logViolation({ ...context, userId, deviceId, violationType: "BANNED_SESSION_ATTEMPT", penalty: "blocked" });
      return forbidden(response, "ACCOUNT_OR_DEVICE_BANNED");
    }

    const sessionId = crypto.randomUUID();
    const csrf = randomToken(24);
    const now = Date.now();
    const vip = getVipStatus(userId);
    const session = {
      id: sessionId,
      csrf,
      userId,
      deviceId,
      fingerprint,
      deviceHash: hash(`${deviceId}:${fingerprint}`),
      userAgentHash: hash(context.userAgent),
      ipHash: hash(context.ipAddress),
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_MS,
      vip
    };
    sessions.set(sessionId, session);
    response.setHeader("Set-Cookie", cookie("mw_session", sessionId, {
      httpOnly: true,
      sameSite: "Strict",
      maxAge: SESSION_TTL_MS / 1000
    }));
    return sendJson(response, publicSession(session));
  }

  function destroySession(request, response, reason = "logout") {
    const sessionId = parseCookies(request.headers.cookie).mw_session;
    if (sessionId) {
      sessions.delete(sessionId);
      state.revokedSessions[sessionId] = Date.now();
      saveState();
    }
    response.setHeader("Set-Cookie", cookie("mw_session", "", {
      httpOnly: true,
      sameSite: "Strict",
      maxAge: 0
    }));
    return sendJson(response, { ok: true, reason });
  }

  function requireSession(request, response, options = {}) {
    const context = requestContext(request);
    enforceDomain(request, context);
    enforceRate(context);
    blockAutomation(request, context);

    const sessionId = parseCookies(request.headers.cookie).mw_session;
    const session = sessions.get(sessionId);
    if (!session || state.revokedSessions[sessionId]) {
      logViolation({ ...context, violationType: "SESSION_MISSING", penalty: "403" });
      forbidden(response, "SESSION_REQUIRED");
      return null;
    }

    const now = Date.now();
    if (session.expiresAt < now) {
      sessions.delete(sessionId);
      logViolation({ ...context, userId: session.userId, deviceId: session.deviceId, violationType: "SESSION_EXPIRED", penalty: "403" });
      forbidden(response, "SESSION_EXPIRED");
      return null;
    }

    if (session.userAgentHash !== hash(context.userAgent) || session.ipHash !== hash(context.ipAddress)) {
      escalate({ ...context, userId: session.userId, deviceId: session.deviceId }, "SESSION_BINDING_CHANGED");
      sessions.delete(sessionId);
      forbidden(response, "SESSION_BINDING_CHANGED");
      return null;
    }

    const deviceId = cleanId(request.headers["x-device-id"]);
    const fingerprint = cleanId(request.headers["x-device-fingerprint"]);
    if (!options.media && (!deviceId || !fingerprint || deviceId !== session.deviceId || hash(`${deviceId}:${fingerprint}`) !== session.deviceHash)) {
      escalate({ ...context, userId: session.userId, deviceId: deviceId || session.deviceId }, "DEVICE_MISMATCH");
      sessions.delete(sessionId);
      forbidden(response, "DEVICE_MISMATCH");
      return null;
    }

    if (options.signed) {
      const valid = validateSignedRequest(request, session, context);
      if (!valid) {
        escalate({ ...context, userId: session.userId, deviceId: session.deviceId }, "SIGNED_REQUEST_INVALID");
        forbidden(response, "SIGNED_REQUEST_INVALID");
        return null;
      }
    }

    session.lastSeenAt = now;
    session.expiresAt = now + SESSION_TTL_MS;
    session.vip = getVipStatus(session.userId);
    return { session, context };
  }

  function requirePremium(request, response) {
    const auth = requireSession(request, response, { signed: true });
    if (!auth) {
      return null;
    }
    if (!auth.session.vip.active) {
      logViolation({ ...auth.context, userId: auth.session.userId, deviceId: auth.session.deviceId, violationType: "PREMIUM_DENIED_NON_VIP", penalty: "403" });
      forbidden(response, "VIP_REQUIRED");
      return null;
    }
    return auth;
  }

  function rewriteEpisodePayload(payload, request, response) {
    const auth = requireSession(request, response, { signed: true });
    if (!auth) {
      return null;
    }
    return rewriteMediaUrls(payload, request, auth, "");
  }

  function signMediaUrl(rawUrl, auth, meta = {}) {
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const payload = {
      id,
      userId: auth.session.userId,
      episodeId: meta.episodeId || "media",
      episodeName: meta.episodeName || "",
      dramaTitle: meta.dramaTitle || "",
      sessionId: auth.session.id,
      deviceHash: auth.session.deviceHash,
      timestamp: Date.now(),
      expiresAt,
      url: rawUrl,
      videoKey: meta.videoKey || ""
    };
    const encrypted = encryptJson(payload, secret);
    const sig = hmac(encrypted, secret);
    const token = `${encrypted}.${sig}`;
    mediaTokens.set(id, { hits: 0, expiresAt });

    // Auto detect stream type
    let kind = "media";
    let ext = "";
    const lowerUrl = rawUrl.toLowerCase();
    const isHls = lowerUrl.includes(".m3u8") || 
      /dramabox/i.test(rawUrl) ||
      /dramabos/i.test(rawUrl) ||
      /goodshort/i.test(rawUrl);

    if (isHls && !/\.(ts|key|aac|png|jpg|jpeg|gif|vtt|srt)$/i.test(lowerUrl)) {
      kind = "hls";
      ext = ".m3u8";
    } else if (lowerUrl.includes(".mpd")) {
      kind = "dash";
      ext = ".mpd";
    } else if (
      lowerUrl.includes("embed") ||
      lowerUrl.includes("iframe") ||
      lowerUrl.includes("/play/") ||
      lowerUrl.includes("/player/") ||
      lowerUrl.includes(".html") ||
      lowerUrl.includes(".htm")
    ) {
      kind = "embed";
    } else if (lowerUrl.includes(".mp4")) {
      kind = "mp4";
      ext = ".mp4";
    }

    return `/api/secure-media/${encodeURIComponent(token)}${ext}?kind=${kind}`;
  }

  async function proxySecureMedia(request, response, rawToken, proxyFn) {
    const token = String(rawToken || "").replace(/\.(m3u8|mpd|mp4)$/i, "");
    let auth = null;
    let context = null;
    try {
      context = requestContext(request);
    } catch (e) {
      context = {
        ipAddress: String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim(),
        userAgent: String(request.headers["user-agent"] || ""),
        userId: "guest",
        deviceId: "unknown"
      };
    }

    const payload = verifyMediaToken(token);

    if (!payload) {
      logStreamPlay({
        userId: context.userId || "guest",
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        deviceId: context.deviceId || "unknown",
        status: "Error",
        details: "Token media tidak valid"
      });
      return forbidden(response, "MEDIA_TOKEN_INVALID");
    }

    // Retrieve session directly from the payload's sessionId instead of requiring cookies
    const session = sessions.get(payload.sessionId);
    if (!session || state.revokedSessions[payload.sessionId]) {
      logStreamPlay({
        userId: payload.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        deviceId: payload.deviceId || "unknown",
        episodeId: payload.episodeId,
        episodeName: payload.episodeName,
        dramaTitle: payload.dramaTitle,
        url: payload.url,
        status: "Error",
        details: "Akses ditolak: Sesi tidak aktif atau expired"
      });
      return forbidden(response, "SESSION_REQUIRED");
    }

    const now = Date.now();
    if (session.expiresAt < now) {
      logStreamPlay({
        userId: payload.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        deviceId: payload.deviceId || "unknown",
        episodeId: payload.episodeId,
        episodeName: payload.episodeName,
        dramaTitle: payload.dramaTitle,
        url: payload.url,
        status: "Error",
        details: "Akses ditolak: Sesi expired"
      });
      return forbidden(response, "SESSION_EXPIRED");
    }

    // Verify User Agent to prevent token sharing, but do not strictly enforce IP bindings
    // because mobile IPs change constantly during streaming.
    if (session.userAgentHash !== hash(context.userAgent)) {
      logStreamPlay({
        userId: payload.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        deviceId: payload.deviceId || "unknown",
        episodeId: payload.episodeId,
        episodeName: payload.episodeName,
        dramaTitle: payload.dramaTitle,
        url: payload.url,
        status: "Error",
        details: "User agent mismatch"
      });
      return forbidden(response, "SESSION_BINDING_CHANGED");
    }

    // Construct the auth object
    auth = { session, context };

    const tracker = mediaTokens.get(payload.id);
    if (!tracker || tracker.expiresAt < Date.now()) {
      escalate({ ...auth.context, userId: auth.session.userId, deviceId: auth.session.deviceId }, "MEDIA_TOKEN_REPLAY");
      logStreamPlay({
        userId: auth.session.userId,
        ipAddress: auth.context.ipAddress,
        userAgent: auth.context.userAgent,
        deviceId: auth.session.deviceId,
        episodeId: payload.episodeId,
        episodeName: payload.episodeName,
        dramaTitle: payload.dramaTitle,
        url: payload.url,
        status: "Error",
        details: "Token media kadaluwarsa (replay)"
      });
      return forbidden(response, "MEDIA_TOKEN_REPLAY");
    }

    const originOk = allowedOrigin(request, auth.context);
    if (!originOk) {
      escalate({ ...auth.context, userId: auth.session.userId, deviceId: auth.session.deviceId }, "HOTLINK_BLOCKED");
      logStreamPlay({
        userId: auth.session.userId,
        ipAddress: auth.context.ipAddress,
        userAgent: auth.context.userAgent,
        deviceId: auth.session.deviceId,
        episodeId: payload.episodeId,
        episodeName: payload.episodeName,
        dramaTitle: payload.dramaTitle,
        url: payload.url,
        status: "Error",
        details: "Origin request diblokir (hotlinking)"
      });
      return forbidden(response, "HOTLINK_BLOCKED");
    }

    tracker.hits += 1;
    auth.mediaPayload = payload;

    const urlObj = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const kindParam = urlObj.searchParams.get("kind");
    const lowerUrl = payload.url.toLowerCase();
    const isEmbed = kindParam === "embed" || lowerUrl.includes("embed") || lowerUrl.includes("iframe") || lowerUrl.includes("/play/") || lowerUrl.includes("/player/") || lowerUrl.includes(".html") || lowerUrl.includes(".htm");
    if (isEmbed) {
      logStreamPlay({
        userId: auth.session.userId,
        ipAddress: auth.context.ipAddress,
        userAgent: auth.context.userAgent,
        deviceId: auth.session.deviceId,
        episodeId: payload.episodeId,
        episodeName: payload.episodeName,
        dramaTitle: payload.dramaTitle,
        url: payload.url,
        status: "Success",
        details: "Redirecting secure media request for embed to original URL"
      });
      response.writeHead(302, { "Location": payload.url });
      response.end();
      return;
    }

    if (payload.url === "__aes_key__") {
      const keyBuffer = Buffer.from(payload.videoKey || "", "base64");
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": keyBuffer.length,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*"
      });
      response.end(keyBuffer);
      return;
    }

    return proxyFn(request, response, payload.url, auth);
  }

  function rewritePlaylist(text, baseUrl, request, auth) {
    if (!text.includes("#EXTM3U")) {
      return text;
    }
    let result = text;
    const videoKey = auth?.mediaPayload?.videoKey;
    if (videoKey) {
      // Create a signed URL that serves the raw AES key bytes
      const keyUrl = signMediaUrl("__aes_key__", auth, { episodeId: "aeskey", videoKey });
      result = result.replace(/URI="local:\/\/[^"]*"/g, `URI="${keyUrl}"`);
      result = result.replace(/#EXT-X-KEY:METHOD=AES-128,URI="([^":\n]+)"/g, `#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}"`);
    }
    return result.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return line;
      }
      return signMediaUrl(new URL(trimmed, baseUrl).toString(), auth, { episodeId: "segment", videoKey });
    }).join("\n");
  }

  function reportViolation(request, response, body = {}) {
    const context = requestContext(request);
    const sessionId = parseCookies(request.headers.cookie).mw_session;
    const session = sessions.get(sessionId);
    const deviceId = cleanId(body.deviceId || request.headers["x-device-id"] || session?.deviceId || "unknown");
    const userId = session?.userId || resolveUserId(request, body);
    const violationType = String(body.violationType || "CLIENT_SECURITY_EVENT").slice(0, 80);
    if (violationType === "DEVTOOLS_DIMENSION_SIGNAL") {
      logViolation({ ...context, userId, deviceId, violationType, penalty: "telemetry" });
      return sendJson(response, { ok: true, telemetry: true });
    }
    escalate({ ...context, userId, deviceId }, violationType);
    if (sessionId) {
      sessions.delete(sessionId);
      state.revokedSessions[sessionId] = Date.now();
      saveState();
    }
    response.setHeader("Set-Cookie", cookie("mw_session", "", { httpOnly: true, sameSite: "Strict", maxAge: 0 }));
    return sendJson(response, { ok: true, redirect: "/" });
  }

  function securitySummary() {
    return {
      projectId: firebaseConfig.projectId || null,
      logs: state.logs.slice(-100).reverse(),
      bannedIps: objectRows(state.bannedIps),
      bannedAccounts: objectRows(state.bannedAccounts),
      bannedDevices: objectRows(state.bannedDevices),
      activeSessions: [...sessions.values()].map(publicSession),
      vipUsers: state.vipUsers
    };
  }

  function unban(request, response, body = {}) {
    const type = body.type;
    const value = String(body.value || "");
    if (type === "ip") delete state.bannedIps[value];
    if (type === "account") delete state.bannedAccounts[value];
    if (type === "device") delete state.bannedDevices[value];
    saveState();
    return sendJson(response, { ok: true, security: securitySummary() });
  }

  function secureHeaders(response) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    response.setHeader("Content-Security-Policy", [
      "default-src 'self' http: https:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://telegram.org https://*.telegram.org https://www.gstatic.com blob:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https: local:",
      "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://www.gstatic.com https://*.telegram.org wss://*.telegram.org blob: data: local: http: https: *",
      "worker-src 'self' blob:",
      "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
      "object-src 'none'",
      "base-uri 'self'"
    ].join("; "));
  }

  function forbidden(response, code) {
    return sendJson(response, { error: "Forbidden", code }, 403);
  }

  function enforceDomain(request, context) {
    if (!allowedOrigin(request, context)) {
      escalate(context, "DOMAIN_ORIGIN_BLOCKED");
      throwSecurityError("DOMAIN_ORIGIN_BLOCKED");
    }
  }

  function allowedOrigin(request, context) {
    const host = String(request.headers.host || "").split(":")[0].toLowerCase();
    const allowed = allowedHosts();
    if (allowed.length && !allowed.includes(host)) {
      return false;
    }

    for (const headerName of ["origin", "referer"]) {
      const value = request.headers[headerName];
      if (!value) continue;
      try {
        const originHost = new URL(value).hostname.toLowerCase();
        if (allowed.length && !allowed.includes(originHost)) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  function allowedHosts() {
    const configured = (env.ALLOWED_DOMAINS || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    return configured;
  }

  function enforceRate(context) {
    if (isLocalIp(context.ipAddress)) {
      return;
    }
    const accountKey = `account:${context.userId || "guest"}`;
    const ipKey = `ip:${context.ipAddress}`;
    if (!hitBucket(accountKey, ACCOUNT_LIMIT) || !hitBucket(ipKey, IP_LIMIT)) {
      escalate(context, "RATE_LIMIT_EXCEEDED");
      throwSecurityError("RATE_LIMIT_EXCEEDED");
    }
  }

  function blockAutomation(request, context) {
    const ua = String(request.headers["user-agent"] || "");
    if (!ua || BOT_UA.test(ua)) {
      escalate(context, "AUTOMATION_USER_AGENT");
      throwSecurityError("AUTOMATION_USER_AGENT");
    }
  }

  function validateSignedRequest(request, session, context) {
    const timestamp = Number(request.headers["x-request-timestamp"]);
    const nonce = cleanId(request.headers["x-request-nonce"]);
    const signature = String(request.headers["x-request-signature"] || "");
    if (!timestamp || Math.abs(Date.now() - timestamp) > API_TIMESTAMP_SKEW_MS || !nonce || !signature) {
      return false;
    }
    const nonceKey = `${session.id}:${nonce}`;
    if (usedNonces.has(nonceKey)) {
      return false;
    }
    const expected = hmac(`${request.method}:${request.url}:${timestamp}:${nonce}:${session.deviceHash}`, session.csrf);
    if (!timingSafe(signature, expected)) {
      return false;
    }
    usedNonces.set(nonceKey, Date.now() + API_TIMESTAMP_SKEW_MS);
    cleanupMap(usedNonces);
    return true;
  }

  function verifyMediaToken(token) {
    const [encrypted, sig] = String(token || "").split(".");
    if (!encrypted || !sig || !timingSafe(sig, hmac(encrypted, secret))) {
      return null;
    }
    const payload = decryptJson(encrypted, secret);
    if (!payload || payload.expiresAt < Date.now()) {
      return null;
    }
    return payload;
  }

  function rewriteMediaUrls(value, request, auth, parentKey, episodeMeta = {}) {
    if (Array.isArray(value)) {
      return value.map((item) => rewriteMediaUrls(item, request, auth, parentKey, episodeMeta));
    }

    if (value && typeof value === "object") {
      const rawNumber = Number(textValue(value, ["episodeNo", "episodeNumber", "chapterNo", "chapterNum", "chapter_num", "chapter_no", "chapterIndex", "chapter_index", "episode", "seqNo", "seq_no", "ep", "order", "serial_number", "episode_number", "episode_num", "episNum", "vid"]));
      const isEpisodeObj = Boolean(
        value.chapterId
        || value.chapter_id
        || value.episodeId
        || value.episode_id
        || value.episodeid
        || value.videoId
        || value.video_id
        || value.videoUrls
        || value.best_url
        || value.stream_url
        || value.cdn_url
        || value.m3u8_url
        || value.video_url
        || value.videoAddress
        || value.h264
        || value.duration
        || value.duration_ms
        || value.episodeNo
        || value.episodeNumber
        || value.chapterNo
        || value.episode
        || value.seqNo
        || value.seq_no
        || value.ep
        || value.order
        || value.serial_number
        || value.episNum
        || value.episId
        || value.mediaUrl
        || value.vid
        || value.cid
        || value.url
      );
      
      let isLocked = Boolean(value.isCharge || value.locked || value.vip || episodeMeta.locked);
      if (isEpisodeObj && Number.isFinite(rawNumber) && rawNumber > 0) {
        isLocked = rawNumber > 12;
      }

      const dramaTitleFromObj = textValue(value, ["dramaTitle", "dramaName", "seriesName", "seriesTitle", "series_title", "drama_title"]);
      const episodeNameFromObj = textValue(value, ["chapterName", "chapterTitle", "episodeName", "episodeTitle", "title", "name"]);

      const nextMeta = {
        episodeId: textValue(value, ["chapterId", "chapter_id", "episodeId", "episode_id", "episodeid", "id", "videoId", "video_id", "episId", "vid"]) || episodeMeta.episodeId,
        episodeName: (episodeNameFromObj !== dramaTitleFromObj ? episodeNameFromObj : "") || episodeMeta.episodeName || "",
        dramaTitle: dramaTitleFromObj || episodeMeta.dramaTitle || "",
        locked: isLocked,
        videoKey: value.videoKey || value.videokey || value.video_key || episodeMeta.videoKey || ""
      };
      if (nextMeta.videoKey) {
        console.log("[DEBUG rewriteMediaUrls] Found videoKey in object:", nextMeta.videoKey.substring(0, 20) + "...", "keys:", Object.keys(value).join(","));
      }
      // Identify if this object is a subtitle track wrapper (has lang, language, label, display_name, etc.)
      const keys = Object.keys(value);
      const isSubtitleObj = keys.some(k => /^(lang|language|label|display_name|subtitle|caption)/i.test(k));

      const output = {};
      for (const [key, item] of Object.entries(value)) {
        const isUrlValue = typeof item === "string" && /^(https?:)?\/\//i.test(item);
        const shouldProxy = isUrlValue && (
          isMediaUrl(item) ||
          isMediaFieldUrl(key, item) ||
          /^(subtitle|caption|vtt|srt)/i.test(key) ||
          (isSubtitleObj && key === "url")
        );

        if (shouldProxy) {
          if (nextMeta.locked && !auth.session.vip.active) {
            output[key] = "";
            output.locked = true;
            output.accessDenied = "VIP_REQUIRED";
            continue;
          }
          output[key] = signMediaUrl(item, auth, nextMeta);
          continue;
        }
        output[key] = rewriteMediaUrls(item, request, auth, key, nextMeta);
      }
      return output;
    }

    const isUrlValue = typeof value === "string" && /^(https?:)?\/\//i.test(value);
    const shouldProxy = isUrlValue && (
      isMediaUrl(value) ||
      isMediaFieldUrl(parentKey, value) ||
      /^(subtitle|caption|vtt|srt)/i.test(parentKey)
    );

    if (shouldProxy) {
      return signMediaUrl(value, auth, episodeMeta);
    }

    return value;
  }

  function escalate(context, violationType) {
    if (!isInspectViolation(violationType)) {
      logViolation({ ...context, violationType, penalty: "blocked" });
      return;
    }

    const key = `${context.userId || "guest"}:${context.ipAddress}:${context.deviceId || "unknown"}`;
    const count = (state.violations[key] || 0) + 1;
    state.violations[key] = count;

    let penalty = "session_revoked_ip_1h";
    if (count === 1) {
      state.bannedIps[context.ipAddress] = { until: Date.now() + INSPECT_FIRST_BLOCK_MS, reason: violationType };
    } else if (count === 2) {
      penalty = "session_revoked_ip_24h";
      state.bannedIps[context.ipAddress] = { until: Date.now() + INSPECT_SECOND_BLOCK_MS, reason: violationType };
    } else {
      penalty = "permanent_account_device_ban";
      state.bannedIps[context.ipAddress] = { until: null, reason: violationType };
      if (context.userId) state.bannedAccounts[context.userId] = { until: null, reason: violationType };
      if (context.deviceId) state.bannedDevices[context.deviceId] = { until: null, reason: violationType };
    }
    revokeUserSessions(context.userId);
    logViolation({ ...context, violationType, penalty });
  }

  function revokeUserSessions(userId) {
    if (!userId) return;
    for (const [sessionId, session] of sessions.entries()) {
      if (session.userId === userId) {
        sessions.delete(sessionId);
        state.revokedSessions[sessionId] = Date.now();
      }
    }
  }

  function logViolation(row) {
    state.logs.push({
      user_id: row.userId || "guest",
      ip_address: row.ipAddress || "unknown",
      user_agent: row.userAgent || "unknown",
      device_id: row.deviceId || "unknown",
      violation_type: row.violationType,
      timestamp: new Date().toISOString(),
      penalty: row.penalty || "logged"
    });
    saveState();
  }

  function getVipStatus(userId) {
    const vip = state.vipUsers[userId] || state.vipUsers[String(userId).toLowerCase()];
    if (!vip?.active) {
      return { active: false, expiresAt: null, source: firebaseConfig.projectId || "local" };
    }
    const expiresAt = vip.expiresAt || vip.vipUntil || vip.validUntil;
    const active = !expiresAt || Date.parse(expiresAt) > Date.now();
    return { active, expiresAt: expiresAt || null, source: firebaseConfig.projectId || "local", purchaseDate: vip.purchaseDate || null };
  }

  function purchaseVip(userId, planDays) {
    const now = new Date();
    const expires = new Date();
    expires.setDate(now.getDate() + planDays);
    
    // Normalize user ID to string
    const normalizedId = String(userId);
    
    state.vipUsers[normalizedId] = {
      active: true,
      purchaseDate: now.toISOString(),
      expiresAt: expires.toISOString()
    };
    saveState();
    return getVipStatus(normalizedId);
  }

  function removeVip(userId) {
    const normalizedId = String(userId);
    if (state.vipUsers[normalizedId]) {
      delete state.vipUsers[normalizedId];
    }
    const lowercaseId = normalizedId.toLowerCase();
    if (state.vipUsers[lowercaseId]) {
      delete state.vipUsers[lowercaseId];
    }
    saveState();
    return { active: false, expiresAt: null };
  }

  function getVipUsers() {
    return state.vipUsers;
  }

  function requestContext(request) {
    const ipAddress = String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
    const userAgent = String(request.headers["user-agent"] || "");
    const userId = cleanId(request.headers["x-user-id"]) || "guest";
    const deviceId = cleanId(request.headers["x-device-id"]) || "unknown";
    if (state.bannedIps[ipAddress] && !banExpired(state.bannedIps[ipAddress])) {
      throwSecurityError("IP_BANNED");
    }
    return { ipAddress, userAgent, userId, deviceId };
  }

  function publicSession(session) {
    return {
      userId: session.userId,
      sessionId: session.id,
      csrf: session.csrf,
      expiresAt: new Date(session.expiresAt).toISOString(),
      vip: session.vip
    };
  }

  return {
    issueSession,
    destroySession,
    requireSession,
    requirePremium,
    rewriteEpisodePayload,
    rewriteMediaUrls,
    proxySecureMedia,
    rewritePlaylist,
    reportViolation,
    securitySummary,
    unban,
    secureHeaders,
    sendJson,
    forbidden,
    signMediaUrl,
    purchaseVip,
    removeVip,
    getVipUsers,
    getVipStatus,
    logStreamPlay,
    getStreamLogs,
    clearStreamLogs
  };

  function hitBucket(key, limit) {
    const now = Date.now();
    const bucket = rateBuckets.get(key) || { resetAt: now + RATE_WINDOW_MS, count: 0 };
    if (bucket.resetAt < now) {
      bucket.resetAt = now + RATE_WINDOW_MS;
      bucket.count = 0;
    }
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    return bucket.count <= limit;
  }
}

export class SecurityError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function throwSecurityError(code) {
  throw new SecurityError(code);
}

function sendJson(response, data, statusCode = 200) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(data));
}

function encryptJson(payload, secret) {
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return base64url(Buffer.concat([iv, tag, encrypted]));
}

function decryptJson(value, secret) {
  try {
    const raw = Buffer.from(fromBase64url(value), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const key = crypto.createHash("sha256").update(secret).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

function hmac(value, secret) {
  return crypto.createHmac("sha256", secret).update(String(value)).digest("hex");
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function timingSafe(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function randomToken(size) {
  return base64url(crypto.randomBytes(size));
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  return parts.join("; ");
}

function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return null;
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(Boolean));
}

function cleanId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 160);
}

function resolveUserId(request, body) {
  const headerUser = cleanId(request.headers["x-user-id"]);
  if (headerUser) return headerUser;
  const bodyUser = cleanId(body.userId);
  if (bodyUser) return bodyUser;
  return "guest";
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, "=");
}

function cleanupMap(map) {
  const now = Date.now();
  for (const [key, expiresAt] of map.entries()) {
    if (expiresAt < now) map.delete(key);
  }
}

function objectRows(value) {
  return Object.entries(value).map(([id, data]) => ({ id, ...data }));
}

function banExpired(ban) {
  return ban?.until && ban.until < Date.now();
}

function isLocalIp(value) {
  return ["::1", "127.0.0.1", "::ffff:127.0.0.1"].includes(String(value));
}

function isInspectViolation(value) {
  return /DEVTOOLS|INSPECT|CONSOLE|DEBUGGER|SOURCES_PANEL|NETWORK_INSPECTOR|IFRAME_EMBED|JS_TAMPERING|DOM_TAMPERING/i.test(String(value || ""));
}

function textValue(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }
  return "";
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
  return /(avatar|banner|best|cdn|cover|hls|image|m3u8|media|mp4|photo|play|poster|src|thumb|video|subtitle|caption|vtt|srt|url)/i.test(key);
}
