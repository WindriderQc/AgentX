'use strict';

// Full-quality archive of the images that pass through conversations: the
// original of every uploaded photo (the model may receive a reduced copy) and
// every image an agent generated. It is optional instance storage: without
// IMAGE_ARCHIVE_DIR nothing is kept. Files are content-addressed, so the same
// image is stored once; a JSON sidecar records where it came from. The archive
// is deliberately independent of conversations: forgetting a conversation does
// not delete its archived images.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 50 * 1024 * 1024;
const ORIGINS = new Set(['uploaded', 'generated']);
const TYPES = Object.freeze({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif'
});

/** The file's own bytes decide its type; a declared type that disagrees is refused. */
function sniff(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (/^(avif|avis)$/.test(brand)) return 'image/avif';
    if (/^(heic|heix|hevc|hevx|heim|heis)$/.test(brand)) return 'image/heic';
    if (/^(mif1|msf1)$/.test(brand)) return 'image/heif';
  }
  return null;
}

function cleanName(name) {
  return String(name || '').replace(/[\x00-\x1f\x7f\\/]/g, '').trim().slice(0, 160) || null;
}

function createImageArchive({ dir = process.env.IMAGE_ARCHIVE_DIR, now = () => new Date(), logger = null } = {}) {
  const root = typeof dir === 'string' && dir.trim() ? path.resolve(dir.trim()) : null;
  const invalid = () => Object.assign(new Error('Image archive unavailable or integrity check failed'), { statusCode: 503 });

  async function storePath(relative) {
    // Configuration chooses a trusted root, including deliberate filesystem aliases.
    await fs.mkdir(root, { recursive: true });
    let directory = await fs.realpath(root);
    for (const part of relative.split('/').slice(0, -1)) {
      directory = path.join(directory, part);
      try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid();
    }
    return path.join(directory, path.posix.basename(relative));
  }

  async function existingFile(file) {
    const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw invalid();
    return stat;
  }

  /**
   * Store one image. Returns its receipt, or null when the archive is off.
   * Throws (statusCode 400/413) for an empty, oversized or non-image payload.
   */
  async function store({ bytes, name = null, origin, context = {} } = {}) {
    if (!root) return null;
    if (!ORIGINS.has(origin)) throw Object.assign(new Error('Unknown image origin'), { statusCode: 400 });
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    if (!data.length) throw Object.assign(new Error('Image vide.'), { statusCode: 400 });
    if (data.length > MAX_BYTES) throw Object.assign(new Error('L’original dépasse 50 Mo.'), { statusCode: 413 });
    const mimeType = sniff(data);
    if (!mimeType) throw Object.assign(new Error('Ce fichier n’est pas une image reconnue.'), { statusCode: 400 });
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const at = now();
    const relative = path.posix.join(origin, String(at.getUTCFullYear()), String(at.getUTCMonth() + 1).padStart(2, '0'),
      `${sha256}.${TYPES[mimeType]}`);
    const file = await storePath(relative);
    const receipt = { sha256, mimeType, size: data.length, path: relative, origin, archivedAt: at.toISOString() };
    const sidecarFile = file.replace(/\.[a-z]+$/, '.json');
    const stored = await existingFile(file);
    await existingFile(sidecarFile);
    const exists = stored?.size === data.length && await read(receipt).then(() => true, () => false);
    if (!exists) {
      const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, data, { flag: 'wx' });
      await fs.rename(temporary, file);
    }
    const sidecarExists = await fs.open(sidecarFile, constants.O_RDONLY | constants.O_NOFOLLOW).then(async handle => {
      try { const record = JSON.parse(await handle.readFile('utf8')); return record.sha256 === sha256 && record.size === data.length; }
      catch { return false; } finally { await handle.close(); }
    }, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (!sidecarExists) {
      const handle = await fs.open(sidecarFile, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW);
      try { await handle.writeFile(`${JSON.stringify({ ...receipt, name: cleanName(name), context }, null, 2)}\n`); }
      finally { await handle.close(); }
    }
    logger?.info?.('Image archived', { origin, sha256, size: data.length, duplicate: exists });
    return { ...receipt, duplicate: exists };
  }

  async function read(receipt) {
    try {
      if (!root || !receipt || !Number.isSafeInteger(receipt.size) || receipt.size < 1 || receipt.size > MAX_BYTES
        || typeof receipt.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.sha256)
        || typeof receipt.mimeType !== 'string' || !Object.hasOwn(TYPES, receipt.mimeType)
        || typeof receipt.path !== 'string' || !receipt.path || receipt.path.length > 1024
        || /[\\\x00-\x1f\x7f]/.test(receipt.path) || path.posix.isAbsolute(receipt.path)
        || path.posix.normalize(receipt.path) !== receipt.path || receipt.path.split('/').some(part => !part || part === '.' || part === '..')) throw invalid();
      const canonicalRoot = await fs.realpath(root);
      const rootStat = await fs.lstat(canonicalRoot);
      if (!rootStat.isDirectory()) throw invalid();
      const file = path.resolve(canonicalRoot, ...receipt.path.split('/'));
      if (!file.startsWith(canonicalRoot + path.sep)) throw invalid();
      const components = [{ path: canonicalRoot, stat: rootStat }];
      let current = canonicalRoot;
      const parts = receipt.path.split('/');
      for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw invalid();
        components.push({ path: current, stat });
      }
      const beforePath = components.at(-1).stat;
      const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size !== receipt.size || !same(before, beforePath)) throw invalid();
        const buffer = Buffer.alloc(receipt.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const result = await handle.read(buffer, length, buffer.length - length, length);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length !== receipt.size || !same(before, await handle.stat())) throw invalid();
        for (const entry of components) {
          const stat = await fs.lstat(entry.path);
          if (stat.isSymbolicLink() || stat.dev !== entry.stat.dev || stat.ino !== entry.stat.ino) throw invalid();
          if (entry.path === file && !same(before, stat)) throw invalid();
        }
        if (await fs.realpath(root) !== canonicalRoot) throw invalid();
        const bytes = buffer.subarray(0, length);
        if (sniff(bytes) !== receipt.mimeType || crypto.createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) throw invalid();
        return { bytes, mimeType: receipt.mimeType };
      } finally { await handle.close(); }
    } catch { throw invalid(); }
  }

  return Object.freeze({ enabled: Boolean(root), store, read });
}

let shared = null;
/** The instance archive configured by IMAGE_ARCHIVE_DIR, reused while that setting is unchanged. */
function defaultArchive() {
  const dir = process.env.IMAGE_ARCHIVE_DIR || '';
  if (!shared || shared.dir !== dir) shared = { dir, archive: createImageArchive({ dir }) };
  return shared.archive;
}

module.exports = { createImageArchive, defaultArchive, sniff, MAX_BYTES, TYPES };
