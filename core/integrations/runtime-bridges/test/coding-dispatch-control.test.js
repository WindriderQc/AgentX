'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { CodingDispatchControl, launchCommand, registerCodingDispatchControlRoutes } = require('../coding-dispatch-control');
const request = { pipelineId: '0700', requestId: '10000000-0000-4000-8000-000000000001', expectedAttemptCount: 0, confirm: true };
const accepted = { accepted: true, run: { ...request, phase: 'accepted' } };
const envelope = data => ({ stdout: JSON.stringify({ status: 'success', data }) });
const configured = sshRunner => new CodingDispatchControl({ sshTarget: 'operator@host', sshRunner });

test('launch binds an exact task, request and observed attempt without shell interpolation', async () => {
  assert.equal(launchCommand({ ...request, root: '/opt/agentx' }), `/usr/bin/python3 /opt/agentx/integrations/coding/coding_dispatch_control.py launch 0700 ${request.requestId} 0`);
  for (const change of [{ pipelineId: '700' }, { pipelineId: '0700; reboot' }, { requestId: 'a; reboot' }, { expectedAttemptCount: '0' }, { expectedAttemptCount: -1 }, { confirm: false }]) {
    await assert.rejects(configured(() => assert.fail('must not contact host')).launch({ ...request, ...change }), error => error.statusCode === 400);
  }
});

test('concurrent copies of the same POST share one SSH request', async () => {
  let complete, calls = 0;
  const control = configured(() => { calls++; return new Promise(resolve => { complete = resolve; }); });
  const first = control.launch(request);
  const second = control.launch(request);
  await assert.rejects(control.launch({ ...request, pipelineId: '0701' }), error => error.code === 'CODING_DISPATCH_REQUEST_CONFLICT');
  complete(envelope(accepted));
  assert.deepEqual(await first, accepted);
  assert.deepEqual(await second, accepted);
  assert.equal(calls, 1);
});

test('status reads the requested receipt and live host admission asynchronously', async () => {
  const data = { contractVersion: 2, available: true, candidates: [], run: { phase: 'running' } };
  const control = configured(async (target, command) => {
    assert.equal(target, 'operator@host');
    assert.equal(command, `/usr/bin/python3 /opt/agentx/integrations/coding/coding_dispatch_control.py status ${request.requestId}`);
    return envelope(data);
  });
  assert.deepEqual(await control.status({ requestId: request.requestId }), data);
});

test('HTTP loss is reported as uncertain and does not reflect private stderr', async () => {
  const control = configured(async () => { throw new Error('secret host output'); });
  await assert.rejects(control.launch(request), error => error.code === 'CODING_DISPATCH_OUTCOME_UNKNOWN' && error.statusCode === 503 && !error.message.includes('secret'));
});

test('stop requires confirmation and binds the exact task and request without signaling another unit', async () => {
  const control = configured(async (target, command) => {
    assert.equal(command, `/usr/bin/python3 /opt/agentx/integrations/coding/coding_dispatch_control.py stop 0700 ${request.requestId}`);
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
    assert.equal(command, `/usr/bin/python3 /opt/agentx/integrations/coding/coding_dispatch_control.py launch-report 0700 ${request.requestId} 0 REVIEW.md --model-call-limit 256`);
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
    assert.equal(command, `/usr/bin/python3 /opt/agentx/integrations/coding/coding_dispatch_control.py reconcile 0700 ${request.requestId}`);
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
    assert.equal(command, `/usr/bin/python3 /opt/agentx/integrations/coding/coding_dispatch_control.py read-checkpoint 0700 ${request.requestId} .review-work/REVIEW.md`);
    return envelope({ sha256: 'a'.repeat(64) });
  });
  assert.equal((await control.checkpoint({ ...request, path: '.review-work/REVIEW.md' })).sha256, 'a'.repeat(64));
  await assert.rejects(control.checkpoint({ ...request, path: '.review-work/../secret.md' }));
});
