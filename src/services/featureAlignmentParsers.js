/**
 * Feature Alignment Parsers
 *
 * Utility and parsing functions extracted from featureAlignmentScanner.js.
 * All functions are pure / stateless and have no external side effects.
 *
 * Used by: featureAlignmentScanner.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../../config/logger');

// ── String normalisation ──────────────────────────────────────

function normalizeToken(token) {
  return String(token || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(text) {
  const norm = normalizeToken(text);
  if (!norm) return [];
  return norm.split(' ').filter(Boolean);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

// ── Endpoint path helpers ─────────────────────────────────────

function normalizeEndpointPath(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  const noQuery = raw.split('?')[0];
  if (noQuery !== '/' && noQuery.endsWith('/')) return noQuery.slice(0, -1);
  return noQuery;
}

function endpointKey(method, endpointPath) {
  return `${String(method || '').toUpperCase()} ${normalizeEndpointPath(endpointPath)}`;
}

// ── File filtering ────────────────────────────────────────────

function shouldExcludeFile(filePath) {
  const fp = String(filePath || '').replace(/\\/g, '/');
  const excludedPathFragments = [
    '/archive/', '/archives/', '/backup/', '/backups/',
    '/.next/', '/dist/', '/build/', '/out/', '/.cache/'
  ];
  if (excludedPathFragments.some(frag => fp.includes(frag))) return true;
  const base = path.basename(fp);
  return base.endsWith('~') || base.toLowerCase().endsWith('.bak') || base.toLowerCase().endsWith('.swp');
}

function isUnderDir(filePath, dirPath) {
  const rel = path.relative(dirPath, filePath);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function walkFiles(rootDir, { includeExtensions, excludeDirs }) {
  const out = [];
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.some(d => entry.name === d)) continue;
        walk(full);
        continue;
      }
      if (shouldExcludeFile(full)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (includeExtensions.includes(ext)) out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

// ── HTML / JS endpoint parsing ────────────────────────────────

function parseHtmlSignals(htmlText) {
  const signals = [];
  for (const m of htmlText.matchAll(/data-feature\s*=\s*['"]([^'"]+)['"]/gi)) signals.push(m[1]);
  const titleMatch = htmlText.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) signals.push(titleMatch[1]);
  for (const m of htmlText.matchAll(/<(h1|h2|h3)[^>]*>([^<]+)<\/(h1|h2|h3)>/gi)) signals.push(m[2]);
  for (const m of htmlText.matchAll(/\bid\s*=\s*['"]([^'"]+)['"]/gi)) signals.push(m[1]);
  return uniq(signals.filter(Boolean));
}

function parseHtmlEndpointRefs(htmlText) {
  const refs = [];
  const html = String(htmlText || '');
  for (const m of html.matchAll(/\baction\s*=\s*['"]([^'"]+)['"]/gi)) {
    const href = normalizeEndpointPath(m[1]);
    if (!href) continue;
    if (href.startsWith('/')) refs.push({ method: 'ANY', path: href, kind: 'form-action' });
  }
  for (const m of html.matchAll(/\bhref\s*=\s*['"]([^'"]+)['"]/gi)) {
    const href = normalizeEndpointPath(m[1]);
    if (!href) continue;
    if (href.startsWith('/')) refs.push({ method: 'ANY', path: href, kind: 'href' });
  }
  return refs;
}

function extractTemplateLiteralAsPath(s) {
  return String(s || '').replace(/\$\{[^}]+\}/g, ':param').trim();
}

function parseJsEndpointRefs(jsText) {
  const refs = [];
  const text = String(jsText || '');

  for (const m of text.matchAll(/\b(fetch|fetchJSON|workspaceFetch|fetchWithWorkspace)\s*\(\s*([`'"])([\s\S]*?)\2\s*(?:,\s*\{[\s\S]*?\})?\s*\)/gi)) {
    const rawPath = normalizeEndpointPath(extractTemplateLiteralAsPath(m[3]));
    if (!rawPath || !rawPath.startsWith('/')) continue;
    const callStart = m.index ?? 0;
    const callWindow = text.slice(callStart, Math.min(callStart + 500, text.length));
    const methodMatch = callWindow.match(/\bmethod\s*:\s*['"](GET|POST|PUT|DELETE|PATCH)['"]/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'ANY';
    refs.push({ method, path: rawPath, kind: m[1].toLowerCase() });
  }

  for (const m of text.matchAll(/\b(axios|API|api|client|apiClient)\.(get|post|put|delete|patch|request)\s*\(\s*([`'"])([\s\S]*?)\3/gi)) {
    const rawPath = normalizeEndpointPath(extractTemplateLiteralAsPath(m[4]));
    if (!rawPath || !rawPath.startsWith('/')) continue;
    let method = m[2].toUpperCase();
    if (method === 'REQUEST') {
      const callStart = m.index ?? 0;
      const callWindow = text.slice(callStart, Math.min(callStart + 300, text.length));
      const methodMatch = callWindow.match(/\bmethod\s*:\s*['"](GET|POST|PUT|DELETE|PATCH)['"]/i);
      method = methodMatch ? methodMatch[1].toUpperCase() : 'ANY';
    }
    refs.push({ method, path: rawPath, kind: `${m[1].toLowerCase()}.${m[2].toLowerCase()}` });
  }

  for (const m of text.matchAll(/(['"`])(\/(api\/[^'"` +]+))\1\s*\+/gi)) {
    const basePath = m[2];
    if (basePath.startsWith('/api/')) refs.push({ method: 'ANY', path: basePath + ':param', kind: 'concat' });
  }
  for (const m of text.matchAll(/\+\s*(['"`])(\/(api\/[^'"` +]+))\1/gi)) {
    const basePath = m[2];
    if (basePath.startsWith('/api/')) refs.push({ method: 'ANY', path: basePath, kind: 'concat' });
  }
  for (const m of text.matchAll(/(origin|baseURL|baseUrl|API_BASE)\s*\+\s*(['"`])(\/(api\/[^'"` +]+))\2/gi)) {
    const p = m[3];
    if (p.startsWith('/api/')) refs.push({ method: 'ANY', path: p, kind: 'concat-origin' });
  }

  return refs;
}

// ── Endpoint matching ─────────────────────────────────────────

function endpointPathToLooseRegex(endpointPath) {
  const p = normalizeEndpointPath(endpointPath);
  if (!p) return null;
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped
    .replace(/\\:[a-zA-Z0-9_]+/g, '[^\\s/]+')
    .replace(/\\\{[a-zA-Z0-9_]+\\\}/g, '[^\\s/]+');
  try { return new RegExp(`^${withWildcards}$`); } catch { return null; }
}

function pathsMatch(a, b) {
  const pa = normalizeEndpointPath(a);
  const pb = normalizeEndpointPath(b);
  if (!pa || !pb) return false;
  if (pa === pb) return true;
  const ra = endpointPathToLooseRegex(pa);
  if (ra && ra.test(pb)) return true;
  const rb = endpointPathToLooseRegex(pb);
  if (rb && rb.test(pa)) return true;
  return false;
}

const COMMON_AUTH_ROUTES = ['/login', '/logout', '/register', '/me', '/auth/callback', '/auth/verify'];

function isAuthishPath(p) {
  const ep = normalizeEndpointPath(p);
  return COMMON_AUTH_ROUTES.some(route => ep === route || ep.endsWith(route));
}

// ── Route / mount parsing ─────────────────────────────────────

function parseExpressRouterEndpoints(jsText) {
  const endpoints = [];
  for (const m of jsText.matchAll(/\brouter\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi)) {
    endpoints.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return endpoints;
}

function parseAppMounts(appJsText) {
  const requireMap = new Map();
  for (const m of appJsText.matchAll(/\bconst\s+(\w+)\s*=\s*require\(['"]\.\.\/routes\/([^'"]+)['"]\)\s*;?/g)) {
    requireMap.set(m[1], m[2]);
  }
  const mounts = new Map();
  for (const m of appJsText.matchAll(/\bapp\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/g)) {
    const mountPath = m[1];
    const varName = m[2];
    const routesFile = requireMap.get(varName);
    if (routesFile) mounts.set(routesFile, mountPath);
  }
  return mounts;
}

function joinPaths(prefix, suffix) {
  const a = String(prefix || '').replace(/\/$/, '');
  const b = String(suffix || '');
  if (!a) return b;
  if (!b) return a;
  if (b.startsWith('/')) return a + b;
  return a + '/' + b;
}

// ── Feature scoring ───────────────────────────────────────────

function computeFeatureKeyFromPath(filePath) {
  const base = path.basename(filePath).replace(path.extname(filePath), '');
  return normalizeToken(base).replace(/\s+/g, '-');
}

const STOPWORDS = new Set([
  'api', 'app', 'auth', 'route', 'routes', 'service', 'services',
  'model', 'models', 'docs', 'doc', 'readme', 'config',
  'dashboard', 'admin', 'test', 'tests', 'agentx', 'public', 'src'
]);

function scoreMatch(featureTokens, haystackText, { minHits = 1, stopwords = STOPWORDS } = {}) {
  const hay = normalizeToken(haystackText);
  if (!hay) return 0;
  let hits = 0;
  for (const t of featureTokens) {
    if (t.length < 3) continue;
    if (stopwords && stopwords.has(t)) continue;
    if (hay.includes(t)) hits += 1;
  }
  return hits >= minHits ? hits : 0;
}

function buildStatus(present) {
  const { frontend, backend, docs } = present;
  if (frontend && backend && docs) return 'complete';
  if (backend && !frontend && !docs) return 'orphan-backend';
  if (frontend && backend && !docs) return 'undocumented';
  if (!frontend && backend && docs) return 'headless-documented';
  return 'partial';
}

module.exports = {
  normalizeToken, tokenize, uniq, readTextSafe,
  normalizeEndpointPath, endpointKey,
  shouldExcludeFile, isUnderDir, walkFiles,
  parseHtmlSignals, parseHtmlEndpointRefs, extractTemplateLiteralAsPath, parseJsEndpointRefs,
  endpointPathToLooseRegex, pathsMatch, isAuthishPath,
  parseExpressRouterEndpoints, parseAppMounts, joinPaths,
  computeFeatureKeyFromPath, STOPWORDS, scoreMatch, buildStatus
};
