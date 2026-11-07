'use strict';

// Read-only, bounded folder intake. Paths never come from a model or Data's index.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { sniff, MAX_BYTES } = require('./imageArchive');
const MAX_ENTRIES = 500;
const PAGE_SIZE = 20;
const PIXELS = 40 * 1000 * 1000;
const fail = (message, status = 400, code = 'PLANT_IMPORT_INVALID') => Object.assign(new Error(message), { status, code });
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file.startsWith(root + path.sep);
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\\\x00-\x1f\x7f]/.test(value)
    || path.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw fail('Le dossier doit être relatif au montage photos, sans « .. ».');
  return value;
}
function roomHint(name) {
  const first = path.parse(name).name.split(/[-_\d]/)[0].trim().slice(0, 60);
  return first ? first[0].toLocaleUpperCase('fr-CA') + first.slice(1) : null;
}
function createPlantFolder({ env = process.env } = {}) {
  async function location() {
    if (!env.HOUSEHOLD_PLANT_IMPORT_DIR) return null;
    const folder = relative(env.HOUSEHOLD_PLANT_IMPORT_DIR);
    const mount = await fs.realpath(path.join(env.HOUSEHOLD_IMAGE_MOUNT_BASE || '/mnt/household', 'photos'));
    let directory = mount;
    const components = [];
    for (const part of folder.split('/')) {
      directory = path.join(directory, part);
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('Le dossier ne peut pas traverser un lien symbolique.');
      components.push({ path: directory, stat });
    }
    const real = await fs.realpath(directory);
    if (!inside(mount, real)) throw fail('Dossier hors du montage photos.');
    return { mount, directory: real, components };
  }
  async function read(name, expectedSha) {
    if (typeof name !== 'string' || name !== path.basename(name) || /[\\/\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') throw fail('Nom de photo invalide.');
    const loc = await location();
    if (!loc) throw fail('Le dossier d’import n’est pas configuré.', 503, 'PLANT_IMPORT_DISABLED');
    const file = path.join(loc.directory, name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || !inside(loc.directory, await fs.realpath(file))) throw fail('Ce fichier ne peut pas être importé.');
    if (stat.size < 1 || stat.size > MAX_BYTES) throw fail('La photo doit faire entre 1 octet et 50 Mo.', 413, 'PLANT_IMPORT_SIZE');
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!same(before, stat) || !before.isFile()) throw fail('Le fichier a changé. Actualisez la liste.', 409);
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length !== before.size || !same(before, await handle.stat()) || !same(before, await fs.lstat(file))) throw fail('Le fichier a changé. Actualisez la liste.', 409);
      for (const entry of loc.components) {
        const current = await fs.lstat(entry.path);
        if (current.isSymbolicLink() || current.dev !== entry.stat.dev || current.ino !== entry.stat.ino) throw fail('Le dossier a changé.', 409);
      }
      if (await fs.realpath(path.join(env.HOUSEHOLD_IMAGE_MOUNT_BASE || '/mnt/household', 'photos')) !== loc.mount) throw fail('Le montage a changé.', 409);
      const bytes = buffer.subarray(0, length), hash = sha256(bytes), mimeType = sniff(bytes);
      if (expectedSha && expectedSha !== hash) throw fail('La photo a changé. Actualisez la liste.', 409, 'PLANT_IMPORT_CHANGED');
      if (mimeType === 'image/heic' || mimeType === 'image/heif' || (!mimeType && /\.hei[cf]$/i.test(name))) throw fail('HEIC : convertir en JPEG avant l’import.', 415, 'PLANT_IMPORT_HEIC');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw fail('Formats acceptés : JPEG, PNG et WebP.', 415, 'PLANT_IMPORT_FORMAT');
      return { name, bytes, sha256: hash, mimeType, size: length, roomHint: roomHint(name) };
    } finally { await handle.close(); }
  }
  async function list({ offset = 0 } = {}) {
    const skip = Number(offset);
    if (!Number.isInteger(skip) || skip < 0 || skip >= MAX_ENTRIES) throw fail('Page invalide.');
    let loc;
    try { loc = await location(); }
    catch (error) { throw error.status ? error : fail('Le dossier d’import est indisponible.', 503, 'PLANT_IMPORT_UNAVAILABLE'); }
    if (!loc) return { configured: false, entries: [], nextOffset: null, truncated: false };
    const names = [];
    const dir = await fs.opendir(loc.directory);
    for await (const entry of dir) {
      if (entry.isDirectory()) continue;
      names.push(entry.name);
      if (names.length > MAX_ENTRIES) break;
    }
    names.sort((a, b) => a.localeCompare(b));
    const entries = [];
    for (const name of names.slice(skip, Math.min(skip + PAGE_SIZE, MAX_ENTRIES))) {
      try {
        const { bytes: _bytes, ...entry } = await read(name);
        entries.push({ ...entry, state: 'available' });
      } catch (error) {
        entries.push({ name, state: 'unsupported', code: error.code || 'PLANT_IMPORT_UNREADABLE', message: error.status ? error.message : 'Fichier illisible.' });
      }
    }
    return { configured: true, entries, nextOffset: skip + PAGE_SIZE < Math.min(names.length, MAX_ENTRIES) ? skip + PAGE_SIZE : null,
      truncated: names.length > MAX_ENTRIES, maxBytes: MAX_BYTES };
  }
  async function rendition(entry, thumbnail = false) {
    try {
      const bytes = await sharp(entry.bytes, { limitInputPixels: PIXELS, failOn: 'warning' }).rotate()
        .resize(thumbnail ? 240 : 1600, thumbnail ? 240 : 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: thumbnail ? 70 : 82 }).toBuffer();
      if (bytes.length > 2 * 1024 * 1024) throw new Error('rendition too large');
      return bytes;
    } catch { throw fail('Image endommagée ou trop grande à décoder.', 415, 'PLANT_IMPORT_DECODE'); }
  }
  return { read, list, rendition };
}
module.exports = { createPlantFolder, roomHint, MAX_ENTRIES, PAGE_SIZE, sha256, fail };
