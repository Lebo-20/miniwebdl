import dns from "node:dns";
dns.setDefaultResultOrder('ipv4first');

import { createTelegramApi } from "./src/telegram-api.js";
import { loadConfig } from "./src/config.js";
import { handleUpdate } from "./src/handlers.js";

const config = loadConfig();
const telegram = createTelegramApi(config.botToken);
let offset = 0;

console.log("Bot Telegram aktif. Gunakan /start untuk membuka menu.");
setupBotProfile();
pollUpdates();

async function setupBotProfile() {
  try {
    await telegram("setMyCommands", {
      commands: [
        { command: "start", description: "Buka menu TEAMDL" },
        { command: "cari", description: "Cari judul drama" },
        { command: "vip", description: "Paket VIP" }
      ]
    });

    if (config.publicUrl.startsWith("https://")) {
      await telegram("setChatMenuButton", {
        menu_button: {
          type: "web_app",
          text: "TEAMDL",
          web_app: { url: config.publicUrl }
        }
      });
    }
  } catch (error) {
    console.error("Setup bot profile gagal:", error.message);
  }
}

async function pollUpdates() {
  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"]
      });

      for (const update of updates.result || []) {
        offset = update.update_id + 1;
        await handleUpdate(update, { config, telegram });
      }
    } catch (error) {
      console.error("Polling error:", error.message);
      await sleep(2500);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
