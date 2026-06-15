import fs from "node:fs";
import path from "node:path";

export function loadPlatformSources(rootDir) {
  const sourcesDir = path.join(rootDir, "storage", "sources");

  if (!fs.existsSync(sourcesDir)) {
    return [];
  }

  return fs.readdirSync(sourcesDir)
    .filter((file) => file.toLowerCase().endsWith("_endpoints.txt"))
    .map((file) => parseEndpointFile(path.join(sourcesDir, file)))
    .sort((a, b) => a.platform.localeCompare(b.platform));
}

export function loadPublicPlatformSources(rootDir) {
  return loadPlatformSources(rootDir).map(redactPlatformSource);
}

export function parseEndpointFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const platform = matchValue(raw, /^PLATFORM:\s*(.+)$/m) || path.basename(filePath).replace(/_endpoints\.txt$/i, "");
  const scrapedAt = matchValue(raw, /^SCRAPED AT:\s*(.+)$/m);
  const totalEndpoints = Number(matchValue(raw, /^TOTAL ENDPOINTS:\s*(\d+)$/m) || 0);
  const blocks = raw.split(/-{20,}/g);
  const endpoints = blocks.map(parseEndpointBlock).filter(Boolean);

  return {
    platform,
    slug: slug(platform),
    scrapedAt,
    totalEndpoints: totalEndpoints || endpoints.length,
    sourceFile: path.basename(filePath),
    status: endpoints.length ? "active" : "maintenance",
    endpoints
  };
}

function parseEndpointBlock(block) {
  const title = block.match(/\[\d+\]\s+([A-Z]+)\s+([^\r\n]+)/);
  if (!title) {
    return null;
  }

  const params = [];
  const paramMatches = block.matchAll(/-\s+Name:[ \t]*([^|]+)\|[ \t]*Type:[ \t]*([^|]+)\|[ \t]*Desc:[ \t]*Value:[ \t]*([^\r\n]*)/g);
  for (const match of paramMatches) {
    params.push({
      name: match[1].trim(),
      type: match[2].trim(),
      defaultValue: match[3].trim()
    });
  }

  return {
    method: title[1].trim(),
    path: title[2].trim(),
    fullUrl: matchValue(block, /^Full URL:\s*(.+)$/m),
    description: matchValue(block, /^Description:\s*(.+)$/m) || "No description provided.",
    statusCode: Number(matchValue(block, /^Status Code:\s*(\d+)$/m) || 0),
    exampleUrl: params.find((param) => /^url[_-]/i.test(param.name))?.defaultValue || "",
    params
  };
}

function redactPlatformSource(source) {
  return {
    ...source,
    endpoints: source.endpoints.map((endpoint) => ({
      ...endpoint,
      fullUrl: "[server-only]",
      exampleUrl: "[server-only]",
      params: endpoint.params.map((param) => ({
        ...param,
        defaultValue: shouldRedactParam(param.name, param.defaultValue) ? "[server-only]" : redactUrl(param.defaultValue)
      }))
    }))
  };
}

function isSecretParam(name) {
  return /(^|[_-])(code|token|key|api[_-]?key|secret)([_-]|$)/i.test(name);
}

function shouldRedactParam(name, value) {
  return isSecretParam(name) || /^url[_-]?\d*$/i.test(name) || /^https?:\/\//i.test(String(value || ""));
}

function redactUrl(value) {
  if (!value) {
    return value;
  }

  return String(value)
    .replace(/([?&](?:code|token|key|api_key|apikey|secret)=)[^&#\s]*/gi, "$1[server-only]")
    .replace(/[A-F0-9]{32}/g, "[server-only]");
}

function matchValue(value, pattern) {
  return value.match(pattern)?.[1]?.trim() || "";
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
