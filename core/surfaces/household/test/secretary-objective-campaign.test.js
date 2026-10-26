'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { step, dependencies } = require('../../../../integrations/secretary/objective_campaign.cjs');
const { watch } = require('../../../../integrations/secretary/objective_watch.cjs');
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
      if (action === 'submit') { const request = JSON.parse(fs.readFileSync(args[1]));
        const id = data.jobs.length ? `11111111-1111-4111-8111-${String(data.jobs.length + 1).padStart(12, '0')}` : jobId;
        data.jobs.push({ ...request, id, state: 'requested', revision: 1 }); return data.jobs.at(-1); }
      const job = data.jobs.find(row => row.id === args[1]) || data.jobs[0];
      if (action === 'show') return job;
      if (action === 'begin-operator') { job.state = 'dispatching'; job.dispatchId = dispatchId; job.revision++;
        if (data.loseBegin) { data.loseBegin = false; throw new Error('lost begin response'); } return job; }
      if (action === 'finish-operator') { data.finishes++;
        const receipt = JSON.parse(fs.readFileSync(args[args.indexOf('--file') + 1]));
        job.state = receipt.state; job.releaseReceipt = { state: receipt.state, runtimeReleased: true }; return job; }
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
    write(path.join(dir, 'status.json'), { phase, queueRequestId: data.jobs.at(-1)?.id || jobId, dispatchId,
      newlyReviewedPages: 10, inferenceCalls: 10, elapsedSeconds: 30 });
  };
  return { config, data, deps, terminal, dir, write };
}
function reviewOnly(t, options) {
  const f = fixture(t, options); f.config.publicationMode = 'review-only';
  f.write(path.join(f.dir, 'findings.json'), [{ id: 'unreviewed-proposal', userConfirmed: false }]);
  f.write(path.join(f.dir, 'coverage.json'), { allTargetTextCovered: false, allTargetTextReviewed: false,
    counts: { extractedMoments: 14, sourcesWithGaps: 2, sourcesPendingMaterialization: 10, pendingPagesKnown: 8 } });
  f.deps.publish = async () => { f.data.publishes++; throw new Error('review-only must never enter the publisher'); };
  return f;
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
test('review-only completes admitted chunks and keeps reading with durable unpublished proposals', async t => {
  const f = reviewOnly(t);
  await step(f.config, f.deps); f.terminal('partial');
  assert.equal((await step(f.config, f.deps)).phase, 'chunk-released');
  const ready = await step(f.config, f.deps);
  assert.equal(ready.phase, 'ready'); assert.equal(ready.publication.writes, 0);
  assert.equal(ready.proposalReview.availableCandidates, 14);
  assert.equal(ready.proposalReview.coreHistoryWritesByController, 0);
  assert.equal(ready.semanticAcceptance, 'not-established'); assert.equal(ready.userConfirmed, false);
  f.data.unit = { LoadState: 'not-found' };
  assert.equal((await step(f.config, f.deps)).phase, 'running');
  assert.equal(f.data.jobs.length, 2); assert.equal(f.data.launches, 2); assert.equal(f.data.publishes, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'findings.json'))).length, 1);
});
test('review-only resumes a publication-pending checkpoint without invoking the publisher', async t => {
  const f = reviewOnly(t); await step(f.config, f.deps); f.terminal('partial');
  await step(f.config, f.deps); await step(f.config, f.deps);
  const file = path.join(f.dir, 'campaigns', f.config.id, 'state.json');
  const checkpoint = JSON.parse(fs.readFileSync(file)); checkpoint.phase = 'publication-pending';
  f.write(file, checkpoint);
  const result = await step(f.config, f.deps, { allowStart: false });
  assert.equal(result.phase, 'controller-drained'); assert.equal(result.publication.writes, 0);
  assert.equal(f.data.publishes, 0); assert.equal(f.data.jobs.length, 1);
});
test('review-only text completion retains proposals and never claims semantic acceptance', async t => {
  const f = reviewOnly(t);
  f.write(path.join(f.dir, 'coverage.json'), { allTargetTextCovered: true, allTargetTextReviewed: false,
    counts: { extractedMoments: 14, reviewedPages: 3, equivalentPages: 2, sourcesWithGaps: 2 } });
  const result = await step(f.config, f.deps);
  assert.equal(result.phase, 'text-scope-complete'); assert.equal(result.publication.writes, 0);
  assert.equal(result.proposalReview.availableCandidates, 14);
  assert.equal(result.textualCoverage.counts.reviewedPages, 3);
  assert.equal(result.textualCoverage.counts.equivalentPages, 2);
  assert.equal(result.textualCoverage.allTargetTextReviewed, false);
  assert.equal(result.semanticAcceptance, 'not-established'); assert.equal(result.userConfirmed, false);
  assert.equal(f.data.publishes, 0); assert.equal(f.data.jobs.length, 0);
});
test('review-only exhausted text gaps and pre-admission drain retain every proposal without publication', async t => {
  const exhausted = reviewOnly(t);
  exhausted.write(path.join(exhausted.dir, 'coverage.json'), { allTargetTextCovered: false,
    counts: { extractedMoments: 14, sourcesPendingMaterialization: 0, pendingPagesKnown: 0, sourcesWithGaps: 2, sourceErrors: 1 } });
  const held = await step(exhausted.config, exhausted.deps);
  assert.equal(held.phase, 'needs-source-review'); assert.equal(held.proposalReview.availableCandidates, 14);
  assert.equal(exhausted.data.publishes, 0); assert.equal(exhausted.data.jobs.length, 0);
  const drained = reviewOnly(t);
  const result = await step(drained.config, drained.deps, { allowStart: false });
  assert.equal(result.phase, 'controller-drained'); assert.equal(drained.data.publishes, 0);
  assert.equal(drained.data.jobs.length, 0);
});
test('review-only future booking cancellation and active-worker drain cannot publish candidates', async t => {
  const future = reviewOnly(t, { future: true }); await step(future.config, future.deps);
  assert.equal((await step(future.config, future.deps, { allowStart: false })).phase, 'controller-drained');
  assert.equal(future.data.jobs[0].state, 'cancelled'); assert.equal(future.data.publishes, 0);
  const active = reviewOnly(t); await step(active.config, active.deps);
  assert.equal((await step(active.config, active.deps, { allowStart: false })).phase, 'running');
  active.terminal('partial'); await step(active.config, active.deps, { allowStart: false });
  assert.equal((await step(active.config, active.deps, { allowStart: false })).phase, 'ready');
  assert.equal((await step(active.config, active.deps, { allowStart: false })).phase, 'controller-drained');
  assert.equal(active.data.publishes, 0); assert.equal(active.data.jobs.length, 1);
});
test('publication mode is validated and changing it cannot mutate an existing campaign identity', async t => {
  const invalid = fixture(t); invalid.config.publicationMode = 'reviewonly';
  await assert.rejects(step(invalid.config, invalid.deps), /publicationMode/);
  assert.equal(invalid.data.jobs.length, 0); assert.equal(invalid.data.publishes, 0);
  const legacy = fixture(t); await step(legacy.config, legacy.deps);
  legacy.config.publicationMode = 'review-only';
  await assert.rejects(step(legacy.config, legacy.deps), /configuration changed/);
  assert.equal(legacy.data.jobs.length, 1); assert.equal(legacy.data.publishes, 0);
});
test('review-only keeps the existing pilot output gate after native release', async t => {
  const f = reviewOnly(t); f.config.reviewBeforePublication = true;
  await step(f.config, f.deps); f.terminal('partial'); await step(f.config, f.deps);
  const result = await step(f.config, f.deps);
  assert.equal(result.phase, 'awaiting-output-review'); assert.equal(f.data.publishes, 0);
  assert.equal((await step(f.config, f.deps)).phase, 'awaiting-output-review');
  assert.equal(f.data.jobs.length, 1);
});
test('a real review-only watch advances two native chunks and ends with separate text/proposal counters', async t => {
  const f = reviewOnly(t); let waits = 0;
  const result = await watch(f.config, { until: '2026-10-26T18:10:00Z', pollSeconds: 15 }, {
    now: () => f.data.now, step: (config, flags) => step(config, f.deps, flags),
    wait: async () => {
      waits++; f.data.now = new Date(f.data.now.getTime() + 1000);
      if ([1, 4].includes(waits)) f.terminal('partial');
      if (waits === 3) f.data.unit = { LoadState: 'not-found' };
      if (waits === 4) f.write(path.join(f.dir, 'coverage.json'), { allTargetTextCovered: true,
        allTargetTextReviewed: false, counts: { extractedMoments: 14, reviewedPages: 3, equivalentPages: 2 } });
      assert.ok(waits <= 8, 'watch must not loop on unpublished proposals');
    }
  });
  assert.equal(result.phase, 'text-scope-complete'); assert.equal(result.exitCode, 0);
  assert.equal(result.publicationMode, 'review-only'); assert.equal(result.completedChunks, 2);
  assert.equal(result.proposalReview.availableCandidates, 14); assert.equal(result.proposalReview.coreHistoryWritesByController, 0);
  assert.equal(result.textualCoverage.counts.reviewedPages, 3); assert.equal(result.semanticAcceptance, 'not-established');
  assert.equal(result.userConfirmed, false); assert.equal(f.data.jobs.length, 2);
  assert.equal(f.data.launches, 2); assert.equal(f.data.publishes, 0);
});
test('review-only errors and uncertain native results retain their status without a publication call', async t => {
  for (const phase of ['source-error', 'validation-error', 'uncertain']) {
    const f = reviewOnly(t); await step(f.config, f.deps); f.terminal(phase);
    const result = await step(f.config, f.deps);
    assert.equal(result.phase, phase === 'uncertain' ? 'uncertain' : 'needs-source-review');
    assert.equal(result.semanticAcceptance, 'not-established'); assert.equal(result.userConfirmed, false);
    if (phase !== 'uncertain') assert.equal((await step(f.config, f.deps)).phase, 'needs-source-review');
    assert.equal(f.data.publishes, 0); assert.equal(f.data.jobs.length, 1);
  }
});
test('review-only signal drain through the real watcher ends without publication or another request', async t => {
  const f = reviewOnly(t); let stop = false;
  const result = await watch(f.config, { until: '2026-10-26T18:10:00Z', pollSeconds: 15 }, {
    now: () => f.data.now, stopRequested: () => stop, step: (config, flags) => step(config, f.deps, flags),
    wait: async () => { stop = true; f.terminal('partial'); }
  });
  assert.equal(result.phase, 'controller-drained'); assert.equal(result.proposalReview.availableCandidates, 14);
  assert.equal(result.proposalReview.coreHistoryWritesByController, 0); assert.equal(result.userConfirmed, false);
  assert.equal(f.data.jobs.length, 1); assert.equal(f.data.publishes, 0);
});
test('explicit candidate publication mode retains the legacy native importer behavior', async t => {
  const f = fixture(t); f.config.publicationMode = 'publish-candidates';
  await step(f.config, f.deps); f.terminal('partial'); await step(f.config, f.deps);
  assert.equal((await step(f.config, f.deps)).phase, 'ready'); assert.equal(f.data.publishes, 1);
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
test('materialized targets with no remaining pages and incomplete text coverage stop without empty chunks', async t => {
  const f = fixture(t); f.write(path.join(f.dir, 'coverage.json'), { allTargetTextCovered: false,
    counts: { sourcesPendingMaterialization: 0, pendingPagesKnown: 0, sourcesWithGaps: 1, sourceErrors: 0 } });
  const state = await step(f.config, f.deps);
  assert.equal(state.phase, 'needs-source-review'); assert.equal(state.remainingGaps, 1);
  assert.equal(state.semanticAcceptance, 'not-established'); assert.equal(state.userConfirmed, false);
  assert.equal(f.data.jobs.length, 0); assert.equal(f.data.launches, 0); assert.equal(f.data.publishes, 1);
});
test('already acquired candidates publish before an exhausted unreadable text scope stops', async t => {
  const f = fixture(t); f.write(path.join(f.dir, 'coverage.json'), { allTargetTextCovered: false,
    counts: { sourcesPendingMaterialization: 0, pendingPagesKnown: 0, sourcesWithGaps: 2 } });
  let writes = 1;
  f.deps.publish = async () => ({ writes: writes-- > 0 ? 1 : 0, candidates: 1 });
  assert.equal((await step(f.config, f.deps)).phase, 'publication-pending');
  assert.equal((await step(f.config, f.deps)).phase, 'needs-source-review');
  assert.equal(f.data.jobs.length, 0); assert.equal(f.data.launches, 0);
});
test('a bounded pilot adopts one reviewed native request without creating another queue identity', async t => {
  const f = fixture(t, { future: true }), id = '11111111-1111-4111-8111-111111111111';
  f.config.existingQueueId = id; f.config.expectedQueueIntentHash = 'f'.repeat(64);
  f.data.jobs.push({ id, key: 'existing-native-pilot', intentHash: f.config.expectedQueueIntentHash, kind: 'diagnostic',
    hosts: f.config.hosts, executor: { mode: 'operator', receiptRef: path.join(f.dir, 'pilot-terminal.json') },
    state: 'reserved', revision: 2, reservation: { start: '2026-10-26T19:00:00Z', end: '2026-10-26T19:30:00Z' } });
  const state = await step(f.config, f.deps);
  assert.equal(state.phase, 'waiting-for-native-window'); assert.equal(state.current.queueId, id);
  assert.equal(state.current.adoptedIntentHash, f.config.expectedQueueIntentHash);
  assert.equal(f.data.jobs.length, 1); assert.equal(f.data.launches, 0);
  f.config.expectedQueueIntentHash = 'e'.repeat(64); f.config.id = 'wrong-adoption';
  await assert.rejects(step(f.config, f.deps), /does not match/);
  assert.equal(f.data.launches, 0);
});
test('pilot review gate stops after native release without publication or a following chunk', async t => {
  const f = fixture(t); f.config.reviewBeforePublication = true;
  await step(f.config, f.deps); f.terminal('partial');
  assert.equal((await step(f.config, f.deps)).phase, 'chunk-released');
  assert.equal((await step(f.config, f.deps)).phase, 'awaiting-output-review');
  assert.equal((await step(f.config, f.deps)).phase, 'awaiting-output-review');
  assert.equal(f.data.publishes, 0); assert.equal(f.data.jobs.length, 1); assert.equal(f.data.launches, 1);
});
test('pilot per-source and explicit output bounds reach the existing worker unchanged', t => {
  const f = fixture(t); f.config.maxPagesPerSource = 1; f.config.maxOutputTokens = 8192;
  let args; dependencies(f.config, (_cmd, flags) => { args = flags; return { status: 0 }; }).launch('pilot.service', { id: 'q', dispatchId: 'd' });
  assert.equal(args[args.indexOf('--max-pages-per-source') + 1], '1');
  assert.equal(args[args.indexOf('--max-output-tokens') + 1], '8192');
});
