'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { CodingDispatchControl, launchCommand, registerCodingDispatchControlRoutes } = require('../coding-dispatch-control');
const request = { pipelineId: '0700', requestId: '10000000-0000-4000-8000-000000000001', expectedAttemptCount: 0, confirm: true };
const accepted = { accepted: true, run: { ...request, phase: 'accepted' } };
const envelope = data => ({ stdout: JSON.stringify({ status: 'success', data }) });
const configured = sshRunner => new CodingDispatchControl({ sshTarget: 'operator@host', sshRunner });

test('launch binds an exact task, request and observed attempt without shell interpolation', async () => {
  assert.equal(launchCommand({ ...request, root: '/srv/agentx/AgentX' }), `/usr/bin/python3 /srv/agentx/AgentX/integrations/coding/coding_dispatch_control.py launch 0700 ${request.requestId} 0`);
  for (const change of [{ pipelineId: '700' }, { pipelineId: '0700; reboot' }, { requestId: 'a; reboot' }, { expectedAttemptCount: '0' }, { expectedAttemptCount: -1 }, { confirm: false }]) {
    await assert.rejects(configured(() => assert.fail('must not contact host')).launch({ ...request, ...change }), error => error.statusCode === 400);
  }
});

test('distributed launches pin the executor, graph, role, step and manifest fingerprint', async () => {
  const fingerprint = 'a'.repeat(64);
  assert.equal(launchCommand({ ...request, root: '/srv/agentx/AgentX', executorId: 'alien-open',
    distributedRole: 'step', graphId: 'graph-0700', stepId: 'step-02', manifestFingerprint: fingerprint }),
  `/usr/bin/python3 /srv/agentx/AgentX/integrations/coding/coding_dispatch_control.py launch-step 0700 ${request.requestId} 0 alien-open graph-0700 step-02 ${fingerprint}`);
  assert.equal(launchCommand({ ...request, root: '/srv/agentx/AgentX', executorId: 'alien-open',
    distributedRole: 'assembly', graphId: 'graph-0700', manifestFingerprint: fingerprint }),
  `/usr/bin/python3 /srv/agentx/AgentX/integrations/coding/coding_dispatch_control.py launch-assembly 0700 ${request.requestId} 0 alien-open graph-0700 ${fingerprint}`);
  for (const extra of [{ executorId: 'bad;id' }, { graphId: 'bad graph' }, { stepId: 'step-1' },
    { manifestFingerprint: 'short' }, { distributedRole: 'planner' }, { autonomous: true }]) {
    assert.throws(() => launchCommand({ ...request, root: '/srv/agentx/AgentX', executorId: 'alien-open',
      distributedRole: 'step', graphId: 'graph-0700', stepId: 'step-02', manifestFingerprint: fingerprint, ...extra }),
    error => error.statusCode === 400);
  }
});

test('concurrent copies of the same POST share one SSH request', async () => {
  let complete, calls = 0;
  const control = configured(() => { calls++; return new Promise(resolve => { complete = resolve; }); });
  const first = control.launch(request);
  const second = control.launch(request);
  await assert.rejects(control.launch({ ...request, pipelineId: '0701' }), error => error.code === 'CODING_DISPATCH_REQUEST_CONFLICT');
  complete(envelope(accepted));
  assert.deepEqual((await first).run, { ...accepted.run, executorId: 'default', executorLabel: 'default', harness: 'dsh' });
  assert.deepEqual((await second).run, { ...accepted.run, executorId: 'default', executorLabel: 'default', harness: 'dsh' });
  assert.equal(calls, 1);
});

test('status reads the requested receipt and live host admission asynchronously', async () => {
  const data = { contractVersion: 2, available: true, candidates: [], run: { phase: 'running' } };
  const control = configured(async (target, command) => {
    assert.equal(target, 'operator@host');
    assert.equal(command, `/usr/bin/python3 /srv/agentx/AgentX/integrations/coding/coding_dispatch_control.py status ${request.requestId}`);
    return envelope(data);
  });
  const status = await control.status({ requestId: request.requestId });
  assert.deepEqual(status.run, { phase: 'running', executorId: 'default', executorLabel: 'default', harness: 'dsh' });
  assert.equal(status.executors[0].id, 'default');
});

