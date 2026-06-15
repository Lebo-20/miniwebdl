/**
 * watch.js
 * Manages video streaming playback pages, player selection, and fallback routing.
 */
import { resolveEpisodeStreams } from "../api/streamResolver.js";
import { FallbackManager } from "../services/fallbackManager.js";
import { Html5Player } from "../player/html5Player.js";
import { HlsPlayer } from "../player/hlsPlayer.js";
import { DashPlayer } from "../player/dashPlayer.js";
import { EmbedPlayer } from "../player/embedPlayer.js";

let activePlayer = null;
let fallbackManager = null;
let nativeVideoErrorListener = null;
let statsInterval = null;

// Debug State for Admin Mode
const debugState = {
  active: false,
  videoId: "",
  episode: "",
  source: "",
  status: "LOADING",
  errorType: "",
  httpCode: null,
  responseTime: "N/A",
  streamUrl: "",
  device: "Unknown",
  browser: "Unknown",
  timestamp: "",
  
  bitrate: "N/A",
  resolution: "N/A",
  bufferLength: 0,
  retryCount: 0,
  maxRetries: 2,
  fallbackStatus: "",
  logs: [],
  screenshot: null,
  fallbackHistory: []
};

export function cleanupActivePlayer(videoElement = null) {
  console.log("[watch.js] Cleaning up active players.");
  
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }

  // Remove admin debug elements if present
  document.querySelector(".admin-debug-float-btn")?.remove();
  document.querySelector(".admin-debug-panel")?.remove();

  if (videoElement && nativeVideoErrorListener) {
    videoElement.removeEventListener("error", nativeVideoErrorListener);
    nativeVideoErrorListener = null;
  }

  if (activePlayer) {
    try {
      activePlayer.destroy();
    } catch (e) {
      console.warn("[watch.js] Error destroying player:", e);
    }
    activePlayer = null;
  }
  fallbackManager = null;
}

// Simple parser for device/browser
function getDeviceAndBrowser() {
  const ua = navigator.userAgent;
  let device = "PC";
  if (/android/i.test(ua)) device = "Android";
  else if (/ipad|iphone|ipod/i.test(ua)) device = "iOS";
  
  let browser = "Chrome";
  if (/firefox|fxios/i.test(ua)) browser = "Firefox";
  else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = "Safari";
  else if (/opr/i.test(ua)) browser = "Opera";
  else if (/edg/i.test(ua)) browser = "Edge";
  
  return { device, browser };
}

// Logs debug event
function logDebug(msg) {
  const time = new Date().toLocaleTimeString("id-ID", { hour12: false });
  const entry = `[${time}] ${msg}`;
  console.log(`[StreamDebug] ${entry}`);
  debugState.logs.push(entry);
  if (debugState.logs.length > 150) {
    debugState.logs.shift();
  }
  updateDebugPanelUi();
}

