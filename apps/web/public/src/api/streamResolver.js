/**
 * streamResolver.js
 * Resolves video streams from platform APIs.
 */
import { resolveAllVideoUrls } from "./sourceParser.js";

export async function resolveEpisodeStreams(drama, episode, episodeNumber, allSources, platformApi, secureFetch, subtitleLang = "off") {
  if (!episode || episode.locked) {
    return { error: "VIP_REQUIRED", episode };
  }

  const slug = (val) => val.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const source = allSources.find((item) => item.slug === slug(drama.platform));
  const stream = source?.episode?.stream || platformApi[slug(drama.platform)]?.stream;
  const idParam = stream?.idParam || source?.episode?.idParam;
  const episodeParam = stream?.episodeParam || "ep";
  const episodeValue = stream?.episodeMode === "sourceId"
    ? (episode.sourceId || episode.id || episodeNumber || episode.number || 1)
    : (episodeNumber || episode.number || episode.sourceId || 1);

  if (!stream?.path || !idParam || !drama.sourceId) {
    // If no dynamic stream endpoint is needed, use direct url in episode if any
    const urls = episode.videoUrl ? [episode.videoUrl] : resolveAllVideoUrls(episode);
    return { urls, episode };
  }

  const params = new URLSearchParams();
  params.set(idParam, drama.sourceId);
  params.set(episodeParam, String(episodeValue));
  if (subtitleLang && subtitleLang !== "off") {
    params.set("lang", subtitleLang);
  }
  Object.entries(episode.streamParams || {}).forEach(([key, value]) => {
    if (value && !params.has(key)) {
      params.set(key, value);
    }
  });

  console.log(`[streamResolver] Resolving stream from: ${stream.path}?${params.toString()}`);
  
  try {
    const response = await secureFetch(`${stream.path}?${params.toString()}`);
    if (response.status === 403) {
      return { error: "VIP_REQUIRED", episode };
    }
    if (!response.ok) {
      console.warn(`[streamResolver] Fetch failed with status ${response.status}`);
      return { urls: episode.videoUrl ? [episode.videoUrl] : [], episode };
    }

    const text = await response.text();
    
    // Check if it's HLS playlist directly
    if (text && text.trimStart().startsWith("#EXTM3U")) {
      const playlistUrl = hlsPlaylistObjectUrl(text);
      return { urls: playlistUrl ? [playlistUrl] : [], episode };
    }

    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      console.warn("[streamResolver] Failed to parse JSON response:", e);
    }

    const config = { episodeField: stream.episodeField || "videoUrl" };
    
    // Parse all possible urls from response payload
    const urls = collectAllUrlsFromPayload(payload, config);
    if (urls.length === 0 && episode.videoUrl) {
      urls.push(episode.videoUrl);
    }

    // Resolve subtitles
    let parsedSubtitles = collectSubtitlesFromPayload(payload);
    const subtitleRoute = source?.routes?.["6"];
    if (slug(drama.platform) === "bilitv" && subtitleRoute) {
      const bilitvSubtitles = [
        { lang: "id", label: "Bahasa Indonesia", url: `${subtitleRoute}?id=${encodeURIComponent(drama.sourceId)}&ep=${encodeURIComponent(episodeValue)}&lang=id&format=vtt` },
        { lang: "en", label: "English", url: `${subtitleRoute}?id=${encodeURIComponent(drama.sourceId)}&ep=${encodeURIComponent(episodeValue)}&lang=en&format=vtt` }
      ];
      parsedSubtitles = [...parsedSubtitles, ...bilitvSubtitles];
    }

    const resolvedEpisode = {
      ...episode,
      videoUrl: urls[0] || "",
      subtitles: normalizeSubtitleOptions([...(episode.subtitles || []), ...parsedSubtitles])
    };

    return { urls, episode: resolvedEpisode };
  } catch (err) {
    console.error("[streamResolver] Error resolving stream:", err);
    return { urls: episode.videoUrl ? [episode.videoUrl] : [], episode };
  }
}