test('HTTP loss is reported as uncertain and does not reflect private stderr', async () => {
  const control = configured(async () => { throw new Error('secret host output'); });
  await assert.rejects(control.launch(request), error => error.code === 'CODING_DISPATCH_OUTCOME_UNKNOWN' && error.statusCode === 503 && !error.message.includes('secret'));
});

test('stop requires confirmation and binds the exact task and request without signaling another unit', async () => {
  const control = configured(async (target, command) => {
    assert.equal(command, `/usr/bin/python3 /srv/agentx/AgentX/integrations/coding/coding_dispatch_control.py stop 0700 ${request.requestId}`);
    return envelope({ accepted: true, phase: 'stopping' });
  });
  assert.equal((await control.stop(request)).phase, 'stopping');
  for (const change of [{ confirm: false }, { pipelineId: '0700; kill' }, { requestId: 'not-a-uuid' }]) {
    await assert.rejects(configured(() => assert.fail('must not contact host')).stop({ ...request, ...change }), error => error.statusCode === 400);
  }
});

test('known rejection preserves the bounded receipt for reconciliation', async () => {
  const run = { requestId: request.requestId, phase: 'rejected' };
  const control = configured(async () => ({ stdout: JSON.stringify({ status: 'error', statusCode: 409, code: 'CODING_DISPATCH_INELIGIBLE', message: 'Task changed', data: { run } }) }));
  await assert.rejects(control.launch(request), error => error.code === 'CODING_DISPATCH_INELIGIBLE' && error.data.run.requestId === request.requestId);
});

test('routes await host observations and reserve 202 for request acknowledgement', async () => {
  const routes = {};
  const express = { Router: () => ({ get: (path, handler) => { routes[`GET ${path}`] = handler; }, post: (path, handler) => { routes[`POST ${path}`] = handler; } }) };
  const control = configured(async (target, command) => envelope(command.includes(' launch ') ? accepted : { contractVersion: 2, candidates: [] }));
  registerCodingDispatchControlRoutes({ express, control });
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const get = response();
  await routes['GET /status']({ query: {} }, get);
  assert.equal(get.body.data.contractVersion, 2);
  const post = response();
  await routes['POST /runs']({ body: request }, post);
  assert.equal(post.statusCode, 202);
  assert.equal(post.body.data.run.phase, 'accepted');
  const stop = response();
  let selection;
  control.stop = async input => { selection = input; return { accepted: true, phase: 'stopping' }; };
  await routes['POST /runs/:requestId/stop']({ params: { requestId: request.requestId }, body: { pipelineId: '0700', confirm: true, requestId: 'spoofed' } }, stop);
  assert.equal(stop.statusCode, 202);
  assert.deepEqual(selection, { requestId: request.requestId, pipelineId: '0700', confirm: true });
});

test('private report launch reaches the native executor with its exact filename and explicit call budget', async () => {
  const control = configured(async (_target, command) => {
    assert.equal(command, `/usr/bin/python3 /srv/agentx/AgentX/integrations/coding/coding_dispatch_control.py launch-report 0700 ${request.requestId} 0 REVIEW.md --model-call-limit 256`);
    return envelope({ ...accepted, run: { ...accepted.run, reportName: 'REVIEW.md', modelCallLimit: 256 } });
  });
  const result = await control.launch({ ...request, reportName: 'REVIEW.md', modelCallLimit: 256 });
  assert.equal(result.run.reportName, 'REVIEW.md');
  assert.equal(result.run.modelCallLimit, 256);
  for (const extra of [{ reportName: '../report.md' }, { reportName: 'report.md;reboot' }, { reportName: 'report.md', autonomous: true },
    { reportName: 'report.md', modelCallLimit: 257 }, { reportName: 'report.md', modelCallLimit: '256' }, { modelCallLimit: 256 }]) {
    await assert.rejects(configured(() => assert.fail('invalid selection reached the host')).launch({ ...request, ...extra }), error => error.statusCode === 400);
  }
});
test('one request id cannot change report filename, mode or call budget while launch is unresolved', async () => {
  let finish;
  const control = configured(() => new Promise(resolve => { finish = resolve; }));
  const original = control.launch({ ...request, reportName: 'REVIEW.md', modelCallLimit: 128 });
  for (const change of [{ reportName: 'OTHER.md', modelCallLimit: 128 }, { reportName: 'REVIEW.md', modelCallLimit: 256 }, {}])
    await assert.rejects(control.launch({ ...request, ...change }), error => error.code === 'CODING_DISPATCH_REQUEST_CONFLICT');
  finish(envelope(accepted)); await original;
});

