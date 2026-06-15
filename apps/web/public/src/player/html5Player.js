/**
 * html5Player.js
 * Native HTML5 Video Player wrapper.
 */

export class Html5Player {
  /**
   * @param {Object} options
   * @param {HTMLVideoElement} options.videoElement - The video element
   * @param {Function} options.onError - Callback when an error occurs: (err) => void
   * @param {Function} options.onLoaded - Callback when media can start playing: () => void
   */
  constructor(options) {
    this.video = options.videoElement;
    this.onError = options.onError;
    this.onLoaded = options.onLoaded;
    this.listeners = [];
  }

  /**
   * Loads and plays the native stream URL
   * @param {string} url - Playable MP4/WebM URL
   */
  play(url) {
    console.log("[Html5Player] Playing native media source:", url.slice(0, 100));
    
    // Clear any previous source/objects
    this.video.removeAttribute("src");
    this.video.load();

    const handleError = (e) => {
      const err = this.video.error;
      const detail = err ? `Code ${err.code}: ${err.message || ""}` : "Unknown error";
      this.onError(detail);
    };
    this.video.addEventListener("error", handleError);
    this.listeners.push({ name: "error", fn: handleError });

    const handleCanPlay = () => {
      this.onLoaded();
    };
    this.video.addEventListener("canplay", handleCanPlay);
    this.listeners.push({ name: "canplay", fn: handleCanPlay });

    this.video.src = url;
    this.video.load();

    this.video.play().catch((err) => {
      console.warn("[Html5Player] Autoplay prevented or playing failed:", err);
    });
  }

  destroy() {
    console.log("[Html5Player] Destroying player instance.");
    try {
      this.video.pause();
    } catch (e) {}
    this.listeners.forEach((l) => {
      this.video.removeEventListener(l.name, l.fn);
    });
    this.listeners = [];
    
    this.video.removeAttribute("src");
    this.video.load();
  }
}
