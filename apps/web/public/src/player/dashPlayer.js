/**
 * dashPlayer.js
 * DASH Player wrapper using Dash.js library. Loads Dash.js CDN dynamically on demand.
 */

export class DashPlayer {
  /**
   * @param {Object} options
   * @param {HTMLVideoElement} options.videoElement - The video element
   * @param {Function} options.onError - Callback when an error occurs: (err) => void
   * @param {Function} options.onLoaded - Callback when media is ready to play: () => void
   */
  constructor(options) {
    this.video = options.videoElement;
    this.onError = options.onError;
    this.onLoaded = options.onLoaded;
    this.player = null;
  }

  /**
   * Loads and plays the DASH stream URL
   * @param {string} url - DASH stream (.mpd) URL
   */
  async play(url) {
    console.log("[DashPlayer] Loading DASH stream URL:", url.slice(0, 100));

    // Reset standard video element
    this.video.removeAttribute("src");
    this.video.load();

    try {
      await this.ensureLibraryLoaded();
      
      if (!window.dashjs) {
        throw new Error("Dash.js library global not found after injection.");
      }

      this.player = window.dashjs.MediaPlayer().create();
      this.player.initialize(this.video, url, true);
      this.player.setXHRWithCredentials(true);

      // Listeners
      const handleMetadataLoaded = () => {
        this.onLoaded();
        this.player.off(window.dashjs.MediaPlayer.events.PLAYBACK_METADATA_LOADED, handleMetadataLoaded);
      };
      this.player.on(window.dashjs.MediaPlayer.events.PLAYBACK_METADATA_LOADED, handleMetadataLoaded);

      this.player.on(window.dashjs.MediaPlayer.events.ERROR, (e) => {
        console.warn("[DashPlayer] Internal Media Error:", e);
        const detail = e.error ? (e.error.message || e.error) : "DASH player playback failed";
        this.onError(detail);
      });

    } catch (err) {
      console.error("[DashPlayer] Initialization failed:", err);
      this.onError(`Dash.js loading failed: ${err.message}`);
    }
  }

  /**
   * Loads Dash.js script dynamically if not already present in the window context
   */
  ensureLibraryLoaded() {
    return new Promise((resolve, reject) => {
      if (window.dashjs) {
        resolve();
        return;
      }

      console.log("[DashPlayer] Script tag injection started.");
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/dashjs/4.7.1/dash.all.min.js";
      script.async = true;
      
      script.onload = () => {
        console.log("[DashPlayer] Script tag loaded successfully.");
        resolve();
      };
      
      script.onerror = () => {
        console.error("[DashPlayer] Failed to fetch script tag from CDN.");
        reject(new Error("Network error loading dash.all.min.js from CDN"));
      };

      document.head.appendChild(script);
    });
  }

  destroy() {
    console.log("[DashPlayer] Destroying player instance.");
    try {
      this.video.pause();
    } catch (e) {}
    if (this.player) {
      this.player.reset();
      this.player = null;
    }
    
    this.video.removeAttribute("src");
    this.video.load();
  }
}