test('report continuations preserve the exact parent and cannot mutate it under the same request id', async () => {
  const parent = '20000000-0000-4000-8000-000000000002', sha = 'a'.repeat(64);
  let finish;
  const control = configured((_target, command) => {
    assert.ok(command.endsWith(` --parent-request-id ${parent} --parent-sha256 ${sha}`));
    return new Promise(resolve => { finish = resolve; });
  });
  const input = { ...request, reportName: 'REVIEW.md', parentRequestId: parent, parentSha256: sha };
  const pending = control.launch(input);
  await assert.rejects(control.launch({ ...input, parentSha256: 'b'.repeat(64) }), error => error.code === 'CODING_DISPATCH_REQUEST_CONFLICT');
  finish(envelope(accepted)); await pending;
  for (const extra of [{ parentRequestId: '../other', parentSha256: sha }, { parentSha256: sha },
    { parentRequestId: [parent], parentSha256: sha }, { parentRequestId: parent, parentSha256: sha, autonomous: true }]) {
    await assert.rejects(configured(() => assert.fail('invalid checkpoint reached host')).launch({ ...request, reportName: 'REVIEW.md', ...extra }), error => error.statusCode === 400);
  }
});
test('reconciliation requires confirmation and reaches only the original native request', async () => {
  const control = configured(async (_target, command) => {
    assert.equal(command, `/usr/bin/python3 /srv/agentx/AgentX/integrations/coding/coding_dispatch_control.py reconcile 0700 ${request.requestId}`);
    return envelope({ reconciled: true });
  });
  // Core's already authorized correction loop reconciles the same native identity internally.
  assert.equal((await control.reconcile({ pipelineId: request.pipelineId, requestId: request.requestId })).reconciled, true);
  const routes = {};
  registerCodingDispatchControlRoutes({ express: { Router: () => ({ get() {}, post: (path, fn) => { routes[path] = fn; } }) }, control });
  const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await routes['/runs/:requestId/reconcile']({ params: { requestId: request.requestId }, body: { pipelineId: '0700' } }, response);
  assert.equal(response.code, 400);
});

test('a terminal execution without a saved file retains its parent id without fabricating a digest', async () => {
  const parent = '20000000-0000-4000-8000-000000000002';
  const control = configured(async (_target, command) => {
    assert.ok(command.endsWith(` --parent-request-id ${parent}`));
    assert.ok(!command.includes('--parent-sha256'));
    return envelope(accepted);
  });
  await control.launch({ ...request, reportName: 'REVIEW.md', parentRequestId: parent, parentSha256: null });
});
test('legacy checkpoint reads use the exact bounded native path without starting a worker', async () => {
  const control = configured(async (_target, command) => {
    assert.equal(command, `/usr/bin/python3 /srv/agentx/AgentX/integrations/coding/coding_dispatch_control.py read-checkpoint 0700 ${request.requestId} .review-work/REVIEW.md`);
    return envelope({ sha256: 'a'.repeat(64) });
  });
  assert.equal((await control.checkpoint({ ...request, path: '.review-work/REVIEW.md' })).sha256, 'a'.repeat(64));
  await assert.rejects(control.checkpoint({ ...request, path: '.review-work/../secret.md' }));
});

