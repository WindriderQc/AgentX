'use strict';

// Opens the household files that the owner's history points to: a photo, a
// photo folder or a document in the owner's Datalake. A history context keeps
// such files as pointers (nativePath, media originalPath) with their content
// hash; this reader serves the original from Core's read-only mounts, only
// inside its root, and only while the file still matches the cited hash.
//   locator  photos:<relative path> | documents:<relative path>
//   sha256   the file's content hash, or for a folder sha256("owner-file:" + locator)

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HASH = /^[a-f0-9]{64}$/;
const FILE = /^(photos|documents):([^\0]{1,480})$/;
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic' };
const FILE_TYPES = { ...IMAGE_TYPES, '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const INLINE = new Set([...Object.values(IMAGE_TYPES), 'application/pdf', 'text/plain; charset=utf-8']);
const FOLDER_LIMIT = 60;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const HASH_CACHE_LIMIT = 5000;

const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (message, statusCode = 400, code = 'OWNER_FILE_INVALID') => Object.assign(new Error(message), { statusCode, code });
const folderHash = locator => digest(`owner-file:${locator}`);

function roots(env = process.env) {
  return {
    photos: path.resolve(env.OWNER_PHOTOS_DIR || path.join(env.HOUSEHOLD_IMAGE_MOUNT_BASE || '/mnt/household', 'photos')),
    documents: path.resolve(env.OWNER_DOCUMENTS_MOUNT || '/mnt/owner/documents')
  };
}

// A history context keeps the host path it was read from (nativePath,
// originalPath). The instance tells Core which host folders its mounts are.
function locatorOf(nativePath, env = process.env) {
  const value = String(nativePath || '');
  for (const [root, host] of [['photos', env.OWNER_PHOTOS_HOST_DIR], ['documents', env.OWNER_DOCUMENTS_HOST_DIR]]) {
    const prefix = String(host || '').replace(/\/+$/, '');
    if (prefix && value.startsWith(`${prefix}/`) && value.length > prefix.length + 1) return `${root}:${value.slice(prefix.length + 1)}`;
  }
  return null;
}

function createOwnerFiles({ env = process.env } = {}) {
  const hashes = new Map();

  // The real path behind a locator, only inside its mounted root.
  function resolve(locator) {
    const match = FILE.exec(locator || '');
    if (!match || match[2].startsWith('/') || match[2].split('/').includes('..')) return null;
    const root = roots(env)[match[1]];
    try {
      const realRoot = fs.realpathSync(root);
      const target = fs.realpathSync(path.join(root, match[2]));
      if (target !== realRoot && !target.startsWith(realRoot + path.sep)) return null;
      return { root: match[1], relative: match[2], target, stat: fs.statSync(target) };
    } catch { return null; }
  }

  // A file's hash is reused while its size and modification time are unchanged.
  async function hashOf(found) {
    const key = `${found.target}\0${found.stat.size}\0${found.stat.mtimeMs}`;
    if (hashes.has(key)) return hashes.get(key);
    const value = await new Promise((done, reject) => {
      const hash = createHash('sha256');
      fs.createReadStream(found.target).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => done(hash.digest('hex')));
    });
    if (hashes.size >= HASH_CACHE_LIMIT) hashes.delete(hashes.keys().next().value);
    hashes.set(key, value);
    return value;
  }

  async function verified(locator, sha256) {
    const found = resolve(locator);
    if (!found || !HASH.test(sha256 || '')) return null;
    if (found.stat.isDirectory()) return folderHash(locator) === sha256 ? { ...found, folder: true } : null;
    if (!found.stat.isFile() || found.stat.size > MAX_FILE_BYTES) return null;
    return await hashOf(found) === sha256 ? { ...found, folder: false } : null;
  }

  const contentUrl = (locator, sha256) => `/api/secretary/files/content?locator=${encodeURIComponent(locator)}&sha256=${sha256}`;

  // By locator, or by the host path a history context recorded. A folder found
  // by its host path needs no hash: its identity is its place in the root.
  async function read(locator, sha256, nativePath) {
    if (!locator && nativePath) {
      locator = locatorOf(nativePath, env);
      const found = locator && resolve(locator);
      if (found?.stat.isDirectory()) sha256 = folderHash(locator);
    }
    const found = await verified(String(locator || ''), String(sha256 || ''));
    if (!found) throw failure('This file is unavailable or has changed since it was cited', 404, 'OWNER_FILE_UNAVAILABLE');
    const name = path.basename(found.relative);
    if (found.folder) {
      const images = fs.readdirSync(found.target, { withFileTypes: true })
        .filter(entry => entry.isFile() && IMAGE_TYPES[path.extname(entry.name).toLowerCase()])
        .map(entry => entry.name).sort().slice(0, FOLDER_LIMIT);
      return { authority: 'agentx.core', kind: 'folder', title: name, locator, modifiedAt: found.stat.mtime.toISOString(),
        images: images.map(file => ({ name: file, url: `/api/secretary/files/folder-image?locator=${encodeURIComponent(locator)}&sha256=${sha256}&name=${encodeURIComponent(file)}` })) };
    }
    const ext = path.extname(name).toLowerCase();
    return { authority: 'agentx.core', kind: IMAGE_TYPES[ext] ? 'photo' : 'document', title: name, locator,
      bytes: found.stat.size, type: FILE_TYPES[ext] || 'application/octet-stream', modifiedAt: found.stat.mtime.toISOString(), url: contentUrl(locator, sha256) };
  }

  function stream(res, file) {
    const type = FILE_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${INLINE.has(type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` });
    return fs.createReadStream(file).on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); }).pipe(res);
  }
  const unavailable = res => res.status(404).json({ status: 'error', code: 'OWNER_FILE_UNAVAILABLE', message: 'File unavailable' });

  async function sendContent(req, res) {
    const locator = req.query.locator || locatorOf(req.query.nativePath, env);
    const found = await verified(String(locator || ''), String(req.query.sha256 || ''));
    return found && !found.folder ? stream(res, found.target) : unavailable(res);
  }

  async function sendFolderImage(req, res) {
    const locator = String(req.query.locator || ''), name = String(req.query.name || '');
    const found = await verified(locator, String(req.query.sha256 || ''));
    if (!found?.folder || !name || name.includes('/') || name.includes('\0') || !IMAGE_TYPES[path.extname(name).toLowerCase()]) return unavailable(res);
    const inside = resolve(`${locator}/${name}`);
    return inside?.stat.isFile() ? stream(res, inside.target) : unavailable(res);
  }

  return { read, sendContent, sendFolderImage, resolve };
}

module.exports = { createOwnerFiles, folderHash, locatorOf, roots, IMAGE_TYPES };
