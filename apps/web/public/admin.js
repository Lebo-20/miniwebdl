import { syncPlatformSources } from "./firebase-sync.js";

async function authFetch(url, options = {}) {
  const token = localStorage.getItem("adminToken");
  options.headers = options.headers || {};
  if (token) {
    options.headers["Authorization"] = `Bearer ${token}`;
  }
  
  const response = await fetch(url, options);
  if (response.status === 401) {
    showLoginOverlay();
    throw new Error("Unauthorized");
  }
  return response;
}

function showLoginOverlay() {
  const overlay = document.querySelector("#adminLoginOverlay");
  if (overlay) {
    overlay.style.display = "flex";
  }
  const sidebar = document.querySelector("#sidebar");
  const layout = document.querySelector(".admin-layout");
  if (sidebar) sidebar.style.display = "none";
  if (layout) layout.style.display = "none";
}

function hideLoginOverlay() {
  const overlay = document.querySelector("#adminLoginOverlay");
  if (overlay) {
    overlay.style.display = "none";
  }
  const sidebar = document.querySelector("#sidebar");
  const layout = document.querySelector(".admin-layout");
  if (sidebar) sidebar.style.display = "flex";
  if (layout) layout.style.display = "block";
}


const navItems = [
  ["Overview", "dashboard"],
  ["Users", "group"],
  ["VIP", "diamond"],
  ["Payment", "payment"],
  ["Platform", "platform"],
  ["Source", "source"],
  ["Content", "content"],
  ["Episode", "episode"],
  ["Streaming", "stream"],
  ["Analytics", "analytics"],
  ["Telegram Bot", "bot"],
  ["Security", "security"],
  ["Settings", "settings"]
];

const metrics = [
  ["Total User", "12.840", "+12.5%"],
  ["Total VIP", "1.276", "+3.2%"],
  ["Online User", "348", "Live"],
  ["Streaming Hari Ini", "38.902", "+8.1%"],
  ["Total Revenue", "Rp 24.6jt", "+18%"],
  ["Total Platform", "32", "30 aktif"]
];

const platforms = [
  ["StarShort", "active"], ["DramaBite", "active"], ["FreeReels", "active"], ["FunDrama", "active"],
  ["MicroDrama", "active"], ["Vigloo", "active"], ["BiliTV", "active"], ["DramaBox", "active"],
  ["DramaWave", "active"], ["NetShort", "active"], ["iDrama", "active"], ["ShortMax", "active"],
  ["GoodShort", "active"], ["Melolo", "active"], ["Velolo", "active"], ["ReelShort", "active"],
  ["FlickReels", "active"], ["Stardusttv", "active"], ["Serial+", "active"], ["DotDrama", "active"],
  ["RapidTV", "active"], ["ShortsWave", "active"], ["DramaNova", "active"], ["CubeTV", "active"],
  ["ReelBuzz", "active"], ["FlareFlow", "active"], ["MoboReels", "active"], ["HappyShort", "active"],
  ["Reelife", "active"], ["PineDrama", "active"], ["FlexTV", "maintenance"], ["Realala", "maintenance"]
];

const modules = [
  ["Dashboard", "Statistik realtime user, VIP, online, streaming, views, revenue, server, Redis, database, dan bot."],
  ["User Management", "Daftar, cari, detail, edit, ban, unban, hapus, reset session, login dan device history."],
  ["VIP Management", "Tambah, kurangi, perpanjang, cabut VIP, riwayat, paket 7/30/90/365 hari dan lifetime."],
  ["Payment Management", "Pending, success, failed, refund, QRIS, Dana, OVO, GoPay, ShopeePay, dan transfer bank."],
  ["Platform Manager", "Tambah, edit, hapus, ON/OFF, maintenance, sort, upload logo, dan API configuration."],
  ["Source Manager", "Upload, edit, delete, reload, backup, restore source TXT dan JSON."],
  ["Source Mapping", "Hubungkan source ke platform, unlink, auto detect error, dan auto maintenance."],
  ["Content Management", "Tambah, edit, hapus, import, bulk import drama, poster, banner, genre, rating, tahun, negara."],
  ["Episode Management", "Tambah, edit, hapus, bulk upload, auto numbering, video URL, subtitle, dan thumbnail."],
  ["Streaming Manager", "HLS URL, multi quality, subtitle, audio track, 360p, 480p, 720p, 1080p, dan 4K."],
  ["Banner Manager", "Homepage, featured, promo banner, upload, edit, delete, dan schedule."],
  ["Search Management", "Search index, rebuild index, search cache, dan search analytics."],
  ["Favorite Management", "Total favorite, user favorite, dan popular favorite."],
  ["Watch History", "Riwayat user, last watch, dan continue watching."],
  ["Analytics", "Daily views, monthly views, active users, watch time, top drama, top platform, top search."],
  ["API Manager", "API status, API logs, API key, API limit per platform."],
  ["Telegram Bot Manager", "Bot status, broadcast, announcement, auto message, dan deep link generator."],
  ["Telegram Mini App", "Mini app status, theme settings, menu settings, dan start page settings."],
  ["Notification Manager", "Push, Telegram, system notification untuk semua user, VIP user, dan platform tertentu."],
  ["Security Center", "Login logs, failed login, suspicious activity, device tracking, IP tracking, dan session management."],
  ["Website Settings", "Site name, logo, favicon, theme, dan SEO settings."],
  ["UI Theme Manager", "Dark mode, light mode, accent color, dan custom CSS."],
  ["File Manager", "Upload poster, banner, logo, subtitle, Cloudflare R2, dan local storage."],
  ["Cache Manager", "Redis status, clear cache, rebuild cache, dan cache statistics."],
  ["Health Monitor", "CPU, RAM, disk, Redis, PostgreSQL, API status, healthy, warning, dan critical."],
  ["Audit Logs", "Catatan semua aktivitas admin yang tidak dapat dihapus oleh admin biasa."],
  ["Role Management", "SUPER_ADMIN, ADMIN, MODERATOR, SUPPORT, dan permission per modul."]
];

const health = [
  ["Server", "Healthy", "ok"],
  ["Redis", "Healthy", "ok"],
  ["Database", "Healthy", "ok"],
  ["Telegram Bot", "Online", "ok"],
  ["Source API", "Warning", "warn"],
  ["Storage", "Healthy", "ok"]
];

const payments = [
  ["Mauta", "VIP 30 Hari", "QRIS", "Pending"],
  ["User 8821", "VIP 365 Hari", "Dana", "Pending"],
  ["User 1930", "VIP Lifetime", "Bank Transfer", "Review"]
];

const MODULES_PER_PAGE = 6;
let modulePage = 0;
let moduleSearchQuery = "";

async function checkAuth() {
  const token = localStorage.getItem("adminToken");
  if (!token) {
    showLoginOverlay();
    return false;
  }
  try {
    const res = await fetch("/api/security/admin", {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (res.status === 401) {
      showLoginOverlay();
      return false;
    }
    return true;
  } catch (err) {
    showLoginOverlay();
    return false;
  }
}

initLoginListeners();
render();
checkAuth().then((authorized) => {
  if (authorized) {
    loadAdminData().then(() => {
      initVipAndPaymentListeners();
      initPasswordChangeListeners();
      initSettingsConfigListeners();
      initNotificationCenterListeners();
      initStreamLogListeners();
      hideLoginOverlay();
    }).catch((err) => {
      console.error("Admin Panel initialization failed:", err);
    });
  }
});

document.querySelector("#menuToggle").addEventListener("click", () => {
  document.body.classList.toggle("sidebar-open");
});

document.querySelector("#sidebarBackdrop")?.addEventListener("click", () => {
  document.body.classList.remove("sidebar-open");
});

document.querySelector("#syncFirebase")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const original = button.textContent;
  button.textContent = "Syncing...";
  button.disabled = true;

  try {
    const result = await syncPlatformSources();
    button.textContent = `Synced ${result.endpointCount}`;
  } catch (error) {
    button.textContent = "Sync Gagal";
    console.error(error);
    alert(`Firebase sync gagal: ${error.message}`);
  } finally {
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 2500);
  }
});

document.querySelector("#adminSearch").addEventListener("input", (event) => {
  moduleSearchQuery = event.target.value.toLowerCase().trim();
  modulePage = 0;
  renderModuleGrid();
});

document.querySelector("#modulePrevBtn")?.addEventListener("click", () => {
  modulePage = Math.max(0, modulePage - 1);
  renderModuleGrid();
});

document.querySelector("#moduleNextBtn")?.addEventListener("click", () => {
  modulePage += 1;
  renderModuleGrid();
});

document.querySelector("#botUserSearch")?.addEventListener("input", (event) => {
  const q = event.target.value.toLowerCase().trim();
  const filtered = q
    ? botUsersCache.filter((user) => `${user.telegramId} ${user.userId} ${user.firstName} ${user.lastName} ${user.username} ${user.status}`.toLowerCase().includes(q))
    : botUsersCache;
  renderBotUsers(filtered);
});

document.querySelector("#sourceFile")?.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  const label = document.querySelector("#sourceFileLabel");
  if (label) {
    label.textContent = file ? file.name : "Pilih file .txt atau .json";
  }

  if (file) {
    const ext = file.name.split(".").pop()?.toLowerCase();
    const type = document.querySelector("#sourceType");
    if (type && (ext === "txt" || ext === "json")) {
      type.value = ext;
    }

    const platform = document.querySelector("#sourcePlatform");
    if (platform && !platform.value.trim()) {
      platform.value = file.name.replace(/\.[^.]+$/g, "").replace(/_endpoints$/i, "").replace(/[_-]+/g, " ");
    }
  }
});

document.querySelector("#sourceUploadForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.querySelector("#sourceUploadStatus");
  const fileInput = document.querySelector("#sourceFile");
  const file = fileInput?.files?.[0];

  if (!file) {
    setSourceStatus("Pilih file dulu.", "warn");
    return;
  }

  const type = document.querySelector("#sourceType")?.value || "txt";
  const platform = document.querySelector("#sourcePlatform")?.value || "";
  const content = await file.text();

  if (status) {
    status.textContent = "Menyimpan...";
    status.dataset.tone = "";
  }

  try {
    const response = await authFetch("/api/sources/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        platform,
        filename: file.name,
        content
      })
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Upload gagal");
    }

    setSourceStatus(`Tersimpan: ${result.file}`, "ok");
    form.reset();
    document.querySelector("#sourceFileLabel").textContent = "Pilih file .txt atau .json";
    await loadSourcePanel();
    await loadSourceFiles();
    await loadSourceHistory();
  } catch (error) {
    setSourceStatus(error.message, "warn");
  }
});

