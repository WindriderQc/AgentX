const fs = require('fs');
const path = require('path');
const logger = require('../../config/logger');

// ─── Shared Helpers ──────────────────────────────────────────────────

function readSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function walkFiles(rootDir, extensions, excludeDirs) {
  const out = [];
  const excl = new Set(excludeDirs || [
    'node_modules', '.git', 'coverage', 'archive', 'archives',
    'backup', 'backups', 'dist', 'build', 'out', '.next', 'tmp', '.cache'
  ]);
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excl.has(entry.name)) walk(full);
      } else if (extensions.includes(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  })(rootDir);
  return out;
}

// ─── Known False Positives ──────────────────────────────────────────
// Services loaded via dynamic require(), lazy init, model hooks, or
// consumed only by scripts (not routes/services).  Suppress as orphans.
const KNOWN_USED_SERVICES = new Set([
  'src/services/benchmark/index.js',     // facade, required by routes/benchmark/
  'src/services/hardwareProfileService.js', // required by routes/benchmark/hardware.js
  'src/services/n8nLLMProvider.js',       // dynamic require in chatService
  'src/services/metricsCollector.js',     // required by metricsService
  'src/services/ollamaVramService.js',    // required by routes/ollama-vram.js
  'src/services/ragFileWatcher.js',       // lazy-loaded in server.js
  'src/services/tokenCounter.js',         // used in models/Conversation.js pre-save hook
  'src/services/validationScanner.js',     // used by scripts/comprehensive-validation.js
  'src/services/metricsCleanup.js'         // built service, pending integration into server.js
]);

// Intentional dual-mount aliases (same route file, two paths on purpose)
const INTENTIONAL_DUAL_MOUNTS = new Set([
  'history'  // /api/history + /api/conversations legacy alias
]);

// ─── A. analyzeServiceCoverage ───────────────────────────────────────

/**
 * Parse module.exports from service files and trace require() usage
 * across routes and other services to find unused exported functions.
 */
function analyzeServiceCoverage(rootDir) {
  const servicesDir = path.join(rootDir, 'src', 'services');
  const routesDir = path.join(rootDir, 'routes');

  if (!fs.existsSync(servicesDir)) return { services: [], summary: {} };

  const serviceFiles = walkFiles(servicesDir, ['.js']);
  const routeFiles = fs.existsSync(routesDir) ? walkFiles(routesDir, ['.js']) : [];
  const allConsumerFiles = [...routeFiles, ...serviceFiles];

  // Build consumer corpus: file -> text (cached)
  const consumerTexts = new Map();
  for (const f of allConsumerFiles) {
    consumerTexts.set(f, readSafe(f));
  }

  const services = [];

  for (const serviceFile of serviceFiles) {
    const text = readSafe(serviceFile);
    const relPath = path.relative(rootDir, serviceFile);
    const exportedFunctions = extractExports(text);
    if (exportedFunctions.length === 0) continue;

    // Find who requires this file
    const serviceBaseName = path.basename(serviceFile, '.js');
    const serviceRelFromRoot = path.relative(rootDir, serviceFile);

    // Build patterns to match require() for this service
    const requirePatterns = buildRequirePatterns(serviceRelFromRoot);

    const usedFunctions = new Set();
    const consumers = []; // files that require this service

    for (const [consumerFile, consumerText] of consumerTexts) {
      if (consumerFile === serviceFile) continue;
      if (!matchesAnyPattern(consumerText, requirePatterns)) continue;

      consumers.push(path.relative(rootDir, consumerFile));

      // Check which exported functions are referenced
      for (const fn of exportedFunctions) {
        // Match: serviceName.fn(), destructured { fn }, or direct fn() calls
        if (consumerText.includes(fn)) {
          usedFunctions.add(fn);
        }
      }
    }

    const unusedFunctions = exportedFunctions.filter(fn => !usedFunctions.has(fn));

    let classification;
    if (KNOWN_USED_SERVICES.has(relPath)) classification = consumers.length === 0 ? 'fully-used' : 'fully-used';
    else if (consumers.length === 0) classification = 'orphan';
    else if (unusedFunctions.length === 0) classification = 'fully-used';
    else if (usedFunctions.size > 0) classification = 'partially-used';
    else classification = 'orphan';

    // Distinguish: used only by other services vs used by routes
    const routeConsumers = consumers.filter(c => c.startsWith('routes/'));
    const serviceConsumers = consumers.filter(c => c.startsWith('src/services/'));
    const scope = routeConsumers.length > 0 ? 'route-facing' : (serviceConsumers.length > 0 ? 'internal-only' : 'orphan');

    services.push({
      file: relPath,
      exportedFunctions,
      usedFunctions: Array.from(usedFunctions),
      unusedFunctions,
      consumers,
      classification,
      scope
    });
  }

  const summary = {
    total: services.length,
    fullyUsed: services.filter(s => s.classification === 'fully-used').length,
    partiallyUsed: services.filter(s => s.classification === 'partially-used').length,
    orphan: services.filter(s => s.classification === 'orphan').length,
    routeFacing: services.filter(s => s.scope === 'route-facing').length,
    internalOnly: services.filter(s => s.scope === 'internal-only').length
  };

  return { services, summary };
}

