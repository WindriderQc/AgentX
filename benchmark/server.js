const { createBrowserOriginGuard } = require('../shared/browserOriginGuard');
const express = require('express');
const path = require('path');
const connectDB = require('./config/db');
const logger = require('./config/logger');
const {
  createCorePublicUrlsResolver,
  getPublicUrls,
} = require('../shared/browserPublicUrls');
const { currentAgentXProfile } = require('../shared/agentxRuntimeProfile');
const { createServiceIdentity } = require('../shared/serviceIdentity');
const { buildEnvStatus, summarizeForLog } = require('../shared/envStatus');
const { registerLocalStyleVendorAssets } = require('../shared/localStyleVendorAssets');
const { admitOllamaTargetResolved } = require('./src/helpers/ollamaTargetAdmission');
const { readBoundedJson } = require('./src/helpers/boundedJsonResponse');

require('dotenv').config({
  path: path.join(__dirname, '.env')
});
const { loadCorePublicConfig } = require('./src/clients/coreApiClient');

const PORT = process.env.PORT || 3081;
// Standalone development is local-only by default. Compose opts into the
// container interface explicitly and publishes it back to host loopback.
const HOST = process.env.HOST || '127.0.0.1';
const SERVICE_VERSION = require('./package.json').version || '0.0.0';

// Global error handlers
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack
  });
});

process.on('uncaughtException', (error) => {
  if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
    logger.debug(`${error.code} ignored (closed connection)`);
    return;
  }
  logger.error('Uncaught Exception', { message: error.message, stack: error.stack });
  setTimeout(() => process.exit(1), 1000);
});

process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

const app = express();
app.locals.publicUrls = getPublicUrls();
app.locals.buildProductNavigation = require('../shared/productNavigation').buildProductNavigation;
app.locals.agentxProfile = currentAgentXProfile();
const resolvePublicUrls = createCorePublicUrlsResolver({
  enabled: process.env.NODE_ENV !== 'test',
  loadCoreConfig: loadCorePublicConfig,
});
// EJS templating — shared layouts from core, local pages
app.set('view engine', 'ejs');
app.set('views', [
  path.join(__dirname, 'views'),
  path.join(__dirname, '..', 'core', 'views')
]);

// Middleware
// Browser pages live under /benchmark; the same routes still answer at root.
app.use(require('../shared/pathPrefix').stripPathPrefix('/benchmark'));
app.use(createBrowserOriginGuard());

// Shared browser controls also consume Core's unified model catalog. Keep the
// request same-origin on standalone Benchmark deployments.
app.get('/api/models/all', async (req, res) => {
  const coreUrl = String(process.env.CORE_URL || 'http://localhost:3080').replace(/\/+$/, '');
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  try {
    const headers = { Accept: req.get('accept') || 'application/json' };
    const response = await fetch(`${coreUrl}/api/models/all${query}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    for (const header of ['content-type', 'cache-control', 'x-require-profiled-models']) {
      const value = response.headers.get(header);
      if (value) res.set(header, value);
    }
    return res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    return res.status(502).json({
      status: 'error',
      code: 'CORE_MODEL_CATALOG_UNAVAILABLE',
      message: error.message,
    });
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Browser-critical libraries are production dependencies served through an
// explicit, immutable allowlist. Never expose node_modules as a static root.
const benchmarkVendorAssets = Object.freeze({
  '/vendor/chart.js/4.4.1/chart.umd.js': path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js')
});

for (const [route, assetPath] of Object.entries(benchmarkVendorAssets)) {
  app.get(route, (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('application/javascript');
    res.sendFile(assetPath);
  });
}

registerLocalStyleVendorAssets(app, path.join(__dirname, 'node_modules'));

// The shared-utils source is copied into /dist by the Benchmark image and its
// relative module import resolves to this legacy-looking URL. Serve only the
// required non-Buddy utility; do not restore the removed generic Buddy proxy.
app.get('/public/js/utils/polling-controller.js', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'core', 'public', 'js', 'utils', 'polling-controller.js'));
});

// Benchmark prompt categories for pages, generated from shared/ (one list).
require('../shared/benchmarkCategories').mountBrowserCategories(app);
// The shared CSV cell rule for page exports, from shared/ as well.
require('../shared/csvCell').mountBrowserCsvCell(app);

// Static files — Benchmark plus an explicit allowlist of shared Core assets.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}model-profiler${path.sep}`)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

require('../shared/sharedCoreAssets').mountSharedCoreAssets(app);

// Core's /api/config is the browser URL authority in the composed platform.
// Standalone Benchmark keeps the environment-driven localhost defaults.
app.use(async (req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !path.extname(req.path)) {
    const publicUrls = await resolvePublicUrls();
    app.locals.publicUrls = publicUrls;
    res.locals.publicUrls = publicUrls;
    // Same validated launchers Core renders, so navigation stays identical.
    res.locals.trustedRuntimeNavItems = await resolvePublicUrls.resolveNavigation();
  }
  next();
});

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'core', 'public', 'img', 'favicon.ico'));
});