function render() {
  const adminSection = [
    { label: "Overview", icon: "dashboard", href: "#overview" },
    { label: "Kelola VIP", icon: "diamond", href: "#vip-admin-panel" },
    { label: "Riwayat Transaksi", icon: "payment", href: "#payment-panel" },
    { label: "Zero Trust Security", icon: "security", href: "#security-center" },
    { label: "Notifikasi Platform", icon: "notification", href: "#platform-notifications" },
    { label: "User Bot", icon: "group", href: "#bot-users-panel" },
    { label: "Telegram Bot", icon: "bot", href: "#telegram-bot" },
    { label: "Settings", icon: "settings", href: "#settings" }
  ];

  const streamingSection = [
    { label: "Mini Web Home", icon: "home", href: "/" },
    { label: "Beli VIP Page", icon: "diamond", href: "/vip" },
    { label: "Platform Catalog", icon: "platform", href: "/platform" },
    { label: "Pencarian Drama", icon: "search", href: "/search" }
  ];

  document.querySelector("#sideNav").innerHTML = `
    <div class="nav-section-title">ADMIN PANEL MODULES</div>
    ${adminSection.map((item, index) => `
      <a class="side-link ${index === 0 ? "active" : ""}" href="${item.href}">
        <span>${iconLabel(item.icon)}</span>
        <strong>${item.label}</strong>
      </a>
    `).join("")}
    
    <div class="nav-section-divider"></div>
    <div class="nav-section-title">WEB STREAMING PORTAL</div>
    ${streamingSection.map(item => `
      <a class="side-link" href="${item.href}" target="_blank">
        <span>${iconLabel(item.icon)}</span>
        <strong>${item.label}</strong>
        <small class="nav-external-indicator">↗</small>
      </a>
    `).join("")}
  `;

  document.querySelector("#metrics").innerHTML = metrics.map(([label, value, trend]) => `
    <article class="metric-card">
      <span>${label}</span>
      <strong>${value}</strong>
      <em>${trend}</em>
    </article>
  `).join("");

  document.querySelector("#activePlatforms").innerHTML = platforms
    .filter(([, status]) => status === "active")
    .map(platformCard)
    .join("");

  const maintEl = document.querySelector("#maintenancePlatforms");
  if (maintEl) {
    maintEl.innerHTML = platforms
      .filter(([, status]) => status === "maintenance")
      .map(([name]) => `
        <a class="maintenance-item" href="/api/platform/${slug(name)}">
          <span>${logoText(name)}</span>
          <strong>${name}</strong>
          <em>Perbaikan</em>
        </a>
      `).join("");
  }

  renderModuleGrid();

  document.querySelector("#healthList").innerHTML = health.map(([name, status, tone]) => `
    <div class="health-item">
      <span class="status ${tone}"></span>
      <strong>${name}</strong>
      <em>${status}</em>
    </div>
  `).join("");

  const paymentRows = document.querySelector("#paymentRows");
  if (paymentRows) {
    paymentRows.innerHTML = payments.map(([user, plan, method, status]) => `
      <tr>
        <td>${user}</td>
        <td>${plan}</td>
        <td>${method}</td>
        <td><span class="table-status">${status}</span></td>
        <td><button type="button" class="small-button">Review</button></td>
      </tr>
    `).join("");
  }
}

function renderModuleGrid() {
  const grid = document.querySelector("#moduleGrid");
  const pageInfo = document.querySelector("#modulePageInfo");
  const prevBtn = document.querySelector("#modulePrevBtn");
  const nextBtn = document.querySelector("#moduleNextBtn");
  if (!grid) {
    return;
  }

  const filteredModules = moduleSearchQuery
    ? modules.filter(([title, body]) => `${title} ${body}`.toLowerCase().includes(moduleSearchQuery))
    : modules;
  const totalPages = Math.max(1, Math.ceil(filteredModules.length / MODULES_PER_PAGE));
  modulePage = Math.min(modulePage, totalPages - 1);
  const start = modulePage * MODULES_PER_PAGE;
  const visibleModules = filteredModules.slice(start, start + MODULES_PER_PAGE);

  grid.innerHTML = visibleModules.length ? visibleModules.map(([title, body]) => `
    <a class="module-card" id="${slug(title)}" href="#${slug(title)}">
      <strong>${title}</strong>
      <span>${body}</span>
    </a>
  `).join("") : `<div class="empty-source">Modul tidak ditemukan.</div>`;

  if (pageInfo) {
    const from = filteredModules.length ? start + 1 : 0;
    const to = Math.min(start + MODULES_PER_PAGE, filteredModules.length);
    pageInfo.textContent = `${from}-${to} dari ${filteredModules.length} modul`;
  }
  if (prevBtn) {
    prevBtn.disabled = modulePage === 0;
  }
  if (nextBtn) {
    nextBtn.disabled = modulePage >= totalPages - 1;
  }
}

async function loadSourcePanel() {
  const sources = await authFetch("/api/sources").then((response) => response.json());
  const endpointCount = sources.reduce((total, source) => total + source.endpoints.length, 0);
  const counter = document.querySelector("#sourceCounter");
  const list = document.querySelector("#sourceList");

  if (counter) {
    counter.textContent = `${endpointCount} Endpoint`;
  }

  if (list) {
    list.innerHTML = sources.map((source) => `
      <a class="health-item" href="/api/sources/${source.slug}">
        <span class="status ${source.status === "active" ? "ok" : "warn"}"></span>
        <strong>${source.platform}</strong>
        <em>${source.endpoints.length} endpoint</em>
      </a>
    `).join("");
  }
}

async function loadAdminData() {
  const [menu, sources] = await Promise.all([
    authFetch("/api/menu").then((response) => response.json()).catch(() => null),
    authFetch("/api/sources").then((response) => response.json()).catch(() => [])
  ]);

  renderDynamicMenu(menu);
  renderDynamicMetrics(sources);
  renderDynamicPlatforms(sources);
  renderDynamicMaintenance(sources);
  await loadSourcePanel();
  await loadSourceFiles();
  await loadSourceHistory();
  await loadPlatformNotifications();
  renderPlatformPlayabilityPlaceholder();
  await loadBotUsersPanel();
  await loadSecurityPanel();
  await loadVipAdminPanel();
  await loadPaymentPanel();
}

function renderDynamicMenu(menu) {
  const adminSection = [
    { label: "Overview", icon: "dashboard", href: "#overview" },
    { label: "Drama Management", icon: "content", href: "#drama-management-panel" },
    { label: "Episode Management", icon: "episode", href: "#episode-management-panel" },
    { label: "User Bot", icon: "group", href: "#bot-users-panel" },
    { label: "Kelola VIP", icon: "diamond", href: "#vip-admin-panel" },
    { label: "Telegram Bot", icon: "bot", href: "#telegram-bot" },
    { label: "Riwayat Transaksi", icon: "payment", href: "#payment-panel" },
    { label: "Zero Trust Security", icon: "security", href: "#security-center" },
    { label: "Cek Video Platform", icon: "platform", href: "#platform-playability" },
    { label: "Analytics", icon: "analytics", href: "#analytics" },
    { label: "Auto Notification", icon: "notification", href: "#auto-notification-panel" },
    { label: "Settings", icon: "settings", href: "#settings" }
  ];

  const streamingSection = [
    { label: "Mini Web Home", icon: "home", href: "/" },
    { label: "Beli VIP Page", icon: "diamond", href: "/vip" },
    { label: "Platform Catalog", icon: "platform", href: "/platform" },
    { label: "Pencarian Drama", icon: "search", href: "/search" }
  ];

  const sideNav = document.querySelector("#sideNav");
  if (!sideNav) return;

  let dynamicSectionsHtml = "";
  if (menu && menu.sections) {
    const filteredSections = menu.sections.filter(sec => !["home", "platform", "source", "history"].includes(sec.id));
    if (filteredSections.length > 0) {
      dynamicSectionsHtml = `
        <div class="nav-section-divider"></div>
        <div class="nav-section-title">DRAMA CATEGORIES</div>
        ${filteredSections.map(sec => `
          <a class="side-link" href="${sec.path}" target="_blank">
            <span>${iconLabel("content")}</span>
            <strong>${sec.label}</strong>
            <small class="nav-external-indicator">↗</small>
          </a>
        `).join("")}
      `;
    }
  }

  sideNav.innerHTML = `
    <div class="nav-section-title">ADMIN PANEL MODULES</div>
    ${adminSection.map(item => `
      <a class="side-link" href="${item.href}">
        <span>${iconLabel(item.icon)}</span>
        <strong>${item.label}</strong>
      </a>
    `).join("")}
    
    <div class="nav-section-divider"></div>
    <div class="nav-section-title">WEB STREAMING PORTAL</div>
    ${streamingSection.map(item => `
      <a class="side-link" href="${item.href}" target="_blank">
        <span>${iconLabel(item.icon)}</span>
        <strong>${item.label}</strong>
        <small class="nav-external-indicator">↗</small>
      </a>
    `).join("")}
    
    ${dynamicSectionsHtml}
  `;

  const updateActiveLink = () => {
    const currentHash = location.hash || "#overview";
    document.querySelectorAll("#sideNav .side-link").forEach(link => {
      const href = link.getAttribute("href");
      if (href && href.startsWith("#")) {
        link.classList.toggle("active", href === currentHash);
      }
    });
    togglePanels(currentHash);
  };
  
  updateActiveLink();
  window.addEventListener("hashchange", updateActiveLink);
}

