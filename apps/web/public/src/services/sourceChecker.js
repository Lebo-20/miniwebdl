/**
 * sourceChecker.js
 * Validates URLs and detects media stream formats.
 */

export function detectTypeFromUrl(url) {
  if (!url) return "unknown";
  
  const lower = url.toLowerCase();
  
  // Custom check for secure media proxy URLs
  if (lower.includes("/api/secure-media/")) {
    if (lower.includes(".m3u8") || lower.includes("kind=hls")) return "hls";
    if (lower.includes(".mpd") || lower.includes("kind=dash")) return "dash";
    if (lower.includes("kind=embed")) return "embed";
    if (lower.includes(".mp4") || lower.includes("kind=mp4")) return "mp4";
  }

  // Try extracting from secure media URL parameter
  try {
    const urlObj = new URL(url, window.location.origin);
    const kind = urlObj.searchParams.get("kind");
    if (kind === "hls" || kind === "dash" || kind === "embed" || kind === "mp4") {
      return kind;
    }
  } catch (e) {}

  if (lower.includes(".m3u8") || lower.includes("mpegurl")) {
    return "hls";
  }
  if (lower.includes(".mpd") || lower.includes("dash+xml")) {
    return "dash";
  }
  if (
    lower.includes("embed") ||
    lower.includes("iframe") ||
    lower.includes("/play/") ||
    lower.includes("/player/") ||
    lower.includes(".html") ||
    lower.includes(".htm")
  ) {
    return "embed";
  }
  return "mp4";
}

/**
 * Probes a stream URL to check if it's active and retrieves Content-Type / CORS support.
 * @param {string} url - The URL to check
 * @returns {Promise<{active: boolean, type: string, cors: boolean, error?: string}>}
 */
export async function validateSourceUrl(url) {
  if (!url) {
    return { active: false, type: "unknown", cors: false, error: "Empty URL" };
  }

  console.log(`[sourceChecker] Validating URL: ${url.slice(0, 100)}...`);

  // Detect type by extension first in case of network blocking
  const typeGuess = detectTypeFromUrl(url);

  // If it's our secure media endpoint, we know the backend will handle CORS and availability.
  // But we can check it.
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: { Accept: "*/*" }
    });

    if (!response.ok) {
      throw new Error(`HEAD status ${response.status}, falling back to GET range`);
    }

    const active = true;
    const contentType = response.headers.get("content-type") || "";
    let detectedType = typeGuess;

    if (contentType.includes("mpegurl") || contentType.includes("m3u8")) {
      detectedType = "hls";
    } else if (contentType.includes("dash+xml")) {
      detectedType = "dash";
    } else if (contentType.includes("html")) {
      detectedType = "embed";
    } else if (contentType.includes("video/mp4") || contentType.includes("video/")) {
      detectedType = "mp4";
    }

    console.log(`[sourceChecker] URL verified active. Status: ${response.status}. Content-Type: ${contentType}. Detected format: ${detectedType}`);

    return {
      active,
      type: detectedType,
      cors: true,
      statusCode: response.status
    };
  } catch (err) {
    // If HEAD request fails, it might be due to CORS or HEAD method not supported by the server.
    // Try doing a short range GET request to verify if it's CORS blocking or dead.
    try {
      const response = await fetch(url, {
        headers: { Range: "bytes=0-10", Accept: "*/*" }
      });

      const active = response.ok;
      const contentType = response.headers.get("content-type") || "";
      let detectedType = typeGuess;

      if (contentType.includes("mpegurl") || contentType.includes("m3u8")) {
        detectedType = "hls";
      } else if (contentType.includes("dash+xml")) {
        detectedType = "dash";
      } else if (contentType.includes("html")) {
        detectedType = "embed";
      } else if (contentType.includes("video/")) {
        detectedType = "mp4";
      }

      console.log(`[sourceChecker] URL verified active via GET. Content-Type: ${contentType}. Detected format: ${detectedType}`);

      return {
        active,
        type: detectedType,
        cors: true,
        statusCode: response.status
      };
    } catch (getCorsErr) {
      // If it throws TypeError: Failed to fetch, it's typically CORS or network failure.
      // For external raw URLs with CORS blocks, HLS.js and Dash.js can sometimes stream them 
      // directly (or they get proxied). So we shouldn't discard them immediately if the syntax looks correct.
      const isNetworkError = getCorsErr.name === "TypeError" || getCorsErr.message?.includes("fetch");
      
      console.warn(`[sourceChecker] Probing URL failed:`, getCorsErr);

      if (isNetworkError) {
        // If it's a proxy url and failed, it means the server failed to fetch it
        if (url.startsWith("/api/secure-media/")) {
          return { active: false, type: typeGuess, cors: true, error: "Upstream down" };
        }
        
        // Otherwise, assume it might be a CORS block, but URL could still be active.
        return {
          active: true, // Optimistically try it
          type: typeGuess,
          cors: false,
          error: "CORS or Network restriction"
        };
      }

      return {
        active: false,
        type: typeGuess,
        cors: false,
        error: getCorsErr.message
      };
    }
  }
}
