'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const diskx = require('../index');
const { allowedForFamilyDevice } = require('../../household/family-device');
const { demoSurfaceDisabled } = require('../../../../shared/agentxRuntimeProfile');

const SHA = 'ab'.repeat(32);
const ROOTS = ['/mnt/datalake', '/mnt/media'];
const MODULE = 'https://graphysx.example/embed/diskx.js';

function app({ env = { DISKX_ROOTS: ROOTS.join(','), DISKX_MODULE_URL: MODULE }, upstream, fetchData } = {}) {
  const server = express();
  const fetches = [];
  diskx.register({
    app: server, express, env,
    fetchData: fetchData || (async () => assert.fail('roots come from DISKX_ROOTS')),
    fetchWithTimeout: async (url) => { fetches.push(url); return upstream(); }
  });
  server.fetches = fetches;
  return server;
}

const js = (body = 'customElements.define("diskx-city", class extends HTMLElement {});') => ({
  ok: true, status: 200, headers: new Map([['content-type', 'text/javascript; charset=utf-8']]), text: async () => body
});

test('the page mounts <diskx-city> with the configured roots and the Toolbox API base', async () => {
  const res = await request(app()).get('/diskx').expect(200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.text, /<diskx-city api-base="\/api\/data-toolbox" roots="\/mnt\/datalake,\/mnt\/media"><\/diskx-city>/);
  assert.match(res.text, /<script type="module" src="\/api\/diskx\/diskx.js"><\/script>/);
  // CSP script-src 'self' with no inline script: every script is a same-origin file.
  assert.doesNotMatch(res.text, /<script(?![^>]*\ssrc=)[^>]*>/);
  assert.doesNotMatch(res.text, /https?:\/\//);
});

test('janitor, group and focus pass to the element only after validation', async () => {
  const res = await request(app()).get(`/diskx?janitor=latest&group=${SHA.toUpperCase()}&focus=/mnt/media/Films/`).expect(200);
  assert.match(res.text, new RegExp(`janitor="latest" group="${SHA}" focus="/mnt/media/Films"`));

  const refused = [
    'janitor=all', 'janitor=latest&run=1', `group=${SHA.slice(1)}`, 'group=xyz',
    'focus=relative/path', 'focus=/mnt/other', 'focus=/mnt/datalakeX', 'focus=/mnt/datalake/../etc',
    'focus=/mnt/datalake//x', 'focus=/mnt/datalake/a%0Ab', 'focus=/mnt/datalake/a,b', `focus=/mnt/datalake/${'a'.repeat(1100)}`
  ];
  for (const query of refused) {
    const answer = await request(app()).get(`/diskx?${query}`);
    assert.equal(answer.status, 400, query);
    assert.doesNotMatch(answer.text, /<diskx-city|<script>alert/, query);
  }
  // A folder name may hold quotes and brackets: it is valid, and escaped.
  const hostile = await request(app()).get('/diskx?focus=' + encodeURIComponent('/mnt/datalake/"><script>alert(1)</script>')).expect(200);
  assert.doesNotMatch(hostile.text, /<script>alert/);
  assert.match(hostile.text, /focus="\/mnt\/datalake\/&quot;&gt;&lt;script&gt;/);
  assert.deepEqual(diskx.checkQuery({ group: [SHA, 'x'] }, ROOTS), { group: SHA }, 'a repeated value takes the first');
  assert.deepEqual(diskx.checkQuery({ focus: '/mnt/datalake' }, ROOTS), { focus: '/mnt/datalake' });
  assert.throws(() => diskx.checkQuery({ focus: '/mnt/datalake/x' }, []), /inside a scanned root/);
});

test('attribute values are escaped in the rendered element', () => {
  const html = diskx.renderPage({ roots: ['/srv/a&b'], attributes: { focus: '/srv/a&b/"<x>' } });
  assert.match(html, /roots="\/srv\/a&amp;b" focus="\/srv\/a&amp;b\/&quot;&lt;x&gt;"/);
});

test('without DISKX_ROOTS the roots are the canonical roots Data declares', async () => {
  const calls = [];
  const fetchData = async (route) => {
    calls.push(route);
    return { response: { ok: true, status: 200 }, body: { data: { sources: {
      media: { canonicalRoot: '/mnt/media' }, lake: { canonicalRoot: '/mnt/datalake/' }, broken: { canonicalRoot: 'relative' }, none: {}
    } } } };
  };
  assert.deepEqual(await diskx.resolveRoots({ env: {}, fetchData }), ['/mnt/media', '/mnt/datalake']);
  assert.deepEqual(calls, ['/api/v1/storage/agents']);
  assert.deepEqual(await diskx.resolveRoots({ env: {}, fetchData: async () => { throw new Error('down'); } }), []);
  // A set but unusable DISKX_ROOTS does not fall back to Data.
  assert.deepEqual(await diskx.resolveRoots({ env: { DISKX_ROOTS: 'relative' }, fetchData: async () => assert.fail('no fallback') }), []);
  // The element requires roots: with none known the page says so and mounts nothing.
  const res = await request(app({ env: {}, fetchData: async () => { throw new Error('down'); } })).get('/diskx?janitor=latest').expect(503);
  assert.doesNotMatch(res.text, /<diskx-city|<script/);
  assert.match(res.text, /DISKX_ROOTS/);
});

test('the module is relayed from Core only when it is JavaScript', async () => {
  let upstream = () => js();
  const server = app({ upstream: () => upstream() });
  const ok = await request(server).get('/api/diskx/diskx.js').expect(200);
  assert.match(ok.headers['content-type'], /application\/javascript/);
  assert.match(ok.text, /diskx-city/);
  assert.deepEqual(server.fetches, [MODULE]);

  // A static host's HTML fallback for a missing file is refused, never relayed.
  upstream = () => ({ ok: true, status: 200, headers: new Map([['content-type', 'text/html']]), text: async () => '<!doctype html>' });
  const html = await request(app({ upstream: () => upstream() })).get('/api/diskx/diskx.js').expect(502);
  assert.equal(html.body.code, 'DISKX_UNAVAILABLE');

  // The real module is ~4.1 MB: this relay alone allows up to 6 MiB.
  assert.equal(diskx.MODULE_MAX_BYTES, 6 * 1024 * 1024);
  const built = 'x'.repeat(4132484);
  upstream = () => js(built);
  assert.equal((await request(app({ upstream: () => upstream() })).get('/api/diskx/diskx.js').expect(200)).text.length, built.length);
  upstream = () => js('x'.repeat(diskx.MODULE_MAX_BYTES + 1));
  assert.equal((await request(app({ upstream: () => upstream() })).get('/api/diskx/diskx.js').expect(502)).body.message, 'Relayed script is too large');

  const unconfigured = await request(app({ env: { DISKX_ROOTS: '/mnt/a' }, upstream: () => assert.fail('no fetch') })).get('/api/diskx/diskx.js').expect(404);
  assert.equal(unconfigured.body.code, 'DISKX_NOT_CONFIGURED');
  assert.throws(() => diskx.diskxModuleUrl({ DISKX_MODULE_URL: 'https://u:p@graphysx.example/x.js' }), /without credentials/);
  assert.throws(() => diskx.diskxModuleUrl({ DISKX_MODULE_URL: 'file:///etc/passwd' }), /http\(s\)/);
});

test('the page assets are served and the status script shows only presentation receipts', async () => {
  const server = app();
  await request(server).get('/assets/diskx/diskx.css').expect(200);
  const page = await request(server).get('/assets/diskx/diskx-page.js').expect(200);
  for (const event of ['diskx-ready', 'diskx-group-shown', 'diskx-error']) assert.match(page.text, new RegExp(`'${event}'`));
  assert.match(page.text, /pas une autorisation/);
  assert.match(page.text, /fetch\('\/api\/diskx\/presentation\?/);
  assert.doesNotMatch(page.text, /method:\s*['"](?:POST|PUT|PATCH|DELETE)/);
});

test('a family-pinned device and the demo profile reach neither the page, the module nor its data', () => {
  const paths = ['/diskx', '/api/diskx/diskx.js', '/assets/diskx/diskx-page.js',
    '/api/data-toolbox/storage/tree', '/api/data-toolbox/janitor/strategy/latest/groups'];
  for (const path of paths) {
    assert.equal(allowedForFamilyDevice({ path, method: 'GET', query: {} }), false, path);
  }
  // The family pages themselves stay open on the pinned device.
  assert.equal(allowedForFamilyDevice({ path: '/panel', method: 'GET', query: {} }), true);
  for (const path of ['/diskx', '/api/diskx/diskx.js']) assert.equal(demoSurfaceDisabled(path), true, path);
});
