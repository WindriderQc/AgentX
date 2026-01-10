const { execFile } = require('child_process');
const { promisify } = require('util');
const logger = require('../../config/logger');

const execFileAsync = promisify(execFile);

const DEFAULT_CACHE_MS = 5000;
const DEFAULT_TIMEOUT_MS = 3000;

function formatSshError(err, timeoutMs) {
  if (err?.killed) return `SSH timeout after ${timeoutMs}ms`;

  const stderr = String(err?.stderr || '').trim();
  const message = String(err?.message || '').trim();
  const combined = `${stderr}\n${message}`.trim();

  if (/permission denied/i.test(combined)) {
    return 'SSH auth failed (Permission denied). Configure OLLAMA_SSH_KEY_PATH or add this server\'s SSH public key to the Ollama host authorized_keys.';
  }

  if (/could not resolve hostname/i.test(combined)) {
    return 'SSH failed (host not found). Check the Ollama host URL / DNS.';
  }

  if (/connection timed out/i.test(combined) || /operation timed out/i.test(combined)) {
    return `SSH connection timed out after ${timeoutMs}ms`;
  }

  if (/connection refused/i.test(combined)) {
    return 'SSH connection refused. Check sshd is running and the port is correct.';
  }

  // Default: keep it short (avoid dumping the full command line)
  const firstUsefulLine = combined
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .find(l => !/^command failed:/i.test(l));

  return firstUsefulLine || 'SSH failed';
}

function parseHostFromUrl(hostUrl) {
  try {
    const url = new URL(hostUrl);
    return url.hostname;
  } catch (_) {
    const m = String(hostUrl || '').match(/^(?:https?:\/\/)?([^/:]+)(?::\d+)?/i);
    return m ? m[1] : null;
  }
}

function parseDisabledHosts() {
  const raw = String(process.env.OLLAMA_SSH_DISABLED_HOSTS || '').trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => s.toLowerCase())
  );
}

function parseSshUserMap() {
  // Format: "host=user,host2=user2" (hosts can be IPs or DNS names)
  const raw = String(process.env.OLLAMA_SSH_USER_MAP || '').trim();
  const map = new Map();
  if (!raw) return map;

  for (const entry of raw.split(',')) {
    const trimmed = String(entry || '').trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const host = trimmed.slice(0, idx).trim().toLowerCase();
    const user = trimmed.slice(idx + 1).trim();
    if (!host || !user) continue;
    map.set(host, user);
  }

  return map;
}

function resolveSshUserForHost(sshHost) {
  const hostKey = String(sshHost || '').trim().toLowerCase();
  if (!hostKey) return process.env.OLLAMA_SSH_USER || null;

  const map = parseSshUserMap();
  if (map.has(hostKey)) return map.get(hostKey);

  return process.env.OLLAMA_SSH_USER || null;
}

