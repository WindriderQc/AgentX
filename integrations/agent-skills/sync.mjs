#!/usr/bin/env node
// Keeps the Claude Code and Codex copies of the `agentx` skill equal to the
// copy Core serves. It replaces an installed copy only when the served one
// differs, and leaves the installed copy untouched on any failure.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const SKILL = 'agentx';
const DOWNLOAD_PATH = '/api/operator-skill/download';
const MAX_ZIP_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const STAGING = '.agentx-skill-sync';
const SERVED = 'references/served.md';

const USAGE = `Usage: node sync.mjs [--runtime claude|codex|all] [--core <url>] [--check] [--force] [--json]

  --runtime   which copy to refresh (default: all installed runtimes)
  --core      AgentX Core origin (default: AGENTX_CORE_URL or http://127.0.0.1:3180)
  --check     report only; change nothing (exit 3 when a copy is stale)
  --force     replace even when the installed copy already matches
  --json      print one JSON report instead of text lines`;

export class SyncError extends Error {}

export function parseArgs(argv, env = process.env) {
  const options = {
    runtime: 'all', core: env.AGENTX_CORE_URL || 'http://127.0.0.1:3180',
    check: false, force: false, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new SyncError(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--runtime') options.runtime = value();
    else if (arg === '--core') options.core = value();
    else if (arg === '--check') options.check = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new SyncError(`unknown argument: ${arg}`);
  }
  if (!['claude', 'codex', 'all'].includes(options.runtime)) {
    throw new SyncError(`--runtime must be claude, codex or all, not ${options.runtime}`);
  }
  if (options.check && options.force) throw new SyncError('--check and --force cannot be combined');
  return options;
}

// Where each runtime keeps its skills. Both honour their own home override.
export function runtimeRoots(env = process.env, home = os.homedir()) {
  return {
    claude: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    codex: env.CODEX_HOME || path.join(home, '.codex'),
  };
}

// --- zip reading -----------------------------------------------------------
// Core's writer emits stored or deflated entries with sizes in the headers; a
// reader for that subset avoids a dependency.

function findEnd(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= lowest; at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) return at;
  }
  throw new SyncError('not a zip archive (no end of central directory)');
}

function safeName(name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every((part, index, parts) => part !== '..' && part !== '.' && (part !== '' || index === parts.length - 1));
}

export function readZip(buffer) {
  const end = findEnd(buffer);
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) {
      throw new SyncError('damaged zip central directory');
    }
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const packed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    if (!safeName(name)) throw new SyncError(`unsafe path in zip: ${JSON.stringify(name)}`);
    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw new SyncError(`encrypted zip entry: ${name}`);
    if (size > MAX_FILE_BYTES) throw new SyncError(`${name} exceeds ${MAX_FILE_BYTES} bytes`);
    if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
      throw new SyncError(`damaged zip entry: ${name}`);
    }
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    if (start + packed > buffer.length) throw new SyncError(`truncated zip entry: ${name}`);
    const raw = buffer.subarray(start, start + packed);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_FILE_BYTES }); } catch (error) {
        throw new SyncError(`cannot inflate ${name}: ${error.message}`);
      }
    } else throw new SyncError(`unsupported zip compression ${method} for ${name}`);
    if (data.length !== size || zlib.crc32(data) !== crc) throw new SyncError(`checksum mismatch for ${name}`);
    if (files.has(name)) throw new SyncError(`duplicate zip entry: ${name}`);
    files.set(name, data);
  }
  return files;
}

// --- the served skill ------------------------------------------------------

export function revisionOf(servedText) {
  const match = /Product revision:\s*`([^`\s]+)`/.exec(servedText || '');
  return match ? match[1] : null;
}

// Keeps the files under `agentx/`, without the prefix, and checks the skill is whole.
export function skillFromZip(buffer) {
  const prefix = `${SKILL}/`;
  const files = new Map();
  for (const [name, data] of readZip(buffer)) {
    if (!name.startsWith(prefix)) throw new SyncError(`zip entry outside ${prefix}: ${name}`);
    files.set(name.slice(prefix.length), data);
  }
  if (!files.has('SKILL.md')) throw new SyncError(`the download has no ${prefix}SKILL.md`);
  if (!/^---\r?\n[\s\S]*?^name:\s*agentx\s*$/m.test(files.get('SKILL.md').toString('utf8'))) {
    throw new SyncError(`${prefix}SKILL.md does not declare name: agentx`);
  }
  const revision = revisionOf(files.get(SERVED)?.toString('utf8'));
  if (!revision) throw new SyncError(`the download has no product revision in ${prefix}${SERVED}`);
  return { revision, files };
}

export async function download(core, fetchImpl = globalThis.fetch, timeoutMs = 30000) {
  let url;
  try { url = new URL(DOWNLOAD_PATH, core); } catch { throw new SyncError(`invalid Core URL: ${core}`); }
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/zip' } });
  } catch (error) {
    throw new SyncError(`cannot reach ${url}: ${error.cause?.message || error.message}`);
  }
  if (!response.ok) throw new SyncError(`${url} answered HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_ZIP_BYTES) throw new SyncError(`the download exceeds ${MAX_ZIP_BYTES} bytes`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_ZIP_BYTES) throw new SyncError(`the download exceeds ${MAX_ZIP_BYTES} bytes`);
  return body;
}

