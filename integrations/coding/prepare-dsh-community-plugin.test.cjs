'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { adaptClient, adaptHost, prepare } = require('./prepare-dsh-community-plugin.cjs');

test('Explorer resolves the current runtime icon exports when rendering', () => {
  const icons = {
    IconChevronLeftOutlineRegular: () => 'left', IconChevronRightOutlineRegular: () => 'right',
    IconCloseOutlineRegular: () => 'close', IconFolderCloseRegular: () => 'folder',
    IconFolderOpenRegular: () => 'open', IconRefreshOutlineRegular: () => 'refresh',
  };
  const client = 'result = [p.IconChevronLeftOutline14(), p.IconChevronRightOutline14(), p.IconCloseOutline16(), p.IconFolderClose16(), p.IconFolderOpen16(), p.IconRefreshOutline16()]';
  const context = vm.createContext({ p: icons });
  vm.runInContext(adaptClient('dsh-client-ui-explorer', client), context);
  assert.deepEqual(Array.from(context.result), ['left', 'right', 'close', 'folder', 'open', 'refresh']);
});

test('Explorer reads the explicitly bound session instead of removed global selection state', () => {
  let registration;
  const ctx = { slots: { inject: (name, callback) => callback(), register: (entry, render) => { registration = { entry, render }; } } };
  const source = 'ctx.slots.inject(`shell.overlay`,()=>ctx.slots.register({name:`shell.overlay`},CM))';
  const CM = props => props.useSessions(state => state.byId[state.current]?.cwd);
  const context = { ctx, CM, m: { jsx: (render, props) => render(props) } };
  vm.runInNewContext(adaptClient('dsh-client-ui-explorer', source), context);
  assert.equal(registration.entry.name, 'conversation.session.header.actions');
  const state = { byId: { active: { cwd: '/workspace/active' }, other: { cwd: '/workspace/other' } } };
  assert.equal(registration.render({ sessionId: 'active', useSessions: select => select(state) }), '/workspace/active');
  assert.equal(registration.render({ sessionId: 'other', useSessions: select => select(state) }), '/workspace/other');
});

test('Marketplace registers on the current settings section without changing its RPC', () => {
  const registrations = [];
  const ctx = { slots: { inject: (slot, callback) => callback(), register: (entry, component) => registrations.push({ entry, component }) } };
  const client = 'ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({name: "settings.plugins.tab", id: "market", label: "插件市场"}, MarketplaceTab));';
  const component = () => '/market';
  vm.runInNewContext(adaptClient('@1e0zj/dsh-plugin-mall', client), { ctx, MarketplaceTab: component });
  assert.equal(registrations[0].entry.name, 'settings.section');
  assert.equal(registrations[0].entry.label, 'Plugin Marketplace');
  assert.equal(registrations[0].component, component);
});

test('Marketplace keeps its handler on native authenticated exact API routes', async () => {
  const { registerFetchRpc } = await import('./dsh-connection-fetch-rpc.mjs');
  const routes = [];
  const ctx = { connection: { fetch: { register: route => routes.push(route) } }, inject: (_, callback) => callback(ctx) };
  const source = `
function registerRpcChannel(ctx, config, token) {
  ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.connection.rpc.handle("/market", handler, {authority: "loopback"});
  });
}
export function apply(ctx) { registerRpcChannel(ctx); }
apply(ctx);`;
  const calls = [];
  const handler = async (endpoint, payload, signal) => { calls.push({ endpoint, payload, signal }); return { ok: true, value: payload }; };
  const parse = value => ({ success: value?.type === 'client-request', data: value });
  const context = { ctx, handler, agentxRpcSchema: { safeParse: parse }, agentxRegisterFetchRpc: registerFetchRpc };
  vm.runInNewContext(adaptHost(source).replace(/^import .*\n/gm, '').replaceAll('export ', ''), context);
  const route = routes.find(route => route.path === '/api/market/installed');
  assert.deepEqual(route.methods, ['POST']);
  assert.equal(route.requestBody, 'buffered');
  const message = { type: 'client-request', rpcId: 'correlated-call', method: 'market/installed', payload: { profile: 'web' } };
  const request = new Request('http://localhost/api/market/installed', { method: 'POST', body: JSON.stringify(message) });
  const response = await route.fetch(request);
  assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'correlated-call', result: { ok: true, value: { profile: 'web' } } });
  assert.equal(calls[0].signal, request.signal);
  const mismatch = new Request(request.url, { method: 'POST', body: JSON.stringify({ ...message, method: 'install' }) });
  assert.equal((await route.fetch(mismatch)).status, 400);
  const malformed = new Request(request.url, { method: 'POST', body: 'not-json' });
  assert.equal((await route.fetch(malformed)).status, 400);
  assert.equal(calls.length, 1);
});

test('Unknown or changed artifacts fail before creating output', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: '@1e0zj/dsh-plugin-mall', version: '0.4.17' }));
  fs.writeFileSync(path.join(source, 'src/client.js'), 'changed artifact');
  const output = path.join(root, 'output');
  assert.throws(() => prepare(source, output), /digest differs/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.readFileSync(path.join(source, 'src/client.js'), 'utf8'), 'changed artifact');
  assert.throws(() => prepare(source, path.join(source, 'output')), /outside the source/);
  fs.symlinkSync(source, path.join(source, 'link'));
  assert.throws(() => prepare(source, output), /without symlinks/);
});