function extractExports(text) {
  const fns = new Set();

  // module.exports = { fn1, fn2 }
  const objMatch = text.match(/module\.exports\s*=\s*\{([^}]+)\}/);
  if (objMatch) {
    for (const m of objMatch[1].matchAll(/(\w+)/g)) {
      // Skip common non-function keys like _internal, _test
      if (!m[1].startsWith('_')) fns.add(m[1]);
    }
  }

  // module.exports.fn = ...
  for (const m of text.matchAll(/module\.exports\.(\w+)\s*=/g)) {
    if (!m[1].startsWith('_')) fns.add(m[1]);
  }

  // exports.fn = ...
  for (const m of text.matchAll(/(?<!\.)exports\.(\w+)\s*=/g)) {
    if (!m[1].startsWith('_')) fns.add(m[1]);
  }

  // class Foo ... module.exports = Foo  (treat as single default export)
  const classExport = text.match(/module\.exports\s*=\s*(\w+)/);
  if (classExport && !objMatch) {
    const className = classExport[1];
    if (/^[A-Z]/.test(className)) fns.add(className);
  }

  // module.exports = new ClassName() or module.exports = singleton
  const singletonExport = text.match(/module\.exports\s*=\s*new\s+(\w+)/);
  if (singletonExport) fns.add(singletonExport[1]);

  return Array.from(fns);
}

function buildRequirePatterns(serviceRelFromRoot) {
  // Convert src/services/foo.js -> various require patterns
  // routes require: require('../src/services/foo')
  // services require: require('./foo') or require('../services/foo')
  const base = path.basename(serviceRelFromRoot, '.js');
  const dirPart = path.dirname(serviceRelFromRoot).replace(/\\/g, '/');

  return [
    `require('../${dirPart}/${base}')`,
    `require("./${base}")`,
    `require('./${base}')`,
    `require("../services/${base}")`,
    `require('../services/${base}')`,
    `require('./${base}')`,
    // For benchmark sub-modules
    `require('./${path.basename(path.dirname(serviceRelFromRoot))}/${base}')`,
    // With index
    `/${base}'`,
    `/${base}"`,
    `/${base}\``
  ];
}

function matchesAnyPattern(text, patterns) {
  return patterns.some(p => text.includes(p));
}

// ─── B. analyzeModelCoverage ─────────────────────────────────────────

/**
 * Parse mongoose models and trace usage across routes + services.
 */
