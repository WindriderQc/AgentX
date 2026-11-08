'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const registry = require('../coding-executor-registry');
const { CodingDispatchControl } = require('../coding-dispatch-control');
const original = '10000000-0000-4000-8000-000000000001';
const fresh = '20000000-0000-4000-8000-000000000002';
const executors = [
  { id: 'archive', harness: 'dsh', sshTarget: 'worker@archive', priority: 1, acceptNewWork: false },
  { id: 'candidate', harness: 'opencode', sshTarget: 'worker@candidate', priority: 2 }
];
function fixture({ candidateBusy = false, archiveUnreadable = false, originalReplyId = original, rows = executors } = {}) {
  const calls = [];
  const control = new CodingDispatchControl({ executors: rows, sshRunner: async (target, command) => {
    calls.push({ target, command });
    const archived = target === 'worker@archive';
    if (archived && archiveUnreadable) throw new Error('Uncertain original host');
    if (command.includes(' status')) return { stdout: JSON.stringify({ status: 'success', data: {
      harness: archived ? 'dsh' : 'opencode', available: true, busy: !archived && candidateBusy,
      candidates: [{ pipelineId: '0700' }],
      ...(command.endsWith(original) ? { run: { requestId: archived ? originalReplyId : original, phase: archived ? 'finished' : 'not_received' } }
        : command.endsWith(fresh) ? { run: { requestId: fresh, phase: 'not_received' } } : {})
    } }) };
    return { stdout: JSON.stringify({ status: 'success', data: { accepted: true,
      run: { requestId: command.includes(fresh) ? fresh : original, phase: 'finished' } } }) };
  } });
  return { control, calls };
}

test('admission defaults on and malformed drain configuration refuses', () => {
  assert.equal(registry.normalize(executors[1], 0).acceptNewWork, true);
  assert.equal(registry.publicExecutor(registry.normalize(executors[0], 0)).acceptNewWork, false);
  for (const acceptNewWork of ['false', 0, null]) assert.throws(() =>
    registry.normalize({ ...executors[0], acceptNewWork }, 0), /admission setting/);
});

test('draining executors stay visible but supply no new candidates or automatic fallback', async () => {
  const { control } = fixture();
  const status = await control.status();
  assert.deepEqual(status.executors.map(x => x.id), ['archive', 'candidate']);
  assert.equal(status.executors[0].acceptNewWork, false);
  assert.deepEqual(status.candidates.map(x => x.executorId), ['candidate']);
  for (const profile of ['code', 'report', 'autonomous']) {
    assert.equal((await control.select({ profile })).id, 'candidate');
    assert.equal((await control.owner({ requestId: fresh }, profile)).id, 'candidate');
  }
  await assert.rejects(fixture({ candidateBusy: true }).control.select(), error => error.code === 'CODING_DISPATCH_BUSY');
});

test('explicit new work on a draining executor refuses before launch', async () => {
  const { control, calls } = fixture();
  await assert.rejects(control.launch({ pipelineId: '0700', requestId: fresh, expectedAttemptCount: 0,
    confirm: true, executorId: 'archive' }), error => error.code === 'CODING_EXECUTOR_DRAINING');
  await assert.rejects(control.select({ executorId: 'archive' }), error => error.code === 'CODING_EXECUTOR_DRAINING');
  assert.ok(calls.every(x => x.command.includes(' status')));
});

test('original receipts retain their executor for reads, selection and recovery replay', async () => {
  const { control, calls } = fixture();
  const status = await control.status({ requestId: original });
  assert.equal(status.run.executorId, 'archive');
  assert.deepEqual(status.candidates, []);
  assert.equal((await control.owner({ requestId: original }, 'code')).id, 'archive');
  assert.equal((await control.select({ requestId: original })).id, 'archive');
  const replay = await control.launch({ pipelineId: '0700', requestId: original, expectedAttemptCount: 0,
    confirm: true, executorId: 'archive' });
  assert.equal(replay.run.executorId, 'archive');
  assert.equal(calls.at(-1).target, 'worker@archive');
});

test('an unreadable original executor never permits a new owner for the same identity', async () => {
  const { control, calls } = fixture({ archiveUnreadable: true });
  await assert.rejects(control.owner({ requestId: original }, 'code'), error => error.code === 'CODING_DISPATCH_OUTCOME_UNKNOWN');
  assert.ok(calls.every(x => x.command.includes(' status')));
});

test('explicit read/stop control still reaches a draining executor before a launch receipt exists', async () => {
  const { control, calls } = fixture();
  assert.equal((await control.owner({ requestId: fresh, executorId: 'archive' })).id, 'archive');
  const stopped = await control.cancel({ pipelineId: '0700', requestId: fresh, executorId: 'archive' });
  assert.equal(stopped.run.requestId, fresh);
  assert.equal(calls.at(-1).target, 'worker@archive');
  assert.ok(calls.at(-1).command.includes(' cancel-waiting '));
});

test('a mismatched native receipt never grants a draining executor a fresh launch', async () => {
  const { control, calls } = fixture({ originalReplyId: fresh });
  await assert.rejects(control.owner({ requestId: original }, 'code'), error => error.code === 'CODING_DISPATCH_OUTCOME_UNKNOWN');
  await assert.rejects(control.launch({ pipelineId: '0700', requestId: original, expectedAttemptCount: 0,
    confirm: true, executorId: 'archive' }), error => error.code === 'CODING_DISPATCH_OUTCOME_UNKNOWN');
  assert.ok(calls.every(x => x.command.includes(' status')));
});

test('a sole visible draining executor remains readable but cannot accept new work', async () => {
  const { control } = fixture({ rows: [executors[0]] });
  assert.equal((await control.status()).available, false);
  assert.equal((await control.status({ requestId: original })).run.executorId, 'archive');
  await assert.rejects(control.owner({ requestId: fresh }), error => error.code === 'CODING_DISPATCH_BUSY');
});