test('executor pool merges candidates and launches on the selected harness', async () => {
  const calls = [];
  const control = new CodingDispatchControl({ executors: [
    { id: 'alien-dsh', harness: 'dsh', sshTarget: 'operator@alien', remoteRoot: '/srv/agentx/AgentX', priority: 20 },
    { id: 'brutal-local', harness: 'opencode', sshTarget: 'operator@brutal', remoteRoot: '/srv/agentx/AgentX', priority: 10 },
  ], sshRunner: async (target, command) => {
    calls.push([target, command]);
    if (command.includes(' status')) return envelope({ contractVersion: 2, available: true, busy: false,
      harness: target.endsWith('@alien') ? 'dsh' : 'opencode',
      candidates: [{ pipelineId: '0700', expectedAttemptCount: 0 }], excluded: [] });
    return envelope(accepted);
  } });
  const status = await control.status();
  assert.deepEqual(status.executors.map(row => row.id), ['brutal-local', 'alien-dsh']);
  assert.deepEqual(status.candidates.map(row => [row.executorId, row.harness]),
    [['brutal-local', 'opencode'], ['alien-dsh', 'dsh']]);
  const result = await control.launch({ ...request, executorId: 'alien-dsh' });
  assert.equal(result.run.executorId, 'alien-dsh');
  assert.equal(calls.at(-1)[0], 'operator@alien');
});

test('distributed launch reaches only its pinned executor and cannot change immutable role identity', async () => {
  const fingerprint = 'b'.repeat(64), commands = [];
  let finish;
  const control = new CodingDispatchControl({ executors: [
    { id: 'alien-open', harness: 'opencode', sshTarget: 'operator@alien', profiles: ['autonomous'] },
    { id: 'brutal-open', harness: 'opencode', sshTarget: 'operator@brutal', profiles: ['autonomous'] },
  ], sshRunner: async (target, command) => {
    commands.push([target, command]);
    return new Promise(resolve => { finish = resolve; });
  } });
  const input = { ...request, executorId: 'alien-open', distributedRole: 'step', graphId: 'graph-0700',
    stepId: 'step-01', manifestFingerprint: fingerprint };
  const pending = control.launch(input);
  await assert.rejects(control.launch({ ...input, stepId: 'step-02' }), error => error.code === 'CODING_DISPATCH_REQUEST_CONFLICT');
  await assert.rejects(control.launch({ ...input, graphId: 'graph-other' }), error => error.code === 'CODING_DISPATCH_REQUEST_CONFLICT');
  finish(envelope({ ...accepted, run: { ...accepted.run, distributedRole: 'step', graphId: 'graph-0700', stepId: 'step-01' } }));
  const result = await pending;
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], 'operator@alien');
  assert.ok(commands[0][1].includes(` launch-step 0700 ${request.requestId} 0 alien-open graph-0700 step-01 ${fingerprint}`));
  assert.deepEqual([result.run.executorId, result.run.harness], ['alien-open', 'opencode']);
  await assert.rejects(control.launch({ ...input, executorId: undefined }), error => error.statusCode === 400);
  await assert.rejects(control.launch({ ...input, distributedRole: 'assembly', stepId: 'step-01' }), error => error.statusCode === 400);
});

test('pooled candidates are offered only by an executor that can accept them now', async () => {
  const control = new CodingDispatchControl({ executors: [
    { id: 'preferred-busy', harness: 'dsh', sshTarget: 'operator@busy', priority: 1 },
    { id: 'available', harness: 'opencode', sshTarget: 'operator@free', priority: 2 },
  ], sshRunner: async target => envelope({ contractVersion: 2, available: true,
    harness: target.endsWith('@busy') ? 'dsh' : 'opencode',
    busy: target.endsWith('@busy'), candidates: [{ pipelineId: '0700', expectedAttemptCount: 0 }], excluded: [] }) });
  const status = await control.status();
  assert.deepEqual(status.candidates.map(row => row.executorId), ['available']);
  assert.equal(status.busy, false);
});