// ── Page routes (EJS) ────────────────────────────────────────────────────────

const benchmarkPageView = path.resolve(__dirname, 'views/pages/benchmark');
const leaderboardPageView = path.resolve(__dirname, 'views/pages/leaderboard');
const courthousePageView = path.resolve(__dirname, 'views/pages/courthouse');
const profilerPageView = path.resolve(__dirname, 'views/pages/profiler');
const efficiencyMapPageView = path.resolve(__dirname, 'views/pages/efficiency-map');
const resultsExplorerPageView = path.resolve(__dirname, 'views/pages/results-explorer');
const setupPageView = path.resolve(__dirname, 'views/pages/setup');

app.get('/', (req, res) => {
  const { isConfigured } = require('./src/helpers/ollamaHostConfig');
  const harnessEnabled = String(process.env.BENCHMARK_HARNESS_ENABLED || '').toLowerCase() === 'true';
  if (!isConfigured() && !harnessEnabled) return res.redirect('/benchmark/setup');
  res.render('layouts/main', {
    pageView: benchmarkPageView,
    title: 'Agent X Evaluation — Compare Models',
    service: 'benchmark',
    activePage: 'benchmark',
    bodyClass: 'page-benchmark',
    headCss: [
      '<link rel="stylesheet" href="/benchmark/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/benchmark/css/redesign-components.css">',
      '<link rel="stylesheet" href="/benchmark/css/benchmark-v2-layout.css?v=unbenchmarked-models-20260501">',
      '<link rel="stylesheet" href="/benchmark/css/benchmark-v2-config.css">',
      '<link rel="stylesheet" href="/benchmark/css/benchmark-v2-live.css">',
      '<link rel="stylesheet" href="/benchmark/css/model-evidence-experience.css">'
    ].join('\n'),
    footerJs: '<script type="module" src="/benchmark/js/benchmark-v2/index.js?v=unbenchmarked-models-20260501"></script>\n<script type="module" src="/benchmark/js/benchmark-v2/experience.js"></script>'
  });
});

app.get('/leaderboard', (req, res) => {
  res.render('layouts/main', {
    pageView: leaderboardPageView,
    title: 'Agent X Evaluation — Ranked Models',
    service: 'benchmark',
    activePage: 'leaderboard',
    headCss: [
      '<link rel="stylesheet" href="/benchmark/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/benchmark/css/redesign-components.css">',
      '<link rel="stylesheet" href="/benchmark/css/leaderboard-v2.css">',
      '<link rel="stylesheet" href="/benchmark/css/leaderboard-v2-groups.css">',
      '<link rel="stylesheet" href="/benchmark/css/scoring-profile.css">',
      '<link rel="stylesheet" href="/benchmark/css/model-evidence-experience.css">'
    ].join('\n'),
    footerJs: '<script type="module" src="/benchmark/js/leaderboard-v2/index.js?v=response-shape-20260927"></script>'
  });
});

