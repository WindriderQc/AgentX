'use strict';

// Image analysis by OpenClaw Main, the gateway's description fallback for a
// model that does not read images, and the gateway's image conversion.
const assert = require('node:assert/strict');
const test = require('node:test');
const { visionMessages } = require('../../../src/services/imageAnalysisService');
const { ollamaMessages } = require('../llm-gateway/messages');
const { createOpenClawExecutionClient } = require('../../../../shared/openclawExecutionClient');
const telemetry = [];
require('../../../src/services/routing/inferenceTelemetry').recordInference = async entry => { telemetry.push(entry); };
const { withExecutionSource } = require('../../../src/services/execution/openclawInference');
const { analyzeImages } = require('../../../src/services/imageAnalysisService');

const image = 'data:image/png;base64,' + Buffer.from('synthetic-image-bytes').toString('base64');
const messages = [{ role: 'user', content: [
  { type: 'text', text: 'Describe the colored shapes.' }, { type: 'image_url', image_url: { url: image } }
] }];
const analyze = (execute, input = messages) => analyzeImages({ messages: input, runtimeServices: { inference: { execute } } });

function completed(agentId = 'main') {
  return { ok: true, status: 200, body: { message: { content: 'A red rectangle and a blue circle.' },
    executionReceipt: { source: 'openclaw', mode: 'agent', requested: { agentId }, completion: 'completed', runId: 'native-run' } } };
}

test('image analysis reaches Main through the existing execution source with unchanged image bytes', async () => {
  let captured;
  const { text, nativeReceipt } = await analyze(async (input, options) => { captured = { input, options }; return completed(); });
  assert.deepEqual(captured.input.execution, { source: 'openclaw', mode: 'agent', agentId: 'main' });
  assert.equal(captured.input.stream, false);
  assert.deepEqual(captured.input.messages[1].content[1], { type: 'input_image', source: {
    type: 'base64', media_type: 'image/png', data: image.split(',')[1]
  } });
  assert.equal(nativeReceipt.runId, 'native-run');
  assert.equal(text, 'A red rectangle and a blue circle.');
});

test('text-only input, remote images and excess image bytes refuse before dispatch', async () => {
  let calls = 0;
  for (const input of [
    [{ role: 'user', content: 'No image.' }],
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://private.test/image.png' } }] }]
  ]) await assert.rejects(analyze(async () => { calls++; return completed(); }, input), error => error.statusCode === 400);
  assert.equal(calls, 0);
  const huge = 'data:image/png;base64,' + Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64');
  assert.throws(() => visionMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: huge } }] }]), error => error.statusCode === 413);
});

test('a failed or incomplete native result never becomes a successful analysis or a retry', async () => {
  for (const result of [completed('other'), { ok: true, body: { response: 'unverified' } }, { ok: false, status: 503 }]) {
    let calls = 0;
    await assert.rejects(analyze(async () => { calls++; return result; }), error => error.statusCode >= 500);
    assert.equal(calls, 1);
  }
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
  const { text } = await analyze(withExecutionSource(async () => { localCalls++; }, client));
  assert.equal(text, 'Image analyzed.'); assert.equal(localCalls, 0);
  assert.equal(nativeRequest.url, 'http://gateway.test/v1/responses');
  assert.equal(nativeRequest.body.model, 'openclaw/main');
  assert.match(nativeRequest.headers['x-openclaw-session-key'], /^agent:main:agentx:turn:/);
  assert.equal(nativeRequest.body.input[0].content[1].source.data, image.split(',')[1]);
  assert.equal(telemetry.at(-1).callerDetail, 'hermes-vision-main');
  assert.equal(telemetry.at(-1).executionSource, 'openclaw');
});

test('reasoning sends inline image bytes to the model instead of removing them', () => {
  assert.deepEqual(ollamaMessages(messages), [{ role: 'user', content: 'Describe the colored shapes.', images: [image.split(',')[1]] }]);
  assert.deepEqual(ollamaMessages([{ role: 'user', content: 'image', images: ['base64'] }]), [{ role: 'user', content: 'image', images: ['base64'] }]);
  assert.deepEqual(ollamaMessages([{ role: 'tool', tool_call_id: 'c1', content: [{ type: 'input_image', image_url: image }] }])[0].images,
    [image.split(',')[1]]);
});

test('remote, malformed and system images are refused rather than fetched or dropped', () => {
  const refused = error => error.code === 'GATEWAY_IMAGE_INVALID' && error.statusCode === 400;
  assert.throws(() => ollamaMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://private.test/a.png' } }] }]), refused);
  assert.throws(() => ollamaMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,PHN2Zz4=' } }] }]), refused);
  assert.throws(() => ollamaMessages([{ role: 'user', content: 'x', images: [42] }]), refused);
  assert.throws(() => ollamaMessages([{ role: 'system', content: [{ type: 'image_url', image_url: { url: image } }] }]), refused);
});

test('the shared advisory helper binds completed receipts to the saved request and preserves unknown native outcomes', async () => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  let result = completed(); result.body.executionReceipt.requestId = 'other-request';
  const runtimeServices = { inference: { execute: async () => result } };
  await assert.rejects(analyzeImages({ messages, requestId, runtimeServices }), error => error.executionState === 'unknown');
  result = { ok: false, status: 409, body: { executionState: 'not-dispatched', code: 'ADMISSION_REFUSED' } };
  await assert.rejects(analyzeImages({ messages, requestId, runtimeServices }), error => error.executionState === 'not-dispatched' && error.code === 'ADMISSION_REFUSED');
  result = { ok: false, status: 502, body: { executionState: 'unknown' } };
  await assert.rejects(analyzeImages({ messages, requestId, runtimeServices }), error => error.executionState === 'unknown');
});