function analyzeModelCoverage(rootDir) {
  const modelsDir = path.join(rootDir, 'models');
  const servicesDir = path.join(rootDir, 'src', 'services');
  const routesDir = path.join(rootDir, 'routes');

  if (!fs.existsSync(modelsDir)) return { models: [], summary: {} };

  const modelFiles = walkFiles(modelsDir, ['.js']);
  const serviceFiles = fs.existsSync(servicesDir) ? walkFiles(servicesDir, ['.js']) : [];
  const routeFiles = fs.existsSync(routesDir) ? walkFiles(routesDir, ['.js']) : [];
  const allConsumerFiles = [...routeFiles, ...serviceFiles];

  const models = [];

  for (const modelFile of modelFiles) {
    const text = readSafe(modelFile);
    const relPath = path.relative(rootDir, modelFile);
    const baseName = path.basename(modelFile, '.js');

    // Extract mongoose model name
    const modelNameMatch = text.match(/mongoose\.model\s*\(\s*['"](\w+)['"]/);
    const modelName = modelNameMatch ? modelNameMatch[1] : baseName;

    // Find consumers
    const requirePatterns = [
      `../models/${baseName}`,
      `../../models/${baseName}`,
      `./models/${baseName}`,
      `'${baseName}'`
    ];

    const routeConsumers = [];
    const serviceConsumers = [];
    const crudOps = new Set();

    for (const consumerFile of allConsumerFiles) {
      const consumerText = readSafe(consumerFile);
      const isConsumer = requirePatterns.some(p => consumerText.includes(p));
      if (!isConsumer) continue;

      const consumerRel = path.relative(rootDir, consumerFile);
      if (consumerRel.startsWith('routes/')) routeConsumers.push(consumerRel);
      else serviceConsumers.push(consumerRel);

      // Detect CRUD patterns
      if (consumerText.match(new RegExp(`${modelName}\\.(find|findOne|findById)`, 'i'))) crudOps.add('read');
      if (consumerText.match(new RegExp(`${modelName}\\.(create|insertMany|save)`, 'i'))) crudOps.add('create');
      if (consumerText.match(new RegExp(`${modelName}\\.(update|updateOne|updateMany|findByIdAndUpdate|findOneAndUpdate)`, 'i'))) crudOps.add('update');
      if (consumerText.match(new RegExp(`${modelName}\\.(delete|deleteOne|deleteMany|findByIdAndDelete|findOneAndDelete|remove)`, 'i'))) crudOps.add('delete');
      // Also check instance methods like .save()
      if (consumerText.includes('.save(')) crudOps.add('create');
    }

    let classification;
    if (routeConsumers.length > 0) classification = 'route-facing';
    else if (serviceConsumers.length > 0) classification = 'service-only';
    else classification = 'orphan';

    models.push({
      file: relPath,
      modelName,
      classification,
      crudOps: Array.from(crudOps),
      routeConsumers,
      serviceConsumers,
      totalConsumers: routeConsumers.length + serviceConsumers.length
    });
  }

  const summary = {
    total: models.length,
    routeFacing: models.filter(m => m.classification === 'route-facing').length,
    serviceOnly: models.filter(m => m.classification === 'service-only').length,
    orphan: models.filter(m => m.classification === 'orphan').length
  };

  return { models, summary };
}

// ─── C. analyzeDocumentationCoverage ─────────────────────────────────

/**
 * Validate markdown links, find orphaned docs, and cross-reference
 * route modules against documentation mentions.
 */
function analyzeDocumentationCoverage(rootDir) {
  const docsDir = path.join(rootDir, 'docs');
  const routesDir = path.join(rootDir, 'routes');

  // Gather all markdown files: docs/ + root-level
  const docFiles = [];
  if (fs.existsSync(docsDir)) {
    docFiles.push(...walkFiles(docsDir, ['.md']));
  }
  // Root-level .md files
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      docFiles.push(path.join(rootDir, entry.name));
    }
  }

  const brokenLinks = [];
  const allLinkedPaths = new Set();
  const fileLinksMap = new Map(); // filePath -> Set of resolved link targets

  for (const docFile of docFiles) {
    const text = readSafe(docFile);
    const docDir = path.dirname(docFile);
    const links = extractMarkdownLinks(text);

    const linkedFromThis = new Set();

    for (const link of links) {
      // Skip external URLs, anchors-only, and mailto
      if (/^https?:\/\//.test(link.href)) continue;
      if (/^mailto:/.test(link.href)) continue;
      if (link.href.startsWith('#')) continue;

      // Strip anchor from path
      const hrefNoAnchor = link.href.split('#')[0];
      if (!hrefNoAnchor) continue;

      // Resolve relative path
      const resolved = path.resolve(docDir, hrefNoAnchor);
      const relResolved = path.relative(rootDir, resolved);

      allLinkedPaths.add(relResolved);
      linkedFromThis.add(relResolved);

      // Check if target exists (allow cross-repo sibling links that resolve on filesystem)
      if (!fs.existsSync(resolved)) {
        // Suppress cross-repo links (e.g. ../../DataAPI/) that resolve outside the repo
        if (/\.\.\/\.\.\/(DataAPI|AgentC)\//i.test(link.href)) continue;

        brokenLinks.push({
          sourceFile: path.relative(rootDir, docFile),
          linkText: link.text,
          href: link.href,
          resolvedPath: relResolved
        });
      }
    }

    fileLinksMap.set(path.relative(rootDir, docFile), linkedFromThis);
  }

  // Orphaned docs: files not linked from anywhere
  const allDocRelPaths = docFiles.map(f => path.relative(rootDir, f));
  const orphanedDocs = allDocRelPaths.filter(relPath => {
    // A doc is orphaned if no other doc links to it
    // Exception: root-level docs and INDEX.md are entry points
    const base = path.basename(relPath);
    if (['README.md', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'ROADMAP.md', 'INDEX.md'].includes(base)) return false;
    if (!relPath.startsWith('docs/')) return false; // root .md files are entry points

    for (const [, links] of fileLinksMap) {
      if (links.has(relPath)) return false;
    }
    return true;
  });

  // Cross-reference route modules against docs
  const routeFiles = fs.existsSync(routesDir) ? walkFiles(routesDir, ['.js']) : [];
  const docsCorpus = docFiles.map(f => readSafe(f)).join('\n');
  const routeDocCoverage = routeFiles.map(rf => {
    const base = path.basename(rf, '.js');
    const relPath = path.relative(rootDir, rf);
    // Check if route is mentioned in any doc
    const mentioned = docsCorpus.includes(base) || docsCorpus.includes(relPath);
    return { route: relPath, documented: mentioned };
  });

  const undocumentedRoutes = routeDocCoverage.filter(r => !r.documented).map(r => r.route);

  const summary = {
    totalDocs: docFiles.length,
    brokenLinks: brokenLinks.length,
    orphanedDocs: orphanedDocs.length,
    routesDocumented: routeDocCoverage.filter(r => r.documented).length,
    routesUndocumented: undocumentedRoutes.length
  };

  return { brokenLinks, orphanedDocs, undocumentedRoutes, summary };
}

function extractMarkdownLinks(text) {
  const links = [];
  // [text](href) - standard markdown links
  for (const m of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    links.push({ text: m[1], href: m[2].trim() });
  }
  return links;
}

// ─── D. detectUnmountedRoutes ────────────────────────────────────────

/**
 * Cross-reference routes/ files against app.use() mounts in src/app.js.
 * Detect unmounted routes, duplicate mounts, inline routes, and archived routes.
 */
function detectUnmountedRoutes(rootDir) {
  const appJsPath = path.join(rootDir, 'src', 'app.js');
  const routesDir = path.join(rootDir, 'routes');

  if (!fs.existsSync(appJsPath)) return { mounted: [], unmounted: [], duplicates: [], inlineRoutes: [], archived: [], summary: {} };

  const appText = readSafe(appJsPath);
  const routeFiles = fs.existsSync(routesDir) ? walkFiles(routesDir, ['.js']) : [];

  // Parse require() statements in app.js
  const requireMap = new Map(); // varName -> routeFile (relative)
  for (const m of appText.matchAll(/\bconst\s+(\w+)\s*=\s*require\(['"]\.\.\/routes\/([^'"]+)['"]\)/g)) {
    requireMap.set(m[1], m[2]);
  }

  // Parse app.use() mounts
  const mounts = []; // { varName, mountPath, routeFile }
  for (const m of appText.matchAll(/\bapp\.use\(\s*['"]([^'"]+)['"]\s*,\s*(?:\w+\s*,\s*)*(\w+)\s*\)/g)) {
    const mountPath = m[1];
    const varName = m[2];
    const routeFile = requireMap.get(varName);
    if (routeFile) {
      mounts.push({ varName, mountPath, routeFile });
    }
  }

  // Detect duplicate mounts (same route file mounted more than once)
  const mountCounts = new Map();
  for (const mount of mounts) {
    const key = mount.routeFile;
    mountCounts.set(key, (mountCounts.get(key) || 0) + 1);
  }
  const duplicates = Array.from(mountCounts.entries())
    .filter(([routeFile, count]) => count > 1 && !INTENTIONAL_DUAL_MOUNTS.has(routeFile))
    .map(([routeFile, count]) => ({
      routeFile: `routes/${routeFile}.js`,
      mountCount: count,
      mounts: mounts.filter(m => m.routeFile === routeFile).map(m => m.mountPath)
    }));

  // Find unmounted route files
  const mountedFiles = new Set(mounts.map(m => m.routeFile));
  const allRouteNames = routeFiles.map(f => {
    const rel = path.relative(routesDir, f).replace(/\\/g, '/').replace(/\.js$/, '');
    return rel;
  });

  // Check for archived (commented-out) routes
  const archived = [];
  for (const m of appText.matchAll(/\/\/\s*(?:const\s+\w+\s*=\s*)?require\(['"]\.\.\/routes\/([^'"]+)['"]\)/g)) {
    archived.push(`routes/${m[1]}.js`);
  }
  const archivedSet = new Set(archived.map(a => a.replace('routes/', '').replace('.js', '')));

  // Detect sub-router directories: if routes/foo/index.js is mounted,
  // then routes/foo/bar.js is a sub-router, not unmounted
  const mountedDirs = new Set();
  for (const m of mountedFiles) {
    // e.g. "benchmark" is mounted via require('../routes/benchmark') -> routes/benchmark/index.js
    if (allRouteNames.includes(`${m}/index`)) {
      mountedDirs.add(m);
    }
  }

  const mounted = [];
  const unmounted = [];
  const subRouters = [];

  for (const routeName of allRouteNames) {
    if (mountedFiles.has(routeName)) {
      const mount = mounts.find(m => m.routeFile === routeName);
      mounted.push({ file: `routes/${routeName}.js`, mountPath: mount.mountPath });
    } else if (archivedSet.has(routeName)) {
      // Skip, it's in the archived list
    } else {
      // Check if this is a sub-router (e.g. benchmark/analytics under benchmark/)
      const parentDir = routeName.includes('/') ? routeName.split('/')[0] : null;
      if (parentDir && mountedDirs.has(parentDir)) {
        subRouters.push({ file: `routes/${routeName}.js`, parentRouter: `routes/${parentDir}` });
      } else {
        unmounted.push({ file: `routes/${routeName}.js` });
      }
    }
  }

  // Detect inline routes (app.get/post/put/delete directly in app.js)
  const inlineRoutes = [];
  for (const m of appText.matchAll(/\bapp\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g)) {
    inlineRoutes.push({ method: m[1].toUpperCase(), path: m[2] });
  }

  const summary = {
    totalRouteFiles: routeFiles.length,
    mounted: mounted.length,
    unmounted: unmounted.length,
    subRouters: subRouters.length,
    duplicates: duplicates.length,
    archived: archived.length,
    inlineRoutes: inlineRoutes.length
  };

  return { mounted, unmounted, subRouters, duplicates, inlineRoutes, archived, summary };
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  analyzeServiceCoverage,
  analyzeModelCoverage,
  analyzeDocumentationCoverage,
  detectUnmountedRoutes
};
