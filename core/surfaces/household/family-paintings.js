'use strict';

// The pictures Nestor may paint on the Family standby screen: the family's own drawings first,
// then finished Atelier renders. Only pictures made from words alone qualify (Core's
// listFinished never returns a retouch, a parent edit or an upload), so a private photo can
// never be repainted in the kitchen. Atelier renders also pass the family word filter, must be
// finished (not a quick draft), must not ask for exact text in the picture (a painted sign or
// label reads badly) and are kept once per request, since trials repeat the same words.
//
// The page receives opaque identifiers and a source word only; it fetches a reduced JPEG of a
// listed picture and nothing else.

const { FAMILY_UNSUITABLE } = require('./conversation-images');

const LIST_TTL_MS = 30 * 60 * 1000;
const FAILURE_TTL_MS = 2 * 60 * 1000;
const READ_TIMEOUT_MS = 8000;
const MAX_LISTED = 24;
const MIN_ATELIER_PIXELS = 1.5e6;
const PAINT_SIDE = 720;
const KEPT_IMAGES = MAX_LISTED; // about 80 KB each
// Words that say a picture continues another one, even without a stored reference.
const DERIVED_WORDS = /\bimage\s*\d\b|\br[ée]f[ée]rence\b|\breference\b|\bkeep the same\b|\bm[êe]mes? (?:personnes?|photo)/i;

const isFamily = conversation => conversation?.surface === 'household' && conversation.packId === 'kidx_nestor'
  && conversation.scopeId === 'family';
const plain = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

function paintingPool(records, { limit = MAX_LISTED } = {}) {
  const family = [], atelier = [], seen = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.id || !(record.width > 0) || !(record.height > 0)) continue;
    if (FAMILY_UNSUITABLE.test(plain(record.words))) continue;
    if (isFamily(record.conversation)) { family.push({ id: record.id, source: 'family' }); continue; }
    if (record.conversation) continue; // another conversation's pictures stay in it
    if (record.width * record.height < MIN_ATELIER_PIXELS || record.text || DERIVED_WORDS.test(record.words || '')) continue;
    const head = plain(record.words).toLowerCase().slice(0, 48);
    if (!head || seen.has(head)) continue;
    seen.add(head);
    atelier.push({ id: record.id, source: 'atelier' });
  }
  return [...family, ...atelier].slice(0, limit);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}

function createFamilyPaintings({
  listFinished = options => require('../../src/services/images/imageService').listFinished(options),
  readImage = id => require('../../src/services/images/imageService').image(id),
  // libvips works off the event loop, so a voice turn never waits on a resize.
  fit = async bytes => {
    const { data, info } = await require('sharp')(bytes, { limitInputPixels: 24 * 1024 * 1024, failOn: 'error' })
      .resize(PAINT_SIDE, PAINT_SIDE, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
    return { bytes: data, width: info.width, height: info.height };
  },
  now = () => Date.now(), logger = null
} = {}) {
  let listed = { value: null, until: 0, pending: null };
  const images = new Map();

  async function list() {
    if (listed.until > now()) return listed.value;
    if (listed.pending) return listed.pending;
    listed.pending = (async () => {
      try {
        const value = paintingPool(await withTimeout(Promise.resolve(listFinished({ limit: 200 })), READ_TIMEOUT_MS));
        listed = { value, until: now() + LIST_TTL_MS, pending: null };
      } catch (error) {
        logger?.debug?.(`Family paintings unavailable: ${error.message}`);
        listed = { value: listed.value, until: now() + FAILURE_TTL_MS, pending: null };
      }
      return listed.value;
    })();
    return listed.pending;
  }

  // A reduced copy of a listed picture; anything not listed is unknown here.
  async function image(id) {
    const pool = await list();
    if (!pool?.some(item => item.id === id)) return null;
    if (images.has(id)) return images.get(id);
    const original = await readImage(id);
    const reduced = await fit(original.bytes);
    const value = { bytes: Buffer.from(reduced.bytes), mimeType: 'image/jpeg', width: reduced.width, height: reduced.height };
    images.set(id, value);
    while (images.size > KEPT_IMAGES) images.delete(images.keys().next().value);
    return value;
  }

  return { list, image };
}

module.exports = { createFamilyPaintings, paintingPool, MIN_ATELIER_PIXELS, PAINT_SIDE };
