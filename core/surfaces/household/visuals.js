'use strict';

// Pictures beside Nestor (#166, #168). The model never supplies a URL or a
// path: an image block carries a source and search words, and Core resolves
// them to something it can vouch for.
//
// - web: SearXNG image search (SEARXNG_URL). The browser loads the https
//   image directly without a referrer; Famille searches with strict SafeSearch.
// - photos / media: the Data process's file index finds a household image by
//   name under a configured canonical root; Core serves the file from its own
//   read-only mount of that root, never from anywhere else.
// - generated: a picture the OpenClaw agent made with its own image tool and
//   cited as MEDIA:<path>. Core relays it from the gateway's read-only media
//   route (integrations/openclaw/super-dad-memory/media.js); the model cannot
//   request it with a show block.

const fs = require('node:fs');
const path = require('node:path');
const { fetchData } = require('../../src/services/dataServiceClient');

const FILE_SOURCES = Object.freeze(['photos', 'media']);
const IMAGE_TYPES = Object.freeze({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' });
const IMAGE_PREFERENCE = Object.freeze({ jpg: 3, jpeg: 3, webp: 2, png: 2, gif: 1 });
const LIMITS = Object.freeze({ query: 200, candidates: 25, timeoutMs: 8000, terms: 4 });
const SOURCE_LABELS = Object.freeze({ web: 'Internet', photos: 'Photos de la famille', media: 'Médias de la maison', generated: 'Image générée' });
const MAX_GENERATED_BYTES = 20 * 1024 * 1024;

function parseRoots(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return Object.fromEntries(FILE_SOURCES
      .filter(source => typeof parsed[source] === 'string' && path.posix.isAbsolute(parsed[source]))
      .map(source => [source, path.posix.normalize(parsed[source]).replace(/\/+$/, '') || '/']));
  } catch { return {}; }
}

function listSetting(value, fallback) {
  const items = String(value ?? fallback).split(',').map(item => item.trim()).filter(Boolean);
  return new Set(items);
}

function extensionOf(file) {
  return path.extname(String(file || '')).slice(1).toLowerCase();
}

// Filenames rarely match a whole sentence: try the phrase, then its longest words.
function searchTerms(query) {
  const phrase = String(query || '').trim().slice(0, LIMITS.query);
  const words = [...new Set(phrase.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [])]
    .sort((left, right) => right.length - left.length).slice(0, LIMITS.terms);
  return [...new Set([phrase, ...words])].filter(Boolean);
}

function httpsImage(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

// Settings are read on each use, like the rest of Household's optional services.
function createVisuals({ env = process.env, fetchImpl = (...args) => globalThis.fetch(...args), dataFetch = fetchData, logger = null } = {}) {
  const settings = () => ({
    searxng: String(env.SEARXNG_URL || '').trim().replace(/\/+$/, ''),
    roots: parseRoots(env.HOUSEHOLD_IMAGE_ROOTS_JSON),
    mountBase: path.resolve(String(env.HOUSEHOLD_IMAGE_MOUNT_BASE || '/mnt/household')),
    familySources: listSetting(env.HOUSEHOLD_IMAGE_FAMILY_SOURCES, 'web,photos,media,generated'),
    gateway: env.OPENCLAW_GATEWAY_URL && env.OPENCLAW_GATEWAY_TOKEN
      ? { url: String(env.OPENCLAW_GATEWAY_URL).replace(/^ws/, 'http'), token: String(env.OPENCLAW_GATEWAY_TOKEN) } : null
  });

  // Only an absolute image path inside a harness media directory is relayed.
  const generatedRef = value => {
    const ref = String(value || '');
    return path.posix.isAbsolute(ref) && !ref.includes('\0') && !ref.split('/').includes('..')
      && /\/media\//.test(ref) && IMAGE_TYPES[extensionOf(ref)] ? ref : '';
  };
  const generatedAllowed = family => Boolean(settings().gateway) && (!family || settings().familySources.has('generated'));

  function mounted(source, { roots, mountBase } = settings()) {
    try { return Boolean(roots[source]) && fs.statSync(path.join(mountBase, source)).isDirectory(); }
    catch { return false; }
  }

  function sources({ family = false } = {}) {
    const { searxng, familySources } = settings();
    const available = [];
    if (searxng) available.push('web');
    for (const source of FILE_SOURCES) if (mounted(source)) available.push(source);
    return family ? available.filter(source => familySources.has(source)) : available;
  }

  async function fromWeb(query, { family, language }) {
    const params = new URLSearchParams({ q: query, format: 'json', categories: 'images',
      safesearch: family ? '2' : '1', language: language === 'en' ? 'en' : 'fr' });
    const response = await fetchImpl(`${settings().searxng}/search?${params}`, { signal: AbortSignal.timeout(LIMITS.timeoutMs) });
    if (!response.ok) throw new Error(`SearXNG ${response.status}`);
    const body = await response.json();
    for (const result of (body.results || []).slice(0, LIMITS.candidates)) {
      const url = httpsImage(result.img_src);
      if (url) return { url, origin: httpsImage(result.url) || '', originTitle: String(result.title || '').slice(0, 200) };
    }
    return null;
  }

  // Only a file the index places under the configured root, with an image
  // extension, maps to Core's own mount of that root.
  function relativeImage(source, recordPath) {
    const root = settings().roots[source];
    const normalized = path.posix.normalize(String(recordPath || '').replace(/\\/g, '/'));
    if (!root || !IMAGE_TYPES[extensionOf(normalized)]) return '';
    const relative = path.posix.relative(root, normalized);
    return relative && !relative.startsWith('..') && !path.posix.isAbsolute(relative) ? relative : '';
  }

  async function fromFiles(source, query, { family }) {
    for (const term of searchTerms(query)) {
      const params = new URLSearchParams({ category: 'media', root: settings().roots[source], search: term,
        includeDirname: 'true', limit: String(LIMITS.candidates) });
      const { response, body } = await dataFetch('/api/v1/storage/files/browse', { query: params.toString(), timeoutMs: LIMITS.timeoutMs });
      if (!response.ok) throw new Error(`Data ${response.status}`);
      const candidates = [...(body?.data?.files || [])].sort((left, right) =>
        (IMAGE_PREFERENCE[extensionOf(right.path)] || 0) - (IMAGE_PREFERENCE[extensionOf(left.path)] || 0)
        || (Number(right.size) || 0) - (Number(left.size) || 0));
      for (const file of candidates) {
        const relative = relativeImage(source, file.path);
        if (!relative) continue;
        const params = new URLSearchParams({ source, path: relative });
        return { url: `/api/voice-personas/${family ? 'family' : 'private'}/visuals/file?${params}`,
          origin: '', originTitle: relative.split('/').slice(-2).join(' / ') };
      }
    }
    return null;
  }

  // Resolves an image block in place, so the turn's display keeps the result.
  async function present(block, { family = false, language = 'fr' } = {}) {
    if (block?.kind !== 'image') return block;
    if (block.source === 'generated') {
      const ref = generatedAllowed(family) ? generatedRef(block.ref) : '';
      delete block.ref;
      block.status = ref ? 'found' : 'missing';
      block.image = ref ? { url: `/api/voice-personas/${family ? 'family' : 'private'}/visuals/generated?${new URLSearchParams({ path: ref })}`,
        origin: '', originTitle: '', sourceLabel: SOURCE_LABELS.generated } : null;
      return block;
    }
    const allowed = sources({ family });
    const source = allowed.includes(block.source) ? block.source : allowed[0] || '';
    block.source = source;
    let found = null;
    try {
      if (source === 'web') found = await fromWeb(block.body, { family, language });
      else if (FILE_SOURCES.includes(source)) found = await fromFiles(source, block.body, { family });
    } catch (error) {
      logger?.warn?.('Household image lookup failed', { source, error: error.message });
    }
    block.status = found ? 'found' : 'missing';
    block.image = found ? { ...found, sourceLabel: SOURCE_LABELS[source] || source } : null;
    return block;
  }

  function sendFile(req, res, { family }) {
    const source = String(req.query.source || '');
    const relative = String(req.query.path || '');
    const notFound = () => res.status(404).json({ status: 'error', code: 'HOUSEHOLD_IMAGE_NOT_FOUND', message: 'Image unavailable' });
    if (!FILE_SOURCES.includes(source) || !sources({ family }).includes(source)) return notFound();
    const type = IMAGE_TYPES[extensionOf(relative)];
    if (!type || relative.includes('\0') || path.posix.isAbsolute(relative)) return notFound();
    const root = path.join(settings().mountBase, source);
    let file;
    try {
      const realRoot = fs.realpathSync(root);
      file = fs.realpathSync(path.join(root, relative));
      if (!file.startsWith(realRoot + path.sep) || !fs.statSync(file).isFile()) return notFound();
    } catch { return notFound(); }
    res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(file).on('error', () => { if (!res.headersSent) notFound(); else res.destroy(); }).pipe(res);
  }

  async function sendGenerated(req, res, { family }) {
    const notFound = () => res.status(404).json({ status: 'error', code: 'HOUSEHOLD_IMAGE_NOT_FOUND', message: 'Image unavailable' });
    const ref = generatedAllowed(family) ? generatedRef(req.query.path) : '';
    if (!ref) return notFound();
    const { gateway } = settings();
    try {
      const url = new URL('/api/nestor/media', gateway.url);
      url.searchParams.set('path', ref);
      const upstream = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(LIMITS.timeoutMs),
        headers: { Authorization: `Bearer ${gateway.token}` } });
      const type = String(upstream.headers.get('content-type') || '').split(';')[0].trim();
      if (!upstream.ok || !Object.values(IMAGE_TYPES).includes(type)) return notFound();
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.length > MAX_GENERATED_BYTES) return notFound();
      // Every generated picture shown to the family is also kept, full quality, in the image archive.
      void require('../../src/services/imageArchive').defaultArchive().store({ bytes, name: path.posix.basename(ref), origin: 'generated',
        context: { ref, space: family ? 'family' : 'personal' } }).catch(error => logger?.warn?.('Generated image archive failed', { error: error.message }));
      res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      return res.end(bytes);
    } catch (error) {
      logger?.warn?.('Generated image relay failed', { error: error.message });
      return notFound();
    }
  }

  function register(router) {
    router.get('/private/visuals/file', (req, res) => sendFile(req, res, { family: false }));
    router.get('/family/visuals/file', (req, res) => sendFile(req, res, { family: true }));
    router.get('/private/visuals/generated', (req, res) => sendGenerated(req, res, { family: false }));
    router.get('/family/visuals/generated', (req, res) => sendGenerated(req, res, { family: true }));
  }

  return { sources, present, register, sendFile, sendGenerated };
}

module.exports = { createVisuals, searchTerms, parseRoots, IMAGE_TYPES, SOURCE_LABELS };
