'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { registerHermesProtocol } = require('../hermes/protocol');
const { VISION_MODEL, visionMessages } = require('../hermes/vision');
const { ollamaMessages } = require('../hermes/messages');
const { createOpenClawExecutionClient } = require('../../../../shared/openclawExecutionClient');
const telemetry = [];
require('../../../src/services/routing/inferenceTelemetry').recordInference = async entry => { telemetry.push(entry); };
const { withExecutionSource } = require('../../../src/services/execution/openclawInference');

const image = 'data:image/png;base64,' + Buffer.from('synthetic-image-bytes').toString('base64');
const messages = [{ role: 'user', content: [
  { type: 'text', text: 'Describe the colored shapes.' }, { type: 'image_url', image_url: { url: image } }
] }];

function setup(execute) {
  const routes = [];
  const express = { Router: () => Object.fromEntries(['get', 'post', 'all'].map(method => [method,
    (path, ...handlers) => routes.push({ method, path, handlers })])) };
  registerHermesProtocol({ express, runtimeServices: { inference: { execute } } });
  const handler = routes.find(r => r.path === '/vision/v1/chat/completions').handlers[0];
  const req = new EventEmitter(); req.body = { model: VISION_MODEL, messages };
  const res = new PassThrough(); res.statusCode = 200; res.headers = {};
  res.status = n => { res.statusCode = n; return res; };
  res.set = (key, value) => { Object.assign(res.headers, typeof key === 'object' ? key : { [key]: value }); return res; };
  res.json = body => { res.jsonBody = body; res.end(JSON.stringify(body)); return res; };
  return { req, res, handler };
}

function completed(agentId = 'main') {
  return { ok: true, status: 200, body: { message: { content: 'A red rectangle and a blue circle.' },
    executionReceipt: { source: 'openclaw', mode: 'agent', requested: { agentId }, completion: 'completed', runId: 'native-run' } } };
}

test('image analysis reaches Main through the existing execution source with unchanged image bytes', async () => {
  let captured;
  const { req, res, handler } = setup(async (input, options) => { captured = { input, options }; return completed(); });
  await handler(req, res);
  assert.deepEqual(captured.input.execution, { source: 'openclaw', mode: 'agent', agentId: 'main' });
  assert.equal(captured.input.stream, false);
  assert.equal(captured.input.callerDetail, 'hermes-vision-main');
  assert.equal(captured.options.consumerContract, 'hermes-vision-v1');
  assert.deepEqual(captured.input.messages[1].content[1], { type: 'input_image', source: {
    type: 'base64', media_type: 'image/png', data: image.split(',')[1]
  } });
  assert.equal(res.headers['X-AgentX-Resolved-Agent'], 'main');
  assert.equal(res.headers['X-AgentX-Native-Run-Id'], 'native-run');
  assert.equal(res.jsonBody.choices[0].message.content, 'A red rectangle and a blue circle.');
  assert.equal(res.jsonBody.usage, undefined);
});

test('invalid content, another agent, text-only input and excess image bytes refuse before dispatch', async () => {
  let calls = 0;
  for (const body of [
    { model: 'openclaw:agent:other', messages },
    { model: VISION_MODEL, messages: [{ role: 'user', content: 'No image.' }] },
    { model: VISION_MODEL, tools: [{}], messages },
    { model: VISION_MODEL, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://private.test/image.png' } }] }] }
  ]) {
    const { req, res, handler } = setup(async () => { calls++; return completed(); }); req.body = body;
    await handler(req, res); assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
  const huge = 'data:image/png;base64,' + Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64');
  assert.throws(() => visionMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: huge } }] }]), error => error.statusCode === 413);
});

test('a failed or incomplete native result never becomes a successful vision answer or a retry', async () => {
  for (const result of [completed('other'), { ok: true, body: { response: 'unverified' } }, { ok: false, status: 503 }]) {
    let calls = 0;
    const { req, res, handler } = setup(async () => { calls++; return result; });
    await handler(req, res);
    assert.ok(res.statusCode >= 500); assert.equal(calls, 1);
  }
});

test('streamed vision returns only the verified final native answer', async () => {
  const { req, res, handler } = setup(async () => completed()); req.body.stream = true;
  let text = ''; res.on('data', bytes => { text += bytes; });
  await handler(req, res);
  assert.match(text, /chat\.completion\.chunk/); assert.match(text, /red rectangle/); assert.match(text, /data: \[DONE\]/);
});

test('the native Responses transport receives actual pixels, not an image description or a local model call', async () => {
  let nativeRequest, localCalls = 0;
  const client = createOpenClawExecutionClient({
    env: { OPENCLAW_GATEWAY_URL: 'http://gateway.test', OPENCLAW_GATEWAY_TOKEN: 'synthetic-gateway-token' },
    fetchImpl: async (url, input) => {
      nativeRequest = { url, ...input, body: JSON.parse(input.body) };
      const result = { type: 'response.completed', response: { id: 'native-image-run', status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Image analyzed.' }] }] } };
      return { ok: true, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify(result)}\n\n`); })() };
    }
  });
  const { req, res, handler } = setup(withExecutionSource(async () => { localCalls++; }, client));
  await handler(req, res);
  assert.equal(res.statusCode, 200); assert.equal(localCalls, 0);
  assert.equal(nativeRequest.url, 'http://gateway.test/v1/responses');
  assert.equal(nativeRequest.body.model, 'openclaw/main');
  assert.match(nativeRequest.headers['x-openclaw-session-key'], /^agent:main:agentx:turn:/);
  assert.equal(nativeRequest.body.input[0].content[1].source.data, image.split(',')[1]);
  assert.equal(telemetry.at(-1).callerDetail, 'hermes-vision-main');
  assert.equal(telemetry.at(-1).consumerContract, 'hermes-vision-v1');
  assert.equal(telemetry.at(-1).executionSource, 'openclaw');
});

test('reasoning refuses image parts rather than silently removing them', () => {
  assert.throws(() => ollamaMessages(messages), error => error.code === 'HERMES_IMAGE_ROUTE_REQUIRED');
  assert.throws(() => ollamaMessages([{ role: 'user', content: 'image', images: ['base64'] }]), /vision endpoint/);
});
