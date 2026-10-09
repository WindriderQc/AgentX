'use strict';

/**
 * AgentX native Data GPU collector.
 *
 * Runs on the always-on Core host (Data publishes on loopback only) and samples
 * `nvidia-smi --query-gpu` read-only on each configured GPU host: locally, or
 * over key-based SSH (`ssh -o BatchMode=yes`). Nothing is installed on the GPU
 * hosts. Every cycle posts one result per host to Data; a failing or slow host
 * is reported as an error and never blocks the others.
 *
 * A host that names its Ollama service (`ollamaService`: a systemd unit such as
 * "ollama.service", or "windows") also has the service's allowlisted settings
 * read, read-only, at a slower interval (shared/ollamaServiceEnvironment.js).
 *
 * Configuration (external instance settings, never committed):
 *   DATA_URL               Data base URL (default http://127.0.0.1:3083)
 *   GPU_AGENT_HOSTS_JSON   JSON array of hosts, or
 *   GPU_AGENT_HOSTS_FILE   path to a file holding that JSON array
 *       [{"id":"gpu-a","name":"GPU A","ssh":"user@gpu-a","ollamaUrl":"http://gpu-a:11434",
 *         "ollamaService":"ollama.service"},
 *        {"id":"core","local":true}]
 *   GPU_AGENT_ID           collector identifier (default hostname)
 *   GPU_AGENT_INTERVAL_MS  sampling interval, 5 s..10 min (default 30 s)
 *   GPU_AGENT_HOST_TIMEOUT_MS  per-host command timeout, 2..60 s (default 10 s)
 *   GPU_AGENT_OLLAMA_ENV_INTERVAL_MS  Ollama settings interval, 1 min..24 h (default 10 min)
 *   GPU_AGENT_ONCE=1       one cycle, then exit (non-zero if anything failed)
 */

const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const {
  SAFE_UNIT,
  WINDOWS_MACHINE_KEY,
  WINDOWS_SERVICE,
  WINDOWS_USER_KEY,
  parseSystemdShow,
  parseWindowsEnvironment,
  systemdShowArgs
} = require('../../shared/ollamaServiceEnvironment');

const VERSION = 'gpu-1.1.0';
const MAX_HOSTS = 32;
const MAX_GPUS = 16;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// user@host, host, user@[v6]; never an option-looking value.
const SAFE_SSH_TARGET = /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\])$/;
const SAFE_BIN = /^[A-Za-z0-9_./\\: -]{1,300}$/;

const QUERY_FIELDS = [
  'index', 'name', 'uuid', 'pci.bus_id', 'utilization.gpu', 'utilization.memory',
  'memory.used', 'memory.total', 'temperature.gpu', 'power.draw', 'power.limit',
  'clocks.sm', 'clocks.max.sm', 'pcie.link.gen.current', 'pcie.link.gen.max',
  'pcie.link.width.current', 'pcie.link.width.max', 'clocks_throttle_reasons.active'
];
const QUERY_ARGS = [`--query-gpu=${QUERY_FIELDS.join(',')}`, '--format=csv,noheader,nounits'];

// nvidia-smi clocks_throttle_reasons bit mask.
const THROTTLE_BITS = [
  [0x1, 'idle'],
  [0x2, 'app_clocks'],
  [0x4, 'sw_power_cap'],
  [0x8, 'hw_slowdown'],
  [0x10, 'sync_boost'],
  [0x20, 'sw_thermal'],
  [0x40, 'hw_thermal'],
  [0x80, 'hw_power_brake'],
  [0x100, 'display_clocks']
];

const ts = () => new Date().toISOString();

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readSettings(env = process.env) {
  return {
    dataUrl: String(env.DATA_URL || 'http://127.0.0.1:3083').replace(/\/+$/, ''),
    collectorId: env.GPU_AGENT_ID || env.SCANNER_ID || os.hostname().toLowerCase(),
    intervalMs: boundedInt(env.GPU_AGENT_INTERVAL_MS, 30_000, 5_000, 600_000),
    hostTimeoutMs: boundedInt(env.GPU_AGENT_HOST_TIMEOUT_MS, 10_000, 2_000, 60_000),
    requestTimeoutMs: boundedInt(env.GPU_AGENT_REQUEST_TIMEOUT_MS, 10_000, 2_000, 60_000),
    ollamaEnvIntervalMs: boundedInt(env.GPU_AGENT_OLLAMA_ENV_INTERVAL_MS, 600_000, 60_000, 86_400_000),
    sshBin: env.GPU_AGENT_SSH_BIN || 'ssh',
    nvidiaSmiBin: env.NVIDIA_SMI_BIN || 'nvidia-smi',
    systemctlBin: env.SYSTEMCTL_BIN || 'systemctl',
    once: env.GPU_AGENT_ONCE === '1'
  };
}

