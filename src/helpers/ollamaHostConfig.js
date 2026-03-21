/**
 * Ollama Host Configuration Helper
 *
 * Single source of truth for discovering configured Ollama hosts from env vars.
 * Used by: ollama-hosts routes, ollama-vram routes, host-test routes,
 *          syncOrchestrator, ollamaEnrichmentService.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const WILDCARD_HOSTNAMES = new Set(['0.0.0.0', '::', '[::]']);
let parsedDotenvCache = null;

function parseHostFromUrl(urlStr) {
  try {
    return new URL(urlStr).hostname.toLowerCase();
  } catch {
    const m = String(urlStr || '').match(/^(?:https?:\/\/)?([^/:]+)/i);
    return m ? m[1].toLowerCase() : null;
  }
}

function normalizeHostUrl(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (WILDCARD_HOSTNAMES.has(parsed.hostname)) {
      parsed.hostname = '127.0.0.1';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return withScheme;
  }
}

function isWildcardHostUrl(raw) {
  if (!raw) return false;
  const trimmed = String(raw).trim();
  if (!trimmed) return false;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    return WILDCARD_HOSTNAMES.has(new URL(withScheme).hostname);
  } catch {
    return false;
  }
}

function getParsedDotenv() {
  if (parsedDotenvCache !== null) return parsedDotenvCache;

  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
      parsedDotenvCache = {};
      return parsedDotenvCache;
    }
    parsedDotenvCache = dotenv.parse(fs.readFileSync(envPath));
    return parsedDotenvCache;
  } catch {
    parsedDotenvCache = {};
    return parsedDotenvCache;
  }
}

function envFirst(...keys) {
  let wildcardFallback = null;

  for (const key of keys) {
    const v = process.env[key];
    if (!v || !String(v).trim()) continue;

    const trimmed = String(v).trim();
    if (!isWildcardHostUrl(trimmed)) return trimmed;

    if (!wildcardFallback) wildcardFallback = trimmed;

    const dotenvValue = getParsedDotenv()[key];
    if (dotenvValue && String(dotenvValue).trim() && !isWildcardHostUrl(dotenvValue)) {
      return String(dotenvValue).trim();
    }
  }

  return wildcardFallback;
}

function parseHostVramMapFromEnv() {
  const raw = envFirst('OLLAMA_HOST_VRAM_MAP');
  const map = new Map();
  if (!raw) return map;

  for (const entry of String(raw).split(',')) {
    const trimmed = String(entry || '').trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const host = trimmed.slice(0, idx).trim().toLowerCase();
    const vramMb = Number.parseInt(trimmed.slice(idx + 1).trim(), 10);
    if (!host || !Number.isFinite(vramMb) || vramMb <= 0) continue;
    map.set(host, vramMb);
  }

  return map;
}

function resolveHostVramMb(hostUrl, fallbackVramMb) {
  const host = parseHostFromUrl(hostUrl);
  if (!host) return fallbackVramMb;

  const map = parseHostVramMapFromEnv();
  return map.get(host) || fallbackVramMb;
}

/** Returns structured host objects: { id, name, url, priority } */
function getConfiguredHosts() {
  const hosts = [];

  // OLLAMA_HOST (primary) = 192.168.2.66 = UGClawdX (RTX 3090 24GB, gateway host)
  const primaryUrl = normalizeHostUrl(envFirst('OLLAMA_HOST', 'OLLAMA_HOST_1', 'OLLAMA_HOST_PRIMARY'));
  if (primaryUrl) hosts.push({
    id: 'primary',
    name: 'UGClawdX',
    url: primaryUrl,
    priority: 1,
    vramMb: resolveHostVramMb(primaryUrl, 24576)
  });

  // OLLAMA_HOST_2 = 192.168.2.12 = UGBrutal (RTX 5070Ti 16GB)
  const secondaryUrl = normalizeHostUrl(envFirst('OLLAMA_HOST_2', 'OLLAMA_HOST_HEAVY', 'OLLAMA_HOST_SECONDARY'));
  if (secondaryUrl) hosts.push({
    id: 'secondary',
    name: 'UGBrutal',
    url: secondaryUrl,
    priority: 2,
    vramMb: resolveHostVramMb(secondaryUrl, 16384)
  });

  // OLLAMA_HOST_3 = 192.168.2.99 = UGFrank (RTX 3080Ti 12GB)
  const tertiaryUrl = normalizeHostUrl(envFirst('OLLAMA_HOST_3', 'OLLAMA_HOST_TERTIARY'));
  if (tertiaryUrl) hosts.push({
    id: 'tertiary',
    name: 'UGFrank',
    url: tertiaryUrl,
    priority: 3,
    vramMb: resolveHostVramMb(tertiaryUrl, 12288)
  });

  return hosts;
}

/** Returns just the URL strings (for backward compat with syncOrchestrator) */
function getHostUrls() {
  return getConfiguredHosts().map(h => h.url);
}

/** Extract IP/hostname from an Ollama URL */
function parseHostIp(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    const m = String(urlStr || '').match(/^(?:https?:\/\/)?([^/:]+)/i);
    return m ? m[1] : null;
  }
}

module.exports = { normalizeHostUrl, getConfiguredHosts, getHostUrls, parseHostIp };
