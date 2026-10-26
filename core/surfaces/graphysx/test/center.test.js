'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const request = require('supertest');

const graphysx = require('../index');
const center = require('../center');
const { allowedForFamilyDevice } = require('../../household/family-device');
const { demoSurfaceDisabled } = require('../../../../shared/agentxRuntimeProfile');

const CENTER_URL = 'https://graphysx.example/';
const HOST_MODULE = 'export class GraphysXCenterElement extends HTMLElement {}';
const SCENE = { id: 'showroom', label: 'Showroom', entities: [{ id: 'plinth', type: 'box', label: 'Plinth' }] };
const COMPOSED = { ok: true, intent: 'Add a lake.', commands: [{ op: 'spawn', entity: { id: 'lake', type: 'water' } }], model: 'test-model' };

function app({ env = { GRAPHYSX_CENTER_URL: CENTER_URL }, compose = async () => COMPOSED, upstream = { ok: true, type: 'text/javascript', body: HOST_MODULE }, policy = null, receiptWaitMs = 300 } = {}) {
  const server = express();
  const composed = [];
  if (policy) server.use((_req, res, next) => { res.set('Content-Security-Policy', policy); next(); });
  const served = center.register({
    app: server, express, env, receiptWaitMs, heartbeatMs: 60_000,
    checkScene: graphysx.checkScene,
    compose: async (input) => { composed.push(input); return compose(input); },
    fetchWithTimeout: async (url) => {
      server.fetched = url;
      return { ok: upstream.ok, status: upstream.ok ? 200 : 503, headers: new Map([['content-type', upstream.type]]), text: async () => upstream.body };
    }
  });
  server.composed = composed;
  server.registry = served.registry;
  return server;
}

/** An open page stream: the hello, then one event at a time. */
async function openStream(base) {
  const response = await fetch(`${base}${center.EVENTS_ROUTE}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async () => {
    for (;;) {
      const index = buffer.indexOf('\n\n');
      if (index >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (chunk.startsWith(':')) continue;
        const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? null;
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        return { event, data: data ? JSON.parse(data) : null };
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };
  const hello = await next();
  return { response, next, pageId: hello.data.pageId, close: () => reader.cancel() };
}

function listen(server) {
  return new Promise((resolve) => {
    const instance = http.createServer(server);
    instance.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${instance.address().port}`, close: () => new Promise((done) => instance.close(done)) }));
  });
}

// `.then` fires the request at once: supertest is lazy, and a push the tool never sent would wait forever.
const rpc = (server, method, params, id = 1) => request(server).post('/mcp').send({ jsonrpc: '2.0', id, method, params }).then((res) => res);

test('the page frames the configured Center, loads the relayed host module, and allows that one origin as a frame', async () => {
  const server = app({ policy: "default-src 'self'; script-src 'self'" });
  const page = await request(server).get('/graphysx').expect(200);
  assert.ok(page.text.includes('<graphysx-center center="https://graphysx.example/" api-base="/api/graphysx">'));
  assert.ok(page.text.includes(`<script type="module" src="${center.HOST_MODULE_ROUTE}">`));
  assert.equal(page.headers['content-security-policy'], "default-src 'self'; script-src 'self'; frame-src 'self' https://graphysx.example");
  assert.equal(page.headers['cache-control'], 'no-store');

  const module = await request(server).get(center.HOST_MODULE_ROUTE).expect(200);
  assert.equal(module.text, HOST_MODULE);
  assert.equal(server.fetched, 'https://graphysx.example/embed/center-host.js', 'the host module comes from the same build as the Center');
  assert.match(module.headers['content-type'], /javascript/);

  // A policy that already names frame-src gains the origin once; one without a policy is untouched.
  assert.equal(center.allowFrame("default-src 'self'; frame-src 'self'", 'https://g.example'), "default-src 'self'; frame-src 'self' https://g.example");
  assert.equal(center.allowFrame("frame-src https://g.example", 'https://g.example'), 'frame-src https://g.example');
  assert.equal(center.allowFrame(undefined, 'https://g.example'), undefined);
});

test('without GRAPHYSX_CENTER_URL the page says so and nothing is relayed', async () => {
  const server = app({ env: {} });
  const page = await request(server).get('/graphysx').expect(503);
  assert.match(page.text, /GRAPHYSX_CENTER_URL/);
  assert.equal((await request(server).get(center.HOST_MODULE_ROUTE)).status, 404);
  assert.throws(() => center.centerUrl({ GRAPHYSX_CENTER_URL: 'https://u:p@graphysx.example/' }), /without credentials/);
  assert.throws(() => center.centerUrl({ GRAPHYSX_CENTER_URL: 'file:///tmp/x' }), /http\(s\)/);
});