function injectDebugStyles() {
  if (document.getElementById("admin-debug-styles")) return;
  const style = document.createElement("style");
  style.id = "admin-debug-styles";
  style.textContent = `
    .admin-debug-float-btn {
      position: fixed;
      top: 90px;
      right: 15px;
      z-index: 9999;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #fff;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: bold;
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    .admin-debug-float-btn:hover {
      background: #ef4444;
      border-color: #ef4444;
      transform: scale(1.05);
    }
    .admin-debug-panel {
      position: absolute;
      top: 0;
      right: 0;
      width: 380px;
      height: 100%;
      background: rgba(15, 23, 42, 0.98);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-left: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: -10px 0 30px rgba(0,0,0,0.5);
      color: #cbd5e1;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      font-family: monospace;
      font-size: 11px;
      transform: translateX(100%);
      transition: transform 0.3s ease;
      overflow: hidden;
      text-align: left;
    }
    .admin-debug-panel.active {
      transform: translateX(0);
    }
    .admin-debug-header {
      padding: 12px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(0,0,0,0.2);
    }
    .admin-debug-header h3 {
      margin: 0;
      font-size: 13px;
      color: #fff;
    }
    .admin-debug-close {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 18px;
      cursor: pointer;
    }
    .admin-debug-tabs {
      display: flex;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(0,0,0,0.1);
    }
    .admin-debug-tab {
      flex: 1;
      padding: 8px;
      text-align: center;
      background: transparent;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 11px;
      border-bottom: 2px solid transparent;
    }
    .admin-debug-tab.active {
      color: #ef4444;
      border-bottom-color: #ef4444;
      background: rgba(255,255,255,0.02);
    }
    .admin-debug-body {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .admin-debug-info-row {
      display: flex;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      padding-bottom: 4px;
    }
    .admin-debug-info-label {
      color: #64748b;
      width: 100px;
      flex-shrink: 0;
    }
    .admin-debug-info-val {
      color: #f1f5f9;
      word-break: break-all;
    }
    .admin-debug-log-area {
      flex: 1;
      background: #090d16;
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 4px;
      padding: 8px;
      overflow-y: auto;
      font-size: 10px;
      color: #94a3b8;
      line-height: 1.4;
      white-space: pre-wrap;
    }
    .admin-debug-screenshot-box {
      width: 100%;
      height: 170px;
      background: #090d16;
      border: 1px dashed rgba(255,255,255,0.1);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .admin-debug-screenshot-img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .admin-debug-actions {
      padding: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
      gap: 8px;
    }
    .admin-debug-btn {
      flex: 1;
      background: #ef4444;
      color: white;
      border: none;
      padding: 8px 12px;
      border-radius: 4px;
      font-weight: bold;
      font-size: 11px;
      cursor: pointer;
      text-align: center;
    }
    .admin-debug-btn:hover {
      background: #dc2626;
    }
    .admin-debug-btn-secondary {
      background: rgba(255, 255, 255, 0.1);
      color: #f1f5f9;
    }
    .admin-debug-btn-secondary:hover {
      background: rgba(255, 255, 255, 0.15);
    }
  `;
  document.head.appendChild(style);
}

function renderDebugElements(container) {
  injectDebugStyles();

  // Create floating debug button
  const floatBtn = document.createElement("button");
  floatBtn.className = "admin-debug-float-btn";
  floatBtn.innerHTML = `<span>🐞</span> Debug`;
  floatBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = document.querySelector(".admin-debug-panel");
    if (panel) {
      panel.classList.toggle("active");
    }
  });
  container.appendChild(floatBtn);

  // Create overlay debug panel
  const panel = document.createElement("div");
  panel.className = "admin-debug-panel";
  panel.innerHTML = `
    <div class="admin-debug-header">
      <h3>🐞 Admin Debug Monitor</h3>
      <button class="admin-debug-close">&times;</button>
    </div>
    <div class="admin-debug-tabs">
      <button class="admin-debug-tab active" data-tab="info">Info</button>
      <button class="admin-debug-tab" data-tab="logs">Event Logs</button>
      <button class="admin-debug-tab" data-tab="screenshot">Last Snapshot</button>
    </div>
    <div class="admin-debug-body" id="adminDebugBody">
      <!-- Dynamic Tab Content -->
    </div>
    <div class="admin-debug-actions">
      <button class="admin-debug-btn" id="adminCopyReportBtn">Copy Error Report</button>
      <button class="admin-debug-btn admin-debug-btn-secondary" id="adminTogglePanelBtn">Close</button>
    </div>
  `;
  
  // Close buttons
  panel.querySelector(".admin-debug-close").addEventListener("click", () => panel.classList.remove("active"));
  panel.querySelector("#adminTogglePanelBtn").addEventListener("click", () => panel.classList.remove("active"));
  
  // Copy Error Report
  panel.querySelector("#adminCopyReportBtn").addEventListener("click", () => {
    const report = {
      drama_id: debugState.videoId,
      episode: debugState.episode,
      error: debugState.errorType || debugState.status,
      source: debugState.source || "N/A",
      fallback: debugState.fallbackStatus || "None",
      device: debugState.device,
      browser: debugState.browser,
      time: new Date().toISOString()
    };
    navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(() => {
      alert("Error report copied to clipboard!");
    }).catch(err => {
      console.error("Failed to copy report:", err);
    });
  });

  // Tabs toggle
  const tabs = panel.querySelectorAll(".admin-debug-tab");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const activeTab = tab.getAttribute("data-tab");
      renderActiveTabContent(activeTab);
    });
  });

  container.appendChild(panel);
  renderActiveTabContent("info");
}

