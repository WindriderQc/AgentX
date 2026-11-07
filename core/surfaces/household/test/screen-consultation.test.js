'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScreenServices } = require('../screen-services');
const { presentationEvidence } = require('../screen-context');
const { createReplyChannels, contract } = require('../reply-channels');
const pages = require('../../../public/js/screen-pages');
const { productPageConfig } = require('../../../../shared/productPageConfig');
const urls = { core: 'https://agentx.test', benchmark: 'https://agentx.test/benchmark', rag: 'https://agentx.test/rag' };
const catalog = createScreenServices({ app: { locals: { publicUrls: urls, agentxProfile: 'full' } }, env: {} });

test('sections are closed tokens on known pages, reconstructed on both sides', () => {
  for (const [page, sections] of Object.entries(pages.SECTIONS)) {
    for (const section of Object.keys(sections)) {
      const target = catalog.parse(`${page} section=${section}`);
      assert.equal(target.focus.section, section);
      assert.equal(new URL(catalog.url(target), urls.core).searchParams.get('section'), section);
      assert.deepEqual(catalog.parse(catalog.canonical(target)), target);
    }
    for (const value of ['#screen-queue', 'body', '../x', 'constructor', 'toString', 'overview=launch']) {
      assert.equal(catalog.parse(`${page} section=${value}`), null);
    }
    assert.equal(catalog.parse(`${page} section=overview section=overview`), null);
  }
  assert.equal(catalog.parse('profiler section=launch'), null);
  assert.equal(catalog.parse('https://arbitrary.test/#screen-queue'), null);
  const custom = pages.createCatalog([{ id: 'constructor', label: 'Service', href: '/service', mode: 'frame' }]);
  assert.equal(custom.parse('constructor section=name'), null);
  assert.equal(catalog.parse('diskx section=overview'), null, 'existing domain focus remains separately owned');
  assert.equal(catalog.url(catalog.parse('pipeline section=attention status=blocked task=812')), '/pipeline?view=screen&from=nestor&section=attention&status=blocked&task=812');
});

test('personal channels accept permitted focus; family never receives these pages', () => {
  const { allowedForFamilyDevice } = require('../family-device');
  for (const body of ['pipeline section=attention', 'analytics section=trend', 'profiler section=hosts', 'cluster-schedule section=queue']) {
    const personal = createReplyChannels({ allowPages: true, pageCatalog: catalog });
    personal.push(`<show kind="page">${body}</show>`);
    assert.deepEqual(personal.end().display.map(row => row.body), [body]);
    assert.equal(catalog.family.parse(body), null);
    const family = createReplyChannels({ allowPages: true, pageCatalog: catalog.family });
    family.push(`<show kind="page">${body}</show>`);
    assert.deepEqual(family.end().display, []);
  }
  for (const path of ['/cluster-schedule', '/benchmark/profiler', '/api/cluster/schedule/timeline', '/benchmark/api/profiler/dashboard']) {
    assert.equal(allowedForFamilyDevice({ method: 'GET', path, query: { view: 'screen' } }), false);
  }
  assert.match(contract({ pages: true, pageCatalog: catalog }), /section=<token>/);
});

test('focus is bounded untrusted observation, never a numeric read receipt', () => {
  const claim = { contract: 'agentx.presentation/v1', id: 'test', revision: 'test', kind: 'page',
    page: 'profiler section=hosts', status: 'visible', headings: ['Baselines des hôtes'],
    focus: { section: 'hosts', status: 'applied', heading: 'h'.repeat(300), selector: 'body' }, read: { data: 'FORGED' } };
  const evidence = presentationEvidence([claim], catalog);
  assert.equal(evidence.focus.heading.length, 160);
  assert.equal(evidence.read.status, 'unavailable');
  assert.equal(evidence.focus.selector, undefined);
  assert.equal(presentationEvidence([{ ...claim, focus: { section: 'models', status: 'applied' } }], catalog).focus, undefined);
  assert.equal(presentationEvidence([{ ...claim, status: 'unavailable' }], catalog).focus, undefined);
});

function appForScreens(publicUrls = urls) {
  const app = express(); app.set('view engine', 'ejs');
  app.use((_req, res, next) => { res.set('X-Frame-Options', 'DENY'); res.set('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'"); next(); });
  const resolvePublicUrls = async () => publicUrls; resolvePublicUrls.resolveNavigation = async () => [];
  app.use('/benchmark', require('../../../../shared/pathPrefix').stripPathPrefix('/benchmark'));
  // The route below represents Benchmark's own path after its prefix strip.
  app.use(productPageConfig({ app, resolvePublicUrls, service: 'benchmark' }));
  require('../../../routes/cluster-screen-page')(app);
  require('../../../../shared/consultationScreen').registerAssets(app);
  app.get('/profiler', require('../../../../benchmark/routes/profiler-screen-page'), (_req, res) => res.send('Full profiler controls'));
  return app;
}
test('screen routes render consultation only and ordinary routes retain their policy', async () => {
  const app = appForScreens();
  for (const path of ['/profiler?view=screen', '/cluster-schedule?view=screen&section=queue']) {
    const response = await request(app).get(path).expect(200);
    assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'self'/);
    assert.match(response.text, /screen-read.js/);
    assert.doesNotMatch(response.text, /<nav|<form|model-profiler\/index|cluster-schedule-controls|data-lane-action|onclick|launch/i);
  }
  await request(app).get('/cluster-schedule?view=calendar').expect(302).expect('Location', '/automations?view=calendar');
  await request(app).get('/profiler').expect(200).expect('X-Frame-Options', 'DENY');
  await request(app).get('/profiler?view=Screen').expect(200).expect('X-Frame-Options', 'DENY');
  await request(appForScreens({ ...urls, benchmark: 'https://other.test/benchmark' })).get('/profiler?view=screen').expect(200).expect('X-Frame-Options', 'DENY');
});

test('Profiler renders using only the shared files and Core views packaged by Benchmark', async () => {
  const root = path.resolve(__dirname, '../../../..');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-screen-package-'));
  try {
    // Match Benchmark's image inputs: all shared files, its own route, and
    // Core layouts/partials. Core pages are deliberately absent from the image.
    fs.cpSync(path.join(root, 'shared'), path.join(stage, 'shared'), { recursive: true });
    for (const directory of ['layouts', 'partials']) fs.cpSync(path.join(root, 'core/views', directory), path.join(stage, 'core/views', directory), { recursive: true });
    fs.mkdirSync(path.join(stage, 'benchmark/routes'), { recursive: true });
    fs.copyFileSync(path.join(root, 'benchmark/routes/profiler-screen-page.js'), path.join(stage, 'benchmark/routes/profiler-screen-page.js'));
    assert.equal(fs.existsSync(path.join(stage, 'core/views/pages')), false);
    const app = express(); app.set('view engine', 'ejs');
    app.use((_req, res, next) => { res.locals.showNav = false; next(); });
    app.get('/profiler', require(path.join(stage, 'benchmark/routes/profiler-screen-page')));
    const response = await request(app).get('/profiler?view=screen').expect(200);
    assert.match(response.text, /Baselines des hôtes/);
    assert.match(response.text, /\/benchmark\/screen-read.js/);
    assert.doesNotMatch(response.text, /<form|<nav|model-profiler\/index/);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
});