// --- the installed copy ----------------------------------------------------

async function exists(target) {
  try { await fs.lstat(target); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readTree(root, relative = '', found = new Map()) {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await readTree(root, name, found);
    else if (entry.isFile()) found.set(name, await fs.readFile(path.join(root, name)));
    else found.set(name, null); // a link or device: never equal to a served file
  }
  return found;
}

export async function readInstalled(dir) {
  if (!(await exists(dir))) return null;
  const files = await readTree(dir);
  return { revision: revisionOf(files.get(SERVED)?.toString('utf8')), files };
}

// The same files with the same bytes. `served.md` only differs by its
// generation time, so it is compared through the revision instead.
export function sameSkill(installed, served) {
  if (!installed || installed.revision !== served.revision) return false;
  if (installed.files.size !== served.files.size) return false;
  for (const [name, data] of served.files) {
    if (name === SERVED) { if (!installed.files.has(name)) return false; continue; }
    const mine = installed.files.get(name);
    if (!mine || !mine.equals(data)) return false;
  }
  return true;
}

// A run that died between the two renames leaves the old copy in staging and
// no installed copy: put it back before anything else.
async function recover(root, dir) {
  const staging = path.join(root, STAGING);
  if (!(await exists(staging))) return;
  if (!(await exists(dir)) && (await exists(path.join(staging, 'old')))) {
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.rename(path.join(staging, 'old'), dir);
  }
  await fs.rm(staging, { recursive: true, force: true });
}

// Writes the new copy beside the runtime, then swaps it in with two renames on
// the same filesystem. Any failure restores the previous copy.
export async function install(root, dir, served) {
  const staging = path.join(root, STAGING);
  const fresh = path.join(staging, 'new');
  const old = path.join(staging, 'old');
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(fresh, { recursive: true });
  try {
    for (const [name, data] of served.files) {
      const target = path.join(fresh, ...name.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    }
    if (!sameSkill(await readInstalled(fresh), served)) throw new SyncError('the staged copy does not read back equal');
    await fs.mkdir(path.dirname(dir), { recursive: true });
    const hadCopy = await exists(dir);
    if (hadCopy) await fs.rename(dir, old);
    try {
      await fs.rename(fresh, dir);
    } catch (error) {
      if (hadCopy) await fs.rename(old, dir);
      throw error;
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

// --- one run ---------------------------------------------------------------

export async function syncRuntime(name, root, served, options) {
  const dir = path.join(root, 'skills', SKILL);
  const report = { runtime: name, dir, served: served.revision };
  try {
    if (!(await exists(root))) {
      if (options.runtime === 'all') return { ...report, status: 'skipped', reason: `${root} not found` };
      throw new SyncError(`${root} not found; is ${name} installed?`);
    }
    if (!options.check) await recover(root, dir);
    const installed = await readInstalled(dir);
    report.installed = installed?.revision || null;
    const current = sameSkill(installed, served);
    if (options.check) return { ...report, status: current ? 'current' : 'stale' };
    if (current && !options.force) return { ...report, status: 'current' };
    await install(root, dir, served);
    const after = await readInstalled(dir);
    if (!sameSkill(after, served)) throw new SyncError('the installed copy does not match after replacement');
    return { ...report, status: installed ? 'updated' : 'installed' };
  } catch (error) {
    return { ...report, status: 'failed', error: error.message };
  }
}

export async function run(options, deps = {}) {
  const roots = deps.roots || runtimeRoots();
  const names = options.runtime === 'all' ? ['claude', 'codex'] : [options.runtime];
  let served;
  try {
    served = skillFromZip(await download(options.core, deps.fetch));
  } catch (error) {
    return { ok: false, error: error.message, runtimes: [] };
  }
  const runtimes = [];
  for (const name of names) runtimes.push(await syncRuntime(name, roots[name], served, options));
  return {
    ok: runtimes.every(item => item.status !== 'failed'),
    stale: runtimes.some(item => item.status === 'stale'),
    served: served.revision, runtimes,
  };
}

const short = (revision) => (revision && /^[0-9a-f]{12,}$/.test(revision) ? revision.slice(0, 8) : revision || 'none');

export function describe(result) {
  if (result.error) return [`agentx-skills sync failed: ${result.error}`];
  return result.runtimes.map((item) => {
    const where = `(${item.dir})`;
    if (item.status === 'failed') return `${item.runtime}: failed, copy left as it was: ${item.error} ${where}`;
    if (item.status === 'skipped') return `${item.runtime}: skipped, ${item.reason}`;
    if (item.status === 'current') return `${item.runtime}: current at ${short(item.served)} ${where}`;
    if (item.status === 'stale') return `${item.runtime}: stale, installed ${short(item.installed)}, served ${short(item.served)} ${where}`;
    return `${item.runtime}: ${item.status} ${short(item.installed)} -> ${short(item.served)} ${where}`;
  });
}

export function exitCode(result) {
  if (!result.ok) return 1;
  return result.stale ? 3 : 0;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  const result = await run(options);
  if (options.json) process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2)}\n`);
  else {
    const stream = result.ok ? process.stdout : process.stderr;
    for (const line of describe(result)) stream.write(`${line}\n`);
  }
  return exitCode(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
