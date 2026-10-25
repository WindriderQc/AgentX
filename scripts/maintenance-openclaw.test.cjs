'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reloadWithFence } = require('./maintenance-openclaw.cjs');
const { ActionError } = require('./maintenance-actions.cjs');
const target = { pid: 100, ownerId: 'native-owner', port: 18000 };

function setup({ busy = 0, lost = false, health = true, invalidIdle = false, resumeFails = false } = {}) {
  let clock = 0, prepares = 0, dispatched = false;
  const calls = [], saves = [];
  const args = { requestId: 'synthetic-request', waitMs: 10000, healthMs: 4000, target, ActionError,
    now: () => clock, sleep: async ms => { clock += ms; },
    readTarget: async () => dispatched && health ? { ...target, pid: 101, ownerId: 'new-owner' } : target,
    ready: async () => health,
    save: async row => { saves.push(row); },
    rpc: async (method, params) => {
      calls.push({ method, params });
      if (method === 'gateway.suspend.prepare') return { status: prepares++ < busy ? 'draining' : 'ready',
        suspensionId: 'native-fence', activeCount: invalidIdle ? 1 : 0, blockers: [], expiresAtMs: clock + 120000 };
      if (method === 'gateway.suspend.resume') {
        if (resumeFails) throw new Error('Lost resume');
        return { ok: true, status: 'running' };
      }
      assert.equal(saves.at(-1).phase, 'dispatching');
      dispatched = true;
      if (lost) throw new Error('Lost acknowledgement');
      return { ok: true, status: 'emitted', pid: target.pid };
    } };
  return { args, calls, saves };
}

test('renews one native fence while busy, dispatches once only after idle, verifies successor readiness', async () => {
  const { args, calls, saves } = setup({ busy: 2 });
  const result = await reloadWithFence(args);
  assert.equal(result.runtimeReady, true);
  assert.equal(calls.filter(c => c.method === 'gateway.suspend.prepare').length, 3);
  assert.deepEqual(calls.at(-1).params, { reason: 'agentx.reload:synthetic-request', target, restartIntent: { waitMs: 0 } });
  assert.equal(saves.at(-1).phase, 'completed');
});

test('timeout and invalid idle evidence resume native scheduling without any restart', async () => {
  for (const opts of [{ busy: 99 }, { invalidIdle: true }]) {
    const { args, calls, saves } = setup(opts);
    await assert.rejects(reloadWithFence(args), e => e.outcome === 'refused');
    assert.equal(calls.at(-1).method, 'gateway.suspend.resume');
    assert.equal(calls.some(c => c.method === 'gateway.restart.request'), false);
    assert.equal(saves.at(-1).resumed, true);
  }
});

test('lost dispatch response and readiness timeout retain uncertainty without another mutation', async () => {
  for (const opts of [{ lost: true }, { health: false }]) {
    const { args, calls } = setup(opts);
    await assert.rejects(reloadWithFence(args), e => e.outcome === 'unknown');
    assert.equal(calls.filter(c => c.method === 'gateway.restart.request').length, 1);
    assert.equal(calls.some(c => c.method === 'gateway.suspend.resume'), false);
  }
});

test('changed native owner refuses and a failed resume never claims safe restoration', async () => {
  const changed = setup(); changed.args.readTarget = async () => ({ ...target, ownerId: 'other' });
  await assert.rejects(reloadWithFence(changed.args), e => e.outcome === 'refused');
  assert.deepEqual(changed.calls, []);
  const failed = setup({ busy: 99, resumeFails: true });
  await assert.rejects(reloadWithFence(failed.args), e => e.outcome === 'unknown');
});