test('an upstream that is not JavaScript never reaches the page as a script', async () => {
  const server = app({ upstream: { ok: true, type: 'text/html', body: '<!doctype html>' } });
  const res = await request(server).get(center.HOST_MODULE_ROUTE).expect(502);
  assert.match(res.body.message, /not answer with JavaScript/);
});

test('a page stream gets a page id; state and receipts are checked and bound to an open page', async () => {
  const server = app();
  const { base, close } = await listen(server);
  try {
    const stream = await openStream(base);
    assert.match(stream.pageId, /^[0-9a-f]{24}$/);
    assert.equal(server.registry.size, 1);
    assert.equal(server.registry.mostRecent(), null, 'no scene reported yet: nothing to compose for');

    const state = (body) => fetch(`${base}${center.STATE_ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await state({ pageId: stream.pageId, revision: 3, scene: SCENE })).status, 204);
    assert.equal(server.registry.mostRecent().revision, 3);
    for (const bad of [
      { pageId: stream.pageId, revision: -1, scene: SCENE },
      { pageId: stream.pageId, revision: 3, scene: { id: 's' } },
      { pageId: stream.pageId, revision: 3, scene: { ...SCENE, entities: [{ id: 'a', type: 'box', label: 'A', transform: {} }] } },
      { pageId: stream.pageId, revision: 3, scene: SCENE, extra: 1 },
      { revision: 3, scene: SCENE }
    ]) assert.equal((await state(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    assert.equal((await state({ pageId: 'nobody', revision: 3, scene: SCENE })).status, 404);

    const receipt = (body) => fetch(`${base}${center.RECEIPTS_ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await receipt({ pageId: stream.pageId, id: 'push-1', status: 'shown', stale: false })).status, 204);
    assert.equal((await receipt({ pageId: stream.pageId, id: 'push-1', status: 'maybe' })).status, 400);
    assert.equal((await receipt({ pageId: stream.pageId, id: '../x', status: 'shown' })).status, 400);
    assert.equal((await receipt({ pageId: 'nobody', id: 'push-1', status: 'shown' })).status, 404);

    await stream.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(server.registry.size, 0, 'a closed stream forgets the page');
  } finally {
    await close();
  }
});

