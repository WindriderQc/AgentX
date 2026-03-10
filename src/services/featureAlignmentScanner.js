/**
 * Feature Alignment Scanner
 *
 * Scans a workspace and produces a feature-alignment report:
 * which features have frontend + backend + docs coverage.
 *
 * Parsing utilities live in featureAlignmentParsers.js.
 *
 * @param {Object} options
 * @param {string} options.rootDir
 */

'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../../config/logger');

const { FALSE_POSITIVE_ENDPOINTS, API_ONLY_ENDPOINTS } = require('./featureAlignmentPriority');
const { calculateEndpointConfidence } = require('./scannerConfidence');
const {
  uniq, readTextSafe,
  normalizeEndpointPath, endpointKey,
  walkFiles,
  parseHtmlSignals, parseHtmlEndpointRefs, parseJsEndpointRefs,
  endpointPathToLooseRegex, pathsMatch, isAuthishPath,
  parseExpressRouterEndpoints, parseAppMounts, joinPaths,
  computeFeatureKeyFromPath, scoreMatch, buildStatus, tokenize
} = require('./featureAlignmentParsers');

function scanWorkspace(options) {
  const rootDir = options?.rootDir;
  if (!rootDir) throw new Error('scanWorkspace requires rootDir');

  const frontendDirs     = options.frontendDirs     || ['public'];
  const backendRouteDirs = options.backendRouteDirs  || ['routes'];
  const serviceDirs      = options.serviceDirs       || ['src/services'];
  const modelDirs        = options.modelDirs         || ['models'];
  const docsDirs         = options.docsDirs          || ['docs'];

  const excludeDirs = options.excludeDirs || [
    'node_modules', '.git', 'coverage', 'archive', 'archives',
    'backup', 'backups', 'dist', 'build', 'out', '.next', 'tmp', '.cache'
  ];

  const appJsPath  = path.join(rootDir, 'src', 'app.js');
  const appJsText  = readTextSafe(appJsPath);
  const mounts     = parseAppMounts(appJsText);

  // ── Frontend ──────────────────────────────────────────────────
  const frontendFiles   = [];
  const frontendJsFiles = [];
  for (const d of frontendDirs) {
    const dirPath = path.join(rootDir, d);
    if (fs.existsSync(dirPath)) {
      frontendFiles.push(...walkFiles(dirPath, { includeExtensions: ['.html'], excludeDirs }));
      frontendJsFiles.push(...walkFiles(dirPath, { includeExtensions: ['.js'], excludeDirs }));
    }
  }

  const frontendEndpointRefs = [];
  for (const filePath of frontendFiles) {
    const html = readTextSafe(filePath);
    frontendEndpointRefs.push(...parseHtmlEndpointRefs(html).map(r => ({ ...r, filePath })));
    const scriptBlocks = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of scriptBlocks) {
      if (match[0].includes('src=')) continue;
      frontendEndpointRefs.push(...parseJsEndpointRefs(match[1]).map(r => ({ ...r, filePath })));
    }
  }
  for (const filePath of frontendJsFiles) {
    frontendEndpointRefs.push(...parseJsEndpointRefs(readTextSafe(filePath)).map(r => ({ ...r, filePath })));
  }

  const frontendIndex = [...frontendFiles, ...frontendJsFiles].map(filePath => {
    const html    = readTextSafe(filePath);
    const signals = parseHtmlSignals(html);
    const key     = computeFeatureKeyFromPath(filePath);
    const tokens  = uniq([...tokenize(key), ...signals.flatMap(tokenize)]);
    return { filePath, key, tokens, signals };
  });

  // ── Backend Routes / Endpoints ────────────────────────────────
  const routeFiles = [];
  for (const d of backendRouteDirs) {
    const dirPath = path.join(rootDir, d);
    if (fs.existsSync(dirPath)) {
      routeFiles.push(...walkFiles(dirPath, { includeExtensions: ['.js'], excludeDirs }));
    }
  }

  const backendEndpoints = [];
  for (const filePath of routeFiles) {
    const rel      = path.relative(path.join(rootDir, 'routes'), filePath);
    const routesKey = rel.replace(/\\/g, '/').replace(/\.js$/i, '');
    const jsText   = readTextSafe(filePath);
    const endpoints = parseExpressRouterEndpoints(jsText);
    const mount    = mounts.get(routesKey) || '';
    for (const ep of endpoints) {
      backendEndpoints.push({
        method: ep.method,
        path: joinPaths(mount, ep.path),
        sourceFile: filePath,
        routeKey: routesKey
      });
    }
  }

  // ── Services / Models ─────────────────────────────────────────
  function scanJsDir(dirRelPath) {
    const dirPath = path.join(rootDir, dirRelPath);
    if (!fs.existsSync(dirPath)) return [];
    return walkFiles(dirPath, { includeExtensions: ['.js'], excludeDirs })
      .map(filePath => ({ filePath, text: readTextSafe(filePath) }));
  }

  const serviceFiles = serviceDirs.flatMap(scanJsDir);
  const modelFiles   = modelDirs.flatMap(scanJsDir);

  // ── Docs ──────────────────────────────────────────────────────
  const docFiles = [];
  for (const d of docsDirs) {
    const dirPath = path.join(rootDir, d);
    if (fs.existsSync(dirPath)) {
      docFiles.push(...walkFiles(dirPath, { includeExtensions: ['.md'], excludeDirs }));
    }
  }
  const rootEntries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      docFiles.push(path.join(rootDir, entry.name));
    }
  }
  const docsIndex  = docFiles.map(filePath => ({ filePath, text: readTextSafe(filePath) }));
  const docsCorpus = docsIndex.map(d => d.text).filter(Boolean).join('\n');

  // ── Evidence collection ───────────────────────────────────────
  const endpointEvidenceMap = new Map();

  for (const ep of backendEndpoints) {
    const epKey = endpointKey(ep.method, ep.path);
    const evidence = {
      frontend: { references: [], directFetch: false, apiHelper: false, htmlForm: false },
      docs: { files: [], explicitMention: false },
      lastModified: null,
      detectionMethod: isAuthishPath(ep.path) ? 'auth-heuristic' : null
    };

    for (const ref of frontendEndpointRefs) {
      if (ref.method !== 'ANY' && ref.method !== ep.method) continue;
      if (pathsMatch(ref.path, ep.path)) {
        evidence.frontend.references.push(ref.filePath);
        if (ref.kind === 'fetch') evidence.frontend.directFetch = true;
        else if (ref.kind === 'form-action') evidence.frontend.htmlForm = true;
        else evidence.frontend.apiHelper = true;
        try {
          const stats = fs.statSync(ref.filePath);
          if (!evidence.lastModified || stats.mtime > evidence.lastModified) evidence.lastModified = stats.mtime;
        } catch (err) {
          logger.error('featureAlignmentScanner: Failed to stat file', { filePath: ref.filePath, error: err.message });
        }
      }
    }

    for (const doc of docsIndex) {
      const epPath = normalizeEndpointPath(ep.path);
      if (epPath.length > 1 && doc.text.includes(epPath)) {
        evidence.docs.files.push(doc.filePath);
        evidence.docs.explicitMention = true;
        try {
          const stats = fs.statSync(doc.filePath);
          if (!evidence.lastModified || stats.mtime > evidence.lastModified) evidence.lastModified = stats.mtime;
        } catch (err) {
          logger.error('featureAlignmentScanner: Failed to stat doc file', { filePath: doc.filePath, error: err.message });
        }
      }
    }

    try {
      const stats = fs.statSync(ep.sourceFile);
      if (!evidence.lastModified || stats.mtime > evidence.lastModified) evidence.lastModified = stats.mtime;
    } catch (err) {
      logger.error('featureAlignmentScanner: Failed to stat source file', { sourceFile: ep.sourceFile, error: err.message });
    }

    endpointEvidenceMap.set(epKey, evidence);
  }

  // ── Candidate features ────────────────────────────────────────
  const candidateKeys = new Map();
  const assignedEndpointKeys = new Set();

  for (const f of frontendIndex) {
    if (!candidateKeys.has(f.key)) candidateKeys.set(f.key, { from: new Set(['frontend']) });
    else candidateKeys.get(f.key).from.add('frontend');
  }
  for (const rf of routeFiles) {
    const key = computeFeatureKeyFromPath(rf);
    if (!candidateKeys.has(key)) candidateKeys.set(key, { from: new Set(['backend']) });
    else candidateKeys.get(key).from.add('backend');
  }
  for (const df of docFiles) {
    const key = computeFeatureKeyFromPath(df);
    if (!candidateKeys.has(key)) candidateKeys.set(key, { from: new Set(['docs']) });
    else candidateKeys.get(key).from.add('docs');
  }

  const features = [];
  for (const [key, meta] of candidateKeys.entries()) {
    if (key.includes('quick-reference') || key.includes('-schema') ||
        key.includes('-design') || key.includes('-guide') || key.includes('-index')) continue;

    const tokens = uniq(tokenize(key));

    const frontendMatches = frontendIndex
      .filter(f => scoreMatch(tokens, f.key + ' ' + f.signals.join(' ')) > 0)
      .map(f => f.filePath);

    const endpointMatches = backendEndpoints
      .filter(ep => scoreMatch(tokens, ep.path + ' ' + ep.routeKey) > 0)
      .map(ep => {
        const epKey = endpointKey(ep.method, ep.path);
        const ev = endpointEvidenceMap.get(epKey) || {};
        assignedEndpointKeys.add(epKey);
        const confidence = calculateEndpointConfidence(ep, { ...ev, featureKey: key });
        return { method: ep.method, path: ep.path, sourceFile: ep.sourceFile, confidence };
      });

    const serviceMatches = serviceFiles
      .filter(sf => scoreMatch(tokens, path.basename(sf.filePath) + ' ' + sf.text.slice(0, 8000)) > 0)
      .map(sf => sf.filePath);

    const modelMatches = modelFiles
      .filter(mf => scoreMatch(tokens, path.basename(mf.filePath) + ' ' + mf.text.slice(0, 8000)) > 0)
      .map(mf => mf.filePath);

    const docMatches = docsIndex
      .filter(d => scoreMatch(tokens, path.basename(d.filePath) + ' ' + d.text.slice(0, 12000)) > 0)
      .map(d => d.filePath);

    const present = {
      frontend: frontendMatches.length > 0,
      backend: endpointMatches.length > 0 || serviceMatches.length > 0 || modelMatches.length > 0,
      docs: docMatches.length > 0
    };

    if (!present.frontend && !present.backend && !present.docs) continue;

    features.push({
      key, sources: Array.from(meta.from), present, status: buildStatus(present),
      frontend: { files: uniq(frontendMatches) },
      backend: { endpoints: endpointMatches, services: uniq(serviceMatches), models: uniq(modelMatches) },
      docs: { files: uniq(docMatches) }
    });
  }

  // ── Orphan endpoints ──────────────────────────────────────────
  const visibleFeatureTokenSets = features
    .filter(f => f.present.frontend || f.present.docs)
    .map(f => ({ key: f.key, tokens: tokenize(f.key) }));

  const isReferencedInFrontend = (ep) => {
    const epPath = normalizeEndpointPath(ep.path);
    for (const r of frontendEndpointRefs) {
      if (r.method !== 'ANY' && r.method !== ep.method) continue;
      if (pathsMatch(r.path, epPath)) return true;
    }
    return false;
  };

  const isMentionedInDocs = (ep) => {
    const epPath = normalizeEndpointPath(ep.path);
    if (!docsCorpus) return false;
    if (docsCorpus.includes(epPath)) return true;
    const loose = endpointPathToLooseRegex(epPath);
    return loose ? loose.test(docsCorpus) : false;
  };

  const orphanEndpoints = backendEndpoints
    .filter(ep => {
      const epKey = endpointKey(ep.method, ep.path);
      if (FALSE_POSITIVE_ENDPOINTS.includes(epKey)) return false;
      if (API_ONLY_ENDPOINTS.includes(epKey)) return false;
      if (isReferencedInFrontend(ep)) return false;
      if (isMentionedInDocs(ep)) return false;
      if (assignedEndpointKeys.has(epKey)) return false;
      if (isAuthishPath(ep.path)) return false;
      const hay = ep.path + ' ' + ep.routeKey;
      for (const ft of visibleFeatureTokenSets) {
        const threshold = ft.tokens.length > 1 ? 2 : 1;
        if (scoreMatch(ft.tokens, hay, { minHits: threshold }) > 0) return false;
      }
      return true;
    })
    .map(ep => {
      const epKey = endpointKey(ep.method, ep.path);
      const ev = endpointEvidenceMap.get(epKey) || {};
      return {
        method: ep.method, path: ep.path, sourceFile: ep.sourceFile,
        evidence: { checkedFrontend: true, checkedDocs: true },
        confidence: calculateEndpointConfidence(ep, ev)
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

  features.sort((a, b) => a.key.localeCompare(b.key));
  return { summary, features, orphanEndpoints };
}

module.exports = {
  scanWorkspace,
  _internal: {
    normalizeToken: require('./featureAlignmentParsers').normalizeToken,
    tokenize:       require('./featureAlignmentParsers').tokenize,
    parseHtmlSignals,
    parseHtmlEndpointRefs,
    parseJsEndpointRefs,
    parseExpressRouterEndpoints,
    parseAppMounts,
    joinPaths
  }
};