function togglePanels(hash) {
  const isOverview = hash === "#overview";
  
  const overviewElements = [
    document.querySelector("#metrics"),
    document.querySelector("#activePlatforms")?.closest(".console-panel"),
    document.querySelector("#sourceUploadForm")?.closest(".console-panel"),
    document.querySelector("#healthList")?.closest(".console-panel"),
    document.querySelector("#platform-notifications"),
    document.querySelector("#platform-playability"),
    document.querySelector("#admin-modules-panel")
  ];

  overviewElements.forEach(el => {
    if (el) el.style.display = isOverview ? "" : "none";
  });

  const otherPanels = {
    "#vip-admin-panel": document.querySelector("#vip-admin-panel"),
    "#payment-panel": document.querySelector("#payment-panel"),
    "#security-center": document.querySelector("#security-center"),
    "#telegram-bot": document.querySelector("#telegram-bot"),
    "#platform-playability": document.querySelector("#platform-playability"),
    "#drama-management-panel": document.querySelector("#drama-management-panel"),
    "#episode-management-panel": document.querySelector("#episode-management-panel"),
    "#analytics": document.querySelector("#analytics"),
    "#auto-notification-panel": document.querySelector("#auto-notification-panel"),
    "#settings": document.querySelector("#settings-panel"),
    "#bot-users-panel": document.querySelector("#bot-users-panel")
  };

  for (const [panelHash, el] of Object.entries(otherPanels)) {
    if (el) {
      el.style.display = hash === panelHash ? "" : "none";
    }
  }

  // Load appropriate panel data when opened
  if (hash === "#auto-notification-panel") {
    loadNotificationCenterData();
  } else if (hash === "#drama-management-panel") {
    loadDramaManagementData();
  } else if (hash === "#episode-management-panel") {
    loadEpisodeManagementData();
  } else if (hash === "#analytics") {
    loadAnalyticsDashboard();
  }
}

function renderDynamicMetrics(sources) {
  const endpointCount = sources.reduce((total, source) => total + source.endpoints.length, 0);
  const activeCount = sources.filter((source) => source.status === "active").length;
  const sourceFiles = new Set(sources.map((source) => source.sourceFile)).size;
  const liveMetrics = [
    ["Platform Source", String(sources.length), `${activeCount} aktif`],
    ["Total Endpoint", String(endpointCount), "Dari storage/sources"],
    ["File Source", String(sourceFiles), "TXT/JSON"],
    ["Web Server", "Online", "localhost:3000"],
    ["Bot Telegram", "Online", "Polling aktif"],
    ["Storage", "Ready", "TEAMDL storage"]
  ];

  document.querySelector("#metrics").innerHTML = liveMetrics.map(([label, value, trend]) => `
    <article class="metric-card">
      <span>${label}</span>
      <strong>${value}</strong>
      <em>${trend}</em>
    </article>
  `).join("");
}

function renderDynamicPlatforms(sources) {
  const active = sources;
  const platformCounter = document.querySelector(".console-panel .counter");
  if (platformCounter) {
    platformCounter.textContent = `${sources.filter((source) => source.status === "active").length} Aktif`;
  }

  document.querySelector("#activePlatforms").innerHTML = active.map((source) => `
    <article class="platform-card source-mode-${source.status}">
      <div class="platform-logo">${logoText(source.platform)}</div>
      <div class="platform-info">
        <strong>${source.platform}</strong>
        <span class="${source.status}">${source.endpoints.length} endpoint | ${statusLabel(source.status)}</span>
      </div>
      <div class="platform-mode-actions">
        <button type="button" class="${source.status === "active" ? "active" : ""}" data-source-status="${source.slug}:active">ON</button>
        <button type="button" class="${source.status === "off" ? "active danger" : ""}" data-source-status="${source.slug}:off">OFF</button>
        <button type="button" class="${source.status === "maintenance" ? "active warn" : ""}" data-source-status="${source.slug}:maintenance">MTC</button>
      </div>
      <a class="pill-link" href="/api/platform/${source.slug}">API</a>
      <a class="watch-link ${source.status === "active" ? "" : "disabled"}" href="${source.status === "active" ? `/platform/${source.slug}` : "#"}">Buka</a>
    </article>
  `).join("");
}

function renderDynamicMaintenance(sources) {
  const maintenance = sources.filter((source) => source.status !== "active");
  const panel = document.querySelector("#maintenancePlatforms")?.closest(".console-panel");
  const counter = panel?.querySelector(".counter");
  if (counter) {
    counter.textContent = `${maintenance.length} Perbaikan`;
  }

  const maintEl = document.querySelector("#maintenancePlatforms");
  if (maintEl) {
    maintEl.innerHTML = maintenance.length ? maintenance.map((source) => `
      <a class="maintenance-item" href="/api/sources/${source.slug}">
        <span>${logoText(source.platform)}</span>
        <strong>${source.platform}</strong>
        <em>${source.status}</em>
      </a>
    `).join("") : `<div class="empty-source">Semua source aktif.</div>`;
  }
}

async function loadSourceFiles() {
  const files = await authFetch("/api/sources/files").then((response) => response.json()).catch(() => []);
  const list = document.querySelector("#sourceFileList");
  if (!list) {
    return;
  }

  list.innerHTML = files.length ? files.map((file) => `
    <a class="source-file-item" href="/api/sources/files" title="${file.file}">
      <span>${file.type.toUpperCase()}</span>
      <strong>${file.file}</strong>
      <em>${formatBytes(file.size)}</em>
    </a>
  `).join("") : `<div class="empty-source">Belum ada file TXT/JSON.</div>`;
}

async function loadSourceHistory() {
  const history = await authFetch("/api/sources/history").then((response) => response.json()).catch(() => []);
  const list = document.querySelector("#sourceHistoryList");
  if (!list) {
    return;
  }

  list.innerHTML = history.length ? history.slice(0, 20).map((item) => `
    <div class="source-history-item">
      <span class="history-status ${item.status}">${statusLabel(item.status)}</span>
      <strong>${item.platform}</strong>
      <small>${item.file}</small>
      <em>${item.endpointCount || 0} endpoint</em>
    </div>
  `).join("") : `<div class="empty-source">Belum ada riwayat source.</div>`;
}

document.addEventListener("click", async (event) => {
  const sideLink = event.target.closest(".side-link");
  if (sideLink) {
    document.body.classList.remove("sidebar-open");
  }

  const unbanButton = event.target.closest("[data-unban]");
  if (unbanButton) {
    const [type, value] = unbanButton.dataset.unban.split(":");
    unbanButton.disabled = true;
    try {
      const response = await authFetch("/api/security/unban", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, value })
      });
      if (!response.ok) {
        throw new Error("Unban gagal");
      }
      await loadSecurityPanel();
    } catch (error) {
      alert(error.message);
    } finally {
      unbanButton.disabled = false;
    }
    return;
  }

  const botUserButton = event.target.closest("[data-bot-user-action]");
  if (botUserButton) {
    const [action, telegramId] = botUserButton.dataset.botUserAction.split(":");
    botUserButton.disabled = true;
    try {
      const response = await authFetch("/api/admin/bot-users/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, telegramId })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Aksi user bot gagal");
      }
      setBotUserStatusMessage(data.telegram?.skipped
        ? "Aksi tersimpan di bot lokal. Untuk kick dari grup/channel, isi TELEGRAM_MANAGED_CHAT_ID."
        : "Aksi berhasil diproses.", "ok");
      await loadBotUsersPanel();
    } catch (error) {
      setBotUserStatusMessage(error.message, "warn");
    } finally {
      botUserButton.disabled = false;
    }
    return;
  }

  const playabilityButton = event.target.closest("#runPlayabilityCheckBtn");
  if (playabilityButton) {
    await loadPlatformPlayability(true);
    return;
  }

  const button = event.target.closest("[data-source-status]");
  if (!button) {
    return;
  }

  const [slug, status] = button.dataset.sourceStatus.split(":");
  button.disabled = true;

  try {
    const response = await authFetch("/api/sources/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, status })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Status gagal disimpan");
    }
    await loadAdminData();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

async function loadSecurityPanel() {
  const security = await authFetch("/api/security/admin").then((response) => response.json()).catch(() => null);
  if (!security) {
    return;
  }

  const counter = document.querySelector("#securityCounter");
  if (counter) {
    counter.textContent = `${security.logs.length} Log`;
  }

  const sessionCounter = document.querySelector("#sessionCounter");
  if (sessionCounter) {
    sessionCounter.textContent = `${security.activeSessions.length} session`;
  }

  renderSecurityLogs(security.logs);
  renderBlockedList("#blockedIpList", "ip", security.bannedIps);
  renderBlockedList("#blockedAccountList", "account", security.bannedAccounts);
  renderBlockedList("#blockedDeviceList", "device", security.bannedDevices);
  renderSecureSessions(security.activeSessions);
  await loadStreamLogs();
}

async function loadStreamLogs() {
  const streamLogs = await authFetch("/api/admin/security/stream-logs").then((response) => response.json()).catch(() => null);
  const list = document.querySelector("#streamLogList");
  if (!list) {
    return;
  }

  if (!streamLogs || !streamLogs.length) {
    list.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">Belum ada log aktivitas streaming.</td></tr>`;
    return;
  }

  // Sort logs by timestamp descending (newest first)
  const sortedLogs = [...streamLogs].reverse();

  list.innerHTML = sortedLogs.slice(0, 100).map((item) => {
    const isError = item.status === "Error";
    const statusClass = isError ? "table-status danger" : "table-status active";
    const statusText = isError ? "EROR" : "BERHASIL";
    const detailsColor = isError ? "color: #ff4a5a;" : "";
    const dramaInfo = item.dramaTitle 
      ? `<strong>${escapeHtml(item.dramaTitle)}</strong>${item.episodeName ? ` - ${escapeHtml(item.episodeName)}` : ""}`
      : `<span style="color: var(--text-muted); font-style: italic;">Direct Media / Terenkripsi</span>`;

    return `
      <tr>
        <td><small>${new Date(item.timestamp).toLocaleString("id-ID")}</small></td>
        <td><strong>${escapeHtml(item.userId)}</strong></td>
        <td>${dramaInfo}</td>
        <td>
          <div style="font-size: 0.85em; display: flex; flex-direction: column;">
            <span>IP: ${escapeHtml(item.ipAddress)}</span>
            <small style="color: var(--text-muted);">Device: ${escapeHtml(item.deviceId)}</small>
          </div>
        </td>
        <td><span class="${statusClass}">${statusText}</span></td>
        <td><span style="${detailsColor} font-size: 0.9em;">${escapeHtml(item.details)}</span></td>
      </tr>
    `;
  }).join("");
}