function validateHost(raw, position) {
  const where = `host #${position + 1}`;
  if (!raw || typeof raw !== 'object') throw new Error(`${where}: must be an object`);
  const id = String(raw.id || '').trim();
  if (!SAFE_ID.test(id)) throw new Error(`${where}: id must match ${SAFE_ID}`);
  const local = raw.local === true;
  const ssh = raw.ssh == null ? '' : String(raw.ssh).trim();
  if (local === Boolean(ssh)) throw new Error(`${id}: set exactly one of "local": true or "ssh"`);
  if (ssh && !SAFE_SSH_TARGET.test(ssh)) throw new Error(`${id}: ssh must be host or user@host`);
  const sshPort = raw.sshPort == null ? null : boundedInt(raw.sshPort, NaN, 1, 65535);
  if (raw.sshPort != null && !Number.isFinite(sshPort)) throw new Error(`${id}: sshPort must be 1-65535`);
  const nvidiaSmi = raw.nvidiaSmi == null ? '' : String(raw.nvidiaSmi);
  if (nvidiaSmi && (!SAFE_BIN.test(nvidiaSmi) || nvidiaSmi.startsWith('-'))) {
    throw new Error(`${id}: nvidiaSmi must be a plain executable path`);
  }
  let ollamaUrl = '';
  if (raw.ollamaUrl) {
    const parsed = new URL(String(raw.ollamaUrl));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`${id}: ollamaUrl must be an http(s) URL without credentials`);
    }
    ollamaUrl = parsed.origin;
  }
  const ollamaService = raw.ollamaService == null ? '' : String(raw.ollamaService).trim();
  if (ollamaService && ollamaService !== WINDOWS_SERVICE && !SAFE_UNIT.test(ollamaService)) {
    throw new Error(`${id}: ollamaService must be a systemd unit name or "${WINDOWS_SERVICE}"`);
  }
  return {
    id,
    name: String(raw.name || id).slice(0, 200),
    local,
    ssh,
    sshPort,
    nvidiaSmi,
    ollamaUrl,
    ollamaService
  };
}

/** Host list from GPU_AGENT_HOSTS_JSON or GPU_AGENT_HOSTS_FILE (never both). */
function loadHosts(env = process.env, readFile = fs.readFileSync) {
  let source = env.GPU_AGENT_HOSTS_JSON;
  let label = 'GPU_AGENT_HOSTS_JSON';
  if (source && env.GPU_AGENT_HOSTS_FILE) throw new Error('Set GPU_AGENT_HOSTS_JSON or GPU_AGENT_HOSTS_FILE, not both');
  if (!source && env.GPU_AGENT_HOSTS_FILE) {
    label = env.GPU_AGENT_HOSTS_FILE;
    source = readFile(env.GPU_AGENT_HOSTS_FILE, 'utf8');
  }
  if (!source) throw new Error('Set GPU_AGENT_HOSTS_JSON or GPU_AGENT_HOSTS_FILE to the GPU hosts to sample');
  let parsed;
  try { parsed = JSON.parse(source); }
  catch (error) { throw new Error(`Invalid host list in ${label}: ${error.message}`); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${label} must be a non-empty JSON array`);
  if (parsed.length > MAX_HOSTS) throw new Error(`${label} lists more than ${MAX_HOSTS} hosts`);
  const hosts = parsed.map(validateHost);
  const ids = new Set();
  for (const host of hosts) {
    if (ids.has(host.id)) throw new Error(`Duplicate host id: ${host.id}`);
    ids.add(host.id);
  }
  return hosts;
}

function nullable(value) {
  const text = String(value ?? '').trim();
  if (!text || /^\[?(?:N\/A|Not Supported|Unknown Error|Unknown|GPU is lost|Requested functionality has been deprecated)\]?$/i.test(text)) return null;
  return text;
}

function number(value) {
  const text = nullable(value);
  if (text == null) return null;
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeThrottleReasons(value) {
  const text = nullable(value);
  if (text == null || !/^0x[0-9a-f]+$/i.test(text)) return { active: null, reasons: [] };
  const mask = Number.parseInt(text.slice(2), 16);
  if (!Number.isFinite(mask)) return { active: null, reasons: [] };
  return { active: text, reasons: THROTTLE_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name) };
}

/** Parse `--format=csv,noheader,nounits` output for QUERY_FIELDS. */
function parseNvidiaSmiCsv(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('nvidia-smi returned no GPU rows');
  if (lines.length > MAX_GPUS) throw new Error(`nvidia-smi returned more than ${MAX_GPUS} GPU rows`);
  return lines.map((line, position) => {
    const cells = line.split(',').map(cell => cell.trim());
    if (cells.length !== QUERY_FIELDS.length) {
      throw new Error(`nvidia-smi row ${position + 1}: expected ${QUERY_FIELDS.length} fields, got ${cells.length}`);
    }
    const [index, name, uuid, busId, util, memUtil, memUsed, memTotal, temp, power, powerLimit,
      sm, smMax, gen, genMax, width, widthMax, throttle] = cells;
    const throttleState = decodeThrottleReasons(throttle);
    const parsedIndex = number(index);
    return {
      index: Number.isInteger(parsedIndex) ? parsedIndex : position,
      name: nullable(name) || '',
      uuid: nullable(uuid) || '',
      busId: nullable(busId) || '',
      utilizationPct: number(util),
      memoryUtilizationPct: number(memUtil),
      memoryUsedMiB: number(memUsed),
      memoryTotalMiB: number(memTotal),
      temperatureC: number(temp),
      powerDrawW: number(power),
      powerLimitW: number(powerLimit),
      smClockMHz: number(sm),
      smClockMaxMHz: number(smMax),
      pcieGen: number(gen),
      pcieGenMax: number(genMax),
      pcieWidth: number(width),
      pcieWidthMax: number(widthMax),
      throttleReasonsActive: throttleState.active,
      throttleReasons: throttleState.reasons
    };
  });
}

function sshCommand(host, settings, remoteCommand) {
  const connectTimeout = String(Math.max(1, Math.min(5, Math.floor(settings.hostTimeoutMs / 2000))));
  return {
    file: settings.sshBin,
    args: [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${connectTimeout}`,
      ...(host.sshPort ? ['-p', String(host.sshPort)] : []),
      '--', host.ssh,
      remoteCommand
    ]
  };
}

