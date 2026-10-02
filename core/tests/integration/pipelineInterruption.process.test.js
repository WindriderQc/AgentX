'use strict';

// Interruption scenarios with a real disposable Core process. The child runs
// the real Pipeline routes against the suite MongoDB; it is terminated with
// SIGKILL right after a chosen write commits and before its HTTP response.
// "Time passing" (lease expiry) is simulated by moving durable expiry dates.
const { fork } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const PipelineTask = require('../../models/PipelineTask');
const PipelineAutomationSlot = require('../../models/PipelineAutomationSlot');
const { normalizeTaskRoutingMetadata, AUTOMATION_SLOT_ID } = require('../../src/services/pipelineTaskService');

const fixture = path.join(__dirname, '../fixtures/pipelineCore.child.js');
const PORT = Number(process.env.PIPELINE_INTERRUPTION_PORT || 3241);
const base = `http://127.0.0.1:${PORT}/api/pipeline`;
const children = new Set();

// One connection per request (no keep-alive agent), so no socket to a killed
// or stopped child outlives its test.
function send(method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${base}${route}`, { method, agent: false,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function automation() {
  return normalizeTaskRoutingMetadata({ automation: {
    schema: 'agentx.pipeline-automation/v1', mode: 'review_only', policyRef: 'product.low-risk-code/v1',
    dataClassification: 'public', operations: ['create', 'update'], scope: ['core/src/example.js'],
    lockKeys: ['repo:core/example'], executionProfile: 'workspace-write-no-network/v1',
    verificationProfile: 'core-unit/v1', budgets: { maxDurationMs: 900000, maxAttempts: 3, maxCostNanodollars: 0 },
    humanGates: ['review', 'merge', 'deploy'],
  } }).automation;
}

const evidence = () => ({
  schema: 'agentx.pipeline-automation-evidence/v1',
  verification: { status: 'passed', durationMs: 1200, testsPassed: 12, testsFailed: 0 },
  changes: { filesChanged: 2, bytesChanged: 900 },
  usage: { durationMs: 45000, costNanodollars: 0, costKind: 'provider-spend',
    costSource: 'openclaw-local-provider-spend/v1', costEvidenceFingerprint: 'a'.repeat(64) },
  failureCodes: [], source: 'clawdx-guarded/v1',
});

function startCore(crashAt = '') {
  return new Promise((resolve, reject) => {
    const child = fork(fixture, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, PIPELINE_CHILD_PORT: String(PORT), PIPELINE_CHILD_MONGO_URI: process.env.MONGODB_URI,
        PIPELINE_CRASH_AT: crashAt },
    });
    children.add(child);
    let stderr = '';
    const events = [];
    child.stderr.on('data', data => { stderr += data; });
    child.exited = new Promise(done => child.once('exit', (code, signal) => {
      children.delete(child);
      child.stderr.destroy();
      if (child.connected) child.disconnect();
      done({ code, signal });
    }));
    child.committed = new Promise(done => child.on('message', message => {
      events.push(message.event);
      if (message.event?.startsWith('committed:')) done(message.event);
    }));
    const timer = setTimeout(() => reject(new Error(`Core fixture did not start: ${events} ${stderr}`)), 15000);
    child.on('message', message => {
      if (message.event === 'ready') { clearTimeout(timer); resolve(child); }
      if (message.event === 'error') { clearTimeout(timer); reject(new Error(message.message)); }
    });
    child.exited.then(exit => { clearTimeout(timer); if (!events.includes('ready')) reject(new Error(`Core fixture exited ${JSON.stringify(exit)} ${stderr}`)); });
  });
}

async function stopCore(child) {
  if (!children.has(child)) return;
  child.send({ command: 'stop' });
  let timer;
  const exit = await Promise.race([child.exited, new Promise(done => { timer = setTimeout(() => done(null), 5000); })]);
  clearTimeout(timer);
  if (!exit) { child.kill('SIGKILL'); await child.exited; }
}

// Sends a request that commits, then kills Core before any response arrives.
async function commitThenKill(child, route, body) {
  const request = send('POST', route, body).then(response => ({ response }), error => ({ error }));
  expect(await child.committed).toMatch(/^committed:/);
  child.kill('SIGKILL');
  const exit = await child.exited;
  expect(exit.signal === 'SIGKILL' || exit.code !== 0).toBe(true);
  const outcome = await request;
  expect(outcome.response).toBeUndefined();
  expect(outcome.error).toBeDefined();
}

const call = send;

const read = pipelineId => PipelineTask.findOne({ pipelineId }).lean();
const slot = () => PipelineAutomationSlot.findById(AUTOMATION_SLOT_ID).lean();
async function expireLease(pipelineId) {
  const past = new Date(Date.now() - 1000);
  await PipelineTask.updateOne({ pipelineId }, { $set: { 'automationLease.expiresAt': past } });
  await PipelineAutomationSlot.updateOne({ _id: AUTOMATION_SLOT_ID }, { $set: { expiresAt: past } });
}

beforeEach(async () => {
  await PipelineTask.deleteMany({});
  await PipelineAutomationSlot.deleteMany({});
  await PipelineTask.create(['0960', '0961', '0962', '0963'].map(pipelineId => ({
    pipelineId, title: `Synthetic interruption fixture ${pipelineId}`, service: 'core', risk: 'low', automation: automation(),
  })));
});
afterEach(async () => {
  for (const child of [...children]) { child.kill('SIGKILL'); await child.exited; }
});

test('a claim committed before Core dies yields one worker; restart refuses a second claim until an operator correction', async () => {
  await commitThenKill(await startCore('claim'), '/tasks/0960/claim',
    { assignee: 'worker-a', automated: true, leaseDurationMs: 60000 });
  const claimed = await read('0960');
  expect(claimed).toMatchObject({ status: 'in_progress', assignee: 'worker-a', automationAttemptCount: 1 });
  expect(claimed.automationAttempts).toHaveLength(1);
  const firstLease = claimed.automationLease.leaseId;
  expect(await slot()).toMatchObject({ leaseId: firstLease, pipelineId: '0960' });

  const core = await startCore();
  expect((await call('POST', '/tasks/0960/claim', { assignee: 'worker-a', automated: true, leaseDurationMs: 60000 })).body)
    .toMatchObject({ code: 'TASK_UNAVAILABLE' });
  expect((await call('POST', '/tasks/0960/claim', { assignee: 'worker-b', automated: true, leaseDurationMs: 60000 })).body)
    .toMatchObject({ code: 'TASK_UNAVAILABLE' });
  expect((await call('POST', '/tasks/0961/claim', { assignee: 'worker-b', automated: true, leaseDurationMs: 60000 })).body)
    .toMatchObject({ code: 'AUTOMATION_SLOT_OCCUPIED' });
  expect((await read('0960')).automationAttempts).toHaveLength(1);
  expect((await read('0961')).status).toBe('queued');

  // The lost worker never heartbeats. Once its lease expires, the dossier asks
  // for inspection even though the last heartbeat is still recent.
  await expireLease('0960');
  const detail = (await call('GET', '/tasks/0960')).body.data.task.nextAction;
  expect(detail).toMatchObject({ code: 'inspect_worker', actor: 'human', attention: true, authorization: 'not_granted' });
  expect(detail.label).toMatch(/lease expired/i);
  const listed = (await call('GET', '/tasks?view=summary')).body.data.tasks.find(task => task.pipelineId === '0960');
  expect(listed.nextAction.code).toBe('inspect_worker');
  expect(listed.automationLease).toEqual({ expiresAt: expect.any(String) });

  expect((await call('POST', '/tasks/0960/status', { status: 'queued', by: 'operator-1' })).status).toBe(200);
  expect((await read('0960')).automationAttempts[0].finalState).toBe('released');
  const reclaimed = await call('POST', '/tasks/0960/claim', { assignee: 'worker-b', automated: true, leaseDurationMs: 60000 });
  expect(reclaimed.body.data.task).toMatchObject({ assignee: 'worker-b', automationAttemptCount: 2 });

  const late = await call('POST', '/tasks/0960/feedback', { status: 'done', by: 'worker-a', text: 'late result',
    leaseId: firstLease, leaseAssignee: 'worker-a' });
  expect(late).toMatchObject({ status: 409, body: { code: 'TASK_LEASE_MISMATCH' } });
  const final = await read('0960');
  expect(final.automationAttempts.map(attempt => attempt.finalState)).toEqual(['released', 'active']);
  expect(final.feedback || []).toHaveLength(0);
  await stopCore(core);
}, 60000);

test('an exact worker retry after Core dies returns the prior result and releases only its orphan slot', async () => {
  let core = await startCore('feedback');
  const claim = await call('POST', '/tasks/0962/claim', { assignee: 'worker-a', automated: true, leaseDurationMs: 60000 });
  const leaseId = claim.body.data.task.automationLease.leaseId;
  const result = { status: 'done', by: 'worker-a', text: 'verified result', leaseId, leaseAssignee: 'worker-a' };
  await commitThenKill(core, '/tasks/0962/feedback', { ...result, attemptEvidence: evidence() });

  const recorded = await read('0962');
  expect(recorded).toMatchObject({ status: 'review' });
  expect(recorded.automationLease).toBeUndefined();
  expect(recorded.feedback).toHaveLength(1);
  expect(recorded.automationAttempts[0]).toMatchObject({ finalState: 'review', evidence: { source: 'clawdx-guarded/v1' } });
  // Core died between the task write and the slot release.
  expect(await slot()).toMatchObject({ leaseId, pipelineId: '0962' });

  core = await startCore();
  const changed = await call('POST', '/tasks/0962/feedback', { ...result, text: 'different result', attemptEvidence: evidence() });
  expect(changed).toMatchObject({ status: 409, body: { code: 'TASK_LEASE_INACTIVE' } });
  const bare = await call('POST', '/tasks/0962/feedback', result);
  expect(bare).toMatchObject({ status: 409, body: { code: 'TASK_LEASE_INACTIVE' } });
  expect(await slot()).toMatchObject({ leaseId, pipelineId: '0962' });
  const retried = await call('POST', '/tasks/0962/feedback', { ...result, attemptEvidence: evidence() });
  expect(retried).toMatchObject({ status: 200, body: { data: { alreadyRecorded: true } } });
  const afterRetry = await read('0962');
  expect(afterRetry.feedback).toHaveLength(1);
  expect(afterRetry.status).toBe('review');
  expect((await call('GET', '/tasks/0962')).body.data.task.nextAction)
    .toMatchObject({ code: 'human_review', receiptPresent: true });

  // Exact retry releases only the slot held by this completed attempt.
  expect((await slot()).leaseId).toBeNull();
  const next = await call('POST', '/tasks/0963/claim', { assignee: 'worker-b', automated: true, leaseDurationMs: 60000 });
  expect(next.body.data.task).toMatchObject({ status: 'in_progress', assignee: 'worker-b' });
  expect((await call('POST', '/tasks/0961/claim', { assignee: 'worker-c', automated: true, leaseDurationMs: 60000 })).body)
    .toMatchObject({ code: 'AUTOMATION_SLOT_OCCUPIED' });

  // The active lease holder can still requeue through /status with its lease.
  const active = next.body.data.task.automationLease.leaseId;
  expect(await call('POST', '/tasks/0963/status', { status: 'queued', by: 'guarded-dispatch', leaseId: active,
    leaseAssignee: 'worker-c' })).toMatchObject({ status: 409, body: { code: 'TASK_LEASE_ASSIGNEE_MISMATCH' } });
  expect((await call('POST', '/tasks/0963/status', { status: 'queued', by: 'guarded-dispatch', leaseId: active,
    leaseAssignee: 'worker-b' })).status).toBe(200);
  expect((await read('0963')).automationAttempts[0].finalState).toBe('released');
  expect((await call('POST', '/tasks/0961/claim', { assignee: 'worker-c', automated: true, leaseDurationMs: 60000 })).body.data.task)
    .toMatchObject({ status: 'in_progress', assignee: 'worker-c' });
  await stopCore(core);
}, 60000);

test('a human decision committed before Core dies persists, repeats idempotently and cannot be reopened by the stale worker', async () => {
  let core = await startCore('review');
  const claim = await call('POST', '/tasks/0962/claim', { assignee: 'worker-a', automated: true, leaseDurationMs: 60000 });
  const leaseId = claim.body.data.task.automationLease.leaseId;
  expect((await call('POST', '/tasks/0962/feedback', { status: 'done', by: 'worker-a', text: 'verified result',
    leaseId, leaseAssignee: 'worker-a', attemptEvidence: evidence() })).status).toBe(200);
  await commitThenKill(core, '/tasks/0962/status', { status: 'done', by: 'operator-1' });

  const decided = await read('0962');
  expect(decided.status).toBe('done');
  expect(decided.automationAttempts[0]).toMatchObject({ finalState: 'review', reviewOutcome: 'accepted' });
  const reviewedAt = decided.automationAttempts[0].reviewedAt.toISOString();
  expect(decided.feedback.filter(entry => /Confirmed review -> done by operator-1/.test(entry.text))).toHaveLength(1);

  core = await startCore();
  expect((await call('POST', '/tasks/0962/status', { status: 'done', by: 'operator-1' })).status).toBe(200);
  const stale = { by: 'worker-a', text: 'late duplicate', leaseId, leaseAssignee: 'worker-a' };
  expect(await call('POST', '/tasks/0962/feedback', { ...stale, status: 'done' }))
    .toMatchObject({ status: 409, body: { code: 'TASK_LEASE_INACTIVE' } });
  expect(await call('POST', '/tasks/0962/heartbeat', { assignee: 'worker-a', leaseId }))
    .toMatchObject({ status: 409, body: { code: 'TASK_LEASE_INACTIVE' } });
  for (const status of ['queued', 'review', 'blocked']) {
    expect(await call('POST', '/tasks/0962/status', { status, by: 'guarded-dispatch', leaseId, leaseAssignee: 'worker-a' }))
      .toMatchObject({ status: 409, body: { code: 'TASK_LEASE_INACTIVE' } });
  }

  const final = await read('0962');
  expect(final.status).toBe('done');
  expect(final.automationAttempts[0].reviewedAt.toISOString()).toBe(reviewedAt);
  expect(final.feedback).toHaveLength(decided.feedback.length);
  const detail = (await call('GET', '/tasks/0962')).body.data.task;
  expect(detail.nextAction.code).toBe('none');
  await stopCore(core);
}, 60000);