function renderActiveTabContent(tabName) {
  const body = document.getElementById("adminDebugBody");
  if (!body) return;

  if (tabName === "info") {
    body.innerHTML = `
      <div class="admin-debug-info-row">
        <div class="admin-debug-info-label">Video ID</div>
        <div class="admin-debug-info-val">${debugState.videoId}</div>
      </div>
      <div class="admin-debug-info-row">
        <div class="admin-debug-info-label">Episode</div>
        <div class="admin-debug-info-val">${debugState.episode}</div>
      </div>
      <div class="admin-debug-info-row">
        <div class="admin-debug-info-label">Active CDN</div>
        <div class="admin-debug-info-val">${debugState.source || 'None'}</div>
      </div>
      <div class="admin-debug-info-row">
        <div class="admin-debug-info-label">Status</div>
        <div class="admin-debug-info-val" style="color: ${debugState.status === 'ERROR' ? '#ef4444' : debugState.status === 'PLAYING' ? '#22c55e' : '#eab308'}">${debugState.status}</div>
      </div>
      <div class="admin-debug-info-row">
        <div class="admin-debug-info-label">Resolution</div>
        <div class="admin-debug-info-val">${debugState.resolution}</div>
      </div>
      <div class="admin-debug-info-row">
        <div class="admin-debug-info-label">Bitrate</div>
        <div class="admin-debug-info-val">${debugState.bitrate}</div>
      </div>
      <div class="admin-debug-info-row">
        <div class="admin-debug-info-label">Buffer</div>
        <div class="admin-debug-info-val">${debugState.bufferLength}s</div>
      </div>
      <div class="admin-debug-info-row">
        <div class="admin-debug-info-label">Retry Count</div>
        <div class="admin-debug-info-val">${debugState.retryCount}/${debugState.maxRetries}</div>
      </div>
      <div class="admin-debug-info-row">
        <div class="admin-debug-info-label">Fallback Status</div>
        <div class="admin-debug-info-val">${debugState.fallbackStatus || 'None'}</div>
      </div>
      <div class="admin-debug-info-row">
        <div class="admin-debug-info-label">Device</div>
        <div class="admin-debug-info-val">${debugState.device}</div>
      </div>
      <div class="admin-debug-info-row">
        <div class="admin-debug-info-label">Browser</div>
        <div class="admin-debug-info-val">${debugState.browser}</div>
      </div>
      <div class="admin-debug-info-row" style="border: none;">
        <div class="admin-debug-info-label">Stream URL</div>
        <div class="admin-debug-info-val" style="font-size: 9px; line-height: 1.3;">${debugState.streamUrl || 'N/A'}</div>
      </div>
    `;
  } else if (tabName === "logs") {
    body.innerHTML = `
      <div class="admin-debug-log-area" id="adminDebugLogArea">${debugState.logs.join("\n")}</div>
    `;
    const logArea = document.getElementById("adminDebugLogArea");
    if (logArea) logArea.scrollTop = logArea.scrollHeight;
  } else if (tabName === "screenshot") {
    if (debugState.screenshot) {
      body.innerHTML = `
        <div class="admin-debug-screenshot-box">
          <img class="admin-debug-screenshot-img" src="${debugState.screenshot}" alt="Last Fail Snapshot" />
        </div>
        <div style="font-size: 10px; color: #94a3b8; text-align: center; margin-top: 4px;">Thumbnail generated automatically upon stream error.</div>
      `;
    } else {
      body.innerHTML = `
        <div class="admin-debug-screenshot-box">
          <span style="color: #64748b;">No error snapshot captured yet.</span>
        </div>
      `;
    }
  }
}

function updateDebugPanelUi() {
  const panel = document.querySelector(".admin-debug-panel");
  if (!panel || !panel.classList.contains("active")) return;
  
  const activeTabBtn = panel.querySelector(".admin-debug-tab.active");
  if (activeTabBtn) {
    renderActiveTabContent(activeTabBtn.getAttribute("data-tab"));
  }
}

