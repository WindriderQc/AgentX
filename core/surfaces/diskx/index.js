'use strict';

// DiskX: the GraphysX 3D city of the disks Data indexed and of the latest
// Janitor duplicate report, served by Core on the private network.
//
// GraphysX publishes one self-contained ES module defining <diskx-city>; Core
// relays it from its own origin (CSP script-src 'self', no CORS) and the
// element reads only same-origin GET routes of the Data Toolbox. The page is a
// presentation: it never scans, runs, approves, moves or deletes anything.
//
// File paths are private. This surface is full-profile only and, like the Data
// Toolbox, stays outside a family-pinned device's allowlist. The separate
// ecosystem presentation and its static module are family-readable.

const path = require('path');
const { createScriptRelay, configuredModuleUrl } = require('../household/asset-relay');
const { reportDate, diskxPlay } = require('../../src/services/janitorPresentation');
const { ecosystemPlay } = require('../../public/js/screen-pages');

const PAGE = '/diskx';
const MODULE_ROUTE = '/api/diskx/diskx.js';
const API_BASE = '/api/data-toolbox';
// Where the owner decides and acts on files. The city only links it.
const ACTIONS_HREF = '/data-toolbox';
const MAX_ROOTS = 8;
const MAX_ROOT_LENGTH = 255;
const MAX_FOCUS_LENGTH = 1024;
const ROOTS_TIMEOUT_MS = 4000;
const SHA256 = /^[0-9a-f]{64}$/;
// The built module is ~4.1 MB (1.4 MB gzip), above the shared 4 MiB relay cap.
const MODULE_MAX_BYTES = 6 * 1024 * 1024;

const hasControl = (text) => [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_DISKX_QUERY' });
}

/** The GraphysX `<diskx-city>` module URL, e.g. https://graphysx.example/embed/diskx.js. */
function diskxModuleUrl(env = process.env) {
  return configuredModuleUrl(env, 'DISKX_MODULE_URL', 'DISKX_NOT_CONFIGURED', 'DiskX module');
}

/** An absolute, already-normal POSIX path without control characters, or null. */
function normalPath(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
  if (!text || text.length > max || !text.startsWith('/') || text.includes('\\') || text.includes(',') || hasControl(text)) return null;
  return path.posix.normalize(text) === text ? text : null;
}

/** Roots from a comma-separated list; anything not an absolute normal path is dropped. */
function parseRoots(raw) {
  const roots = String(raw || '').split(',').map((item) => normalPath(item.trim(), MAX_ROOT_LENGTH)).filter(Boolean);
  return [...new Set(roots)].slice(0, MAX_ROOTS);
}

/**
 * The scanned roots the city opens on: DISKX_ROOTS when set, otherwise the
 * canonical roots of the storage sources Data declares. Data being down leaves
 * the list empty, and the page then says no root is known.
 */
async function resolveRoots({ env = process.env, fetchData } = {}) {
  const configured = parseRoots(env.DISKX_ROOTS);
  if (configured.length || String(env.DISKX_ROOTS || '').trim()) return configured;
  try {
    const read = fetchData || require('../../src/services/dataServiceClient').fetchData;
    const { response, body } = await read('/api/v1/storage/agents', { timeoutMs: ROOTS_TIMEOUT_MS });
    const sources = response.ok && body?.data?.sources && typeof body.data.sources === 'object' ? body.data.sources : {};
    return parseRoots(Object.values(sources).map((source) => source?.canonicalRoot).filter((root) => typeof root === 'string').join(','));
  } catch {
    return [];
  }
}

const single = (value) => (Array.isArray(value) ? value[0] : value);

/**
 * The element attributes the query string may set. Refuses anything it does not
 * know: janitor=latest only, group as one SHA-256, focus as an absolute folder
 * under one of the roots, play as a DiskX animation list (presentation steps).
 */
function checkQuery(query = {}, roots = []) {
  const ecosystem = single(query.app) === 'ecosystem';
  const allowed = ecosystem ? ['app', 'view', 'from', 'play', 'presentation'] : ['janitor', 'group', 'focus', 'report', 'view', 'from', 'play'];
  const unknown = Object.keys(query).filter((key) => !allowed.includes(key));
  if (unknown.length) throw invalid(`Unknown parameter: ${unknown[0].slice(0, 40)}`);
  if (query.view !== undefined && single(query.view) !== 'screen') throw invalid('view must be screen');
  if (query.from !== undefined && single(query.from) !== 'nestor') throw invalid('from must be nestor');
  if (ecosystem) {
    const attributes = { app: 'ecosystem' };
    if (query.play !== undefined) {
      const play = ecosystemPlay(single(query.play));
      if (!play) throw invalid('play must be an ecosystem presentation list');
      attributes.play = play;
    }
    if (query.presentation !== undefined) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(single(query.presentation))) throw invalid('Invalid presentation identity');
      attributes['presentation-id'] = single(query.presentation);
    }
    return attributes;
  }
  const attributes = {};
  if (query.report !== undefined) {
    const report = reportDate(single(query.report));
    if (!report) throw invalid('report must be a UTC report date');
    attributes.report = report;
  }
  const janitor = single(query.janitor);
  if (janitor !== undefined && janitor !== '') {
    if (janitor !== 'latest') throw invalid('janitor must be latest');
    attributes.janitor = 'latest';
  }
  const group = single(query.group);
  if (group !== undefined && group !== '') {
    const sha = String(group).toLowerCase();
    if (!SHA256.test(sha)) throw invalid('group must be one SHA-256 (64 hexadecimal characters)');
    attributes.group = sha;
  }
  const play = single(query.play);
  if (play !== undefined && play !== '') {
    const list = diskxPlay(String(play));
    if (!list) throw invalid('play must list DiskX steps: overview, duplicates, pairs, target, summary, tour-N (1-20), group-<sha256>');
    attributes.play = list;
  }
  const focus = single(query.focus);
  if (focus !== undefined && focus !== '') {
    const folder = normalPath(String(focus), MAX_FOCUS_LENGTH);
    if (!folder) throw invalid('focus must be an absolute folder path');
    const inside = roots.some((root) => root === '/' || folder === root || folder.startsWith(`${root}/`));
    if (!inside) throw invalid('focus must be inside a scanned root');
    attributes.focus = folder;
  }
  return attributes;
}