test('Nestor\'s tool composes for the most recent page, pushes on its stream and relays the Center\'s receipt', async () => {
  const server = app();
  const { base, close } = await listen(server);
  try {
    const stream = await openStream(base);
    await fetch(`${base}${center.STATE_ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageId: stream.pageId, revision: 7, scene: SCENE }) });

    const pending = rpc(server, 'tools/call', { name: center.TOOL_NAME, arguments: { request: 'add a lake' } }, 5);
    const pushed = await stream.next();
    assert.equal(pushed.event, 'proposal');
    assert.match(pushed.data.id, /^push-[0-9a-f]{12}$/);
    assert.deepEqual(pushed.data.actor, { id: 'nestor', label: 'Nestor · Core', kind: 'agent' });
    assert.equal(pushed.data.intent, 'Add a lake.');
    assert.deepEqual(pushed.data.commands, COMPOSED.commands);
    assert.equal(pushed.data.expectedRevision, 7, 'composed against the revision the page reported');
    assert.deepEqual(server.composed, [{ request: 'add a lake', revision: 7, scene: SCENE }]);

    await fetch(`${base}${center.RECEIPTS_ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pageId: stream.pageId, id: pushed.data.id, status: 'shown', proposalId: 'Add a lake.@7', stale: false }) });
    const res = await pending;
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 5);
    const result = res.body.result;
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.status, 'proposed');
    assert.equal(result.structuredContent.commandCount, 1);
    assert.equal(result.structuredContent.expectedRevision, 7);
    assert.deepEqual(result.structuredContent.delivery, { status: 'shown', stale: false, proposalId: 'Add a lake.@7' });
    assert.match(result.structuredContent.note, /inert until a person presses Apply/);
    assert.equal(JSON.parse(result.content[0].text).status, 'proposed');

    // A refused receipt is relayed as such; no receipt in time is "unconfirmed", never "shown".
    const refused = rpc(server, 'tools/call', { name: center.TOOL_NAME, arguments: { request: 'add another lake' } }, 6);
    const second = await stream.next();
    await fetch(`${base}${center.RECEIPTS_ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pageId: stream.pageId, id: second.data.id, status: 'refused', reason: 'A proposal is already waiting for a decision.' }) });
    assert.deepEqual((await refused).body.result.structuredContent.delivery, { status: 'refused', reason: 'A proposal is already waiting for a decision.' });

    const silent = await rpc(server, 'tools/call', { name: center.TOOL_NAME, arguments: { request: 'a third' } }, 7);
    await stream.next();
    assert.equal(silent.body.result.structuredContent.delivery.status, 'unconfirmed');

    await stream.close();
  } finally {
    await close();
  }
});

test('with no page open, or a declined composition, the tool says so and proposes nothing', async () => {
  const server = app({ compose: async () => ({ ok: false, reason: 'That asks for a dragon.' }) });
  const none = await rpc(server, 'tools/call', { name: center.TOOL_NAME, arguments: { request: 'add a lake' } });
  assert.equal(none.body.result.structuredContent.status, 'no-page');
  assert.match(none.body.result.structuredContent.message, /\/graphysx/);
  assert.equal(server.composed.length, 0, 'nothing is composed without a page to compose for');

  const { base, close } = await listen(server);
  try {
    const stream = await openStream(base);
    await fetch(`${base}${center.STATE_ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageId: stream.pageId, revision: 1, scene: SCENE }) });
    const declined = await rpc(server, 'tools/call', { name: center.TOOL_NAME, arguments: { request: 'summon a dragon' } });
    assert.deepEqual(declined.body.result.structuredContent, { status: 'declined', page: '/graphysx', reason: 'That asks for a dragon.', model: null });
    await stream.close();
  } finally {
    await close();
  }

  const bad = await rpc(server, 'tools/call', { name: center.TOOL_NAME, arguments: { request: '' } });
  assert.equal(bad.body.result.isError, true);
  assert.equal(bad.body.result.structuredContent.error, 'INVALID_ARGUMENTS');
  const notification = await request(server).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/call', params: { name: center.TOOL_NAME, arguments: { request: 'x' } } });
  assert.equal(notification.status, 204);
});

test('the tool is listed once on tools/list and other MCP traffic passes through', async () => {
  const server = app();
  server.post('/mcp', (req, res) => res.json({ jsonrpc: '2.0', id: req.body.id, result: { tools: [{ name: 'add_idea' }] } }));
  const listed = await rpc(server, 'tools/list', {});
  assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ['add_idea', center.TOOL_NAME]);
  const tool = listed.body.result.tools[1];
  assert.equal(tool._meta['agentx/owner'], 'agentx-graphysx');
  assert.deepEqual(tool.inputSchema.required, ['request']);
  assert.match(tool.description, /nothing is applied until the person presses Apply/);
  assert.deepEqual(center.appendTool({ result: { tools: [center.TOOL] } }).result.tools.length, 1, 'never listed twice');
  const other = await rpc(server, 'tools/call', { name: 'add_idea', arguments: {} });
  assert.deepEqual(other.body.result, { tools: [{ name: 'add_idea' }] }, 'another tool reaches the downstream handler');
});

test('at most eight page streams; the ninth is refused before the response is held open', async () => {
  const server = app();
  const { base, close } = await listen(server);
  try {
    const streams = [];
    for (let index = 0; index < center.MAX_PAGES; index += 1) streams.push(await openStream(base));
    const extra = await fetch(`${base}${center.EVENTS_ROUTE}`);
    assert.equal(extra.status, 429);
    assert.equal((await extra.json()).code, 'GRAPHYSX_CENTER_PAGES_FULL');
    for (const stream of streams) await stream.close();
  } finally {
    await close();
  }
});

test('the page and its routes are full-profile only and refused on a family-pinned device, like DiskX', () => {
  for (const path of ['/graphysx', center.HOST_MODULE_ROUTE, center.EVENTS_ROUTE, center.STATE_ROUTE, center.RECEIPTS_ROUTE]) {
    assert.equal(demoSurfaceDisabled(path, 'GET'), true, path);
    assert.equal(allowedForFamilyDevice({ path, method: 'GET', query: {} }), false, path);
    assert.equal(allowedForFamilyDevice({ path, method: 'POST', query: {} }), false, path);
  }
});
