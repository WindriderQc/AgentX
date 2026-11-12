'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');

const quote = (arg) => "'" + String(arg).replace(/'/g, "'\\''") + "'";

function childResult(child, max = 16 * 1024 * 1024, timeoutMs = 30 * 60 * 1000) {
  let stdout = '', stderr = '', size = 0;
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > max) child.kill(); else stdout += chunk; });
  child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (size > max) return reject(new Error('Native response exceeds its bound'));
      try {
        const value = JSON.parse(stdout.replace(/^\uFEFF/, ''));
        if (code && value?.ok !== false) return reject(new Error(stderr.trim() || `Native transport failed (${code}); reconcile the same request`));
        resolve(value);
      } catch { reject(new Error(stderr.trim() || 'Invalid native JSON response; reconcile the same request')); }
    });
  });
}

function createRemote(config) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(config.sshHost || '') || !config.receiver || !config.receiverConfig) throw new Error('Invalid SSH receiver configuration');
  const command = [config.node || 'node', config.receiver, '--config', config.receiverConfig].map(quote).join(' ');
  if (config.remoteTransportRoot) return createFileRemote(config, command);
  return async (header, payload) => {
    if (process.platform === 'win32') throw new Error('Windows requires remoteTransportRoot for native SSH/SCP transport');
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', config.sshHost, command], { windowsHide: true });
    const result = childResult(child, 1024 * 1024);
    // Attach rejection handling before streaming so a lost connection cannot
    // leave an unhandled rejection or trigger a replacement request.
    result.catch(() => {});
    const data = payload?.file ? createReadStream(payload.file) : Readable.from(payload?.json ? [Buffer.from(JSON.stringify(payload.json))] : []);
    const input = Readable.from((async function* () { yield Buffer.from(JSON.stringify(header) + '\n'); for await (const chunk of data) yield chunk; })());
    try { await pipeline(input, child.stdin); } catch (error) { child.kill(); await result.catch(() => {}); throw error; }
    const answer = await result;
    if (!answer.ok) throw Object.assign(new Error(answer.error?.message || 'Receiver refused import'), { code: answer.error?.code });
    return answer.data;
  };
}

function inherited(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
}

function createFileRemote(config, command) {
  if (!config.remoteTransportRoot.startsWith('/') || !path.isAbsolute(config.cacheRoot || '')) throw new Error('Invalid native transport roots');
  const options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  const ssh = command => inherited('ssh', ['-T', ...options, config.sshHost, command]);
  return async (header, payload) => {
    const job = crypto.randomUUID();
    const dir = await fs.mkdtemp(path.join(config.cacheRoot, 'transport-'));
    const remoteDir = config.remoteTransportRoot.replace(/\/+$/, '') + '/' + job;
    const copy = async (source, target) => {
      if (await inherited('scp', ['-q', ...options, source, target]) !== 0) throw new Error('SCP transfer incomplete; preserve the original import identity');
    };
    await fs.writeFile(path.join(dir, 'request.json'), JSON.stringify(header), { flag: 'wx', mode: 0o600 });
    if (payload?.json) await fs.writeFile(path.join(dir, 'payload.bin'), JSON.stringify(payload.json), { flag: 'wx', mode: 0o600 });
    if (await ssh('mkdir -m 700 -- ' + quote(remoteDir)) !== 0) throw new Error('Receiver staging is unavailable');
    await copy(path.join(dir, 'request.json'), config.sshHost + ':' + remoteDir + '/request.json');
    if (payload?.file || payload?.json) await copy(payload.file || path.join(dir, 'payload.bin'), config.sshHost + ':' + remoteDir + '/payload.bin');
    await ssh(command + ' --job ' + quote(job));
    await copy(config.sshHost + ':' + remoteDir + '/response.json', path.join(dir, 'response.json'));
    const answer = JSON.parse(await fs.readFile(path.join(dir, 'response.json'), 'utf8'));
    if (!answer.ok) throw Object.assign(new Error(answer.error?.message || 'Receiver refused import'), { code: answer.error?.code });
    // A response file is written and synced after the domain operation. It
    // reconciles a lost SSH exit acknowledgment without replaying that effect.
    // Failed/uncertain envelopes are retained. Only a successful domain result
    // permits cleanup of this transport's own files; canonical receipts remain.
    const cleaned = await ssh(command + ' --cleanup ' + quote(job));
    if (cleaned === 0) {
      for (const file of ['payload.bin', 'request.json', 'response.json']) await fs.rm(path.join(dir, file), { force: true });
      await fs.rmdir(dir);
    }
    return answer.data;
  };
}

function createWpd(cache) {
  const script = path.join(__dirname, 'wpd.ps1');
  async function call(action, request) {
    let file;
    try {
      // wpd.ps1 owns its device lock for the actual COM process lifetime.
      const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action];
      if (request) {
        file = path.join(cache, `wpd-${require('node:crypto').randomUUID()}.json`);
        await fs.writeFile(file, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
        args.push('-RequestFile', file);
      }
      return await childResult(spawn('powershell.exe', args, { windowsHide: true }));
    } finally {
      if (file) await fs.rm(file, { force: true });
    }
  }
  return { devices: () => call('devices'), inventory: deviceId => call('inventory', { deviceId }),
    prefixes: (deviceId, objects, prefixJournal) => call('prefixes', { deviceId, objects, prefixJournal }),
    spool: (deviceId, items, spoolRoot) => call('spool', { deviceId, items, spoolRoot }),
    read: (deviceId, item, destination) => call('read', { deviceId, objectId: item.objectId, relativePath: item.relativePath, destination }) };
}

async function lockCache(file) {
  if (process.platform !== 'win32') {
    const handle = await fs.open(file, 'wx', 0o600);
    return async () => { await handle.close(); await fs.rm(file, { force: true }); };
  }
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'lock.ps1'), '-LockFile', file], { windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Another importer holds the staging lock')));
    child.stdout.once('data', data => data.toString().trim() === 'ready' ? resolve() : reject(new Error('Invalid lock response')));
  });
  return () => new Promise(resolve => { child.once('close', resolve); child.stdin.end('\n'); });
}

module.exports = { createRemote, createWpd, quote, childResult, lockCache };
