/**
 * embedPlayer.js
 * Embed Player wrapper using <iframe>.
 */

export class EmbedPlayer {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.containerElement - The #playerShell container element
   * @param {HTMLVideoElement} options.videoElement - The underlying native video element to hide
   * @param {Function} options.onError - Callback when an error occurs: (err) => void
   * @param {Function} options.onLoaded - Callback when embed player has loaded: () => void
   */
  constructor(options) {
    this.container = options.containerElement;
    this.video = options.videoElement;
    this.onError = options.onError;
    this.onLoaded = options.onLoaded;
    this.iframe = null;
  }

  /**
   * Loads and mounts the iframe player
   * @param {string} url - The embed/iframe URL
   */
  play(url) {
    console.log("[EmbedPlayer] Rendering embed iframe for url:", url);

    // Hide the native video element to avoid audio/visual collisions
    if (this.video) {
      this.video.style.display = "none";
      this.video.pause();
    }

    // Clean up any existing iframe
    this.removeIframe();

    // Create iframe element
    this.iframe = document.createElement("iframe");
    this.iframe.className = "real-embed-iframe";
    this.iframe.src = url;
    
    // Inline styles to match container boundaries
    Object.assign(this.iframe.style, {
      width: "100%",
      height: "100%",
      border: "0",
      position: "absolute",
      top: "0",
      left: "0",
      zIndex: "1"
    });

    this.iframe.setAttribute("allow", "autoplay; encrypted-media; gyroscope; picture-in-picture");
    this.iframe.setAttribute("allowfullscreen", "true");
    
    // Hide native custom control elements since iframe handles its own controls
    const nativeControls = this.container.querySelectorAll("#playerControlsBar, #playToggleBtn, #fullscreenBackBtn");
    nativeControls.forEach((ctrl) => {
      ctrl.classList.add("hide-embed-active");
      ctrl.style.display = "none";
    });

    this.iframe.onload = () => {
      console.log("[EmbedPlayer] Iframe load complete.");
      this.onLoaded();
    };

    this.iframe.onerror = (e) => {
      console.error("[EmbedPlayer] Iframe load failed:", e);
      this.onError("Gagal memuat iframe player.");
    };

    this.container.appendChild(this.iframe);
  }

  removeIframe() {
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }
  }

  destroy() {
    console.log("[EmbedPlayer] Destroying Embed Player.");
    this.removeIframe();

    // Restore native video elements and custom control layers
    if (this.video) {
      this.video.style.display = "";
    }

    const nativeControls = this.container.querySelectorAll(".hide-embed-active");
    nativeControls.forEach((ctrl) => {
      ctrl.classList.remove("hide-embed-active");
      ctrl.style.display = "";
    });
  }
}
