const fs = require('fs');
const path = require('path');

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
        if (excludeDirs.some((d) => entry.name === d)) continue;
        walk(full);
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (includeExtensions.includes(ext)) out.push(full);
    }
  }

  walk(rootDir);
  return out;
}

function parseHtmlSignals(htmlText) {
  const signals = [];

  // data-feature attributes
  for (const m of htmlText.matchAll(/data-feature\s*=\s*['"]([^'"]+)['"]/gi)) {
    signals.push(m[1]);
  }

  // title and headings
  const titleMatch = htmlText.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) signals.push(titleMatch[1]);

  for (const m of htmlText.matchAll(/<(h1|h2|h3)[^>]*>([^<]+)<\/(h1|h2|h3)>/gi)) {
    signals.push(m[2]);
  }

  // button/section ids and classes that look like features
  for (const m of htmlText.matchAll(/\bid\s*=\s*['"]([^'"]+)['"]/gi)) {
    signals.push(m[1]);
  }

  return uniq(signals.filter(Boolean));
}

function parseExpressRouterEndpoints(jsText) {
  const endpoints = [];

  // router.get('/path', ...)
  for (const m of jsText.matchAll(/\brouter\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi)) {
    endpoints.push({ method: m[1].toUpperCase(), path: m[2] });
  }

  return endpoints;
}