app.get('/courthouse', (req, res) => {
  res.render('layouts/main', {
    pageView: courthousePageView,
    title: 'Courthouse — The Judge\'s Chambers',
    service: 'benchmark',
    activePage: 'courthouse',
    headCss: [
      '<link rel="stylesheet" href="/benchmark/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/benchmark/css/redesign-components.css">',
      '<link rel="stylesheet" href="/benchmark/css/courthouse-v2-layout.css">',
      '<link rel="stylesheet" href="/benchmark/css/courthouse-v2-detail.css">'
    ].join('\n'),
    footerJs: '<script type="module" src="/benchmark/js/courthouse-v2/index.js?v=fast-hosts-20260503"></script>'
  });
});

app.get('/profiler', (req, res) => {
  res.render('layouts/main', {
    pageView: profilerPageView,
    title: 'Agent X Evaluation — Prepare Models',
    service: 'benchmark',
    activePage: 'profiler',
    headCss: [
      '<link rel="stylesheet" href="/benchmark/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/benchmark/css/redesign-components.css">',
      '<link rel="stylesheet" href="/benchmark/css/model-profiler.css?v=host-telemetry-20260622b">',
      '<link rel="stylesheet" href="/benchmark/css/profiler-experience.css">', '<link rel="stylesheet" href="/benchmark/css/profiler-coverage.css">',
      '<link rel="stylesheet" href="/benchmark/css/context-proposal.css">'
    ].join('\n'),
    footerJs: '<script type="module" src="/benchmark/js/model-profiler/index.js?v=host-telemetry-20260622b"></script>\n<script src="/benchmark/js/model-profiler/recovery.js"></script><script src="/benchmark/js/model-profiler/experience.js"></script><script src="/benchmark/js/model-profiler/coverage.js"></script>'
  });
});

app.get('/efficiency-map', (req, res) => {
  res.render('layouts/main', {
    pageView: efficiencyMapPageView,
    title: 'Efficiency Map — Intelligence per tok/s',
    service: 'benchmark',
    activePage: 'efficiency-map',
    headCss: [
      '<link rel="stylesheet" href="/benchmark/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/benchmark/css/redesign-components.css">',
      '<link rel="stylesheet" href="/benchmark/css/efficiency-map.css">'
    ].join('\n'),
    footerJs: '<script type="module" src="/benchmark/js/efficiency-map/index.js"></script>'
  });
});

app.get('/results-explorer', (req, res) => {
  res.render('layouts/main', {
    pageView: resultsExplorerPageView,
    title: 'Agent X Evaluation — Evidence',
    service: 'benchmark',
    activePage: 'results-explorer',
    bodyClass: 'benchmark-shell',
    headCss: [
      '<link rel="stylesheet" href="/benchmark/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/benchmark/css/redesign-components.css">',
      '<link rel="stylesheet" href="/benchmark/css/results-explorer-layout.css">',
      '<link rel="stylesheet" href="/benchmark/css/results-explorer-components.css">',
      '<link rel="stylesheet" href="/benchmark/css/benchmark-shell.css">',
      '<link rel="stylesheet" href="/benchmark/css/model-evidence-experience.css">',
      '<link rel="stylesheet" href="/benchmark/css/results-qualification-card.css">',
      '<script src="/benchmark/vendor/chart.js/4.4.1/chart.umd.js"></script>'
    ].join('\n'),
    footerJs: [
      '<script src="/benchmark/js/benchmark-categories.global.js"></script>',
      '<script src="/benchmark/js/csv-cell.global.js"></script>',
      '<script src="/benchmark/js/results-explorer.js"></script>',
      '<script src="/benchmark/js/results-explorer-charts.js"></script>',
      '<script src="/benchmark/js/results-explorer-comparison.js"></script>',
      '<script src="/benchmark/js/results-qualification-card.js"></script>',
      '<script src="/benchmark/js/results-explorer-inspector.js"></script>'
    ].join('\n')
  });
});