test('request discovery binds follow-up actions to the one executor holding its receipt', async () => {
  const commands = [];
  const control = new CodingDispatchControl({ executors: [
    { id: 'first', harness: 'dsh', sshTarget: 'operator@first' },
    { id: 'second', harness: 'dsh', sshTarget: 'operator@second' },
  ], sshRunner: async (target, command) => {
    commands.push([target, command]);
    if (command.includes(' status ')) return envelope({ contractVersion: 2, available: true, busy: false, harness: 'dsh',
      candidates: [], excluded: [], run: target.endsWith('@second')
        ? { ...request, phase: 'running' } : { requestId: request.requestId, phase: 'not_received' } });
    return envelope({ accepted: true, phase: 'stopping' });
  } });
  const status = await control.status({ requestId: request.requestId });
  assert.equal(status.run.executorId, 'second');
  await control.stop(request);
  assert.equal(commands.at(-1)[0], 'operator@second');
});

test('continuation selection stays on the executor holding the original receipt', async () => {
  const control = new CodingDispatchControl({ executors: [
    { id: 'free', harness: 'dsh', sshTarget: 'operator@free', priority: 1, profiles: ['report'] },
    { id: 'owner', harness: 'opencode', sshTarget: 'operator@owner', priority: 2, profiles: ['report'] },
  ], sshRunner: async (target, command) => envelope({ contractVersion: 2, available: true, busy: false,
    harness: target.endsWith('@owner') ? 'opencode' : 'dsh', candidates: [], excluded: [],
    ...(command.includes(`status ${request.requestId}`) && { run: target.endsWith('@owner')
      ? { ...request, phase: 'finished' } : { requestId: request.requestId, phase: 'not_received' } }) }) });
  assert.equal((await control.select({ profile: 'report', requestId: request.requestId })).id, 'owner');
});

test('required executor selection waits instead of migrating a checkpoint', async () => {
  const control = new CodingDispatchControl({ executors: [
    { id: 'free', harness: 'dsh', sshTarget: 'operator@free', priority: 1, profiles: ['autonomous'] },
    { id: 'owner', harness: 'opencode', sshTarget: 'operator@owner', priority: 2, profiles: ['autonomous'] },
  ], sshRunner: async target => envelope({ contractVersion: 2, available: true,
    busy: target.endsWith('@owner'), harness: target.endsWith('@owner') ? 'opencode' : 'dsh', candidates: [], excluded: [] }) });
  await assert.rejects(control.select({ profile: 'autonomous', executorId: 'owner' }),
    error => error.code === 'CODING_DISPATCH_BUSY');
});

test('an unanswered executor keeps an unlocated request outcome unknown', async () => {
  const control = new CodingDispatchControl({ executors: [
    { id: 'first', harness: 'dsh', sshTarget: 'operator@first' },
    { id: 'second', harness: 'dsh', sshTarget: 'operator@second' },
  ], sshRunner: async (target, command) => {
    if (target.endsWith('@second')) throw new Error('offline');
    return envelope({ contractVersion: 2, available: true, busy: false, harness: 'dsh', candidates: [], excluded: [],
      run: { requestId: request.requestId, phase: 'not_received' } });
  } });
  await assert.rejects(control.status({ requestId: request.requestId }), error => error.code === 'CODING_DISPATCH_OUTCOME_UNKNOWN');
});

test('pool refuses a host whose installed harness differs from the registry', async () => {
  const control = new CodingDispatchControl({ executors: [
    { id: 'declared-open', harness: 'opencode', sshTarget: 'operator@host' },
  ], sshRunner: async () => envelope({ contractVersion: 2, harness: 'dsh', available: true,
    busy: false, candidates: [], excluded: [] }) });
  await assert.rejects(control.status(), error => error.code === 'CODING_DISPATCH_OUTCOME_UNKNOWN');
  await assert.rejects(control.status({ executorId: 'declared-open' }), error => error.code === 'CODING_EXECUTOR_HARNESS_MISMATCH');
});

test('waiting cancellation carries the task identity to the selected executor', async () => {
  const control = configured(async (_target, command) => {
    assert.equal(command, `/usr/bin/python3 /srv/agentx/AgentX/integrations/coding/coding_dispatch_control.py cancel-waiting 0700 ${request.requestId}`);
    return envelope({ accepted: true, cancelledBeforeLaunch: true });
  });
  assert.equal((await control.cancel(request)).cancelledBeforeLaunch, true);
  await assert.rejects(control.cancel({ requestId: request.requestId }), error => error.statusCode === 400);
});
