import fs from "node:fs";
import path from "node:path";

const DEFAULT_SETTINGS = {
  autoDetectDrama: true,
  autoDetectEpisode: true,
  autoNotification: true,
  duplicateProtection: true,
  queueSystem: true,
  retryFailed: true,
  miniAppButton: true,
  topicRouting: true,
  interval: 60000, // 1 minute default monitoring interval
  miniAppUrl: "https://t.me/Tesupload02_bot/app",
  routing: {
    drama_baru: "18520",
    episode_baru: "18520",
    vip_only: "18520",
    pengumuman: "18520",
    maintenance: "18520"
  }
};

const DEFAULT_TARGETS = [
  {
    id: 1,
    name: "Channel Utama Drama Baru",
    channel_id: "-1001684809997",
    topic_id: "18520",
    type: "Drama Baru",
    status: "Aktif"
  },
  {
    id: 2,
    name: "Channel Utama Episode Baru",
    channel_id: "-1001684809997",
    topic_id: "18520",
    type: "Episode Baru",
    status: "Aktif"
  }
];

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

export function loadSettings(rootDir) {
  const filePath = path.join(rootDir, "storage", "notification-settings.json");
  if (!fs.existsSync(filePath)) {
    saveSettings(rootDir, DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS };
  }
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(rootDir, settings) {
  const filePath = path.join(rootDir, "storage", "notification-settings.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  safeWriteFileSync(filePath, JSON.stringify(settings, null, 2), "utf8");
}

export function loadTargets(rootDir) {
  const filePath = path.join(rootDir, "storage", "notification-targets.json");
  if (!fs.existsSync(filePath)) {
    saveTargets(rootDir, DEFAULT_TARGETS);
    return [...DEFAULT_TARGETS];
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return [...DEFAULT_TARGETS];
  }
}

export function saveTargets(rootDir, targets) {
  const filePath = path.join(rootDir, "storage", "notification-targets.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  safeWriteFileSync(filePath, JSON.stringify(targets, null, 2), "utf8");
}

export function loadLogs(rootDir) {
  const filePath = path.join(rootDir, "storage", "notification-logs.json");
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return [];
  }
}

export function saveLogs(rootDir, logs) {
  const filePath = path.join(rootDir, "storage", "notification-logs.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Limit to last 5000 logs
  const truncated = logs.slice(0, 5000);
  safeWriteFileSync(filePath, JSON.stringify(truncated, null, 2), "utf8");
}

export function loadQueue(rootDir) {
  const filePath = path.join(rootDir, "storage", "notification-queue.json");
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return [];
  }
}

export function saveQueue(rootDir, queue) {
  const filePath = path.join(rootDir, "storage", "notification-queue.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  safeWriteFileSync(filePath, JSON.stringify(queue, null, 2), "utf8");
}

export function loadDetectedDramas(rootDir) {
  const filePath = path.join(rootDir, "storage", "detected-dramas.json");
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return [];
  }
}

export function saveDetectedDramas(rootDir, dramas) {
  const filePath = path.join(rootDir, "storage", "detected-dramas.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  safeWriteFileSync(filePath, JSON.stringify(dramas, null, 2), "utf8");
}