/** The executable and arguments that sample one host. Arguments are never shell-joined locally. */
function commandFor(host, settings) {
  const smi = host.nvidiaSmi || settings.nvidiaSmiBin;
  if (host.local) return { file: smi, args: [...QUERY_ARGS] };
  // The remote shell receives one fixed command; only the validated binary path
  // is configurable (quoted when it holds a space, e.g. a Windows install path).
  return sshCommand(host, settings, [smi.includes(' ') ? `"${smi}"` : smi, ...QUERY_ARGS].join(' '));
}

/**
 * Read-only commands that print the Ollama service's environment: one
 * `systemctl show` for a systemd unit, or the machine then the user
 * environment for "windows". Each remote command is fixed text that both
 * cmd.exe and PowerShell accept; only the validated unit name varies.
 */
function ollamaEnvCommands(host, settings) {
  if (host.ollamaService === WINDOWS_SERVICE) {
    const keys = [WINDOWS_MACHINE_KEY, WINDOWS_USER_KEY];
    return host.local
      ? keys.map(key => ({ file: 'reg', args: ['query', key] }))
      : keys.map(key => sshCommand(host, settings, `reg query ${key.includes(' ') ? `"${key}"` : key}`));
  }
  const args = systemdShowArgs(host.ollamaService);
  return [host.local
    ? { file: settings.systemctlBin, args }
    : sshCommand(host, settings, ['systemctl', ...args].join(' '))];
}

