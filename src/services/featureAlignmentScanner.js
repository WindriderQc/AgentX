const fs = require('fs');
const path = require('path');
const logger = require('../../config/logger');

const { FALSE_POSITIVE_ENDPOINTS, API_ONLY_ENDPOINTS } = require('./featureAlignmentPriority');
const { calculateEndpointConfidence } = require('./scannerConfidence');

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

function shouldExcludeFile(filePath) {
  const fp = String(filePath || '').replace(/\\/g, '/');

  // common backup / build outputs
  const excludedPathFragments = [
    '/archive/',
    '/archives/',
    '/backup/',
    '/backups/',
    '/.next/',
    '/dist/',
    '/build/',
    '/out/',
    '/tmp/',
    '/.cache/'
  ];
  if (excludedPathFragments.some((frag) => fp.includes(frag))) return true;

  // editor backups
  const base = path.basename(fp);
  if (base.endsWith('~')) return true;
  if (base.toLowerCase().endsWith('.bak')) return true;
  if (base.toLowerCase().endsWith('.swp')) return true;

  return false;
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

      if (shouldExcludeFile(full)) continue;

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
  // Replace any ${...} with a stable placeholder so we can still match /api/foo/:param
  return String(s || '')
    .replace(/\$\{[^}]+\}/g, ':param')
    .trim();
}

