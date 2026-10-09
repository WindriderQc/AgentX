'use strict';

// One address serves Core, Benchmark and RAG: RAG lives under /rag and still
// answers at root for healthchecks, Core and the ingest worker.
const path = require('node:path');
const request = require('supertest');
const app = require('../../app');
const { SHARED_ROOT_PATHS, prefixedAssets, unprefixedLiterals, unprefixedPaths }
  = require('../../../shared/testing/pathPrefixChecks');

const PAGES = ['/', '/documents', '/search', '/upload', '/maintenance'];
const api = request.agent(app);

afterAll((done) => {
  if (api.app.listening) return api.app.close(done);
  return done();
});

describe('RAG under /rag', () => {
  it.each(PAGES)('renders %s at the prefix with every own path prefixed, and still at root', async (page) => {
    const prefixed = await api.get(`/rag${page}`).expect(200).expect('Content-Type', /html/);
    expect(unprefixedPaths(prefixed.text, '/rag')).toEqual([]);
    for (const asset of prefixedAssets(prefixed.text, '/rag')) {
      await api.get(asset).expect(200);
    }
    const root = await api.get(page).expect(200);
    expect(root.text).toBe(prefixed.text);
  });

  it('answers the bare prefix and its APIs, and keeps the root APIs', async () => {
    // The static handler completes a bare prefix with its slash; never elsewhere.
    const bare = await api.get('/rag?source=docs');
    expect([bare.status, bare.headers.location]).toEqual([301, '/rag/?source=docs']);
    const home = await api.get('/rag').redirects(1).expect(200);
    expect(home.text).toContain('data-agentx-surface="rag-home"');
    const prefixed = await api.get('/rag/api/rag/ingestion/policy').expect(200);
    const root = await api.get('/api/rag/ingestion/policy').expect(200);
    expect(prefixed.body.data).toEqual(root.body.data);
    const health = await api.get('/rag/health');
    expect(health.body.service).toBe('agentx-rag');
    expect(health.status).toBe((await api.get('/health')).status);
  });

  it.each(['/ragfoo', '/ragfoo/documents', '/rags', '/rag-documents'])(
    'does not treat %s as the prefix', async (url) => {
      await api.get(url).expect(404);
    }
  );

  // dist/ is built by Core (or copied into the image), not present in a bare checkout.
  it.each(SHARED_ROOT_PATHS.filter(url => !url.startsWith('/dist/')))(
    'still serves the shared layout path %s at root', async (url) => {
      await api.get(url).expect(200);
    }
  );
});

describe('RAG browser files', () => {
  it('address every RAG route under the prefix', () => {
    const ragRoot = path.join(__dirname, '..', '..');
    expect(unprefixedLiterals({
      roots: [path.join(ragRoot, 'public', 'js'), path.join(ragRoot, 'views')],
      prefix: '/rag',
      // First path segments RAG routes itself (app.js, public/).
      ownedSegments: ['api', 'css', 'js', 'health', 'public', 'documents', 'search', 'upload', 'maintenance'],
      // No exception: RAG's own files address no shared path. The shared
      // layout paths (SHARED_ROOT_PATHS) come from Core's templates only.
      allowed: [],
    })).toEqual([]);
  });
});
