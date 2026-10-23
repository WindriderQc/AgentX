'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const inference = require('../../../src/services/pipelineCodingInferenceService');
const { parseGatewayClients } = require('../llm-gateway/clients');
const { registerLlmGateway } = require('../llm-gateway/router');
const TOKEN = 'settlement-test-token-01';

test('frozen inference result streams content but holds terminal until the native coding receipt is durable', async () => {
  const prior = inference.prepare;
  let release;
  let completed;
  const persisted = new Promise(resolve => { release = resolve; });
  inference.prepare = async () => ({ options: { codingCapacity: { pipelineId: '0001', leaseId: 'synthetic' } },
    finish: async state => { completed = state; await persisted; } });
  try {
    const routes = [];
    const express = { Router: () => Object.fromEntries(['get', 'post', 'all'].map(method => [method,
      (path, ...handlers) => routes.push({ method, path, handlers })])) };
    const source = new PassThrough();
    let finish;
    const native = new Promise(resolve => { finish = resolve; });
    let options;
    registerLlmGateway({ express, logger: {}, clients: parseGatewayClients(JSON.stringify({ 'coding-team': TOKEN })), runtimeServices: {
      routing: { getEffectiveSnapshot: async () => ({ tasks: { code_generation: { model: 'synthetic' } } }) },
      inference: { execute: async (_input, opts) => { options = opts; return Object.freeze({ ok: true, status: 200,
        stream: source, completion: native, metadata: { model: 'synthetic', upstreamProtocol: 'ollama' } }); } }
    } });
    const req = new EventEmitter(); req.headers = { authorization: `Bearer ${TOKEN}` }; req.body = { model: 'synthetic', stream: true, messages: [{ role: 'user', content: 'Synthetic fixture' }] };
    const res = new PassThrough(); res.status = () => res; res.set = () => res;
    res.json = value => { throw new Error(JSON.stringify(value)); };
    let output = ''; res.on('data', data => { output += data.toString(); });
    await routes.find(route => route.path === '/v1/chat/completions').handlers[0](req, res);
    source.write('{"message":{"content":"first"},"done":false}\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.match(output, /first/);
    source.end('{"done":true}\n'); finish({ completed: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, 'completed'); assert.doesNotMatch(output, /\[DONE\]/);
    assert.equal(options.codingCapacity.pipelineId, '0001');
    const ended = once(res, 'end'); release(); await ended;
    assert.match(output, /\[DONE\]/);
  } finally { inference.prepare = prior; }
});

test('a report escalation call runs on the escalation path only, never on the local runtime, and settles its receipt', async () => {
  const prior = inference.prepare;
  const escalation = require('../../../src/services/pipelineReportEscalation');
  const priorExecute = escalation.execute;
  let settled; let preparedModel; let executed;
  inference.prepare = async (headers, model) => {
    preparedModel = model;
    return { options: { signal: new AbortController().signal, reportDeadlineAt: Date.now() + 60000,
      reportEscalation: { requestId: 'r', pipelineId: '0939', callId: 'c', step: 3, model, remainingNanodollars: 5 } },
    finish: async state => { settled = state; } };
  };
  escalation.execute = async input => { executed = input;
    return { model: 'openrouter/nvidia/nemotron', body: { message: { role: 'assistant', content: '{"documents":[]}' }, done_reason: 'stop' } }; };
  try {
    const routes = [];
    const express = { Router: () => Object.fromEntries(['get', 'post', 'all'].map(method => [method,
      (path, ...handlers) => routes.push({ method, path, handlers })])) };
    registerLlmGateway({ express, logger: {}, clients: parseGatewayClients(JSON.stringify({ 'coding-team': TOKEN })), runtimeServices: {
      // The model is not in the routing table: only the run's recorded models authorize it.
      routing: { getEffectiveSnapshot: async () => ({ tasks: { code_generation: { model: 'local-coder' } } }) },
      inference: { execute: async () => { throw new Error('local runtime must not run an escalation call'); } }
    } });
    const req = new EventEmitter();
    req.headers = { authorization: `Bearer ${TOKEN}`, 'x-agentx-report-request': 'r', 'x-agentx-report-task': '0939', 'x-agentx-report-escalation': '3' };
    req.body = { model: 'openai/gpt-5.6-sol', messages: [{ role: 'user', content: 'Review these documents' }], max_tokens: 4096 };
    let status; let body;
    const res = new PassThrough(); res.status = code => { status = code; return res; }; res.set = () => res;
    res.json = value => { body = value; return res; };
    await routes.find(route => route.path === '/v1/chat/completions').handlers[0](req, res);
    assert.equal(preparedModel, 'openai/gpt-5.6-sol');
    assert.equal(executed.identity.step, 3);
    assert.equal(executed.maxTokens, 4096);
    assert.equal(settled, 'completed');
    assert.equal(status, 200);
    assert.equal(body.choices[0].message.content, '{"documents":[]}');
  } finally { inference.prepare = prior; escalation.execute = priorExecute; }
});

for (const [executionState, expectedSettlement] of [['not-dispatched', 'refused'], ['unknown', 'unknown'], ['completed', 'completed'], [undefined, 'unknown']]) {
test(`an escalation failure with state ${executionState} keeps settlement ${expectedSettlement}`, async () => {
  const prior = inference.prepare;
  const escalation = require('../../../src/services/pipelineReportEscalation');
  const priorExecute = escalation.execute;
  let settled;
  inference.prepare = async (headers, model) => ({ options: { signal: new AbortController().signal, reportDeadlineAt: Date.now() + 60000,
    reportEscalation: { requestId: 'r', pipelineId: '0939', callId: 'c', step: 3, model, remainingNanodollars: 5 } },
  finish: async state => { settled = state; } });
  const attempts = [{ model: 'cloud/model', code: 'OPENCLAW_MODEL_UNAVAILABLE', executionState }];
  escalation.execute = async () => { throw Object.assign(new Error('No escalation model answered'), {
    code: 'REPORT_ESCALATION_UNAVAILABLE', statusCode: 502, executionState, attempts }); };
  try {
    const routes = [];
    const express = { Router: () => Object.fromEntries(['get', 'post', 'all'].map(method => [method,
      (path, ...handlers) => routes.push({ method, path, handlers })])) };
    registerLlmGateway({ express, logger: {}, clients: parseGatewayClients(JSON.stringify({ 'coding-team': TOKEN })), runtimeServices: {
      routing: { getEffectiveSnapshot: async () => ({ tasks: {} }) }, inference: { execute: async () => { throw new Error('no'); } } } });
    const req = new EventEmitter();
    req.headers = { authorization: `Bearer ${TOKEN}`, 'x-agentx-report-request': 'r', 'x-agentx-report-task': '0939', 'x-agentx-report-escalation': '3' };
    req.body = { model: 'openai/gpt-5.6-sol', messages: [{ role: 'user', content: 'x' }] };
    let status; let body;
    const res = new PassThrough(); res.status = code => { status = code; return res; }; res.set = () => res;
    res.json = value => { body = value; return res; };
    await routes.find(route => route.path === '/v1/chat/completions').handlers[0](req, res);
    assert.equal(settled, expectedSettlement);
    assert.equal(status, 502);
    assert.equal(body.error.code, 'REPORT_ESCALATION_UNAVAILABLE');
    assert.equal(body.error.executionState, executionState || 'unknown');
    assert.deepEqual(body.error.attempts, attempts);
  } finally { inference.prepare = prior; escalation.execute = priorExecute; }
});
}