function parseAppMounts(appJsText) {
  // Parse patterns like:
  // const fooRoutes = require('../routes/foo');
  // app.use('/api/foo', fooRoutes);

  const requireMap = new Map(); // varName -> routesFile (foo)
  for (const m of appJsText.matchAll(/\bconst\s+(\w+)\s*=\s*require\(['"]\.\.\/routes\/([^'"]+)['"]\)\s*;?/g)) {
    requireMap.set(m[1], m[2]);
  }

  const mounts = new Map(); // routesFile -> mountPath
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

function computeFeatureKeyFromPath(filePath) {
  const base = path.basename(filePath).replace(path.extname(filePath), '');
  return normalizeToken(base).replace(/\s+/g, '-');
}

const STOPWORDS = new Set([
  'api',
  'app',
  'auth',
  'route',
  'routes',
  'service',
  'services',
  'model',
  'models',
  'docs',
  'doc',
  'readme',
  'config',
  'dashboard',
  'admin',
  'test',
  'tests',
  'agentx',
  'public',
  'src'
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

/**
 * Scan a workspace and produce an alignment report.
 *
 * @param {Object} options
 * @param {string} options.rootDir - Workspace root (AgentX)
 * @param {string[]} [options.frontendDirs] - default ['public']
 * @param {string[]} [options.backendRouteDirs] - default ['routes']
 * @param {string[]} [options.serviceDirs] - default ['src/services']
 * @param {string[]} [options.modelDirs] - default ['models']
 * @param {string[]} [options.docsDirs] - default ['docs'] plus root *.md
 */
function scanWorkspace(options) {
  const rootDir = options?.rootDir;
  if (!rootDir) throw new Error('scanWorkspace requires rootDir');

  const frontendDirs = options.frontendDirs || ['public'];
  const backendRouteDirs = options.backendRouteDirs || ['routes'];
  const serviceDirs = options.serviceDirs || ['src/services'];
  const modelDirs = options.modelDirs || ['models'];
  const docsDirs = options.docsDirs || ['docs'];

  const excludeDirs = ['node_modules', '.git', 'coverage'];

  const appJsPath = path.join(rootDir, 'src', 'app.js');
  const appJsText = readTextSafe(appJsPath);
  const mounts = parseAppMounts(appJsText);

  // ---------- Frontend ----------
  const frontendFiles = [];
  for (const d of frontendDirs) {
    const dirPath = path.join(rootDir, d);
    if (fs.existsSync(dirPath)) {
      frontendFiles.push(...walkFiles(dirPath, { includeExtensions: ['.html'], excludeDirs }));
    }
  }

  const frontendIndex = frontendFiles.map((filePath) => {
    const html = readTextSafe(filePath);
    const signals = parseHtmlSignals(html);
    const key = computeFeatureKeyFromPath(filePath);
    const tokens = uniq([...tokenize(key), ...signals.flatMap(tokenize)]);

    return {
      filePath,
      key,
      tokens,
      signals
    };
  });

  // ---------- Backend Routes/Endpoints ----------
  const routeFiles = [];
  for (const d of backendRouteDirs) {
    const dirPath = path.join(rootDir, d);
    if (fs.existsSync(dirPath)) {
      routeFiles.push(...walkFiles(dirPath, { includeExtensions: ['.js'], excludeDirs }));
    }
  }

  const backendEndpoints = [];
  for (const filePath of routeFiles) {
    const rel = path.relative(path.join(rootDir, 'routes'), filePath);
    const routesKey = rel.replace(/\\/g, '/').replace(/\.js$/i, '');

    const jsText = readTextSafe(filePath);
    const endpoints = parseExpressRouterEndpoints(jsText);
    const mount = mounts.get(routesKey) || '';

    for (const ep of endpoints) {
      const fullPath = joinPaths(mount, ep.path);
      backendEndpoints.push({
        method: ep.method,
        path: fullPath,
        sourceFile: filePath,
        routeKey: routesKey
      });
    }
  }

  // ---------- Services/Models ----------
  function scanJsDir(dirRelPath) {
    const dirPath = path.join(rootDir, dirRelPath);
    if (!fs.existsSync(dirPath)) return [];
    const files = walkFiles(dirPath, { includeExtensions: ['.js'], excludeDirs });
    return files.map((filePath) => ({ filePath, text: readTextSafe(filePath) }));
  }

  const serviceFiles = serviceDirs.flatMap(scanJsDir);
  const modelFiles = modelDirs.flatMap(scanJsDir);

  // ---------- Docs ----------
  const docFiles = [];
  for (const d of docsDirs) {
    const dirPath = path.join(rootDir, d);
    if (fs.existsSync(dirPath)) {
      docFiles.push(...walkFiles(dirPath, { includeExtensions: ['.md'], excludeDirs }));
    }
  }

  // root-level markdown
  const rootEntries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    docFiles.push(path.join(rootDir, entry.name));
  }

  const docsIndex = docFiles.map((filePath) => ({ filePath, text: readTextSafe(filePath) }));

  // ---------- Candidate features ----------
  const candidateKeys = new Map();

  for (const f of frontendIndex) {
    if (!candidateKeys.has(f.key)) candidateKeys.set(f.key, { from: new Set(['frontend']) });
    else candidateKeys.get(f.key).from.add('frontend');
  }

  // seed from route file names (often feature-ish)
  for (const rf of routeFiles) {
    const key = computeFeatureKeyFromPath(rf);
    if (!candidateKeys.has(key)) candidateKeys.set(key, { from: new Set(['backend']) });
    else candidateKeys.get(key).from.add('backend');
  }

  // seed from docs filenames
  for (const df of docFiles) {
    const key = computeFeatureKeyFromPath(df);
    if (!candidateKeys.has(key)) candidateKeys.set(key, { from: new Set(['docs']) });
    else candidateKeys.get(key).from.add('docs');
  }

  const features = [];
  for (const [key, meta] of candidateKeys.entries()) {
    const tokens = uniq(tokenize(key));

    // Frontend evidence
    const frontendMatches = frontendIndex
      .filter((f) => scoreMatch(tokens, f.key + ' ' + f.signals.join(' ')) > 0)
      .map((f) => f.filePath);

    // Backend evidence
    const endpointMatches = backendEndpoints
      .filter((ep) => scoreMatch(tokens, ep.path + ' ' + ep.routeKey) > 0)
      .map((ep) => ({ method: ep.method, path: ep.path, sourceFile: ep.sourceFile }));

    const serviceMatches = serviceFiles
      .filter((sf) => scoreMatch(tokens, path.basename(sf.filePath) + ' ' + sf.text.slice(0, 8000)) > 0)
      .map((sf) => sf.filePath);

    const modelMatches = modelFiles
      .filter((mf) => scoreMatch(tokens, path.basename(mf.filePath) + ' ' + mf.text.slice(0, 8000)) > 0)
      .map((mf) => mf.filePath);

    // Docs evidence
    const docMatches = docsIndex
      .filter((d) => scoreMatch(tokens, path.basename(d.filePath) + ' ' + d.text.slice(0, 12000)) > 0)
      .map((d) => d.filePath);

    const present = {
      frontend: frontendMatches.length > 0,
      backend: endpointMatches.length > 0 || serviceMatches.length > 0 || modelMatches.length > 0,
      docs: docMatches.length > 0
    };

    // Avoid flooding output with extremely weak candidates
    const hasAnyEvidence = present.frontend || present.backend || present.docs;
    if (!hasAnyEvidence) continue;

    features.push({
      key,
      sources: Array.from(meta.from),
      present,
      status: buildStatus(present),
      frontend: { files: uniq(frontendMatches) },
      backend: {
        endpoints: endpointMatches,
        services: uniq(serviceMatches),
        models: uniq(modelMatches)
      },
      docs: { files: uniq(docMatches) }
    });
  }

  // Orphan endpoints: endpoints that do not match any feature key that is visible in
  // frontend OR documentation. This avoids the common false-negative where backend
  // route file names themselves create a "feature" and make everything look "matched".
  const visibleFeatureTokenSets = features
    .filter((f) => f.present.frontend || f.present.docs)
    .map((f) => ({ key: f.key, tokens: tokenize(f.key) }));

  const orphanEndpoints = backendEndpoints
    .filter((ep) => {
      const hay = ep.path + ' ' + ep.routeKey;
      for (const ft of visibleFeatureTokenSets) {
        if (scoreMatch(ft.tokens, hay, { minHits: 1 }) > 0) return false;
      }
      return true;
    })
    .map((ep) => ({ method: ep.method, path: ep.path, sourceFile: ep.sourceFile }));

  const summary = {
    generatedAt: new Date().toISOString(),
    rootDir,
    counts: {
      features: features.length,
      frontendFiles: frontendFiles.length,
      routeFiles: routeFiles.length,
      backendEndpoints: backendEndpoints.length,
      docsFiles: docFiles.length,
      orphanEndpoints: orphanEndpoints.length
    },
    statusCounts: features.reduce((acc, f) => {
      acc[f.status] = (acc[f.status] || 0) + 1;
      return acc;
    }, {})
  };

  // Stabilize ordering
  features.sort((a, b) => a.key.localeCompare(b.key));

  return { summary, features, orphanEndpoints };
}

module.exports = {
  scanWorkspace,
  // exposed for unit tests
  _internal: {
    normalizeToken,
    tokenize,
    parseHtmlSignals,
    parseExpressRouterEndpoints,
    parseAppMounts,
    joinPaths
  }
};
