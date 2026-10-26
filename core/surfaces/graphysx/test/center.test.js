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

function app({ env = { GRAPHYSX_CENTER_URL: CENTER_URL }, compose = async () => COMPOSED, upstream = { ok: true, type: 'text/javascript', body: HOST_MODULE }, policy = null, receiptWaitMs = 300, registry } = {}) {
  const server = express();
  const composed = [];
  if (policy) server.use((_req, res, next) => { res.set('Content-Security-Policy', policy); next(); });
  const served = center.register({
    app: server, express, env, receiptWaitMs, heartbeatMs: 60_000, ...(registry ? { registry } : {}),
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

    // A decision carries the proposal and the revision after it; the fields of one kind of
    // receipt are refused on the other.
    for (const good of [
      { pageId: stream.pageId, id: 'push-1', status: 'accepted', proposalId: 'Add a lake.@3', revision: 4, commitId: 'commit-0001' },
      { pageId: stream.pageId, id: 'push-1', status: 'discarded', proposalId: 'Add a lake.@3', revision: 3 },
      { pageId: stream.pageId, id: 'push-1', status: 'stale', proposalId: 'Add a lake.@3', revision: 5 },
      { pageId: stream.pageId, id: 'push-1', status: 'rejected', proposalId: 'Add a lake.@3', revision: 3, reason: 'The scene rejected the change.' }
    ]) assert.equal((await receipt(good)).status, 204, JSON.stringify(good).slice(0, 80));
    for (const bad of [
      { pageId: stream.pageId, id: 'push-1', status: 'accepted', revision: 4 },
      { pageId: stream.pageId, id: 'push-1', status: 'accepted', proposalId: 'x', revision: -1 },
      { pageId: stream.pageId, id: 'push-1', status: 'accepted', proposalId: 'x', revision: '4' },
      { pageId: stream.pageId, id: 'push-1', status: 'discarded', proposalId: 'x', revision: 3, stale: false },
      { pageId: stream.pageId, id: 'push-1', status: 'discarded', proposalId: 'x', revision: 3, commitId: 'commit-0001' },
      { pageId: stream.pageId, id: 'push-1', status: 'discarded', proposalId: 'x', revision: 3, reason: 'why' },
      { pageId: stream.pageId, id: 'push-1', status: 'accepted', proposalId: 'x', revision: 3, commitId: '' },
      { pageId: stream.pageId, id: 'push-1', status: 'shown', revision: 3 },
      { pageId: stream.pageId, id: 'push-1', status: 'shown', commitId: 'commit-0001' }
    ]) assert.equal((await receipt(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
    assert.equal(server.registry.pushCount, 0, 'receipts for pushes Core never sent are acknowledged and forgotten');

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
    assert.match(result.structuredContent.followUp, /world_proposal_status/);
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

test('what the person decided reaches Nestor through world_proposal_status, once per push, for pushes Core sent', async () => {
  const server = app();
  const { base, close } = await listen(server);
  try {
    const stream = await openStream(base);
    const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await post(center.STATE_ROUTE, { pageId: stream.pageId, revision: 7, scene: SCENE });
    const status = async (args, id = 9) => (await rpc(server, 'tools/call', { name: center.STATUS_TOOL_NAME, arguments: args }, id)).body.result;

    const before = await status({});
    assert.equal(before.isError, false);
    assert.equal(before.structuredContent.status, 'none');
    assert.match(before.structuredContent.message, /No proposal has been pushed/);

    // Push one: pending until the page answers, shown once it does.
    const first = rpc(server, 'tools/call', { name: center.TOOL_NAME, arguments: { request: 'add a lake' } }, 5);
    const pushed = await stream.next();
    assert.equal((await status({ id: pushed.data.id })).structuredContent.status, 'pending');
    await post(center.RECEIPTS_ROUTE, { pageId: stream.pageId, id: pushed.data.id, status: 'shown', proposalId: 'Add a lake.@7', stale: false });
    assert.equal((await first).body.result.structuredContent.status, 'proposed');
    const shown = (await status({ id: pushed.data.id })).structuredContent;
    assert.equal(shown.status, 'shown');
    assert.equal(shown.decision, null);
    assert.match(shown.message, /has not decided yet/);

    // A decision that is not accepted names no commit; the first decision is the decision.
    await post(center.RECEIPTS_ROUTE, { pageId: stream.pageId, id: pushed.data.id, status: 'accepted', proposalId: 'Add a lake.@7', revision: 8, commitId: 'commit-0001' });
    const accepted = (await status({ id: pushed.data.id })).structuredContent;
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.id, pushed.data.id);
    assert.equal(accepted.intent, 'Add a lake.');
    assert.equal(accepted.expectedRevision, 7);
    assert.deepEqual(accepted.delivery, { status: 'shown', stale: false, proposalId: 'Add a lake.@7' });
    assert.equal(accepted.decision.status, 'accepted');
    assert.equal(accepted.decision.revision, 8);
    assert.equal(accepted.decision.commitId, 'commit-0001');
    assert.match(accepted.decision.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(accepted.message, /revision 8/);
    assert.match(accepted.message, /commit-0001/);
    await post(center.RECEIPTS_ROUTE, { pageId: stream.pageId, id: pushed.data.id, status: 'discarded', proposalId: 'Add a lake.@7', revision: 8 });
    assert.equal((await status({ id: pushed.data.id })).structuredContent.decision.status, 'accepted', 'a push is decided once');

    // Without an id: the most recent push. A discarded one says so and names no commit.
    const second = rpc(server, 'tools/call', { name: center.TOOL_NAME, arguments: { request: 'add birds' } }, 6);
    const pushed2 = await stream.next();
    await post(center.RECEIPTS_ROUTE, { pageId: stream.pageId, id: pushed2.data.id, status: 'shown', proposalId: 'Add a lake.@7', stale: false });
    await second;
    await post(center.RECEIPTS_ROUTE, { pageId: stream.pageId, id: pushed2.data.id, status: 'discarded', proposalId: 'Add a lake.@7', revision: 8 });
    const latest = (await status({})).structuredContent;
    assert.equal(latest.id, pushed2.data.id);
    assert.equal(latest.status, 'discarded');
    assert.equal(latest.decision.commitId, undefined);
    assert.match(latest.message, /Discarded/);
    assert.deepEqual(latest.recent.map((entry) => [entry.id, entry.status]), [[pushed2.data.id, 'discarded'], [pushed.data.id, 'accepted']], 'most recent first');

    // A refused push was never a card: a decision on it is not believed. Stale and rejected are kept as decided.
    const third = rpc(server, 'tools/call', { name: center.TOOL_NAME, arguments: { request: 'a volcano' } }, 7);
    const pushed3 = await stream.next();
    await post(center.RECEIPTS_ROUTE, { pageId: stream.pageId, id: pushed3.data.id, status: 'refused', reason: 'A proposal is already waiting for a decision.' });
    await third;
    await post(center.RECEIPTS_ROUTE, { pageId: stream.pageId, id: pushed3.data.id, status: 'accepted', proposalId: 'x', revision: 9, commitId: 'commit-0002' });
    const refused = (await status({ id: pushed3.data.id })).structuredContent;
    assert.equal(refused.status, 'refused');
    assert.equal(refused.decision, null);
    assert.match(refused.message, /did not show it: A proposal is already waiting/);
    const fourth = rpc(server, 'tools/call', { name: center.TOOL_NAME, arguments: { request: 'dim the lights' } }, 8);
    const pushed4 = await stream.next();
    await post(center.RECEIPTS_ROUTE, { pageId: stream.pageId, id: pushed4.data.id, status: 'shown', proposalId: 'Dim.@7', stale: true });
    await fourth;
    assert.match((await status({ id: pushed4.data.id })).structuredContent.message, /stale card/);
    await post(center.RECEIPTS_ROUTE, { pageId: stream.pageId, id: pushed4.data.id, status: 'stale', proposalId: 'Dim.@7', revision: 9 });
    const stale = (await status({ id: pushed4.data.id })).structuredContent;
    assert.equal(stale.status, 'stale');
    assert.match(stale.message, /moved to revision 9/);

    // A push id Core never sent is unknown, whatever the page said about it; a bad id is an argument error.
    await post(center.RECEIPTS_ROUTE, { pageId: stream.pageId, id: 'push-forged', status: 'accepted', proposalId: 'x', revision: 1 });
    const unknown = (await status({ id: 'push-forged' })).structuredContent;
    assert.equal(unknown.status, 'unknown');
    assert.match(unknown.message, /no record/);
    const bad = await status({ id: '../x' });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error, 'INVALID_ARGUMENTS');

    // Records outlive the page: the tab closing does not erase what the person decided.
    await stream.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(server.registry.size, 0);
    assert.equal((await status({ id: pushed.data.id })).structuredContent.status, 'accepted');
    assert.equal(server.registry.pushCount, 4);
  } finally {
    await close();
  }
});

test('push records are bounded: the oldest is forgotten first and answers unknown', async () => {
  const registry = center.createCenterRegistry({ maxPushes: 2 });
  const server = app({ registry });
  const { base, close } = await listen(server);
  try {
    const stream = await openStream(base);
    await fetch(`${base}${center.STATE_ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageId: stream.pageId, revision: 1, scene: SCENE }) });
    const ids = [];
    for (let index = 0; index < 3; index += 1) {
      const call = rpc(server, 'tools/call', { name: center.TOOL_NAME, arguments: { request: `change ${index}` } }, 20 + index);
      ids.push((await stream.next()).data.id);
      await call;
    }
    assert.equal(registry.pushCount, 2);
    const status = async (id) => (await rpc(server, 'tools/call', { name: center.STATUS_TOOL_NAME, arguments: { id } }, 30)).body.result.structuredContent;
    assert.equal((await status(ids[0])).status, 'unknown');
    assert.equal((await status(ids[1])).status, 'pending');
    assert.equal((await status(ids[2])).status, 'pending');
    assert.equal(center.MAX_PUSHES, 64);
    await stream.close();
  } finally {
    await close();
  }
});

test('both tools are listed once on tools/list and other MCP traffic passes through', async () => {
  const server = app();
  server.post('/mcp', (req, res) => res.json({ jsonrpc: '2.0', id: req.body.id, result: { tools: [{ name: 'add_idea' }] } }));
  const listed = await rpc(server, 'tools/list', {});
  assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ['add_idea', center.TOOL_NAME, center.STATUS_TOOL_NAME]);
  const tool = listed.body.result.tools[1];
  assert.equal(tool._meta['agentx/owner'], 'agentx-graphysx');
  assert.deepEqual(tool.inputSchema.required, ['request']);
  assert.match(tool.description, /nothing is applied until the person presses Apply/);
  const statusTool = listed.body.result.tools[2];
  assert.equal(statusTool.annotations.readOnlyHint, true);
  assert.equal(statusTool.inputSchema.required, undefined, 'the id is optional: no id means the most recent push');
  assert.match(statusTool.description, /accepted in revision N/);
  assert.deepEqual(center.appendTool({ result: { tools: [center.TOOL] } }).result.tools.map((entry) => entry.name), [center.TOOL_NAME, center.STATUS_TOOL_NAME], 'a listing that names one gains only the other');
  assert.deepEqual(center.appendTool({ result: { tools: [...center.TOOLS] } }).result.tools.length, 2, 'never listed twice');
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


function responseRecorder() {
  return { writableEnded: false, destroyed: false, messages: [], write(chunk) { this.messages.push(JSON.parse(chunk.split('data: ')[1].trim())); } };
}

test('an explicit page target never drifts to a more recently active page', async () => {
  let now = 1;
  const registry = center.createCenterRegistry({ now: () => now });
  const first = registry.open(responseRecorder()), second = registry.open(responseRecorder());
  registry.setState(first.id, { revision: 7, scene: SCENE }); now = 2;
  registry.setState(second.id, { revision: 20, scene: { ...SCENE, id: 'other' } });
  const result = await center.callCenterTool({ request: 'add a lake', pageId: first.id }, { registry, compose: async () => COMPOSED, receiptWaitMs: 0 });
  assert.equal(result.isError, false); assert.equal(result.structuredContent.pageId, first.id);
  assert.equal(first.res.messages.length, 1); assert.equal(second.res.messages.length, 0);
  assert.equal(first.res.messages[0].expectedRevision, 7);
  assert.equal(center.readWorldProposalStatus({ id: result.structuredContent.id }, { registry }).pageId, first.id);
});

test('a model reply retains the observed revision when the page changes during composition', async () => {
  const registry = center.createCenterRegistry(), page = registry.open(responseRecorder());
  registry.setState(page.id, { revision: 7, scene: SCENE });
  const result = await center.pushWorldProposal({ request: 'add a lake' }, { registry, receiptWaitMs: 0, compose: async observed => {
    assert.equal(observed.revision, 7); assert.deepEqual(observed.scene, SCENE);
    registry.setState(page.id, { revision: 8, scene: { ...SCENE, label: 'Changed while composing' } });
    return COMPOSED;
  } });
  assert.equal(page.revision, 8); assert.equal(page.res.messages[0].expectedRevision, 7); assert.equal(result.expectedRevision, 7);
});

test('missing, unready or malformed explicit page targets never fall back or start inference', async () => {
  const registry = center.createCenterRegistry(), ready = registry.open(responseRecorder()), unready = registry.open(responseRecorder());
  registry.setState(ready.id, { revision: 7, scene: SCENE }); let calls = 0;
  const deps = { registry, compose: async () => { calls++; return COMPOSED; }, receiptWaitMs: 0 };
  for (const pageId of ['missing-page', unready.id]) {
    const result = await center.callCenterTool({ request: 'add a lake', pageId }, deps);
    assert.equal(result.structuredContent.status, 'no-page');
  }
  for (const pageId of [null, '', 2, 'a'.repeat(65)]) assert.equal((await center.callCenterTool({ request: 'add a lake', pageId }, deps)).isError, true);
  assert.equal(calls, 0); assert.equal(ready.res.messages.length, 0);
});