/**
 * The page's Content-Security-Policy with 'wasm-unsafe-eval' added to
 * script-src. The DiskX module compiles WebAssembly (Manifold geometry);
 * 'wasm-unsafe-eval' allows WebAssembly compilation only, not eval() of
 * JavaScript, and only on this page. Without a policy nothing changes.
 */
function allowWasm(policy) {
  if (!policy) return policy;
  const directives = String(policy).split(';').map((part) => part.trim()).filter(Boolean);
  const index = directives.findIndex((part) => /^script-src(\s|$)/i.test(part));
  if (index === -1) {
    const fallback = directives.find((part) => /^default-src(\s|$)/i.test(part));
    directives.push(`script-src${fallback ? fallback.slice('default-src'.length) : " 'self'"} 'wasm-unsafe-eval'`);
  } else if (!/'wasm-unsafe-eval'/i.test(directives[index])) {
    directives[index] = `${directives[index]} 'wasm-unsafe-eval'`;
  }
  return directives.join(';');
}

const escapeAttribute = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderPage({ roots, attributes }) {
  const ecosystem = attributes.app === 'ecosystem';
  const tag = ecosystem ? 'agentx-ecosystem' : 'diskx-city';
  const title = ecosystem ? 'Écosystème' : 'DiskX';
  const element = ecosystem ? attributes : { 'api-base': API_BASE, roots: roots.join(','), ...attributes, 'actions-href': ACTIONS_HREF };
  const attrs = Object.entries(element).map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<link rel="stylesheet" href="/assets/diskx/diskx.css">
<script src="/assets/household/journey-timings.js?v=1"></script>
<script src="/js/screen-pages.js?v=1"></script>
<script type="module" src="${MODULE_ROUTE}"></script>
<script defer src="/assets/diskx/${ecosystem ? 'ecosystem-page' : 'diskx-page'}.js"></script>
</head>
<body>
<${tag}${attrs}></${tag}>
<p id="diskx-status" role="status" aria-live="polite">Chargement de la vue ${title}…</p>
<noscript><p>DiskX a besoin de JavaScript.</p></noscript>
</body>
</html>
`;
}

function errorPage(message) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>DiskX</title><link rel="stylesheet" href="/assets/diskx/diskx.css"></head>
<body><p id="diskx-status" class="error" role="alert">${escapeAttribute(message)}</p></body></html>
`;
}

function register({ app, express, fetchWithTimeout, fetchData, env = process.env }) {
  app.use('/assets/diskx', express.static(path.join(__dirname, 'public'), { fallthrough: false, maxAge: '5m' }));

  app.get('/api/diskx/presentation', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (Object.keys(req.query).some(key => !['group', 'report'].includes(key))) throw invalid('Unknown presentation parameter');
      const attributes = checkQuery(req.query);
      if (!attributes.report) throw invalid('A displayed report date is required');
      const view = await require('../../src/services/janitorReportView').readJanitorReportView(
        attributes.group ? { group: attributes.group } : {}, { fetchData, env, expectedReport: attributes.report });
      const read = require('../../src/services/presentationReadService').presentationReader.publishJanitor(view);
      return res.json({ ok: true, data: { read, filters: { report: attributes.report, group: attributes.group || null } } });
    } catch (error) {
      return res.status(error.status || 502).json({ ok: false, code: error.code || 'DISKX_READ_UNAVAILABLE', message: error.message });
    }
  });

  app.get('/diskx', async (req, res) => {
    const ecosystem = single(req.query.app) === 'ecosystem';
    const roots = ecosystem ? [] : await resolveRoots({ env, fetchData });
    // <diskx-city> requires roots: without any, say so instead of mounting a broken city.
    if (!ecosystem && !roots.length) {
      return res.status(503).type('html').set('Cache-Control', 'no-store')
        .send(errorPage('Aucune racine de stockage connue : définissez DISKX_ROOTS ou vérifiez que Data déclare ses sources.'));
    }
    let attributes;
    try { attributes = checkQuery(req.query, roots); }
    catch (error) { return res.status(error.status || 400).type('html').send(errorPage(error.message)); }
    const policy = res.getHeader('Content-Security-Policy');
    if (policy) res.set('Content-Security-Policy', allowWasm(policy));
    return res.type('html').set('Cache-Control', 'no-store').send(renderPage({ roots, attributes }));
  });

  app.get(MODULE_ROUTE, createScriptRelay({
    resolveUrl: () => diskxModuleUrl(env),
    fetchWithTimeout: fetchWithTimeout || require('../../src/services/voice/transport').fetchWithTimeout,
    requireScriptType: true,
    maxBytes: MODULE_MAX_BYTES,
    unavailable: (res, error) => res.status(error.status || 503).json({
      ok: false, status: 'error', code: error.code || 'DISKX_UNAVAILABLE', message: error.message
    })
  }));
}

module.exports = { register, allowWasm, diskxModuleUrl, resolveRoots, parseRoots, checkQuery, renderPage, PAGE, MODULE_ROUTE, API_BASE, MODULE_MAX_BYTES };
