'use strict';

// One address serves Core, Benchmark and RAG: Benchmark lives under /benchmark
// and still answers at root for healthchecks, Core and on-host scripts.
const path = require('node:path');
const expressApp = require('../../server');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const { SHARED_ROOT_PATHS, prefixedAssets, unprefixedLiterals, unprefixedPaths }
  = require('../../../shared/testing/pathPrefixChecks');

const PAGES = ['/', '/leaderboard', '/courthouse', '/profiler', '/efficiency-map', '/results-explorer', '/setup'];
let httpHarness;
let api;

beforeAll(async () => {
  httpHarness = await startTestHttpHarness(expressApp, {
    transport: process.platform === 'win32' ? 'pipe' : 'tcp'
  });
  api = httpHarness.request;
  jest.spyOn(require('../../src/helpers/ollamaHostConfig'), 'isConfigured').mockReturnValue(true);
});

afterAll(async () => {
  jest.restoreAllMocks();
  await httpHarness?.close();
});

describe('Benchmark under /benchmark', () => {
  it.each(PAGES)('renders %s at the prefix with every own path prefixed, and still at root', async (page) => {
    const prefixed = await api.get(`/benchmark${page}`).expect(200).expect('Content-Type', /html/);
    expect(unprefixedPaths(prefixed.text, '/benchmark')).toEqual([]);
    for (const asset of prefixedAssets(prefixed.text, '/benchmark')) {
      await api.get(asset).expect(200);
    }
    const root = await api.get(page).expect(200);
    expect(root.text).toBe(prefixed.text);
  });

  it('answers the bare prefix and its APIs, and keeps the root APIs', async () => {
    // The static handler completes a bare prefix with its slash; never elsewhere.
    const bare = await api.get('/benchmark?view=compare');
    expect([bare.status, bare.headers.location]).toEqual([301, '/benchmark/?view=compare']);
    const home = await api.get('/benchmark').redirects(1).expect(200);
    expect(home.text).toContain('data-agentx-surface="benchmark-home"');
    const prefixed = await api.get('/benchmark/api/config/status').expect(200);
    const root = await api.get('/api/config/status').expect(200);
    expect(prefixed.body).toEqual(root.body);
    expect((await api.get('/benchmark/health')).status).toBe((await api.get('/health')).status);
  });

  it.each(['/benchmarkfoo', '/benchmarkfoo/leaderboard', '/benchmark-v2.html', '/benchmarks'])(
    'does not treat %s as the prefix', async (url) => {
      await api.get(url).expect(404);
    }
  );

  it('sends first-run setup to the prefixed page', async () => {
    const config = require('../../src/helpers/ollamaHostConfig');
    config.isConfigured.mockReturnValueOnce(false);
    const previous = process.env.BENCHMARK_HARNESS_ENABLED;
    process.env.BENCHMARK_HARNESS_ENABLED = 'false';
    try {
      const response = await api.get('/benchmark/').expect(302);
      expect(response.headers.location).toBe('/benchmark/setup');
    } finally {
      if (previous === undefined) delete process.env.BENCHMARK_HARNESS_ENABLED;
      else process.env.BENCHMARK_HARNESS_ENABLED = previous;
    }
  });

  // dist/ is built by Core (or copied into the image), not present in a bare checkout.
  it.each(SHARED_ROOT_PATHS.filter(url => !url.startsWith('/dist/')))('still serves the shared layout path %s at root', async (url) => {
    await api.get(url).expect(200);
  });
});

describe('Benchmark browser files', () => {
  it('address every Benchmark route under the prefix', () => {
    const benchmarkRoot = path.join(__dirname, '..', '..');
    expect(unprefixedLiterals({
      roots: [path.join(benchmarkRoot, 'public', 'js'), path.join(benchmarkRoot, 'views')],
      prefix: '/benchmark',
      // First path segments Benchmark routes itself (server.js, public/).
      ownedSegments: ['api', 'css', 'js', 'vendor', 'health', 'public',
        'leaderboard', 'courthouse', 'profiler', 'efficiency-map', 'results-explorer', 'setup'],
      // No exception: Benchmark's own files address no shared path through one
      // of these segments. The two root paths they do use are not Benchmark
      // routes: `/playground` is resolved against Core's public URL
      // (leaderboard-v2/combined-board.js) and `/favicon.svg` is the shared
      // product mark that Core serves at the same path (views/pages/setup.ejs).
      allowed: [],
    })).toEqual([]);
  });

  it('keeps the links Benchmark returns to its pages under the prefix', () => {
    const source = require('node:fs').readFileSync(
      path.join(__dirname, '..', '..', 'src', 'services', 'benchmark', 'judgeReadiness.js'), 'utf8');
    expect(source.match(/href: [^\n]*/g).filter(line => /'\/(?!benchmark\/)/.test(line))).toEqual([]);
  });
});
