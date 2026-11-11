import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogFingerprint, createCatalogWatcher } from './catalog-watch.mjs';

const tool = (name, description = name) => ({ name, description, inputSchema: { type: 'object' } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), 'condition did not settle');
}

test('fingerprints ignore ordering but include descriptions and schemas', () => {
  assert.equal(catalogFingerprint([tool('a'), tool('b')]), catalogFingerprint([
    { inputSchema: { type: 'object' }, description: 'b', name: 'b' }, tool('a'),
  ]));
  assert.notEqual(catalogFingerprint([tool('a')]), catalogFingerprint([tool('a', 'updated')]));
  assert.notEqual(catalogFingerprint([tool('a')]), catalogFingerprint([
    { ...tool('a'), inputSchema: { type: 'object', additionalProperties: false } },
  ]));
});

test('reads all pages, notifies on addition/change/removal, and does not loop on client discovery', async () => {
  let tools = [tool('a'), tool('b')];
  let notifications = 0;
  let calls = 0;
  const watcher = createCatalogWatcher({
    intervalMs: 10, log: () => {}, notify: () => notifications++,
    request: async message => {
      assert.equal(message.method, 'tools/list');
      calls++;
      const index = Number(message.params?.cursor || 0);
      return { id: message.id, result: {
        tools: tools.slice(index, index + 1),
        ...(index + 1 < tools.length ? { nextCursor: String(index + 1) } : {}),
      } };
    },
  });
  try {
    watcher.start();
    watcher.start();
    await until(() => notifications === 1);
    await until(() => calls >= 6);
    assert.equal(notifications, 1);
    tools.push(tool('c'));
    await until(() => notifications === 2);
    tools[0] = tool('a', 'updated');
    await until(() => notifications === 3);
    tools = [tool('c')];
    await until(() => notifications === 4);
  } finally { watcher.stop(); }
});

test('partial lists and failed reads retain the last good catalogue and recover', async () => {
  let mode = 'ok';
  let notifications = 0;
  let calls = 0;
  const logs = [];
  const watcher = createCatalogWatcher({
    intervalMs: 5, log: text => logs.push(text), notify: () => notifications++,
    request: async message => {
      calls++;
      if (mode === 'error') return { id: message.id, error: { code: -32000 } };
      if (mode === 'cycle') return { id: message.id, result: { tools: [], nextCursor: 'same' } };
      if (mode === 'duplicate') return { id: message.id, result: { tools: [tool('a'), tool('a')] } };
      if (mode === 'mismatch') return { id: 'someone-else', result: { tools: [] } };
      return { id: message.id, result: { tools: [tool('a')] } };
    },
  });
  try {
    watcher.start();
    await until(() => notifications === 1);
    for (const bad of ['error', 'cycle', 'duplicate', 'mismatch']) {
      mode = bad;
      const previous = calls;
      await until(() => calls > previous);
      assert.equal(notifications, 1);
      mode = 'ok';
      const recovered = logs.filter(text => text.includes('recovered')).length;
      await until(() => logs.filter(text => text.includes('recovered')).length > recovered);
      assert.equal(notifications, 1);
    }
  } finally { watcher.stop(); }
});

test('each watcher stays scoped to its own bus and stop aborts only its pending discovery', async () => {
  let tools = [tool('owner')];
  let ownerNotifications = 0;
  let generalNotifications = 0;
  let blockedSignal;
  let block = false;
  const owner = createCatalogWatcher({
    intervalMs: 5, log: () => {}, notify: () => ownerNotifications++,
    request: async (message, signal) => {
      if (block) {
        blockedSignal = signal;
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      }
      return { id: message.id, result: { tools } };
    },
  });
  const general = createCatalogWatcher({
    intervalMs: 5, log: () => {}, notify: () => generalNotifications++,
    request: async message => ({ id: message.id, result: { tools: [tool('general')] } }),
  });
  try {
    owner.start(); general.start();
    await until(() => ownerNotifications === 1 && generalNotifications === 1);
    tools.push(tool('new_owner'));
    await until(() => ownerNotifications === 2);
    assert.equal(generalNotifications, 1);
    block = true;
    await until(() => blockedSignal);
    owner.stop();
    assert.equal(blockedSignal.aborted, true);
    await delay(20);
    assert.equal(ownerNotifications, 2);
    assert.equal(generalNotifications, 1);
  } finally { owner.stop(); general.stop(); }
});
