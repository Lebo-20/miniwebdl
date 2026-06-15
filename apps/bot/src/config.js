import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");

export function loadConfig() {
  const env = loadEnv(path.join(rootDir, ".env"));
  const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  const adminId = process.env.ADMIN_ID || env.ADMIN_ID;
  const publicUrl = process.env.WEB_PUBLIC_URL || env.WEB_PUBLIC_URL || "http://localhost:3000";

  if (!botToken) {
    console.error("BOT_TOKEN belum diisi. Salin .env.example ke .env lalu isi token bot.");
    process.exit(1);
  }

  return {
    apiId: process.env.API_ID || env.API_ID || "",
    apiHash: process.env.API_HASH || env.API_HASH || "",
    botToken,
    adminId: Number(adminId || 0),
    publicUrl: trimSlash(publicUrl),
    rootDir
  };
}

function trimSlash(value) {
  return value.replace(/\/$/, "");
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
