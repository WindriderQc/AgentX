'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pages = require('../../../public/js/screen-pages');
const { loadServices, createScreenServices, screenPolicy } = require('../screen-services');
const { buildProductNavigation } = require('../../../../shared/productNavigation');
const { productPageConfig } = require('../../../../shared/productPageConfig');
const { screenContext } = require('../screen-context');
const { createReplyChannels, contract } = require('../reply-channels');
const urls = { core: 'https://core.test', benchmark: 'https://core.test/benchmark', rag: 'https://core.test/rag' };
const app = { locals: { publicUrls: urls, agentxProfile: 'full' } };
function response(policy = "default-src 'self'; frame-ancestors 'none'") {
  const headers = new Map([['Content-Security-Policy', policy], ['X-Frame-Options', 'DENY']]);
  return { locals: {}, headers, getHeader: key => headers.get(key), setHeader: (key, value) => headers.set(key, value) };
}

test('the screen catalogue follows every menu destination and preserves configured service prefixes', () => {
  const catalog = createScreenServices({ app, env: {} });
  const menu = buildProductNavigation({ publicUrls: urls }).navItems.flatMap(row => row.children).filter(row => row.href && !row.href.startsWith('/api/'));
  for (const entry of menu) assert.ok(catalog.parse(entry.id), entry.id);
  assert.equal(catalog.url(catalog.parse('rag-search')), '/rag/search?view=screen&from=nestor');
  assert.equal(catalog.url(catalog.parse('profiler')), '/benchmark/profiler?view=screen&from=nestor');
  assert.equal(catalog.url(catalog.parse('iot')), '/data-toolbox?view=screen&from=nestor#iot');
  assert.equal(catalog.mode(catalog.parse('dad')), 'link', 'never duplicate a conversation in a frame');
  assert.equal(catalog.parse('operator-skill'), null, 'a download is not a page');
  assert.equal(createScreenServices({ app: { locals: { publicUrls: urls, agentxProfile: 'demo' } }, env: {} }).parse('dad'), null);
});

test('instance services are opt-in, bounded and never accept credentials, unsafe URLs or duplicate overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-services-')); fs.mkdirSync(path.join(dir, 'config'));
  const file = path.join(dir, 'config/screen-services.json'), env = { AGENTX_INSTANCE_ROOT: dir };
  const write = services => fs.writeFileSync(file, JSON.stringify({ version: 1, services }));
  try {
    assert.deepEqual(loadServices(env), []);
    write([{ id: 'home-assistant', label: 'Home Assistant', href: 'http://home.test:8123', mode: 'frame' }]);
    const services = loadServices(env), catalog = createScreenServices({ app, env });
    assert.equal(services[0].mode, 'link', 'HTTPS conversations cannot frame HTTP services');
    assert.equal(catalog.url(catalog.parse('home-assistant')), 'http://home.test:8123/');
    const channels = createReplyChannels({ allowPages: true, pageCatalog: catalog });
    channels.push('Voici votre maison. <show kind="page">home-assistant url=https://evil.test</show>');
    assert.deepEqual(channels.end().display.map(row => row.body), ['home-assistant']);
    assert.doesNotMatch(channels.end().say, /home-assistant|evil/);
    assert.match(contract({ pages: true, pageCatalog: catalog }), /home-assistant/);
    assert.doesNotMatch(contract({ pages: true, pageCatalog: catalog }), /http:\/\/home/);
    for (const href of ['javascript:alert(1)', '//evil.test', 'https://user:pass@home.test', 'https://home.test?token=abc', 'https://home.test/\\evil']) {
      write([{ id: 'home-assistant', label: 'Home Assistant', href }]); assert.deepEqual(loadServices(env), [], href);
    }
    write([{ id: 'pipeline', label: 'Injected', href: 'https://other.test', mode: 'frame' }]);
    assert.equal(createScreenServices({ app, env }).url(pages.parse('pipeline')), '/pipeline?view=screen&from=nestor');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('frame permission is limited to known HTML pages and exact configured external origins', () => {
  const catalog = createScreenServices({ app, env: {}, services: [{ id: 'example-service', label: 'Example', href: 'https://service.test/ui', mode: 'frame' }] });
  const middleware = screenPolicy(catalog);
  for (const pathname of ['/dad/day', '/finance', '/nerve-center']) {
    const res = response(); middleware({ method: 'GET', path: pathname, query: { view: 'screen' } }, res, () => {});
    assert.equal(res.headers.get('X-Frame-Options'), 'SAMEORIGIN'); assert.equal(res.locals.showNav, false);
    assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'self'/);
  }
  for (const pathname of ['/api/tasks', '/unknown', '/dad']) {
    const res = response(); middleware({ method: 'GET', path: pathname, query: { view: 'screen' } }, res, () => {});
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  }
  const res = response(); middleware({ method: 'GET', path: '/dad', query: {} }, res, () => {});
  assert.match(res.headers.get('Content-Security-Policy'), /frame-src 'self' https:\/\/service.test$/);
  assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
});