function initStreamLogListeners() {
  const clearBtn = document.querySelector("#clearStreamLogsBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      if (!confirm("Apakah Anda yakin ingin menghapus semua log streaming member?")) {
        return;
      }
      clearBtn.disabled = true;
      try {
        const response = await authFetch("/api/admin/security/stream-logs/clear", {
          method: "POST"
        });
        if (!response.ok) {
          throw new Error("Gagal menghapus log streaming");
        }
        await loadStreamLogs();
      } catch (err) {
        alert(err.message);
      } finally {
        clearBtn.disabled = false;
      }
    });
  }
}

async function loadPlatformNotifications() {
  const data = await authFetch("/api/admin/platform-notifications").then((response) => response.json()).catch(() => null);
  const counter = document.querySelector("#platformNotificationCounter");
  const list = document.querySelector("#platformNotificationList");

  if (!counter || !list) {
    return;
  }

  if (!data) {
    counter.textContent = "Offline";
    counter.className = "counter danger";
    list.innerHTML = `<div class="empty-source">Notifikasi platform belum bisa dimuat.</div>`;
    return;
  }

  const attentionCount = (data.critical || 0) + (data.warning || 0);
  counter.textContent = attentionCount ? `${attentionCount} Perlu Cek` : "Aman";
  counter.className = `counter ${data.critical ? "danger" : attentionCount ? "warn" : ""}`.trim();

  list.innerHTML = data.notifications?.length ? data.notifications.map((item) => `
    <div class="notification-item ${escapeHtml(item.tone)}">
      <span class="status ${toneStatusClass(item.tone)}"></span>
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.message)}</p>
      </div>
      <em>${escapeHtml(item.platform || "Platform")}</em>
      <small>${formatDateTime(item.createdAt)}</small>
    </div>
  `).join("") : `<div class="empty-source">Belum ada notifikasi platform.</div>`;
}

function renderPlatformPlayabilityPlaceholder() {
  const counter = document.querySelector("#playabilityCounter");
  const list = document.querySelector("#platformPlayabilityList");
  const checkedAt = document.querySelector("#playabilityCheckedAt");
  if (counter) {
    counter.textContent = "Belum Dicek";
    counter.className = "counter warn";
  }
  if (checkedAt) {
    checkedAt.textContent = "Klik cek untuk mulai pemeriksaan video.";
  }
  if (list && !list.dataset.loaded) {
    list.innerHTML = `<div class="empty-source">Belum ada hasil pemeriksaan video.</div>`;
  }
}

async function loadPlatformPlayability(force = false) {
  const button = document.querySelector("#runPlayabilityCheckBtn");
  const counter = document.querySelector("#playabilityCounter");
  const list = document.querySelector("#platformPlayabilityList");
  const checkedAt = document.querySelector("#playabilityCheckedAt");
  if (!counter || !list) {
    return;
  }

  if (!force && list.dataset.loaded === "true") {
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = "Mengecek...";
  }
  counter.textContent = "Scanning";
  counter.className = "counter warn";
  list.dataset.loaded = "true";
  list.innerHTML = `<div class="empty-source">Sedang mengecek sample video tiap platform...</div>`;

  try {
    const response = await authFetch("/api/admin/platform-playability");
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("Endpoint checker belum aktif. Restart server web lalu coba lagi.");
    }
    const data = await response.json();
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Checker video gagal diproses server.");
    }
    const playable = data.playable || 0;
    const total = data.total || 0;
    counter.textContent = `${playable}/${total} Playable`;
    counter.className = `counter ${playable === total ? "" : playable ? "warn" : "danger"}`.trim();
    if (checkedAt) {
      checkedAt.textContent = `Terakhir dicek: ${formatDateTime(data.checkedAt)}`;
    }
    list.innerHTML = data.results?.length ? data.results.map(playabilityItem).join("") : `<div class="empty-source">Tidak ada platform aktif untuk dicek.</div>`;
  } catch (error) {
    counter.textContent = "Gagal";
    counter.className = "counter danger";
    list.innerHTML = `<div class="empty-source">Gagal mengecek video platform: ${escapeHtml(error.message)}</div>`;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Cek Sekarang";
    }
  }
}

function playabilityItem(item) {
  const ok = item.status === "playable";
  const tone = ok ? "ok" : item.status === "not_playable" || item.status === "no_video_url" ? "critical" : "warn";
  const detail = [
    item.sampleTitle ? `Sample: ${item.sampleTitle}` : "",
    item.episodeNumber ? `Ep ${item.episodeNumber}` : "",
    item.videoType ? item.videoType.toUpperCase() : "",
    item.httpStatus ? `HTTP ${item.httpStatus}` : ""
  ].filter(Boolean).join(" | ");

  return `
    <div class="playability-item ${tone}">
      <span class="status ${toneStatusClass(tone)}"></span>
      <div>
        <strong>${escapeHtml(item.platform || item.slug)}</strong>
        <p>${escapeHtml(item.message || item.status)}</p>
        ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
      </div>
      <em>${escapeHtml(item.status)}</em>
    </div>
  `;
}

function toneStatusClass(tone) {
  if (tone === "critical") {
    return "critical";
  }
  if (tone === "warn") {
    return "warn";
  }
  return "ok";
}

let botUsersCache = [];

async function loadBotUsersPanel() {
  const data = await authFetch("/api/admin/bot-users").then((response) => response.json()).catch(() => null);
  const counter = document.querySelector("#botUserCounter");
  const summary = document.querySelector("#botUserStatusSummary");

  if (!data) {
    if (counter) counter.textContent = "Offline";
    renderBotUsers([]);
    return;
  }

  botUsersCache = data.users || [];
  if (counter) {
    counter.textContent = `${data.total || 0} User`;
  }
  if (summary) {
    summary.textContent = `Aktif ${data.active || 0} | Ban ${data.banned || 0} | Kick ${data.kicked || 0}`;
  }
  renderBotUsers(botUsersCache);
}

function renderBotUsers(users) {
  const tbody = document.querySelector("#botUserTableRows");
  if (!tbody) {
    return;
  }

  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">Belum ada user bot.</td></tr>`;
    return;
  }

  tbody.innerHTML = users.map((user) => {
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Tanpa Nama";
    const username = user.username ? `@${user.username}` : "-";
    const status = user.status || "active";
    const telegramId = String(user.telegramId || "").replace(/^tg-/, "");
    return `
      <tr>
        <td>
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(username)}</span>
        </td>
        <td>
          <strong>${escapeHtml(telegramId)}</strong>
          <span>${escapeHtml(user.userId || `tg-${telegramId}`)}</span>
        </td>
        <td><span class="table-status ${escapeHtml(status)}">${botStatusLabel(status)}</span></td>
        <td>${formatDateTime(user.joinedAt || user.firstSeenAt)}</td>
        <td>
          ${formatDateTime(user.lastActiveAt)}
          <span>${escapeHtml(user.lastCommand || "menu")}</span>
        </td>
        <td>
          <div class="bot-user-actions">
            <button class="small-button danger" type="button" data-bot-user-action="kick:${escapeHtml(telegramId)}" ${status === "kicked" ? "disabled" : ""}>Kick</button>
            <button class="small-button danger" type="button" data-bot-user-action="ban:${escapeHtml(telegramId)}" ${status === "banned" ? "disabled" : ""}>Ban</button>
            <button class="small-button" type="button" data-bot-user-action="unban:${escapeHtml(telegramId)}" ${status === "active" ? "disabled" : ""}>Unban</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

function botStatusLabel(status) {
  return {
    active: "Aktif",
    banned: "Banned",
    kicked: "Kicked"
  }[status] || status;
}

function setBotUserStatusMessage(message, tone) {
  const status = document.querySelector("#botUserStatusMsg");
  if (!status) {
    return;
  }
  status.textContent = message;
  status.className = `status-msg ${tone}`;
}

function renderSecurityLogs(logs) {
  const list = document.querySelector("#securityLogList");
  if (!list) {
    return;
  }

  list.innerHTML = logs.length ? logs.slice(0, 50).map((item) => `
    <div class="security-item">
      <strong>${escapeHtml(item.violation_type)}</strong>
      <span>${escapeHtml(item.user_id)} | ${escapeHtml(item.ip_address)}</span>
      <small>${escapeHtml(item.device_id)} | ${escapeHtml(item.penalty)}</small>
      <em>${new Date(item.timestamp).toLocaleString("id-ID")}</em>
    </div>
  `).join("") : `<div class="empty-source">Belum ada pelanggaran.</div>`;
}

function renderBlockedList(selector, type, rows) {
  const list = document.querySelector(selector);
  if (!list) {
    return;
  }

  list.innerHTML = rows.length ? rows.map((item) => `
    <div class="security-item compact">
      <strong>${escapeHtml(item.id)}</strong>
      <span>${escapeHtml(item.reason || "blocked")}</span>
      <button class="small-button" type="button" data-unban="${type}:${escapeHtml(item.id)}">Unban</button>
    </div>
  `).join("") : `<div class="empty-source">Kosong.</div>`;
}

function renderSecureSessions(sessions) {
  const list = document.querySelector("#secureSessionList");
  if (!list) {
    return;
  }

  list.innerHTML = sessions.length ? sessions.map((item) => `
    <div class="source-history-item">
      <span class="history-status ${item.vip?.active ? "active" : "pending"}">${item.vip?.active ? "VIP" : "NON-VIP"}</span>
      <strong>${escapeHtml(item.userId)}</strong>
      <small>${escapeHtml(item.sessionId)}</small>
      <em>${new Date(item.expiresAt).toLocaleString("id-ID")}</em>
    </div>
  `).join("") : `<div class="empty-source">Tidak ada session aktif.</div>`;
}

function setSourceStatus(message, tone) {
  const status = document.querySelector("#sourceUploadStatus");
  if (!status) {
    return;
  }

  status.textContent = message;
  status.dataset.tone = tone;
}

function formatBytes(value) {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function statusLabel(value) {
  return {
    active: "Aktif",
    off: "Off",
    maintenance: "Maintenance",
    pending: "Pending"
  }[value] || value;
}

function platformCard([name, status]) {
  return `
    <article class="platform-card">
      <div class="platform-logo">${logoText(name)}</div>
      <div class="platform-info">
        <strong>${name}</strong>
        <span class="${status}">${status === "active" ? "Aktif" : "Perbaikan"}</span>
      </div>
      <a class="pill-link" href="/api/platform/${slug(name)}">API</a>
      <a class="watch-link" href="/watch/${slug(name)}">Tonton</a>
    </article>
  `;
}

function iconLabel(value) {
  const icons = {
    dashboard: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`,
    group: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
    diamond: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 18 3 22 9 12 22 2 9 6 3"></polygon><path d="M11 3 8 9l4 13 4-13-3-6"></path><path d="M2 9h20"></path></svg>`,
    payment: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg>`,
    platform: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`,
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="9" rx="9" ry="3"></circle><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"></path></svg>`,
    content: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2" ry="2"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line></svg>`,
    episode: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`,
    stream: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg>`,
    analytics: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>`,
    bot: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="15" x2="23" y2="15"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="15" x2="4" y2="15"></line></svg>`,
    security: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>`,
    notification: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path><path d="M18 8A6 6 0 0 0 6 8c0 7-3 7-3 9h18c0-2-3-2-3-9"></path></svg>`,
    settings: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
    search: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
    home: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`
  };
  return icons[value] || `<span class="icon-fallback">${value.slice(0, 2).toUpperCase()}</span>`;
}

function logoText(name) {
  return name.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase();
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("id-ID");
}

async function loadVipAdminPanel() {
  try {
    const response = await authFetch("/api/admin/vip");
    const vipUsers = await response.json();
    const listContainer = document.querySelector("#vipUserList");
    const counter = document.querySelector("#vipUserCounter");
    
    const userIds = Object.keys(vipUsers);
    if (counter) {
      counter.textContent = `${userIds.length} VIP User`;
    }
    
    if (listContainer) {
      if (userIds.length === 0) {
        listContainer.innerHTML = `<div class="empty-source">Tidak ada VIP aktif.</div>`;
      } else {
        listContainer.innerHTML = userIds.map(uid => {
          const u = vipUsers[uid];
          const expires = new Date(u.expiresAt);
          const isLifetime = expires.getFullYear() > 3000;
          const dateStr = isLifetime ? "Lifetime" : expires.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
          return `
            <div class="vip-user-item">
              <strong>${escapeHtml(uid)}</strong>
              <span>Sampai: <em>${dateStr}</em></span>
              <button class="small-button" type="button" onclick="document.querySelector('#vipTargetUserId').value = '${escapeHtml(uid)}'" style="margin-left: 10px;">Pilih</button>
            </div>
          `;
        }).join("");
      }
    }
  } catch (error) {
    console.warn("Failed to load VIP Admin panel:", error);
  }
}

async function loadPaymentPanel() {
  try {
    const response = await authFetch("/api/admin/payments");
    const paymentsList = await response.json();
    const tbody = document.querySelector("#paymentTableRows");
    const counter = document.querySelector("#paymentCounter");
    
    if (counter) {
      counter.textContent = `${paymentsList.length} Transaksi`;
    }
    
    if (tbody) {
      if (paymentsList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--muted);">Belum ada riwayat pembayaran.</td></tr>`;
      } else {
        tbody.innerHTML = paymentsList.map(item => {
          const date = new Date(item.date).toLocaleString("id-ID", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit"
          });
          const userLabel = item.userName ? escapeHtml(item.userName) : escapeHtml(item.userId);
          const telegramLine = item.telegramUsername
            ? `@${escapeHtml(String(item.telegramUsername).replace(/^@/, ""))}`
            : (item.telegramId ? `TG ${escapeHtml(item.telegramId)}` : escapeHtml(item.userId));
          const totalText = item.total ? `Rp ${Number(item.total).toLocaleString("id-ID")}` : "";
          const proofHref = item.proofUrl || item.proofFile || "";
          return `
            <tr>
              <td>
                <strong>${userLabel}</strong>
                <span>${escapeHtml(item.userId)}${telegramLine ? ` | ${telegramLine}` : ""}</span>
              </td>
              <td>
                <strong>${escapeHtml(item.plan)}</strong>
                <span>${totalText}</span>
              </td>
              <td>
                <strong>${escapeHtml(item.method)}</strong>
                <span>${escapeHtml(item.source || "-")}</span>
              </td>
              <td><span class="table-status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
              <td>${proofHref ? `<a class="payment-proof-link" href="${escapeHtml(proofHref)}" target="_blank" rel="noopener">Lihat Bukti</a>` : `<span style="color: var(--muted);">-</span>`}</td>
              <td style="color: var(--muted);">${date}</td>
            </tr>
          `;
        }).join("");
      }
    }
  } catch (error) {
    console.warn("Failed to load Payment panel:", error);
  }
}