function parseNvidiaSmiCsv(output) {
  const lines = String(output || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const gpus = [];
  for (const line of lines) {
    const parts = line.split(',').map(p => p.trim());
    if (parts.length < 4) continue;

    const indexRaw = parts[0];
    const usedRaw = parts[parts.length - 2];
    const totalRaw = parts[parts.length - 1];
    const name = parts.slice(1, parts.length - 2).join(',').trim();

    const index = Number.parseInt(indexRaw, 10);
    const memoryUsedMiB = Number.parseInt(usedRaw, 10);
    const memoryTotalMiB = Number.parseInt(totalRaw, 10);

    if (!Number.isFinite(index) || !Number.isFinite(memoryUsedMiB) || !Number.isFinite(memoryTotalMiB)) continue;

    gpus.push({
      index,
      name: name || null,
      memoryUsedMiB,
      memoryTotalMiB
    });
  }

  const memoryUsedMiBTotal = gpus.reduce((sum, g) => sum + (g.memoryUsedMiB || 0), 0);
  const memoryTotalMiBTotal = gpus.reduce((sum, g) => sum + (g.memoryTotalMiB || 0), 0);

  return { gpus, memoryUsedMiBTotal, memoryTotalMiBTotal };
}

function buildSshArgs({ sshHost, sshUser, sshPort, sshKeyPath }) {
  const args = [];

  if (sshPort) {
    args.push('-p', String(sshPort));
  }

  // Non-interactive operation
  args.push('-o', 'BatchMode=yes');
  // Keep this permissive by default so first-run works without manual known_hosts.
  // If you want strict checking, set OLLAMA_SSH_STRICT_HOST_KEY_CHECKING=yes and pre-populate known_hosts.
  const strict = (process.env.OLLAMA_SSH_STRICT_HOST_KEY_CHECKING || 'no').toLowerCase();
  args.push('-o', `StrictHostKeyChecking=${strict}`);
  if (strict !== 'yes') {
    args.push('-o', 'UserKnownHostsFile=/dev/null');
  }

  if (sshKeyPath) {
    args.push('-i', sshKeyPath);
  }

  const target = sshUser ? `${sshUser}@${sshHost}` : sshHost;
  args.push(target);

  // Remote command (no shell)
  args.push(
    'nvidia-smi',
    '--query-gpu=index,name,memory.used,memory.total',
    '--format=csv,noheader,nounits'
  );

  return args;
}

class OllamaVramService {
  constructor() {
    this.cache = new Map();
  }

  async getHostVram(hostUrl, overrides = {}) {
    const sshHost = parseHostFromUrl(hostUrl);
    if (!sshHost) {
      return { ok: false, error: 'Invalid host URL' };
    }

    const disabledHosts = parseDisabledHosts();
    if (disabledHosts.has(String(sshHost).toLowerCase())) {
      return { ok: false, sshHost, error: 'VRAM telemetry disabled for this host (OLLAMA_SSH_DISABLED_HOSTS). Common case: Ollama running on Windows without SSH/nvidia-smi compatibility.' };
    }

    const cacheMs = Number.parseInt(process.env.OLLAMA_VRAM_CACHE_MS || '', 10) || DEFAULT_CACHE_MS;
    const cacheKey = sshHost;
    const now = Date.now();

    const cached = this.cache.get(cacheKey);
    if (cached && (now - cached.ts) < cacheMs) {
      return cached.value;
    }

    const sshUser = overrides.sshUser || resolveSshUserForHost(sshHost);
    const sshPort = process.env.OLLAMA_SSH_PORT || 22;
    const sshKeyPath = process.env.OLLAMA_SSH_KEY_PATH || null;
    const timeoutMs = Number.parseInt(process.env.OLLAMA_SSH_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;

    if (!sshUser && !process.env.OLLAMA_SSH_ALLOW_NO_USER) {
      const value = { ok: false, error: 'OLLAMA_SSH_USER not configured' };
      this.cache.set(cacheKey, { ts: now, value });
      return value;
    }

    const args = buildSshArgs({ sshHost, sshUser, sshPort, sshKeyPath });

    try {
      const { stdout } = await execFileAsync('ssh', args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      });

      const parsed = parseNvidiaSmiCsv(stdout);
      const value = {
        ok: true,
        sshHost,
        ...parsed,
        collectedAt: new Date().toISOString()
      };

      this.cache.set(cacheKey, { ts: now, value });
      return value;
    } catch (err) {
      const msg = formatSshError(err, timeoutMs);
      logger.warn('Failed to fetch VRAM via SSH', { sshHost, error: msg });

      const value = { ok: false, sshHost, error: msg };
      this.cache.set(cacheKey, { ts: now, value });
      return value;
    }
  }

  async getVramForHosts(hosts) {
    const out = await Promise.all(
      (hosts || []).map(async (host) => {
        const result = await this.getHostVram(host.url, { sshUser: host?.sshUser });
        return {
          ...host,
          sshHost: result.sshHost || parseHostFromUrl(host.url),
          ok: !!result.ok,
          gpus: result.gpus || [],
          memoryUsedMiBTotal: result.memoryUsedMiBTotal || 0,
          memoryTotalMiBTotal: result.memoryTotalMiBTotal || 0,
          collectedAt: result.collectedAt || null,
          error: result.ok ? null : result.error
        };
      })
    );

    return out;
  }
}

module.exports = new OllamaVramService();
module.exports._internal = { parseHostFromUrl, parseNvidiaSmiCsv, buildSshArgs, parseDisabledHosts, parseSshUserMap, resolveSshUserForHost };
