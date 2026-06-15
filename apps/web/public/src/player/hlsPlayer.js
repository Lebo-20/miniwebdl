/**
 * hlsPlayer.js
 * HLS Player wrapper using Hls.js library or native Safari playback.
 */

export class HlsPlayer {
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
    this.hls = null;
    this.listeners = [];
  }

  /**
   * Loads and plays the HLS stream URL
   * @param {string} url - HLS stream (.m3u8) URL
   */
  play(url) {
    console.log("[HlsPlayer] Loading HLS stream:", url.slice(0, 100));

    // Clear previous settings
    this.video.removeAttribute("src");
    this.video.load();

    if (window.Hls && window.Hls.isSupported()) {
      this.hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        startFragPrefetch: true,
        xhrSetup: (xhr, url) => {
          xhr.withCredentials = true;
        }
      });

      this.hls.attachMedia(this.video);
      this.hls.loadSource(url);

      this.hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        this.onLoaded();
        this.video.play().catch((err) => {
          console.warn("[HlsPlayer] Play request prevented by browser:", err);
        });
      });

      this.hls.on(window.Hls.Events.ERROR, (event, data) => {
        console.warn(`[HlsPlayer] HLS Event Error: type=${data.type}, details=${data.details}, fatal=${data.fatal}`);
        if (data.fatal) {
          switch (data.type) {
            case window.Hls.ErrorTypes.NETWORK_ERROR:
              console.log("[HlsPlayer] Fatal network error encountered, trying to recover...");
              this.hls.startLoad();
              break;
            case window.Hls.ErrorTypes.MEDIA_ERROR:
              console.log("[HlsPlayer] Fatal media error, attempting recovery...");
              this.hls.recoverMediaError();
              break;
            default:
              this.onError(`HLS Fatal Error (${data.details})`);
              break;
          }
        }
      });
    } else if (this.video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native Apple device support
      const handleCanPlay = () => {
        this.onLoaded();
      };
      this.video.addEventListener("canplay", handleCanPlay);
      this.listeners.push({ name: "canplay", fn: handleCanPlay });

      const handleError = (e) => {
        const err = this.video.error;
        const detail = err ? `Code ${err.code}: ${err.message || ""}` : "Unknown error";
        this.onError(`Native HLS Error: ${detail}`);
      };
      this.video.addEventListener("error", handleError);
      this.listeners.push({ name: "error", fn: handleError });

      this.video.src = url;
      this.video.load();
      this.video.play().catch((err) => {
        console.warn("[HlsPlayer] Play failed:", err);
      });
    } else {
      this.onError("HLS.js is not loaded and native HLS playback is unsupported in this browser.");
    }
  }

  destroy() {
    console.log("[HlsPlayer] Destroying HLS player.");
    try {
      this.video.pause();
    } catch (e) {}
    this.listeners.forEach((l) => {
      this.video.removeEventListener(l.name, l.fn);
    });
    this.listeners = [];

    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    this.video.removeAttribute("src");
    this.video.load();
  }
}
