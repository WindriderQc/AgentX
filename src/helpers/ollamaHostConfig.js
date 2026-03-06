/**
 * Ollama Host Configuration Helper
 *
 * Single source of truth for discovering configured Ollama hosts from env vars.
 * Used by: ollama-hosts routes, ollama-vram routes, host-test routes,
 *          syncOrchestrator, ollamaEnrichmentService.
 */

function normalizeHostUrl(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function envFirst(...keys) {
  for (const key of keys) {
    const v = process.env[key];
    if (v && String(v).trim()) return String(v).trim();
  }
  return null;
}

/** Returns structured host objects: { id, name, url, priority } */
function getConfiguredHosts() {
  const hosts = [];

  const primaryUrl = normalizeHostUrl(envFirst('OLLAMA_HOST', 'OLLAMA_HOST_1', 'OLLAMA_HOST_PRIMARY'));
  if (primaryUrl) hosts.push({ id: 'primary', name: 'UGFrank', url: primaryUrl, priority: 1, vramMb: 12288 });

  const secondaryUrl = normalizeHostUrl(envFirst('OLLAMA_HOST_2', 'OLLAMA_HOST_HEAVY', 'OLLAMA_HOST_SECONDARY'));
  if (secondaryUrl) hosts.push({ id: 'secondary', name: 'UGBrutal', url: secondaryUrl, priority: 2, vramMb: 16384 });

  const tertiaryUrl = normalizeHostUrl(envFirst('OLLAMA_HOST_3', 'OLLAMA_HOST_TERTIARY'));
  if (tertiaryUrl) hosts.push({ id: 'tertiary', name: 'UGClawdX', url: tertiaryUrl, priority: 3, vramMb: 24576 });

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