app.get('/setup', (req, res) => {
  res.render('layouts/main', {
    pageView: setupPageView,
    title: 'AgentX Benchmark — Setup',
    service: 'benchmark',
    activePage: 'setup',
    showNav: false,
    headCss: [
      '<link rel="stylesheet" href="/benchmark/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/benchmark/css/setup.css">'
    ].join('\n'),
    footerJs: '<script type="module" src="/benchmark/js/setup/index.js"></script>'
  });
});

// Health check
app.get('/health', (req, res) => {
  const dbReady = require('mongoose').connection.readyState === 1;
  const status = dbReady ? 'ok' : 'degraded';
  res.status(dbReady ? 200 : 503).json({
    ok: dbReady,
    status,
    ...createServiceIdentity({ service: 'agentx-benchmark', version: SERVICE_VERSION }),
    uptime: process.uptime(),
    db: dbReady ? 'connected' : 'disconnected'
  });
});

// Ollama hosts endpoint — enriched with availability and model lists
app.get('/api/ollama-hosts', async (req, res) => {
  const { getConfiguredHosts, readConfigFile } = require('./src/helpers/ollamaHostConfig');
  const hosts = getConfiguredHosts();

  const enriched = await Promise.all(hosts.map(async (host) => {
    let timeout;
    try {
      const admittedUrl = await admitOllamaTargetResolved(host.url, { configuredHosts: hosts });
      const ctrl = new AbortController();
      timeout = setTimeout(() => ctrl.abort(), 4000);
      const resp = await fetch(`${admittedUrl}/api/tags`, {
        signal: ctrl.signal,
        redirect: 'manual'
      });
      if (!resp.ok) return { ...host, available: false, models: [], modelDetails: [] };
      const data = await readBoundedJson(resp);
      const models = (data.models || []).map(m => m.name);
      const modelDetails = (data.models || []).map(m => ({
        name: m.name,
        size: m.size || 0,
        parameterSize: m.details?.parameter_size || '',
        family: m.details?.family || '',
        quantization: m.details?.quantization_level || ''
      }));
      return { ...host, available: true, models, modelDetails };
    } catch {
      return { ...host, available: false, models: [], modelDetails: [] };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }));

  // Include judge config from config file if available
  const config = readConfigFile();
  const judgeConfig = config?.judge || null;

  res.json({ hosts: enriched, judgeConfig });
});

// Setup wizard routes
app.use('/api/setup', require('./routes/setup'));

// Benchmark API routes
app.use('/api/benchmark', require('./routes/benchmark'));

// Profiler API routes (includes host testing at /api/profiler/hosts/test/*)
app.use('/api/profiler', require('./routes/profiler'));

// Read-only configuration status, aggregated by Core's Nerve Center
app.get('/api/config/status', (_req, res) => res.json(buildEnvStatus({ service: 'benchmark' })));

// Start
async function start() {
  await connectDB();

  // Prompt-library synchronization is an explicit startup mutation. Keeping
  // it out of GET /api/benchmark/prompts preserves safe-method semantics while
  // ensuring a normal service start still presents the canonical library.
  const benchmarkService = require('./src/services/benchmark');
  await benchmarkService.seedPrompts();

  require('./src/services/startupRecovery').startStartupRecovery(app.locals.agentxProfile);

  const server = app.listen(PORT, HOST, () => {
    logger.info(`agentx-benchmark listening on ${HOST}:${PORT}`);
    logger.info(summarizeForLog(buildEnvStatus({ service: 'benchmark' })));
  });
  require('./src/serverShutdown').installShutdown(server);
}

if (require.main === module) {
  start().catch(err => {
    logger.error('Failed to start', { error: err.message });
    process.exit(1);
  });
}

module.exports = app;
