/**
 * sourceParser.js
 * Parses API responses and extracts all possible streaming URLs and formats.
 */

export function resolveAllVideoUrls(item, config = {}) {
  const urls = new Set();
  const episodeField = config.episodeField || "videoUrl";

  // Check direct video fields
  const directFields = [
    episodeField,
    "videoUrl",
    "video_url",
    "videoURL",
    "video_hd",
    "videoHd",
    "video",
    "videoAddress",
    "video_address",
    "stream_url",
    "streamUrl",
    "cdn_url",
    "cdnUrl",
    "playUrl",
    "play_url",
    "hls_url",
    "hlsUrl",
    "m3u8_url",
    "m3u8_path",
    "m3u8",
    "external_audio_h264_m3u8",
    "external_audio_h265_m3u8",
    "best_url",
    "1080p_mp4",
    "720p_mp4",
    "540p_mp4",
    "mp4",
    "src",
    "mediaUrl",
    "media_url",
    "file_url",
    "downloadUrl",
    "h264",
    "h265",
    "h264Url",
    "h265Url",
    "Cvideo",
    "hs_path",
    "Bcold",
    "Mopp",
    "Bbar",
    "Mmast",
    "url"
  ];

  for (const field of directFields) {
    const value = item?.[field];
    if (value && typeof value === "string" && isPlayableUrl(value)) {
      urls.add(value);
    }
  }

  // Check nested videoUrls array
  if (Array.isArray(item?.videoUrls)) {
    item.videoUrls.forEach((entry) => {
      const nestedUrl = entry?.url || entry?.videoUrl || entry?.video_url || entry?.cdn_url || entry?.stream_url;
      if (nestedUrl && typeof nestedUrl === "string" && isPlayableUrl(nestedUrl)) {
        urls.add(nestedUrl);
      }
    });
  }

  // Check nested videos array
  if (Array.isArray(item?.videos)) {
    item.videos.forEach((entry) => {
      if (typeof entry === "string" && isPlayableUrl(entry)) {
        urls.add(entry);
      } else if (entry && typeof entry === "object") {
        const nestedUrl = entry?.url || entry?.videoUrl || entry?.video_url || entry?.cdn_url || entry?.stream_url || entry?.playUrl;
        if (nestedUrl && typeof nestedUrl === "string" && isPlayableUrl(nestedUrl)) {
          urls.add(nestedUrl);
        }
      }
    });
  }

  // Check nested streams array (if array)
  if (Array.isArray(item?.streams)) {
    item.streams.forEach((entry) => {
      if (typeof entry === "string" && isPlayableUrl(entry)) {
        urls.add(entry);
      } else if (entry && typeof entry === "object") {
        const nestedUrl = entry?.url || entry?.videoUrl || entry?.video_url || entry?.cdn_url || entry?.stream_url || entry?.playUrl;
        if (nestedUrl && typeof nestedUrl === "string" && isPlayableUrl(nestedUrl)) {
          urls.add(nestedUrl);
        }
      }
    });
  }

  // Check allQualities / qualities / streams / urls objects
  const qualityObjects = [item?.allQualities, item?.qualities, item?.streams, item?.urls];
  for (const qObj of qualityObjects) {
    if (qObj && typeof qObj === "object" && !Array.isArray(qObj)) {
      Object.values(qObj).forEach((val) => {
        if (val && typeof val === "string" && isPlayableUrl(val)) {
          urls.add(val);
        }
      });
    }
  }

  return Array.from(urls);
}

function isPlayableUrl(value) {
  if (!value) return false;
  if (/\.(srt|vtt)(?:$|[?&#])/i.test(value)) return false;
  return /\/api\/secure-media\/|\/api\/media\?|^https?:\/\/|^blob:/i.test(value);
}