function captureScreenshot(video) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;
    const ctx = canvas.getContext("2d");
    
    // Draw current frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Draw text overlay on frame
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(0, 0, canvas.width, 45);
    
    ctx.font = "14px monospace";
    ctx.fillStyle = "#ef4444";
    ctx.fillText(`🐞 STREAM ERROR DETECTED`, 15, 25);
    
    ctx.font = "10px monospace";
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(`Type: ${debugState.errorType || 'Unknown'} | Time: ${new Date().toLocaleTimeString("id-ID")}`, 15, 40);
    
    debugState.screenshot = canvas.toDataURL("image/png");
  } catch (e) {
    console.warn("[watch.js] CORS block on canvas screenshot, drawing mockup card.");
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d");
    
    const grad = ctx.createLinearGradient(0, 0, 640, 360);
    grad.addColorStop(0, "#0f172a");
    grad.addColorStop(1, "#1e293b");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 640, 360);
    
    ctx.font = "40px sans-serif";
    ctx.fillText("🐞", 300, 130);
    
    ctx.font = "16px monospace";
    ctx.fillStyle = "#ef4444";
    ctx.textAlign = "center";
    ctx.fillText("ERROR IN STREAM PLAYBACK", 320, 190);
    
    ctx.font = "11px monospace";
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(`URL: ${debugState.streamUrl ? debugState.streamUrl.substring(0, 60) + "..." : "N/A"}`, 320, 230);
    ctx.fillText(`Time: ${new Date().toISOString()}`, 320, 250);
    ctx.fillText(`CDN: ${debugState.source} | Episode: ${debugState.episode}`, 320, 270);
    
    debugState.screenshot = canvas.toDataURL("image/png");
  }
}

function startStatsMonitoring(video) {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(() => {
    if (!video) return;
    
    if (video.videoWidth) {
      debugState.resolution = `${video.videoWidth}x${video.videoHeight}`;
    }
    
    // Buffer length
    let buffer = 0;
    const time = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);
      if (time >= start && time <= end) {
        buffer = end - time;
        break;
      }
    }
    debugState.bufferLength = Number(buffer.toFixed(1));
    
    // Bitrate & quality estimates (HLS.js specific)
    if (activePlayer && activePlayer.hls) {
      const hls = activePlayer.hls;
      if (hls.levels && hls.currentLevel !== -1 && hls.levels[hls.currentLevel]) {
        const level = hls.levels[hls.currentLevel];
        debugState.bitrate = level.bitrate ? `${(level.bitrate / 1000000).toFixed(2)} Mbps` : "N/A";
        if (level.attrs && level.attrs.RESOLUTION) {
          debugState.resolution = level.attrs.RESOLUTION;
        }
      }
    } else {
      debugState.bitrate = "N/A";
    }
    
    updateDebugPanelUi();
  }, 1000);
}

/**
 * Resolves streams and mounts the appropriate player with multi-source fallback.
 */
