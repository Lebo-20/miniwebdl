/**
 * fallbackManager.js
 * Automatically manages stream URL fallback switching.
 */
import { validateSourceUrl } from "./sourceChecker.js";

export class FallbackManager {
  /**
   * @param {string[]} urls - List of candidate stream URLs
   * @param {Function} onSourceReady - Callback when a playable source is found: (url, type) => void
   * @param {Function} onAllFailed - Callback when all candidate sources have failed
   * @param {Function} onMessage - Callback to show player message overlays: (msg) => void
   */
  constructor(urls, onSourceReady, onAllFailed, onMessage) {
    this.urls = Array.isArray(urls) ? urls.filter(Boolean) : [];
    this.currentIndex = 0;
    this.activeUrl = null;
    this.activeType = null;
    this.onSourceReady = onSourceReady;
    this.onAllFailed = onAllFailed;
    this.onMessage = onMessage;
    this.retryCount = 0;
    this.maxRetries = 2; // Total 3 attempts per source URL
  }

  /**
   * Attempts to play the next stream URL in the list
   */
  async start() {
    this.currentIndex = 0;
    this.retryCount = 0;
    await this.tryNext();
  }

  async tryNext() {
    if (this.currentIndex >= this.urls.length) {
      console.error("[FallbackManager] All video sources failed.");
      this.onAllFailed();
      return;
    }

    const nextUrl = this.urls[this.currentIndex];
    this.onMessage(`Menghubungkan ke server ${this.currentIndex + 1}...`);

    try {
      const check = await validateSourceUrl(nextUrl);
      
      console.log("Selected Source:", nextUrl);
      console.log("Detected Type:", check.type);

      if (check.active) {
        this.activeUrl = nextUrl;
        this.activeType = check.type;
        this.retryCount = 0; // Reset retry counter for new stream URL
        this.onSourceReady(nextUrl, check.type);
      } else {
        console.warn(`[FallbackManager] Source #${this.currentIndex + 1} failed check.`);
        this.currentIndex++;
        this.retryCount = 0;
        await this.tryNext();
      }
    } catch (err) {
      console.error(`[FallbackManager] Validation error on source #${this.currentIndex + 1}:`, err);
      this.currentIndex++;
      this.retryCount = 0;
      await this.tryNext();
    }
  }

  /**
   * Handles player error event
   * @param {Error|string} error - The player error payload
   */
  handlePlayerError(error) {
    console.warn("[FallbackManager] Player Error event:", error);
    
    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      const msg = `Koneksi terputus, mencoba memuat ulang (${this.retryCount}/${this.maxRetries})...`;
      this.onMessage(msg);
      console.log(`[FallbackManager] Retry attempt ${this.retryCount} of ${this.maxRetries} for current URL.`);
      
      setTimeout(() => {
        if (this.activeUrl && this.activeType) {
          this.onSourceReady(this.activeUrl, this.activeType);
        } else {
          this.currentIndex++;
          this.retryCount = 0;
          this.tryNext();
        }
      }, 1500);
    } else {
      console.warn("[FallbackManager] Max retries reached. Falling back to next server.");
      this.currentIndex++;
      this.retryCount = 0;
      this.tryNext();
    }
  }
}