function initVipAndPaymentListeners() {
  const vipForm = document.querySelector("#vipManageForm");
  const addVipBtn = document.querySelector("#addVipBtn");
  const removeVipBtn = document.querySelector("#removeVipBtn");
  const statusMsg = document.querySelector("#vipStatusMsg");
  const uploadGDriveBtn = document.querySelector("#uploadGDriveBtn");
  const gdriveStatus = document.querySelector("#gdriveStatus");
  
  const showMsg = (text, type) => {
    if (statusMsg) {
      statusMsg.textContent = text;
      statusMsg.className = `status-msg ${type}`;
    }
  };

  const handleVipAction = async (action) => {
    const userIdInput = document.querySelector("#vipTargetUserId");
    let userId = userIdInput?.value?.trim() || "";
    
    const durationSelect = document.querySelector("#vipDuration");
    let planDays = Number(durationSelect?.value || 30);
    if (durationSelect?.value === "custom") {
      planDays = Number(document.querySelector("#vipCustomDurationInput")?.value || 30);
    }
    
    if (!userId) {
      showMsg("User ID wajib diisi!", "warn");
      return;
    }
    
    if (/^\d+$/.test(userId)) {
      userId = `tg-${userId}`;
    }
    
    try {
      if (addVipBtn) addVipBtn.disabled = true;
      if (removeVipBtn) removeVipBtn.disabled = true;
      
      const response = await authFetch("/api/admin/vip/modify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, planDays, action })
      });
      const data = await response.json();
      
      if (!response.ok) throw new Error(data.error || "Gagal mengubah VIP");
      
      showMsg(`Sukses: VIP untuk ${userId} berhasil ${action === "add" ? "ditambahkan" : "dihapus"}.`, "ok");
      if (userIdInput) userIdInput.value = "";
      await loadVipAdminPanel();
      await loadPaymentPanel();
    } catch (e) {
      showMsg(e.message, "warn");
    } finally {
      if (addVipBtn) addVipBtn.disabled = false;
      if (removeVipBtn) removeVipBtn.disabled = false;
    }
  };

  vipForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    handleVipAction("add");
  });

  removeVipBtn?.addEventListener("click", () => {
    handleVipAction("remove");
  });
  
  const durationSelect = document.querySelector("#vipDuration");
  const customDurationContainer = document.querySelector("#vipCustomDurationContainer");
  durationSelect?.addEventListener("change", () => {
    if (customDurationContainer) {
      customDurationContainer.style.display = durationSelect.value === "custom" ? "block" : "none";
    }
  });
  
  uploadGDriveBtn?.addEventListener("click", async () => {
    if (uploadGDriveBtn.disabled) return;
    uploadGDriveBtn.disabled = true;
    
    const originalText = uploadGDriveBtn.innerHTML;
    
    const setGDriveStatus = (text, tone) => {
      if (gdriveStatus) {
        gdriveStatus.textContent = text;
        gdriveStatus.className = `status-msg ${tone}`;
      }
    };
    
    try {
      uploadGDriveBtn.innerHTML = "Menghubungkan ke Drive...";
      setGDriveStatus("Menginisialisasi sesi Google Drive...", "ok");
      await new Promise(r => setTimeout(r, 1200));
      
      uploadGDriveBtn.innerHTML = "Memproses CSV & Upload...";
      setGDriveStatus("Mengunggah berkas laporan rekapitulasi...", "ok");
      
      const response = await authFetch("/api/admin/payments/upload-gdrive", { method: "POST" });
      const data = await response.json();
      
      if (!response.ok) throw new Error("Upload Google Drive gagal");
      
      await new Promise(r => setTimeout(r, 1000));
      uploadGDriveBtn.innerHTML = "Upload Selesai!";
      setGDriveStatus(`Sukses diunggah! File: ${data.fileName}. <a href="${data.viewUrl}" target="_blank" style="color: #2ecc71; text-decoration: underline; font-weight: 800;">Lihat di GDrive</a>`, "ok");
    } catch (err) {
      setGDriveStatus(err.message, "warn");
    } finally {
      setTimeout(() => {
        uploadGDriveBtn.innerHTML = originalText;
        uploadGDriveBtn.disabled = false;
      }, 4000);
    }
  });
}

function initLoginListeners() {
  const loginForm = document.querySelector("#adminLoginForm");
  const pendingState = document.querySelector("#loginPendingState");
  const loginStatusMsg = document.querySelector("#loginStatusMsg");
  const submitBtn = document.querySelector("#loginSubmitBtn");
  const cancelBtn = document.querySelector("#loginCancelBtn");
  
  let pollInterval = null;
  let currentSessionId = null;
  
  const showLoginMsg = (text, type) => {
    if (loginStatusMsg) {
      loginStatusMsg.textContent = text;
      loginStatusMsg.className = `status-msg ${type}`;
    }
  };
  
  const resetLoginUI = () => {
    if (loginForm) loginForm.style.display = "block";
    if (pendingState) pendingState.style.display = "none";
    if (submitBtn) submitBtn.disabled = false;
    currentSessionId = null;
  };

  loginForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const credential = document.querySelector("#loginCredential")?.value?.trim();
    
    if (!credential) {
      showLoginMsg("ID Telegram atau Kata Sandi wajib diisi!", "warn");
      return;
    }
    
    showLoginMsg("", "");
    if (submitBtn) submitBtn.disabled = true;
    
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential })
      });
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Gagal masuk");
      }
      
      if (data.status === "approved") {
        localStorage.setItem("adminToken", data.token);
        location.reload();
        return;
      }
      
      currentSessionId = data.sessionId;
      
      if (loginForm) loginForm.style.display = "none";
      if (pendingState) pendingState.style.display = "block";
      
      pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`/api/admin/login/status?sessionId=${currentSessionId}`);
          const statusData = await res.json();
          
          if (statusData.status === "approved") {
            clearInterval(pollInterval);
            localStorage.setItem("adminToken", statusData.token);
            location.reload();
          } else if (statusData.status === "rejected") {
            clearInterval(pollInterval);
            showLoginMsg("Login ditolak oleh Telegram Admin!", "warn");
            resetLoginUI();
          }
        } catch (err) {
          console.error("Error polling login status:", err);
        }
      }, 2000);
      
    } catch (err) {
      showLoginMsg(err.message, "warn");
      if (submitBtn) submitBtn.disabled = false;
    }
  });
  
  cancelBtn?.addEventListener("click", async () => {
    if (pollInterval) clearInterval(pollInterval);
    if (currentSessionId) {
      await fetch("/api/admin/login/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: currentSessionId })
      }).catch(() => {});
    }
    showLoginMsg("Login dibatalkan.", "warn");
    resetLoginUI();
  });
}