export async function mountWatchPlayer(drama, episode, episodeNumber, allSources, platformApi, secureFetch, subtitleLang = "off") {
  const container = document.querySelector("#playerShell");
  const video = container?.querySelector("video.real-video, video.moviebox-video-element");
  const message = container?.querySelector("#videoMessage");

  // Clean up any previously active players/listeners before starting
  cleanupActivePlayer(video);

  const showMessage = (msg) => {
    if (message) {
      message.innerHTML = `<span>${msg}</span>`;
      message.style.display = "flex";
    }
  };

  const clearMessage = () => {
    if (message) {
      message.style.display = "none";
      message.innerHTML = "";
    }
  };

  if (!container || !video) {
    console.error("[watch.js] Target DOM player elements not found.");
    return;
  }

  // 1. Initialize Debug State
  const clientInfo = getDeviceAndBrowser();
  debugState.videoId = drama?.id || "unknown";
  debugState.episode = String(episodeNumber);
  debugState.source = "";
  debugState.status = "CONNECTING";
  debugState.errorType = "";
  debugState.httpCode = null;
  debugState.responseTime = "N/A";
  debugState.streamUrl = "";
  debugState.device = clientInfo.device;
  debugState.browser = clientInfo.browser;
  debugState.timestamp = new Date().toISOString();
  debugState.bitrate = "N/A";
  debugState.resolution = "N/A";
  debugState.bufferLength = 0;
  debugState.retryCount = 0;
  debugState.fallbackStatus = "";
  debugState.logs = [];
  debugState.screenshot = null;

  logDebug("Initializing player connection to API server...");
  showMessage("<span class='inline-dot-loader' aria-label='Memuat'></span> Menghubungkan ke API server...");

  // Check if current user is admin (instant mount check + background API verification)
  let isUserAdminOnFrontend = !!localStorage.getItem("adminToken");

  if (isUserAdminOnFrontend) {
    logDebug("Admin token found in local storage. Mounting debug tools instantly.");
    renderDebugElements(container);
    startStatsMonitoring(video);
  }

  // Probe API in the background to verify admin status
  const userIdForProbe = window.telegram?.initDataUnsafe?.user?.id 
    ? `tg-${window.telegram.initDataUnsafe.user.id}` 
    : (localStorage.getItem("TEAMDLUserId") || "guest");
  const adminTokenForProbe = localStorage.getItem("adminToken") || "";
  
  fetch(`/api/watch-party/check-admin?userId=${encodeURIComponent(userIdForProbe)}&adminToken=${encodeURIComponent(adminTokenForProbe)}`)
    .then(r => r.json())
    .then(data => {
      const isVerifiedAdmin = !!data.isAdmin;
      if (isVerifiedAdmin && !isUserAdminOnFrontend) {
        logDebug("Admin status verified by server. Mounting debug tools.");
        renderDebugElements(container);
        startStatsMonitoring(video);
      } else if (!isVerifiedAdmin && isUserAdminOnFrontend) {
        logDebug("Admin verification failed. Removing debug tools.");
        document.querySelector(".admin-debug-float-btn")?.remove();
        document.querySelector(".admin-debug-panel")?.remove();
        if (statsInterval) {
          clearInterval(statsInterval);
          statsInterval = null;
        }
      }
    }).catch(e => {
      console.warn("[watch.js] Background admin check failed:", e);
    });

  // 1. Resolve candidate URLs and settings from platform APIs
  console.log(`[watch.js] Fetching streams for drama=${drama.id}, episode=${episodeNumber}`);
  logDebug(`Resolving episode streams from platform APIs...`);
  
  const startTime = Date.now();
  const resolved = await resolveEpisodeStreams(drama, episode, episodeNumber, allSources, platformApi, secureFetch, subtitleLang);
  const resolveTime = Date.now() - startTime;
  debugState.responseTime = `${resolveTime}ms`;

  if (resolved.error === "VIP_REQUIRED" || resolved.episode?.accessDenied === "VIP_REQUIRED") {
    logDebug("Access Denied: VIP purchase required.");
    showMessage("Episode khusus VIP. Silakan beli VIP untuk menonton.");
    return;
  }

  const urls = resolved.urls || [];
  if (urls.length === 0) {
    logDebug("Stream resolution completed. No active streams found.");
    showMessage("Video belum bisa diputar dari sumber platform ini. Coba episode lain.");
    return;
  }

  logDebug(`Stream resolution finished. Found ${urls.length} candidates.`);
  console.log(`[watch.js] Stream resolution completed. Found ${urls.length} candidates.`);

  // 2. Setup FallbackManager
  fallbackManager = new FallbackManager(
    urls,
    (url, type) => {
      // onSourceReady
      clearMessage();
      debugState.status = "PLAYING";
      debugState.streamUrl = url;
      
      const cdnName = `CDN-${String.fromCharCode(65 + fallbackManager.currentIndex)}`;
      debugState.source = cdnName;
      logDebug(`Playback Ready. Mounting player type: ${type} (via ${cdnName})`);
      console.log(`[watch.js] Playback ready. Mounting player of type: ${type}`);

      // Destroy old active player first
      if (activePlayer) {
        try {
          activePlayer.destroy();
        } catch (e) {
          console.warn("[watch.js] Failed to destroy player:", e);
        }
      }

      const playerOptions = {
        videoElement: video,
        containerElement: container,
        onLoaded: () => {
          logDebug(`Player content loaded successfully. Starting playback.`);
          console.log(`[watch.js] Player mounted successfully and content loaded.`);
          clearMessage();
        },
        onError: (err) => {
          logDebug(`Player reported error: ${err.message || err}`);
          console.warn(`[watch.js] Player error event:`, err);
          
          debugState.status = "ERROR";
          debugState.errorType = err.type || "PLAYER_ERROR";
          
          // Capture failure frame
          captureScreenshot(video);
          
          // Send client-side error to backend stream logs
          const userId = window.telegram?.initDataUnsafe?.user?.id 
            ? `tg-${window.telegram.initDataUnsafe.user.id}` 
            : (localStorage.getItem("TEAMDLUserId") || "guest");
          const deviceId = localStorage.getItem("TEAMDLDeviceId") || "unknown";

          fetch("/api/security/log-stream-error", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId,
              deviceId,
              episodeId: episode?.id || episodeNumber,
              episodeName: episode?.name || `Episode ${episodeNumber}`,
              dramaTitle: drama?.title || "",
              url,
              error: String(err.message || err || "Player playback error"),
              errorType: debugState.errorType,
              httpCode: debugState.httpCode,
              responseTime: debugState.responseTime,
              device: debugState.device,
              browser: debugState.browser,
              cdn: debugState.source
            })
          }).catch(() => {});

          fallbackManager.handlePlayerError(err);
        }
      };

      // Auto routing based on check types
      if (type === "hls") {
        activePlayer = new HlsPlayer(playerOptions);
      } else if (type === "dash") {
        activePlayer = new DashPlayer(playerOptions);
      } else if (type === "embed") {
        activePlayer = new EmbedPlayer(playerOptions);
      } else {
        activePlayer = new Html5Player(playerOptions);
      }

      activePlayer.play(url);
    },
    () => {
      // onAllFailed
      debugState.status = "ERROR";
      debugState.errorType = "ALL_SOURCES_FAILED";
      logDebug("Playback Failed: All video streams failed to connect.");
      showMessage("Gagal memuat video dari semua server platform. Silakan coba episode lain.");

      // Send telemetry error log to backend
      const userId = window.telegram?.initDataUnsafe?.user?.id 
        ? `tg-${window.telegram.initDataUnsafe.user.id}` 
        : (localStorage.getItem("TEAMDLUserId") || "guest");
      const deviceId = localStorage.getItem("TEAMDLDeviceId") || "unknown";

      fetch("/api/security/log-stream-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          deviceId,
          episodeId: episode?.id || episodeNumber,
          episodeName: episode?.name || `Episode ${episodeNumber}`,
          dramaTitle: drama?.title || "",
          url: urls.join(" | ") || "No candidate URLs",
          error: "All stream sources failed validation probe",
          errorType: "ALL_SOURCES_FAILED",
          device: debugState.device,
          browser: debugState.browser,
          cdn: "ALL_CDNS"
        })
      }).catch(() => {});
    },
    (msg) => {
      // onMessage
      if (msg.includes("mencoba memuat ulang")) {
        debugState.retryCount = fallbackManager.retryCount;
        logDebug(`Connection Interrupted. Retry attempt #${debugState.retryCount}/${debugState.maxRetries}...`);
      } else if (msg.includes("Menghubungkan ke server")) {
        const targetCdn = `CDN-${String.fromCharCode(65 + fallbackManager.currentIndex)}`;
        if (debugState.source && debugState.source !== targetCdn) {
          debugState.fallbackStatus = `Switching from ${debugState.source} to ${targetCdn}`;
          logDebug(`Fall back trigger: Switching target stream to ${targetCdn}`);
        }
      }
      showMessage(msg);
    }
  );

  // Hook error event on native video element to trigger fallback switch
  nativeVideoErrorListener = () => {
    if (activePlayer && !(activePlayer instanceof EmbedPlayer)) {
      logDebug("Native HTML5 video element reported playback interruption.");
      fallbackManager.handlePlayerError("Native video tag reported playback failure");
    }
  };
  video.addEventListener("error", nativeVideoErrorListener);

  // Hook other video state events
  const onPlay = () => {
    logDebug("Playback Started");
  };
  const onPlaying = () => {
    debugState.status = "PLAYING";
    logDebug("Playback Restored Successfully");
  };
  const onPause = () => {
    logDebug("Playback Paused");
  };
  const onWaiting = () => {
    debugState.status = "BUFFERING";
    logDebug("Buffering Started");
  };
  
  video.addEventListener("play", onPlay);
  video.addEventListener("playing", onPlaying);
  video.addEventListener("pause", onPause);
  video.addEventListener("waiting", onWaiting);

  // Clean up native listeners when player is destroyed
  const originalCleanup = cleanupActivePlayer;
  cleanupActivePlayer = (v) => {
    if (v) {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("waiting", onWaiting);
    }
    originalCleanup(v);
  };

  // Start checking and playing
  await fallbackManager.start();
}
