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
    const file = path.join(root, ...relative.split('/'));
    const receipt = { sha256, mimeType, size: data.length, path: relative, origin, archivedAt: at.toISOString() };
    await fs.mkdir(path.dirname(file), { recursive: true });
    const exists = await fs.stat(file).then(stat => stat.size === data.length, () => false);
    if (!exists) {
      const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, data, { flag: 'wx' });
      await fs.rename(temporary, file);
      const sidecar = { ...receipt, name: cleanName(name), context };
      await fs.writeFile(file.replace(/\.[a-z]+$/, '.json'), `${JSON.stringify(sidecar, null, 2)}\n`);
    }
    logger?.info?.('Image archived', { origin, sha256, size: data.length, duplicate: exists });
    return { ...receipt, duplicate: exists };
  }

  return Object.freeze({ enabled: Boolean(root), store });
}

let shared = null;
/** The instance archive configured by IMAGE_ARCHIVE_DIR, reused while that setting is unchanged. */
function defaultArchive() {
  const dir = process.env.IMAGE_ARCHIVE_DIR || '';
  if (!shared || shared.dir !== dir) shared = { dir, archive: createImageArchive({ dir }) };
  return shared.archive;
}

module.exports = { createImageArchive, defaultArchive, sniff, MAX_BYTES, TYPES };
