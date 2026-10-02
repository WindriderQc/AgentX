'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenHold, describe } = require('../public/open-hold');
const household = require('../index');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = hold => ({ ok: true, json: async () => ({ data: { hold } }) });

test('loading seconds advance between replies and through a slow status poll without claiming readiness', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const status = deferred(), labels = [];
  let polls = 0;
  const hold = new OpenHold(snapshot => labels.push(describe(snapshot)), async (_url, options) => options.method === 'GET'
    ? (++polls === 1 ? status.promise : response({ phase: 'resident' })) : response({ phase: 'loading', warm: { elapsedMs: 0 } }));
  await hold.start();
  t.mock.timers.tick(1000);
  assert.match(labels.at(-1), /1s\./);
  t.mock.timers.tick(2000); // The next GET is now pending.
  t.mock.timers.tick(2000);
  assert.match(labels.at(-1), /5s\./);
  assert.equal(hold.snapshot.warm.elapsedMs, 0); // Keep server evidence intact.
  assert.ok(labels.every(label => !label.includes('model ready')));
  status.resolve(response({ phase: 'loading', warm: { elapsedMs: 3000 } }));
  await new Promise(setImmediate);
  assert.match(labels.at(-1), /5s\./); // A delayed sample cannot rewind to 3s.
  await hold.poll();
  assert.match(labels.at(-1), /model ready/);
  const count = labels.length;
  t.mock.timers.tick(1000);
  assert.equal(labels.length, count);
  await hold.release({ watch: false });
});

test('leaving during a slow poll stops the display clock and ignores its late loading result', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const status = deferred(), labels = [];
  const hold = new OpenHold(snapshot => labels.push(describe(snapshot, hold.active)), async (_url, options) => options.method === 'GET'
    ? status.promise : response(options.method === 'POST' ? { phase: 'pending', warm: { elapsedMs: 20000 } } : { pinResident: true }));
  await hold.start();
  t.mock.timers.tick(3000);
  assert.match(labels.at(-1), /23s\./);
  await hold.release({ watch: false });
  const count = labels.length;
  status.resolve(response({ phase: 'loading', warm: { elapsedMs: 0 } }));
  await new Promise(setImmediate);
  t.mock.timers.tick(5000);
  assert.equal(labels.length, count);
  assert.equal(hold.renderTimer, null);
  assert.match(labels.at(-1), /everyday model is ready/);
});

test('the text surface can identify its tab on raw LAN HTTP without randomUUID', () => {
  const sandbox = { module: { exports: {} }, globalThis: {} };
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../public/open-hold'), 'utf8'), sandbox);
  const hold = new sandbox.module.exports.OpenHold(() => {}, async () => {});
  assert.match(hold.clientId, /^tab-/);
});

test('leaving sends release immediately and a late acquisition cannot revive polling or overwrite it', async () => {
  const acquire = deferred(), calls = [];
  const hold = new OpenHold(() => {}, async (url, options) => {
    calls.push({ url, ...options });
    return options.method === 'POST' ? acquire.promise : response({ active: false, pinResident: true });
  });
  const starting = hold.start();
  assert.equal(hold.start(), starting);
  await hold.release({ watch: false });
  assert.deepEqual(calls.map(c => c.method), ['POST', 'DELETE']);
  assert.equal(calls[1].keepalive, true);
  assert.equal(new URL(calls[1].url, 'http://test').searchParams.get('revision'), '2');
  acquire.resolve(response({ active: true, phase: 'loading' }));
  await starting;
  assert.equal(hold.active, false);
  assert.equal(hold.snapshot.pinResident, true);
  assert.equal(hold.timer, null);
});

test('pagehide stops a release response from scheduling more work after visibilitychange', async () => {
  const release = deferred();
  const hold = new OpenHold(() => {}, async (_url, options) => options.method === 'DELETE'
    ? release.promise : response({ active: true, phase: 'resident' }));
  await hold.start();
  const leaving = hold.release();
  await hold.release({ watch: false });
  release.resolve(response({ active: false, pinResident: false }));
  await leaving;
  assert.equal(hold.watching, false);
  assert.equal(hold.timer._destroyed, true);
});

test('an unconfirmed release never claims that restoration succeeded', async () => {
  const hold = new OpenHold(() => {}, async (_url, options) => {
    if (options.method === 'DELETE') throw new Error('offline');
    return response({ active: true });
  });
  await hold.start();
  await hold.release({ watch: false });
  assert.match(describe(hold.snapshot, false), /Could not confirm/);
  assert.match(describe({ pinResident: true }, false), /everyday model is ready/);
  assert.doesNotMatch(describe({ pinResident: true, restoration: { phase: 'waiting' } }, false), /model is ready/);
});

test('quarantine is shown as blocked and stops the turn without waiting or fallback', async () => {
  assert.match(describe({ phase: 'blocked' }), /unavailable until the server is recovered/);
  assert.match(describe({ phase: 'pending', warm: { elapsedMs: 305000 } }), /305s/);
  const { hold } = serverFixture();
  await assert.rejects(hold.waitForResident({ phase: 'blocked' }), { code: 'OPEN_RUNTIME_RECOVERY_REQUIRED', statusCode: 503 });
});

function serverFixture(acquireDelay) {
  let state = { hold: null, phase: 'none', pinResident: true };
  const calls = [];
  const hosts = {
    async acquireHold(request) {
      calls.push('acquire');
      if (acquireDelay) await acquireDelay;
      state = { hold: { holdId: 'h', owner: request.owner, model: request.model }, phase: 'loading' };
      return state;
    },
    async releaseHold() { calls.push('release'); state = { hold: null, phase: 'none' }; return { ...state, released: true }; },
    async getHoldStatus() { return state; },
    async touchHold() { return state; }
  };
  return { calls, hold: household.createOpenLaneHold({ runtimeServices: { hosts }, env: { HOUSEHOLD_PERMISSIVE_PRIMARY_HOST_URL: 'http://inference-host:11434' } }) };
}

test('server orders a release behind its pending acquire and ignores delayed older requests', async () => {
  const delay = deferred();
  const { hold, calls } = serverFixture(delay.promise);
  const acquiring = hold.browser('acquire', { clientId: 'a', revision: 1 });
  await Promise.resolve();
  const releasing = hold.browser('release', { clientId: 'a', revision: 2 });
  delay.resolve();
  await Promise.all([acquiring, releasing]);
  assert.deepEqual(calls, ['acquire', 'release']);
  assert.equal((await hold.status()).active, false);
  await hold.browser('acquire', { clientId: 'a', revision: 1 });
  assert.deepEqual(calls, ['acquire', 'release']);
});

test('leaving one live tab preserves the hold until the final tab leaves', async () => {
  const { hold, calls } = serverFixture();
  await hold.browser('acquire', { clientId: 'a', revision: 1 });
  await hold.browser('acquire', { clientId: 'b', revision: 1 });
  assert.equal((await hold.browser('release', { clientId: 'a', revision: 2 })).active, true);
  assert.equal(calls.includes('release'), false);
  await hold.browser('release', { clientId: 'b', revision: 2 });
  assert.equal(calls.at(-1), 'release');
});

test('a disconnected turn releases an acquisition that completes after cancellation', async () => {
  const delay = deferred();
  const { hold, calls } = serverFixture(delay.promise);
  const controller = new AbortController();
  const refreshing = hold.touch({ signal: controller.signal });
  controller.abort(); delay.resolve();
  await refreshing;
  assert.deepEqual(calls, ['acquire', 'release']);
  assert.equal((await hold.status()).active, false);
});