function parseJsEndpointRefs(jsText) {
  const refs = [];
  const text = String(jsText || '');

  // fetch('/path', { method: 'POST' }) - including custom wrappers like fetchJSON, workspaceFetch
  for (const m of text.matchAll(/\b(fetch|fetchJSON|workspaceFetch|fetchWithWorkspace)\s*\(\s*([`'"])([\s\S]*?)\2\s*(?:,\s*\{[\s\S]*?\})?\s*\)/gi)) {
    const rawPath = normalizeEndpointPath(extractTemplateLiteralAsPath(m[3]));
    if (!rawPath || !rawPath.startsWith('/')) continue;

    // best-effort method detection near the call
    const callStart = m.index ?? 0;
    const callWindow = text.slice(callStart, Math.min(callStart + 500, text.length));
    const methodMatch = callWindow.match(/\bmethod\s*:\s*['"](GET|POST|PUT|DELETE|PATCH)['"]/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'ANY';

    refs.push({ method, path: rawPath, kind: m[1].toLowerCase() });
  }

  // axios.get('/path'), API.post('/path'), apiClient.get(), client.request()
  // Case-insensitive matching for client variables
  for (const m of text.matchAll(/\b(axios|API|api|client|apiClient)\.(get|post|put|delete|patch|request)\s*\(\s*([`'"])([\s\S]*?)\3/gi)) {
    const rawPath = normalizeEndpointPath(extractTemplateLiteralAsPath(m[4]));
    if (!rawPath || !rawPath.startsWith('/')) continue;

    // For .request() calls, try to detect method from options
    let method = m[2].toUpperCase();
    if (method === 'REQUEST') {
      const callStart = m.index ?? 0;
      const callWindow = text.slice(callStart, Math.min(callStart + 300, text.length));
      const methodMatch = callWindow.match(/\bmethod\s*:\s*['"](GET|POST|PUT|DELETE|PATCH)['"]/i);
      method = methodMatch ? methodMatch[1].toUpperCase() : 'ANY';
    }

    refs.push({ method, path: rawPath, kind: `${m[1].toLowerCase()}.${m[2].toLowerCase()}` });
  }

  // String concatenation patterns: '/api/' + var, baseUrl + '/path', origin + '/api/...'
  // Pattern 1: '/api/...' + variable
  for (const m of text.matchAll(/(['"`])(\/(api\/[^'"` +]+))\1\s*\+/gi)) {
    const basePath = m[2];
    if (basePath.startsWith('/api/')) {
      refs.push({ method: 'ANY', path: basePath + ':param', kind: 'concat' });
    }
  }

  // Pattern 2: variable + '/api/...'
  for (const m of text.matchAll(/\+\s*(['"`])(\/(api\/[^'"` +]+))\1/gi)) {
    const basePath = m[2];
    if (basePath.startsWith('/api/')) {
      refs.push({ method: 'ANY', path: basePath, kind: 'concat' });
    }
  }

  // Pattern 3: origin/baseUrl + '/api/...'
  for (const m of text.matchAll(/(origin|baseURL|baseUrl|API_BASE)\s*\+\s*(['"`])(\/(api\/[^'"` +]+))\2/gi)) {
    const path = m[3];
    if (path.startsWith('/api/')) {
      refs.push({ method: 'ANY', path, kind: 'concat-origin' });
    }
  }

  return refs;
}

function endpointPathToLooseRegex(endpointPath) {
  const p = normalizeEndpointPath(endpointPath);
  if (!p) return null;
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // :id or {id} style placeholders
  const withWildcards = escaped
    .replace(/\\:[a-zA-Z0-9_]+/g, '[^\\s/]+')
    .replace(/\\\{[a-zA-Z0-9_]+\\\}/g, '[^\\s/]+');

  try {
    return new RegExp(`^${withWildcards}$`);
  } catch {
    return null;
  }
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

const COMMON_AUTH_ROUTES = [
  '/login',
  '/logout',
  '/register',
  '/me',
  '/auth/callback',
  '/auth/verify'
];

function isAuthishPath(p) {
  const ep = normalizeEndpointPath(p);
  // Common auth routes that might be handled via form actions or direct navigation
  return COMMON_AUTH_ROUTES.some(route => ep === route || ep.endsWith(route));
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

  const excludeDirs = options.excludeDirs || [
    'node_modules',
    '.git',
    'coverage',
    'archive',
    'archives',
    'backup',
    'backups',
    'dist',
    'build',
    'out',
    '.next',
    'tmp',
    '.cache'
  ];

  const appJsPath = path.join(rootDir, 'src', 'app.js');
  const appJsText = readTextSafe(appJsPath);
  const mounts = parseAppMounts(appJsText);

  // ---------- Frontend ----------
  const frontendFiles = [];
  const frontendJsFiles = [];
  for (const d of frontendDirs) {
    const dirPath = path.join(rootDir, d);
    if (fs.existsSync(dirPath)) {
      frontendFiles.push(...walkFiles(dirPath, { includeExtensions: ['.html'], excludeDirs }));
      frontendJsFiles.push(...walkFiles(dirPath, { includeExtensions: ['.js'], excludeDirs }));
    }
  }

  // endpoint references in frontend assets (helps reduce orphan endpoint false positives)
  const frontendEndpointRefs = [];
  for (const filePath of frontendFiles) {
    const html = readTextSafe(filePath);

    // HTML form actions
    const formRefs = parseHtmlEndpointRefs(html).map((r) => ({ ...r, filePath }));
    frontendEndpointRefs.push(...formRefs);

    // JavaScript in <script> tags
    const scriptBlocks = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of scriptBlocks) {
      const scriptContent = match[1];
      // Skip if it's a src reference (external file, already scanned)
      if (match[0].includes('src=')) continue;

      const jsRefs = parseJsEndpointRefs(scriptContent).map((r) => ({ ...r, filePath }));
      frontendEndpointRefs.push(...jsRefs);
    }
  }
  for (const filePath of frontendJsFiles) {
    const js = readTextSafe(filePath);
    const refs = parseJsEndpointRefs(js).map((r) => ({ ...r, filePath }));
    frontendEndpointRefs.push(...refs);
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

  // build a cheap docs search corpus for endpoint mentions
  const docsCorpus = docsIndex
    .map((d) => d.text)
    .filter(Boolean)
    .join('\n');

  // ---------- Evidence Collection for Confidence Scoring ----------
  const endpointEvidenceMap = new Map(); // endpointKey -> evidence

  for (const ep of backendEndpoints) {
    const epKey = endpointKey(ep.method, ep.path);
    const evidence = {
      frontend: { references: [], directFetch: false, apiHelper: false, htmlForm: false },
      docs: { files: [], explicitMention: false },
      lastModified: null,
      detectionMethod: isAuthishPath(ep.path) ? 'auth-heuristic' : null
    };

    // Frontend refs
    for (const ref of frontendEndpointRefs) {
      if (ref.method !== 'ANY' && ref.method !== ep.method) continue;
      if (pathsMatch(ref.path, ep.path)) {
        evidence.frontend.references.push(ref.filePath);
        if (ref.kind === 'fetch') evidence.frontend.directFetch = true;
        else if (ref.kind === 'form-action') evidence.frontend.htmlForm = true;
        else evidence.frontend.apiHelper = true;

        // Recency
        try {
          const stats = fs.statSync(ref.filePath);
          if (!evidence.lastModified || stats.mtime > evidence.lastModified) {
            evidence.lastModified = stats.mtime;
          }
        } catch (err) {
          logger.error('featureAlignmentScanner: Failed to stat file', { filePath: ref.filePath, error: err.message });
        }
      }
    }

    // Docs refs
    for (const doc of docsIndex) {
      // Use tighter check for docs to avoid false positives on short paths
      const epPath = normalizeEndpointPath(ep.path);
      if (epPath.length > 1 && doc.text.includes(epPath)) {
         evidence.docs.files.push(doc.filePath);
         evidence.docs.explicitMention = true;
         try {
          const stats = fs.statSync(doc.filePath);
          if (!evidence.lastModified || stats.mtime > evidence.lastModified) {
            evidence.lastModified = stats.mtime;
          }
        } catch (err) {
          logger.error('featureAlignmentScanner: Failed to stat doc file', { filePath: doc.filePath, error: err.message });
        }
      }
    }
    
    // Check backend source file for recency
    try {
        const stats = fs.statSync(ep.sourceFile);
        if (!evidence.lastModified || stats.mtime > evidence.lastModified) {
          evidence.lastModified = stats.mtime;
        }
    } catch (err) {
        logger.error('featureAlignmentScanner: Failed to stat source file', { sourceFile: ep.sourceFile, error: err.message });
    }

    endpointEvidenceMap.set(epKey, evidence);
  }

  // ---------- Candidate features ----------
  const candidateKeys = new Map();
  const assignedEndpointKeys = new Set();

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
      .map((ep) => {
        const epKey = endpointKey(ep.method, ep.path);
        const ev = endpointEvidenceMap.get(epKey) || {};
        // Record assignment
        assignedEndpointKeys.add(epKey);
        const confidence = calculateEndpointConfidence(ep, { ...ev, featureKey: key });
        return { method: ep.method, path: ep.path, sourceFile: ep.sourceFile, confidence };
      });

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

  function isReferencedInFrontend(ep) {
    const epPath = normalizeEndpointPath(ep.path);
    for (const r of frontendEndpointRefs) {
      if (r.method !== 'ANY' && r.method !== ep.method) continue;
      if (pathsMatch(r.path, epPath)) return true;
    }
    return false;
  }

  function isMentionedInDocs(ep) {
    const epPath = normalizeEndpointPath(ep.path);
    if (!docsCorpus) return false;
    if (docsCorpus.includes(epPath)) return true;
    const loose = endpointPathToLooseRegex(epPath);
    if (loose && loose.test(docsCorpus)) return true;
    return false;
  }

  const orphanEndpoints = backendEndpoints
    .filter((ep) => {
      const epKey = endpointKey(ep.method, ep.path);

      // If we already know it's not an orphan by policy, do not report it as an orphan.
      if (FALSE_POSITIVE_ENDPOINTS.includes(epKey)) return false;
      if (API_ONLY_ENDPOINTS.includes(epKey)) return false;

      // If the endpoint is referenced directly in frontend assets or docs, it's not an orphan.
      if (isReferencedInFrontend(ep)) return false;
      if (isMentionedInDocs(ep)) return false;

      // New: If assigned to a feature with reasonable confidence, it's not an orphan side-effect
      if (assignedEndpointKeys.has(epKey)) return false;

      // Heuristic: auth-ish and dashboard endpoints are often referenced indirectly.
      if (isAuthishPath(ep.path)) return false;

      // Fallback: token-match to any visible feature.
      // Now simpler because assignedEndpointKeys covers most cases.
      // But if an endpoint was NOT assigned (maybe weak match?), we check again with stricter threshold
      const hay = ep.path + ' ' + ep.routeKey;
      for (const ft of visibleFeatureTokenSets) {
        // Only consider it 'used' if it matches decently (2 tokens, or full 1 token)
        const threshold = ft.tokens.length > 1 ? 2 : 1;
        if (scoreMatch(ft.tokens, hay, { minHits: threshold }) > 0) return false;
      }
      return true;
    })
    .map((ep) => {
      const epKey = endpointKey(ep.method, ep.path);
      const ev = endpointEvidenceMap.get(epKey) || {};
      const confidence = calculateEndpointConfidence(ep, ev);
      
      return {
        method: ep.method,
        path: ep.path,
        sourceFile: ep.sourceFile,
        evidence: {
          checkedFrontend: true,
          checkedDocs: true
        },
        confidence
      };
    });

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
    parseHtmlEndpointRefs,
    parseJsEndpointRefs,
    parseExpressRouterEndpoints,
    parseAppMounts,
    joinPaths
  }
};