function hlsPlaylistObjectUrl(text) {
  const normalized = text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }
    return new URL(trimmed, window.location.origin).toString();
  }).join("\n");
  return URL.createObjectURL(new Blob([normalized], { type: "application/vnd.apple.mpegurl" }));
}

function collectAllUrlsFromPayload(payload, config) {
  if (!payload) return [];
  const items = collectObjects(payload);
  const urls = new Set();
  items.forEach((item) => {
    resolveAllVideoUrls(item, config).forEach((url) => urls.add(url));
  });
  return Array.from(urls);
}

function collectSubtitlesFromPayload(payload) {
  if (!payload) return [];
  const items = collectObjects(payload);
  return items.flatMap(resolveSubtitles);
}

function collectObjects(value) {
  const list = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    list.push(node);
    Object.values(node).forEach(walk);
  };
  walk(value);
  return list;
}

function resolveSubtitles(item) {
  const rows = [];
  const arrayValue = (v) => (Array.isArray(v) ? v : []);
  const textValue = (itm, keys) => {
    for (const key of keys) {
      const val = itm?.[key];
      if (val !== undefined && val !== null && val !== "") return String(val);
    }
    return "";
  };

  if (item.subtitles) rows.push(...arrayValue(item.subtitles));
  if (item.subtitle_list) rows.push(...arrayValue(item.subtitle_list));
  if (item.subtitleList) rows.push(...arrayValue(item.subtitleList));
  if (item.captions) rows.push(...arrayValue(item.captions));
  if (item.captionList) rows.push(...arrayValue(item.captionList));

  const directUrl = textValue(item, ["subtitle", "subtitleUrl", "caption", "captionUrl", "srt", "vtt", "subtitles"]);
  if (directUrl) {
    rows.push({ lang: textValue(item, ["subtitleLang", "captionLang", "lang", "language"]) || "default", url: directUrl });
  }

  return rows.map((entry, index) => {
    if (typeof entry === "string") {
      return { lang: `sub${index + 1}`, label: `SUB ${index + 1}`, url: entry };
    }
    const url = textValue(entry, ["url", "subtitle", "subtitleUrl", "caption", "captionUrl", "srt", "vtt", "file"]);
    if (!url) return null;
    const lang = textValue(entry, ["lang", "language", "language_code", "code", "locale", "display_name", "name"]) || `sub${index + 1}`;
    const label = textValue(entry, ["display_name", "label", "name", "language", "lang"]) || lang;
    return { lang, label, url };
  }).filter(Boolean);
}

function normalizeSubtitleOptions(items) {
  const seen = new Set();
  const normalizeSubtitleLang = (value) => {
    const text = String(value || "").trim().toLowerCase();
    const aliases = {
      bahasa: "id", indonesia: "id", indonesian: "id", inggris: "en", english: "en",
      thai: "th", thailand: "th", korean: "ko", korea: "ko", vietnamese: "vi",
      vietnam: "vi", chinese: "zh", mandarin: "zh", japanese: "ja", jepang: "ja"
    };
    const compact = text.replace(/[^a-z]/g, "");
    return aliases[compact] || text.replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 8) || "sub";
  };
  const subtitleSortScore = (lang) => {
    const order = ["id", "en", "th", "ko", "vi", "zh", "ja"];
    const index = order.indexOf(lang);
    return index >= 0 ? index : 99;
  };

  return items
    .map((item) => ({
      lang: normalizeSubtitleLang(item.lang || item.label || "sub"),
      label: item.label || item.lang || "Subtitle",
      url: item.url
    }))
    .filter((item) => {
      if (!item.url || seen.has(item.lang)) return false;
      seen.add(item.lang);
      return true;
    })
    .sort((a, b) => subtitleSortScore(a.lang) - subtitleSortScore(b.lang) || a.lang.localeCompare(b.lang));
}
