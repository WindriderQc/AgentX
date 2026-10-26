'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { step, dependencies } = require('../../../../integrations/secretary/objective_campaign.cjs');
function fixture(t, { future = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-campaign-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'objective-reviews/life/v1'); fs.mkdirSync(dir, { recursive: true });
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const objectiveFile = path.join(root, 'objective.json'); write(objectiveFile, { id: 'life', version: 'v1' });
  write(path.join(dir, 'manifest.json'), { objectiveSha256: 'a'.repeat(64) });
  write(path.join(dir, 'coverage.json'), { allTargetTextCovered: false, counts: { sourcesWithGaps: 1 } });
  const config = { id: 'campaign-v1', actor: 'test-operator', core: 'http://core.test', archiveRoot: root,
    objectiveFile, hosts: ['http://host.test:11434'], source: { type: 'coding', ref: 'Synthetic session and issue' },
    maxPages: 10, maxSeconds: 600, estimatedMinutes: 30, publishBudget: 20, when: 'asap', startBefore: '2026-11-01T00:00:00Z' };
  const jobId = '11111111-1111-4111-8111-111111111111', dispatchId = '22222222-2222-4222-8222-222222222222';
  const data = { jobs: [], launches: 0, finishes: 0, publishes: 0, loseBegin: false,
    unit: { LoadState: 'not-found' }, now: new Date('2026-10-26T18:00:00Z') };
  const deps = {
    now: () => data.now,
    queue: async (action, args) => {
      if (action === 'list') return { jobs: data.jobs };
      if (action === 'submit') { const request = JSON.parse(fs.readFileSync(args[1])); data.jobs.push({ ...request, id: jobId, state: 'requested', revision: 1 }); return data.jobs[0]; }
      const job = data.jobs[0];
      if (action === 'show') return job;
      if (action === 'begin-operator') { job.state = 'dispatching'; job.dispatchId = dispatchId; job.revision++;
        if (data.loseBegin) { data.loseBegin = false; throw new Error('lost begin response'); } return job; }
      if (action === 'finish-operator') { data.finishes++; job.state = 'completed'; job.releaseReceipt = { state: 'completed', runtimeReleased: true }; return job; }
      if (action === 'cancel') { job.state = 'cancelled'; job.revision++; return job; }
      throw new Error('unexpected action: ' + action);
    },
    place: async job => { job.state = 'reserved'; job.revision++; job.reservation = {
      start: future ? '2026-10-26T19:00:00Z' : '2026-10-26T18:00:00Z', end: '2026-10-26T19:30:00Z' }; return job; },
    unit: async () => data.unit,
    launch: async () => { data.launches++; data.unit = { LoadState: 'loaded', MainPID: '123', ExecMainCode: '0', ExecMainStatus: '0' }; return { status: 0 }; },
    coordination: async () => ({ maintenance: null, drain: null, workloads: [], inferences: [] }),
    publish: async () => { data.publishes++; return { writes: 0, candidates: 1 }; }
  };
  const terminal = phase => {
    data.unit = { LoadState: 'loaded', MainPID: '0', ExecMainCode: '1', ExecMainStatus: '0' };
    write(path.join(dir, 'status.json'), { phase, queueRequestId: jobId, dispatchId,
      newlyReviewedPages: 10, inferenceCalls: 10, elapsedSeconds: 30 });
  };
  return { config, data, deps, terminal, dir, write };
}
test('one native queue/unit identity survives repeated controller steps', async t => {
  const f = fixture(t);
  assert.equal((await step(f.config, f.deps)).phase, 'running');
  assert.equal((await step(f.config, f.deps)).phase, 'running');
  assert.equal(f.data.jobs.length, 1);
  assert.equal(f.data.launches, 1);
  f.terminal('partial');
  assert.equal((await step(f.config, f.deps)).phase, 'chunk-released');
  assert.equal(f.data.finishes, 1);
  assert.equal((await step(f.config, f.deps)).phase, 'ready');
  assert.equal(f.data.publishes, 1);
});
test('a future Core reservation never launches a worker', async t => {
  const f = fixture(t, { future: true });
  const state = await step(f.config, f.deps);
  assert.equal(state.phase, 'waiting-for-native-window');
  assert.equal(state.nextAt, '2026-10-26T19:00:00Z');
  assert.equal(f.data.launches, 0);
});
test('the native worker reads the controller explicit archive root', t => {
  const f = fixture(t);
  let command;
  const deps = dependencies(f.config, (...args) => { command = args; return { status: 0 }; });
  deps.launch('synthetic.service', { id: 'queue-id', dispatchId: 'dispatch-id' });
  assert.equal(command[0], 'systemd-run');
  const rootFlag = command[1].indexOf('--root');
  assert.ok(rootFlag > 0);
  assert.equal(command[1][rootFlag + 1], f.config.archiveRoot);
});
test('an expired reservation is placed again through Core under the same queue identity', async t => {
  const f = fixture(t, { future: true });
  await step(f.config, f.deps);
  const id = f.data.jobs[0].id;
  f.data.now = new Date('2026-10-26T20:00:00Z');
  let replaced = 0;
  f.deps.place = async job => {
    assert.equal(job.id, id); replaced++;
    return { ...job, revision: job.revision + 1, reservation: { start: '2026-10-26T20:01:00Z', end: '2026-10-26T20:31:00Z' } };
  };
  const result = await step(f.config, f.deps);
  assert.equal(result.phase, 'waiting-for-native-window');
  assert.equal(result.nextAt, '2026-10-26T20:01:00Z');
  assert.equal(replaced, 1); assert.equal(f.data.jobs.length, 1); assert.equal(f.data.launches, 0);
});
test('a conflict while replacing an expired reservation preserves the original queue identity', async t => {
  const f = fixture(t, { future: true }); await step(f.config, f.deps);
  const id = f.data.jobs[0].id; f.data.now = new Date('2026-10-26T20:00:00Z');
  f.deps.place = async () => { throw new Error('native resource remains held'); };
  const result = await step(f.config, f.deps);
  assert.equal(result.phase, 'waiting-for-native-placement');
  assert.match(result.reason, /resource remains held/);
  assert.equal(result.current.queueId, id); assert.equal(f.data.jobs.length, 1); assert.equal(f.data.launches, 0);
});
test('a lost begin response is reconciled by the same Core queue identity', async t => {
  const f = fixture(t); f.data.loseBegin = true;
  await assert.rejects(step(f.config, f.deps), /lost begin/);
  assert.equal((await step(f.config, f.deps)).phase, 'running');
  assert.equal(f.data.jobs.length, 1); assert.equal(f.data.launches, 1);
});
test('a missing systemd identity after launch blocks replacement', async t => {
  const f = fixture(t);
  await step(f.config, f.deps); f.data.unit = { LoadState: 'not-found' };
  assert.equal((await step(f.config, f.deps)).phase, 'uncertain');
  assert.equal(f.data.launches, 1); assert.equal(f.data.finishes, 0);
});
test('an uncertain inference outcome retains its queue and prevents a new chunk', async t => {
  const f = fixture(t); await step(f.config, f.deps); f.terminal('uncertain');
  assert.equal((await step(f.config, f.deps)).phase, 'uncertain');
  assert.equal(f.data.finishes, 0); assert.equal(f.data.jobs.length, 1);
});
test('an active native inference prevents release even after the local worker exits', async t => {
  const f = fixture(t); await step(f.config, f.deps); f.terminal('partial');
  f.deps.coordination = async () => ({ inferences: [{ host: 'host.test' }] });
  assert.equal((await step(f.config, f.deps)).phase, 'waiting-for-native-release');
  assert.equal(f.data.finishes, 0);
});
test('text coverage plus reconciled Core publication completes only the text scope', async t => {
  const f = fixture(t); f.write(path.join(f.dir, 'coverage.json'), { allTargetTextCovered: true, counts: { sourcesWithGaps: 2 } });
  const state = await step(f.config, f.deps);
  assert.equal(state.phase, 'text-scope-complete'); assert.equal(state.remainingGaps, 2);
  assert.equal(state.semanticAcceptance, 'not-established'); assert.equal(state.userConfirmed, false);
  assert.equal(f.data.jobs.length, 0); assert.equal(f.data.publishes, 1);
});
test('a controller deadline starts no new queue request', async t => {
  const f = fixture(t);
  const state = await step(f.config, f.deps, { allowStart: false });
  assert.equal(state.phase, 'controller-drained'); assert.equal(f.data.jobs.length, 0); assert.equal(f.data.launches, 0);
});
test('a deadline cancels an unstarted native booking and retains its cancellation identity', async t => {
  const f = fixture(t, { future: true }); await step(f.config, f.deps);
  const id = f.data.jobs[0].id;
  const state = await step(f.config, f.deps, { allowStart: false });
  assert.equal(state.phase, 'controller-drained'); assert.equal(f.data.jobs[0].state, 'cancelled');
  assert.equal(state.cancelledChunks[0].queueId, id); assert.equal(state.completedChunks.length, 0);
  assert.equal(f.data.launches, 0);
});
test('a lost cancellation reply reconciles the same unstarted booking', async t => {
  const f = fixture(t, { future: true }); await step(f.config, f.deps);
  const queue = f.deps.queue;
  f.deps.queue = async (action, args) => { const result = await queue(action, args); if (action === 'cancel') throw new Error('lost cancellation response'); return result; };
  await assert.rejects(step(f.config, f.deps, { allowStart: false }), /lost cancellation/);
  const state = await step(f.config, f.deps, { allowStart: false });
  assert.equal(state.phase, 'controller-drained'); assert.equal(state.cancelledChunks.length, 1);
  assert.equal(f.data.jobs.length, 1); assert.equal(f.data.launches, 0);
});
test('an admitted chunk drains and publishes after the controller deadline without starting another', async t => {
  const f = fixture(t); await step(f.config, f.deps);
  assert.equal((await step(f.config, f.deps, { allowStart: false })).phase, 'running');
  f.terminal('partial');
  assert.equal((await step(f.config, f.deps, { allowStart: false })).phase, 'chunk-released');
  assert.equal((await step(f.config, f.deps, { allowStart: false })).phase, 'ready');
  assert.equal((await step(f.config, f.deps, { allowStart: false })).phase, 'controller-drained');
  assert.equal(f.data.jobs.length, 1); assert.equal(f.data.launches, 1); assert.equal(f.data.publishes, 1);
});
test('an operator running state observes the same retained worker and can release its exact terminal receipt', async t => {
  const f = fixture(t); await step(f.config, f.deps);
  f.data.jobs[0].state = 'running';
  assert.equal((await step(f.config, f.deps)).phase, 'running');
  assert.equal(f.data.launches, 1);
  f.terminal('partial');
  assert.equal((await step(f.config, f.deps)).phase, 'chunk-released');
  assert.equal(f.data.finishes, 1);
});
test('an operator running state without a retained worker never authorizes another launch', async t => {
  const f = fixture(t); await step(f.config, f.deps);
  f.data.jobs[0].state = 'running'; f.data.unit = { LoadState: 'not-found' };
  const state = await step(f.config, f.deps);
  assert.equal(state.phase, 'uncertain'); assert.match(state.reason, /no retained local worker/);
  assert.equal(f.data.launches, 1);
});