function runCommand(execFileImpl, file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFileImpl(file, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
      maxBuffer: 256 * 1024
    }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

function describeFailure(error, stderr, timeoutMs) {
  if (error?.killed || error?.signal === 'SIGKILL') return `timed out after ${timeoutMs}ms`;
  const detail = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || error?.message || 'failed';
  return detail.slice(0, 400);
}

/** Sample one host. Never rejects: failures become `{ ok: false, error }`. */
async function sampleHost(host, settings, execFileImpl = execFile) {
  const base = { hostId: host.id, name: host.name, ollamaUrl: host.ollamaUrl, local: host.local };
  const { file, args } = commandFor(host, settings);
  const startedAt = Date.now();
  try {
    const { error, stdout, stderr } = await runCommand(execFileImpl, file, args, settings.hostTimeoutMs);
    const sampledAt = new Date().toISOString();
    if (error) return { ...base, ok: false, sampledAt, durationMs: Date.now() - startedAt, error: describeFailure(error, stderr, settings.hostTimeoutMs) };
    return { ...base, ok: true, sampledAt, durationMs: Date.now() - startedAt, gpus: parseNvidiaSmiCsv(stdout) };
  } catch (error) {
    return { ...base, ok: false, sampledAt: new Date().toISOString(), durationMs: Date.now() - startedAt, error: String(error.message || error).slice(0, 400) };
  }
}

/** Read one host's Ollama service settings. Never rejects: failures become `{ ok: false, error }`. */
async function readOllamaEnvironment(host, settings, execFileImpl = execFile) {
  const windows = host.ollamaService === WINDOWS_SERVICE;
  const base = { source: windows ? 'windows-registry' : 'systemd', unit: windows ? null : host.ollamaService };
  try {
    const outputs = [];
    for (const { file, args } of ollamaEnvCommands(host, settings)) {
      const { error, stdout, stderr } = await runCommand(execFileImpl, file, args, settings.hostTimeoutMs);
      if (error) {
        return { ...base, observedAt: new Date().toISOString(), ok: false, error: describeFailure(error, stderr, settings.hostTimeoutMs) };
      }
      outputs.push(stdout);
    }
    const parsed = windows ? parseWindowsEnvironment(outputs[0], outputs[1]) : parseSystemdShow(outputs[0], host.ollamaService);
    return { ...parsed, observedAt: new Date().toISOString() };
  } catch (error) {
    return { ...base, observedAt: new Date().toISOString(), ok: false, error: String(error.message || error).slice(0, 400) };
  }
}

function collectorInfo(settings, hosts) {
  return {
    collectorId: settings.collectorId,
    hostname: os.hostname(),
    platform: process.platform,
    agentVersion: VERSION,
    intervalMs: settings.intervalMs,
    hosts: hosts.map(host => ({ id: host.id, name: host.name, ollamaUrl: host.ollamaUrl, local: host.local }))
  };
}

async function postJson(settings, route, body, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${settings.dataUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(settings.requestTimeoutMs)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.message || `${route}: HTTP ${response.status}`);
  return json.data || json;
}

/**
 * One collection cycle: all hosts in parallel, then one post to Data. Ollama
 * settings are read for a host when `envState` (host id → last read) says they
 * are due; a failed read waits for the next interval too.
 */
async function runCycle({ settings, hosts, execFileImpl = execFile, fetchImpl = globalThis.fetch, envState = new Map(), now = Date.now }) {
  const startedAt = now();
  const due = host => Boolean(host.ollamaService)
    && (!envState.has(host.id) || startedAt - envState.get(host.id) >= settings.ollamaEnvIntervalMs);
  const results = await Promise.all(hosts.map(async (host) => {
    const [sample, environment] = await Promise.all([
      sampleHost(host, settings, execFileImpl),
      due(host) ? readOllamaEnvironment(host, settings, execFileImpl) : null
    ]);
    if (!environment) return sample;
    envState.set(host.id, startedAt);
    if (!environment.ok) console.error(`[${ts()}] ${host.id} Ollama settings: ${environment.error}`);
    return { ...sample, ollamaEnvironment: environment };
  }));
  for (const result of results) {
    if (!result.ok) console.error(`[${ts()}] ${result.hostId}: ${result.error}`);
  }
  let posted = null;
  let postError = null;
  try {
    posted = await postJson(settings, '/api/v1/hardware/samples', { ...collectorInfo(settings, hosts), results }, fetchImpl);
  } catch (error) {
    postError = error.message;
    console.error(`[${ts()}] post to Data failed (${settings.dataUrl}): ${error.message}`);
  }
  return { results, posted, postError, failedHosts: results.filter(result => !result.ok).length };
}

function start(env = process.env) {
  const settings = readSettings(env);
  const hosts = loadHosts(env);
  console.log(`AgentX gpu-agent ${VERSION} starting`, {
    DATA_URL: settings.dataUrl,
    collectorId: settings.collectorId,
    intervalMs: settings.intervalMs,
    hostTimeoutMs: settings.hostTimeoutMs,
    ollamaEnvIntervalMs: settings.ollamaEnvIntervalMs,
    hosts: hosts.map(host => host.id)
  });
  const envState = new Map();

  if (settings.once) {
    (async () => {
      try {
        const cycle = await runCycle({ settings, hosts });
        console.log(`[${ts()}] cycle: ${cycle.results.length - cycle.failedHosts}/${cycle.results.length} hosts sampled${cycle.postError ? ', not stored' : ''}`);
        if (cycle.postError || cycle.failedHosts > 0) process.exitCode = 1;
      } finally {
        setTimeout(() => process.exit(process.exitCode || 0), 250).unref();
      }
    })();
    return;
  }

  let running = false;
  const tick = async () => {
    if (running) return; // a slow cycle is never stacked
    running = true;
    try { await runCycle({ settings, hosts, envState }); }
    catch (error) { console.error(`[${ts()}] cycle failed: ${error.message}`); }
    finally { running = false; }
  };
  postJson(settings, '/api/v1/hardware/collector/heartbeat', collectorInfo(settings, hosts))
    .catch(error => console.error(`[${ts()}] heartbeat failed (${settings.dataUrl}): ${error.message}`));
  tick();
  setInterval(tick, settings.intervalMs);
}

if (require.main === module) {
  try { start(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  VERSION,
  QUERY_FIELDS,
  QUERY_ARGS,
  readSettings,
  loadHosts,
  validateHost,
  parseNvidiaSmiCsv,
  decodeThrottleReasons,
  commandFor,
  ollamaEnvCommands,
  sampleHost,
  readOllamaEnvironment,
  runCycle,
  collectorInfo
};