function initPasswordChangeListeners() {
  const form = document.querySelector("#adminPasswordForm");
  const currentInput = document.querySelector("#adminCurrentPassword");
  const newInput = document.querySelector("#adminNewPassword");
  const statusMsg = document.querySelector("#passwordStatusMsg");
  const submitBtn = document.querySelector("#changePasswordBtn");
  
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const oldPassword = currentInput?.value;
    const newPassword = newInput?.value;
    
    if (!oldPassword || !newPassword) {
      if (statusMsg) {
        statusMsg.textContent = "Semua field harus diisi!";
        statusMsg.className = "status-msg warn";
      }
      return;
    }
    
    if (submitBtn) submitBtn.disabled = true;
    
    try {
      const response = await authFetch("/api/admin/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword })
      });
      const data = await response.json();
      
      if (!response.ok) throw new Error(data.error || "Gagal mengubah sandi");
      
      if (statusMsg) {
        statusMsg.textContent = "Sandi berhasil diubah! Notifikasi dikirim ke Telegram.";
        statusMsg.className = "status-msg ok";
      }
      
      if (currentInput) currentInput.value = "";
      if (newInput) newInput.value = "";
    } catch (err) {
      if (statusMsg) {
        statusMsg.textContent = err.message;
        statusMsg.className = "status-msg warn";
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

async function initSettingsConfigListeners() {
  const form = document.querySelector("#adminSettingsForm");
  const geminiInput = document.querySelector("#adminGeminiKey");
  const statusMsg = document.querySelector("#settingsStatusMsg");
  const submitBtn = document.querySelector("#saveSettingsBtn");
  
  if (!form) return;
  
  // 1. Fetch current config
  try {
    const res = await authFetch("/api/admin/config");
    const data = await res.json();
    if (res.ok && data.config) {
      if (geminiInput) {
        geminiInput.value = data.config.geminiApiKey || "";
      }
    }
  } catch (err) {
    console.error("Gagal memuat konfigurasi API:", err);
  }
  
  // 2. Form submission
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const geminiApiKey = geminiInput?.value?.trim();
    
    if (submitBtn) submitBtn.disabled = true;
    
    try {
      const response = await authFetch("/api/admin/save-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiApiKey })
      });
      const data = await response.json();
      
      if (!response.ok) throw new Error(data.error || "Gagal menyimpan konfigurasi");
      
      if (statusMsg) {
        statusMsg.textContent = "Konfigurasi API berhasil disimpan!";
        statusMsg.className = "status-msg ok";
      }
    } catch (err) {
      if (statusMsg) {
        statusMsg.textContent = err.message;
        statusMsg.className = "status-msg warn";
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// --- TELEGRAM AUTO NOTIFICATION CENTER FRONTEND ---

let logCurrentPage = 1;
const logPageLimit = 10;
let isLogsSearchActive = false;

function initNotificationCenterListeners() {
  // Switches Change Listeners
  const switches = [
    ["#switchDetectDrama", "autoDetectDrama"],
    ["#switchDetectEpisode", "autoDetectEpisode"],
    ["#switchNotification", "autoNotification"],
    ["#switchDuplicateProtection", "duplicateProtection"],
    ["#switchQueueSystem", "queueSystem"],
    ["#switchRetryFailed", "retryFailed"],
    ["#switchMiniAppButton", "miniAppButton"],
    ["#switchTopicRouting", "topicRouting"]
  ];

  switches.forEach(([selector, settingsKey]) => {
    document.querySelector(selector)?.addEventListener("change", async (event) => {
      const value = event.target.checked;
      await saveNotificationSettings({ [settingsKey]: value });
    });
  });

  // Interval and Mini App URL settings listeners
  document.querySelector("#detectInterval")?.addEventListener("change", async (event) => {
    const value = Number(event.target.value);
    await saveNotificationSettings({ interval: value });
  });

  document.querySelector("#miniAppUrlInput")?.addEventListener("change", async (event) => {
    const value = event.target.value.trim();
    await saveNotificationSettings({ miniAppUrl: value });
  });

  // Smart Routing Map Input Listeners
  const routes = [
    ["#routeDramaBaru", "drama_baru"],
    ["#routeEpisodeBaru", "episode_baru"],
    ["#routeVipOnly", "vip_only"],
    ["#routePengumuman", "pengumuman"],
    ["#routeMaintenance", "maintenance"]
  ];

  routes.forEach(([selector, routeKey]) => {
    document.querySelector(selector)?.addEventListener("change", async (event) => {
      const value = event.target.value.trim();
      const currentSettings = await authFetch("/api/admin/notifications/settings").then(r => r.json());
      const routing = currentSettings.routing || {};
      routing[routeKey] = value;
      await saveNotificationSettings({ routing });
    });
  });

  // Trigger Detection & Process Queue Buttons
  document.querySelector("#triggerDetectionBtn")?.addEventListener("click", async () => {
    const btn = document.querySelector("#triggerDetectionBtn");
    const original = btn.textContent;
    btn.textContent = "Detecting...";
    btn.disabled = true;
    try {
      const res = await authFetch("/api/admin/notifications/detect/trigger", { method: "POST" });
      if (res.ok) {
        alert("Proses deteksi drama baru dipicu di backend.");
        setTimeout(loadNotificationCenterData, 2000);
      }
    } catch (e) {
      alert("Gagal memicu deteksi: " + e.message);
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
  });

  document.querySelector("#triggerQueueBtn")?.addEventListener("click", async () => {
    const btn = document.querySelector("#triggerQueueBtn");
    const original = btn.textContent;
    btn.textContent = "Processing...";
    btn.disabled = true;
    try {
      const res = await authFetch("/api/admin/notifications/queue/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume" })
      });
      if (res.ok) {
        alert("Proses antrean notifikasi dimulai.");
        setTimeout(loadNotificationCenterData, 2000);
      }
    } catch (e) {
      alert("Gagal memicu antrean: " + e.message);
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
  });

  // Target Manager Buttons
  document.querySelector("#addTargetBtn")?.addEventListener("click", () => {
    document.querySelector("#targetForm").reset();
    document.querySelector("#targetId").value = "";
    document.querySelector("#targetModalTitle").textContent = "Tambah Target Notifikasi";
    document.querySelector("#targetModal").style.display = "flex";
  });

  document.querySelector("#closeTargetModalBtn")?.addEventListener("click", () => {
    document.querySelector("#targetModal").style.display = "none";
  });

  document.querySelector("#targetForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = document.querySelector("#targetId").value;
    const name = document.querySelector("#targetName").value.trim();
    const channel_id = document.querySelector("#targetChannelId").value.trim();
    const topic_id = document.querySelector("#targetTopicId").value.trim();
    const type = document.querySelector("#targetType").value;
    const status = document.querySelector("#targetStatus").value;

    const payload = { name, channel_id, topic_id, type, status };
    if (id) payload.id = id;

    try {
      const response = await authFetch("/api/admin/notifications/targets", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        document.querySelector("#targetModal").style.display = "none";
        loadNotificationCenterData();
      } else {
        const err = await response.json();
        alert("Gagal menyimpan target: " + (err.error || "Terjadi kesalahan"));
      }
    } catch (e) {
      alert("Gagal menyimpan target: " + e.message);
    }
  });

  // Queue Action Listeners
  document.querySelector("#pauseQueueBtn")?.addEventListener("click", async () => {
    await sendQueueAction("pause");
  });
  document.querySelector("#resumeQueueBtn")?.addEventListener("click", async () => {
    await sendQueueAction("resume");
  });
  document.querySelector("#retryQueueBtn")?.addEventListener("click", async () => {
    await sendQueueAction("retry");
  });
  document.querySelector("#clearQueueBtn")?.addEventListener("click", async () => {
    if (confirm("Apakah Anda yakin ingin menghapus semua item antrean?")) {
      await sendQueueAction("clear");
    }
  });

  // Logs Search & Filters
  document.querySelector("#logSearchInput")?.addEventListener("input", () => {
    logCurrentPage = 1;
    loadLogsTable();
  });
  document.querySelector("#logTypeFilter")?.addEventListener("change", () => {
    logCurrentPage = 1;
    loadLogsTable();
  });

  document.querySelector("#logPrevBtn")?.addEventListener("click", () => {
    if (logCurrentPage > 1) {
      logCurrentPage--;
      loadLogsTable();
    }
  });

  document.querySelector("#logNextBtn")?.addEventListener("click", () => {
    logCurrentPage++;
    loadLogsTable();
  });

  // Broadcast Form Listener
  document.querySelector("#broadcastForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const btn = document.querySelector("#sendBroadcastBtn");
    const status = document.querySelector("#broadcastStatusMsg");
    const text = document.querySelector("#broadcastMessageText").value.trim();

    if (btn) btn.disabled = true;
    if (status) {
      status.textContent = "Mengirim pesan siaran...";
      status.className = "status-msg ok";
    }

    try {
      const response = await authFetch("/api/admin/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      const data = await response.json();
      if (response.ok) {
        status.textContent = `Siaran berhasil terkirim ke ${data.count || 0} user bot Telegram.`;
        status.className = "status-msg ok";
        document.querySelector("#broadcastMessageText").value = "";
      } else {
        throw new Error(data.error || "Gagal mengirim broadcast");
      }
    } catch (e) {
      status.textContent = e.message;
      status.className = "status-msg warn";
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  
  // Episode Filter Select Listener
  document.querySelector("#episodePlatformFilter")?.addEventListener("change", (e) => {
    loadEpisodeManagementTable(e.target.value);
  });
  
  // Episode Search Input Listener
  document.querySelector("#episodeSearchInput")?.addEventListener("input", (e) => {
    const filter = document.querySelector("#episodePlatformFilter").value;
    loadEpisodeManagementTable(filter, e.target.value.toLowerCase().trim());
  });
  
  // Drama Search Input Listener
  document.querySelector("#dramaSearchInput")?.addEventListener("input", (e) => {
    loadDramaManagementTable(e.target.value.toLowerCase().trim());
  });
}

async function saveNotificationSettings(settings) {
  try {
    await authFetch("/api/admin/notifications/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings)
    });
  } catch (e) {
    console.error("Gagal menyimpan konfigurasi notifikasi:", e.message);
  }
}

async function sendQueueAction(action, id = null) {
  try {
    const res = await authFetch("/api/admin/notifications/queue/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id })
    });
    if (res.ok) {
      loadNotificationCenterData();
    }
  } catch (e) {
    alert("Gagal melakukan aksi antrean: " + e.message);
  }
}

async function loadAnalyticsDashboard() {
  try {
    const data = await authFetch("/api/admin/stream-analytics").then(r => r.json());
    if (!data.ok) {
      console.error("Gagal memuat analitik:", data.error);
      return;
    }

    // Set numbers
    document.querySelector("#analyticsTotalStreams").textContent = data.totalStreams;
    document.querySelector("#analyticsTotalErrors").textContent = data.totalErrors;
    
    const rateEl = document.querySelector("#analyticsErrorRate");
    rateEl.textContent = `${data.errorRate}%`;
    if (data.errorRate >= 10) {
      rateEl.style.color = "#ef4444"; // red
    } else if (data.errorRate >= 5) {
      rateEl.style.color = "#eab308"; // yellow
    } else {
      rateEl.style.color = "#22c55e"; // green
    }

    // Render Tables
    const renderTableBody = (bodyElId, items, labelKey, countKey) => {
      const body = document.getElementById(bodyElId);
      if (!body) return;
      if (!items || items.length === 0) {
        body.innerHTML = `<tr><td colspan="2" style="text-align: center; color: rgba(255,255,255,0.4); padding: 12px;">Tidak ada data</td></tr>`;
        return;
      }
      body.innerHTML = items.map(item => `
        <tr>
          <td><strong>${escapeHtml(item[labelKey] || "N/A")}</strong></td>
          <td style="text-align: right; font-weight: bold; color: rgba(255,255,255,0.7);">${item[countKey] || 0}</td>
        </tr>
      `).join("");
    };

    renderTableBody("analyticsBrokenCdnsBody", data.topBrokenCDNs, "cdn", "count");
    renderTableBody("analyticsBrokenEpisodesBody", data.topBrokenEpisodes, "episode", "count");
    renderTableBody("analyticsErrorTypesBody", data.topErrorTypes, "type", "count");
    renderTableBody("analyticsDeviceErrorsBody", data.topDeviceErrors, "device", "count");

    // Render Hourly Chart (Vertical Bars)
    const renderBarChart = (chartId, list, labelKey, valueKey) => {
      const container = document.getElementById(chartId);
      if (!container) return;
      if (!list || list.length === 0) {
        container.innerHTML = `<div style="color: rgba(255,255,255,0.4); font-size: 11px; margin: auto; padding: 40px 0;">Tidak ada data error dalam periode ini</div>`;
        return;
      }
      const maxVal = Math.max(...list.map(item => item[valueKey]), 1);
      container.innerHTML = list.map(item => {
        const pct = (item[valueKey] / maxVal) * 100;
        return `
          <div style="display: flex; flex-direction: column; align-items: center; flex: 1; height: 100%; justify-content: flex-end; position: relative;" title="${item[labelKey]}: ${item[valueKey]} error">
            <div style="font-size: 8px; color: #94a3b8; margin-bottom: 4px;">${item[valueKey]}</div>
            <div style="width: 70%; max-width: 20px; height: ${pct}%; background: linear-gradient(to top, #ef4444, #f87171); border-radius: 4px 4px 0 0; min-height: 4px;"></div>
            <div style="font-size: 8px; color: rgba(255,255,255,0.5); margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 35px;">${item[labelKey]}</div>
          </div>
        `;
      }).join("");
    };

    // Sort hourly by time if possible
    const sortedHourly = (data.charts.hourly || []).sort((a, b) => {
      return parseInt(a.hour) - parseInt(b.hour);
    });
    renderBarChart("chartHourly", sortedHourly, "hour", "count");
    renderBarChart("chartDaily", data.charts.daily || [], "day", "count");

    // Render Horizontal Charts
    const renderHorizontalChart = (chartId, list, labelKey, valueKey) => {
      const container = document.getElementById(chartId);
      if (!container) return;
      if (!list || list.length === 0) {
        container.innerHTML = `<div style="color: rgba(255,255,255,0.4); font-size: 11px; margin: auto; padding: 40px 0;">Tidak ada data kegagalan</div>`;
        return;
      }
      const maxVal = Math.max(...list.map(item => item[valueKey]), 1);
      container.innerHTML = list.map(item => {
        const pct = (item[valueKey] / maxVal) * 100;
        return `
          <div style="display: flex; flex-direction: column; gap: 4px; width: 100%;">
            <div style="display: flex; justify-content: space-between; font-size: 10px; color: rgba(255,255,255,0.7);">
              <span style="font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 80%;">${escapeHtml(item[labelKey] || "N/A")}</span>
              <span>${item[valueKey]} error</span>
            </div>
            <div style="width: 100%; height: 8px; background: rgba(255,255,255,0.05); border-radius: 4px; overflow: hidden;">
              <div style="width: ${pct}%; height: 100%; background: linear-gradient(to right, #ef4444, #f87171); border-radius: 4px;"></div>
            </div>
          </div>
        `;
      }).join("");
    };

    renderHorizontalChart("chartDrama", data.charts.drama || [], "drama", "count");
    renderHorizontalChart("chartCdn", data.charts.cdn || [], "cdn", "count");

    // Setup listener once
    const refreshBtn = document.getElementById("refreshAnalyticsBtn");
    if (refreshBtn && !refreshBtn.dataset.hasListener) {
      refreshBtn.dataset.hasListener = "true";
      refreshBtn.addEventListener("click", () => {
        loadAnalyticsDashboard();
      });
    }

  } catch (e) {
    console.error("Gagal mengambil data analitik:", e);
  }
}

async function loadNotificationCenterData() {
  try {
    // 1. Load Stats
    const stats = await authFetch("/api/admin/notifications/stats").then(r => r.json());
    document.querySelector("#statDramaToday").textContent = stats.dramaToday || 0;
    document.querySelector("#statEpisodeToday").textContent = stats.episodeToday || 0;
    document.querySelector("#statBerhasil").textContent = stats.berhasil || 0;
    document.querySelector("#statGagal").textContent = stats.gagal || 0;
    document.querySelector("#statChannels").textContent = stats.activeChannels || 0;
    document.querySelector("#statTopics").textContent = stats.activeTopics || 0;
    document.querySelector("#statQueueWaiting").textContent = `${stats.queueWaiting || 0} antrean`;
    
    const lastRun = stats.lastDetectionTime !== "-" ? new Date(stats.lastDetectionTime).toLocaleTimeString("id-ID") : "-";
    document.querySelector("#statLastDetectTime").textContent = `Last Run: ${lastRun}`;
    
    // Toggle pause/resume queue buttons
    document.querySelector("#pauseQueueBtn").style.display = stats.isQueuePaused ? "none" : "inline-flex";
    document.querySelector("#resumeQueueBtn").style.display = stats.isQueuePaused ? "inline-flex" : "none";

    // 2. Load Settings
    const settings = await authFetch("/api/admin/notifications/settings").then(r => r.json());
    document.querySelector("#switchDetectDrama").checked = !!settings.autoDetectDrama;
    document.querySelector("#switchDetectEpisode").checked = !!settings.autoDetectEpisode;
    document.querySelector("#switchNotification").checked = !!settings.autoNotification;
    document.querySelector("#switchDuplicateProtection").checked = !!settings.duplicateProtection;
    document.querySelector("#switchQueueSystem").checked = !!settings.queueSystem;
    document.querySelector("#switchRetryFailed").checked = !!settings.retryFailed;
    document.querySelector("#switchMiniAppButton").checked = !!settings.miniAppButton;
    document.querySelector("#switchTopicRouting").checked = !!settings.topicRouting;
    
    document.querySelector("#detectInterval").value = settings.interval || 60000;
    document.querySelector("#miniAppUrlInput").value = settings.miniAppUrl || "";

    const routing = settings.routing || {};
    document.querySelector("#routeDramaBaru").value = routing.drama_baru || "";
    document.querySelector("#routeEpisodeBaru").value = routing.episode_baru || "";
    document.querySelector("#routeVipOnly").value = routing.vip_only || "";
    document.querySelector("#routePengumuman").value = routing.pengumuman || "";
    document.querySelector("#routeMaintenance").value = routing.maintenance || "";

    // 3. Load Targets
    const targets = await authFetch("/api/admin/notifications/targets").then(r => r.json());
    const targetsBody = document.querySelector("#targetTableRows");
    if (targetsBody) {
      if (targets.length === 0) {
        targetsBody.innerHTML = `<tr><td colspan="6" class="empty-cell">Belum ada target pengiriman notifikasi.</td></tr>`;
      } else {
        targetsBody.innerHTML = targets.map(t => `
          <tr>
            <td><strong>${escapeHtml(t.name)}</strong></td>
            <td><code>${escapeHtml(t.channel_id)}</code></td>
            <td><code>${t.topic_id ? escapeHtml(t.topic_id) : "-"}</code></td>
            <td><span class="table-status">${escapeHtml(t.type)}</span></td>
            <td><span class="table-status ${t.status === "Aktif" ? "active" : "pending"}">${t.status}</span></td>
            <td>
              <div class="bot-user-actions">
                <button class="small-button" type="button" onclick="editTargetNotification(${t.id})">Edit</button>
                <button class="small-button" type="button" onclick="testTargetNotification(${t.id})">Test</button>
                <button class="small-button danger" type="button" onclick="deleteTargetNotification(${t.id})">Hapus</button>
              </div>
            </td>
          </tr>
        `).join("");
      }
    }

    // 4. Load Queue
    const queue = await authFetch("/api/admin/notifications/queue").then(r => r.json());
    const queueBody = document.querySelector("#queueTableRows");
    if (queueBody) {
      const pendingItems = queue.filter(q => q.status === "Pending" || q.status === "Processing" || q.status === "Retry" || q.status === "Failed");
      if (pendingItems.length === 0) {
        queueBody.innerHTML = `<tr><td colspan="7" class="empty-cell">Antrean kosong.</td></tr>`;
      } else {
        queueBody.innerHTML = pendingItems.map(q => `
          <tr>
            <td><code>${q.id}</code></td>
            <td><code>${escapeHtml(q.drama_id)}</code></td>
            <td><span class="table-status">${escapeHtml(q.type)}</span></td>
            <td>
              <strong>${escapeHtml(q.payload?.title || "-")}</strong>
              <span>Platform: ${escapeHtml(q.payload?.platform || "-")}</span>
            </td>
            <td>${q.retry_count} / 3</td>
            <td><span class="table-status ${q.status.toLowerCase()}">${q.status}</span></td>
            <td>
              <div class="bot-user-actions">
                <button class="small-button" type="button" onclick="sendQueueAction('retry', ${q.id})" ${q.status !== "Failed" && q.status !== "Retry" ? "disabled" : ""}>Retry</button>
              </div>
            </td>
          </tr>
        `).join("");
      }
    }

    // 5. Load Logs
    loadLogsTable();

  } catch (e) {
    console.warn("Gagal memuat data Notification Center:", e.message);
  }
}

async function loadLogsTable() {
  try {
    const search = document.querySelector("#logSearchInput")?.value?.trim() || "";
    const type = document.querySelector("#logTypeFilter")?.value || "";
    const url = `/api/admin/notifications/logs?page=${logCurrentPage}&limit=${logPageLimit}&search=${encodeURIComponent(search)}&type=${encodeURIComponent(type)}`;
    
    const data = await authFetch(url).then(r => r.json());
    const logsBody = document.querySelector("#logTableRows");
    if (logsBody) {
      if (!data.logs || data.logs.length === 0) {
        logsBody.innerHTML = `<tr><td colspan="7" class="empty-cell">Belum ada catatan log pengiriman.</td></tr>`;
      } else {
        logsBody.innerHTML = data.logs.map(l => {
          const date = new Date(l.sent_at).toLocaleString("id-ID");
          return `
            <tr>
              <td>${date}</td>
              <td><strong>${escapeHtml(l.title)}</strong><span>ID: ${escapeHtml(l.drama_id)}</span></td>
              <td><span class="table-status">${escapeHtml(l.type)}</span></td>
              <td><code>${escapeHtml(l.channel_id)}</code></td>
              <td><code>${l.topic_id ? escapeHtml(l.topic_id) : "-"}</code></td>
              <td><span class="table-status ${l.status === "Berhasil" ? "active" : "pending"}">${l.status}</span></td>
              <td>
                <strong>${l.status === "Berhasil" ? "Message ID: " + l.telegram_message_id : "Error"}</strong>
                <span title="${escapeHtml(l.response)}">${escapeHtml(l.response)}</span>
              </td>
            </tr>
          `;
        }).join("");
      }
    }

    // Pagination update
    const total = data.total || 0;
    const from = total ? (logCurrentPage - 1) * logPageLimit + 1 : 0;
    const to = Math.min(logCurrentPage * logPageLimit, total);
    
    const info = document.querySelector("#logPageInfo");
    if (info) info.textContent = `${from}-${to} dari ${total} log`;
    
    const prevBtn = document.querySelector("#logPrevBtn");
    if (prevBtn) prevBtn.disabled = logCurrentPage === 1;
    
    const nextBtn = document.querySelector("#logNextBtn");
    if (nextBtn) nextBtn.disabled = logCurrentPage * logPageLimit >= total;

  } catch (e) {
    console.error("Gagal memuat log tabel:", e.message);
  }
}

// Global functions exposed to window object for button onclicks
window.editTargetNotification = async function(id) {
  try {
    const targets = await authFetch("/api/admin/notifications/targets").then(r => r.json());
    const t = targets.find(item => item.id === id);
    if (t) {
      document.querySelector("#targetId").value = t.id;
      document.querySelector("#targetName").value = t.name;
      document.querySelector("#targetChannelId").value = t.channel_id;
      document.querySelector("#targetTopicId").value = t.topic_id || "";
      document.querySelector("#targetType").value = t.type;
      document.querySelector("#targetStatus").value = t.status;
      
      document.querySelector("#targetModalTitle").textContent = "Ubah Target Notifikasi";
      document.querySelector("#targetModal").style.display = "flex";
    }
  } catch (e) {
    alert("Gagal memuat data target: " + e.message);
  }
};

window.testTargetNotification = async function(id) {
  try {
    const res = await authFetch("/api/admin/notifications/targets/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (data.ok) {
      alert("✅ Notifikasi uji coba berhasil terkirim ke Telegram. Message ID: " + data.messageId);
    } else {
      alert("❌ Uji coba gagal: " + data.error);
    }
  } catch (e) {
    alert("❌ Error: " + e.message);
  }
};

window.deleteTargetNotification = async function(id) {
  if (!confirm("Apakah Anda yakin ingin menghapus target ini?")) return;
  try {
    const res = await authFetch("/api/admin/notifications/targets", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    if (res.ok) {
      loadNotificationCenterData();
    }
  } catch (e) {
    alert("Gagal menghapus target: " + e.message);
  }
};

// Drama & Episode Panel Fetching & rendering
let allDetectedDramasCache = [];
let allPlatformSourcesCache = [];

async function loadDramaManagementData() {
  try {
    const res = await authFetch("/api/admin/notifications/detected");
    const data = await res.json();
    allDetectedDramasCache = data || [];
    loadDramaManagementTable();
  } catch (e) {
    console.warn("Gagal memuat data detected dramas:", e.message);
  }
}

function loadDramaManagementTable(search = "") {
  const tbody = document.querySelector("#dramaTableRows");
  if (!tbody) return;

  const filtered = search
    ? allDetectedDramasCache.filter(d => `${d.title} ${d.platform} ${d.last_notification}`.toLowerCase().includes(search))
    : allDetectedDramasCache;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">Drama tidak ditemukan.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(d => `
    <tr>
      <td>
        <strong>${escapeHtml(d.title)}</strong>
        <span>Slug: ${escapeHtml(d.slug)}</span>
      </td>
      <td><strong>${escapeHtml(d.platform)}</strong></td>
      <td><span class="table-status active">${escapeHtml(d.last_notification || "Aktif")}</span></td>
      <td><strong>${d.last_episode || 0} Episode</strong></td>
      <td>ID</td>
      <td>
        <div class="bot-user-actions">
          <button class="small-button" type="button" onclick="window.open('/detail/${d.slug}', '_blank')">Tinjau</button>
        </div>
      </td>
    </tr>
  `).join("");
}

async function loadEpisodeManagementData() {
  try {
    const res = await authFetch("/api/platforms");
    allPlatformSourcesCache = await res.json();
    
    // Fill select filter
    const select = document.querySelector("#episodePlatformFilter");
    if (select) {
      select.innerHTML = `<option value="">Semua Platform</option>` + allPlatformSourcesCache.map(p => `
        <option value="${p.slug}">${p.platform}</option>
      `).join("");
    }
    
    loadEpisodeManagementTable();
  } catch (e) {
    console.warn("Gagal memuat platforms list:", e.message);
  }
}

async function loadEpisodeManagementTable(platformSlug = "", search = "") {
  const tbody = document.querySelector("#episodeTableRows");
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="4" class="empty-cell">Memuat data episode...</td></tr>`;

  try {
    let list = [];
    
    // Resolve platforms we want to list episodes for
    const selectedPlatforms = platformSlug 
      ? allPlatformSourcesCache.filter(p => p.slug === platformSlug)
      : allPlatformSourcesCache.filter(p => p.status === "active");

    for (const source of selectedPlatforms) {
      if (!source.episode?.path) continue;
      
      try {
        // Fetch platform summary endpoints
        const res = await authFetch(`/api/platform/${source.slug}`);
        if (!res.ok) continue;
        const details = await res.json();
        
        // Find episode endpoints and try parsing
        const endpoints = details.endpoints || [];
        const episodeEp = endpoints.find(e => e.index === source.episode.episodesEndpoint);
        if (episodeEp) {
          // Let's call the actual API proxy of that platform to get real live episodes!
          const dataUrl = `/api/platform/${source.slug}/endpoint/${source.episode.episodesEndpoint}?${source.episode.idParam}=${details.idParam || '1'}`;
          const episodesData = await authFetch(dataUrl).then(r => r.json()).catch(() => null);
          
          if (episodesData) {
            const objects = collectCatalogObjects(episodesData);
            objects.forEach(obj => {
              const epNum = getObjectTextValue(obj, ["chapterCount", "chapterNum", "episodeCount", "episodeNo", "episodeNumber", "episode", "ep", "order", "vid", "chapterNo"]);
              const streamUrl = getObjectTextValue(obj, ["videoUrl", "url", "stream_url", "m3u8_path", "m3u8_url", "video_url", "mediaUrl", "cdn_url", "videoAddress"]);
              const title = getObjectTextValue(obj, ["title", "name", "bookName", "chapterName", "chapterTitle"]) || `Episode ${epNum}`;
              
              if (epNum && streamUrl) {
                list.push({
                  platform: source.platform,
                  platformSlug: source.slug,
                  episode: epNum,
                  title: title,
                  streamUrl: streamUrl,
                  vip: Number(epNum) > 12
                });
              }
            });
          }
        }
      } catch (err) {
        // Suppress individual fetch fails
      }
    }

    // Apply search filter if any
    if (search) {
      list = list.filter(item => 
        item.title.toLowerCase().includes(search) || 
        item.platform.toLowerCase().includes(search) || 
        item.streamUrl.toLowerCase().includes(search)
      );
    }

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-cell">Tidak ada episode aktif terdeteksi dari platform terpilih.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(item => `
      <tr>
        <td><strong>${escapeHtml(item.platform)}</strong></td>
        <td><strong>Episode ${item.episode}</strong></td>
        <td>
          <code style="word-break: break-all; font-size: 11px;">${escapeHtml(item.streamUrl)}</code>
        </td>
        <td>
          <span class="table-status ${item.vip ? "active" : "pending"}">${item.vip ? "VIP" : "FREE"}</span>
        </td>
      </tr>
    `).join("");

  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-cell" style="color:var(--red);">Gagal memuat list episode: ${e.message}</td></tr>`;
  }
}
