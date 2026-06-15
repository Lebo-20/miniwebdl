import fs from "node:fs";
import path from "node:path";

export function createTelegramApi(token) {
  return async function telegram(method, payload = {}) {
    let response;
    
    // Detect if any property in payload is a local path to an existing file
    const hasLocalFile = Object.values(payload).some(
      (val) => typeof val === "string" && fs.existsSync(val) && path.isAbsolute(val)
    );

    if (hasLocalFile) {
      const formData = new FormData();
      for (const [key, value] of Object.entries(payload)) {
        if (typeof value === "string" && fs.existsSync(value) && path.isAbsolute(value)) {
          const fileBuffer = fs.readFileSync(value);
          const blob = new Blob([fileBuffer]);
          formData.append(key, blob, path.basename(value));
        } else if (value !== undefined) {
          if (typeof value === "object") {
            formData.append(key, JSON.stringify(value));
          } else {
            formData.append(key, String(value));
          }
        }
      }
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        body: formData
      });
    } else {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }

    const data = await response.json();

    if (!data.ok) {
      throw new Error(`${method}: ${data.description || "Telegram API error"}`);
    }

    return data;
  };
}
