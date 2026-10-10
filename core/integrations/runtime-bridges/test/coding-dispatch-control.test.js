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
    assert.equal(command, `/usr/bin/python3 /srv/agentx/AgentX/integrations/coding/coding_dispatch_control.py status ${request.requestId}`);
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