test('RAG and Benchmark screen pages allow self framing while APIs and ordinary pages keep their policy', async () => {
  const resolvePublicUrls = async () => urls; resolvePublicUrls.resolveNavigation = async () => [];
  for (const [service, pathname] of [['benchmark', '/profiler'], ['rag', '/search']]) {
    const middleware = productPageConfig({ app: { locals: {} }, resolvePublicUrls, service });
    for (const [query, requestPath, expected] of [[{ view: 'screen' }, pathname, 'SAMEORIGIN'], [{}, pathname, 'DENY'], [{ view: 'screen' }, '/api/tasks', 'DENY'], [{ view: 'screen' }, '/unknown', 'DENY']]) {
      const res = response(); await middleware({ method: 'GET', path: requestPath, query }, res, error => { if (error) throw error; });
      assert.equal(res.headers.get('X-Frame-Options'), expected);
    }
  }
});

test('screen context retains bounded headings and never forwards URLs, forms or unknown pages', () => {
  const catalog = createScreenServices({ app, env: {} });
  const context = screenContext([{ page: 'finance', status: 'visible', title: 'Compte', headings: ['Mes comptes', 'x'.repeat(1000)], password: 'PRIVATE_PASSWORD', url: 'https://evil.test' },
    { page: 'not-configured', status: 'visible', title: 'SECRET' }, { page: 'pipeline', status: 'external', title: 'NOT_OBSERVED' }], catalog);
  assert.match(context, /untrusted reference data/); assert.match(context, /Mes comptes/);
  assert.doesNotMatch(context, /PRIVATE_PASSWORD|evil|SECRET|NOT_OBSERVED/); assert.ok(context.length < 1000);
});

test('late-installed runtime launchers join the same catalogue without fetching their launch URL', () => {
  const app = { locals: { publicUrls: urls } }, catalog = createScreenServices({ app, env: {} });
  assert.equal(catalog.parse('coding-studio'), null);
  app.locals.trustedRuntimeNavItems = [{ id: 'coding-studio', label: 'Coding Studio', href: '/api/studio/launch', icon: 'fa-terminal' }];
  assert.equal(catalog.url(catalog.parse('coding-studio')), '/api/studio/launch');
  assert.equal(catalog.mode(catalog.parse('coding-studio')), 'link');
});

test('page visits require complete Main work even when the guardian can acknowledge them', () => {
  const { requestsScreenVisit } = require('../screen-services');
  const catalog = createScreenServices({ app, env: {}, services: [{ id: 'grafana', label: 'Grafana', href: 'http://service.test' }] });
  for (const text of ['Montre-moi Home Assistant', 'Ouvre Grafana', 'Guide-moi dans les pages AgentX', 'Show my services', 'open the pipeline']) assert.equal(requestsScreenVisit(text, catalog), true, text);
  for (const text of ['Bonjour', 'Raconte une histoire', 'Que signifie le mot page ?']) assert.equal(requestsScreenVisit(text, catalog), false, text);
});
