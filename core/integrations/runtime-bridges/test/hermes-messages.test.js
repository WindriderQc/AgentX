'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ollamaMessages } = require('../hermes/messages');

test('OpenAI tool history and content parts become Ollama chat messages', () => {
  const converted = ollamaMessages([
    { role: 'user', content: [{ type: 'text', text: 'list' }, { type: 'text', text: 'the files' }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"path":"."}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'a.txt' }
  ]);
  assert.equal(converted[0].content, 'list\nthe files');
  assert.deepEqual(converted[1].tool_calls[0].function, { name: 'ls', arguments: { path: '.' } });
  assert.deepEqual(converted[2], { role: 'tool', tool_call_id: 'c1', content: 'a.txt' });
});

test('unreadable tool arguments become an empty object instead of failing the request', () => {
  const [message] = ollamaMessages([{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'ls', arguments: '{"path":' } }] }]);
  assert.deepEqual(message.tool_calls[0].function.arguments, {});
});

const { whenAdmitted } = require('../hermes/protocol');
const denied = () => Object.assign(new Error('busy'), { code: 'RUNTIME_INFERENCE_ADMISSION_DENIED', statusCode: 503 });

test('the patient route waits for a busy host and then runs the inference once', async () => {
  let calls = 0;
  const result = await whenAdmitted(async () => { if (++calls < 3) throw denied(); return 'answer'; }, { waitMs: 1000, retryMs: 1 });
  assert.deepEqual([result, calls], ['answer', 3]);
});

test('the ordinary route, an exhausted wait, a gone client and other failures are not retried', async () => {
  let calls = 0;
  const busy = async () => { calls += 1; throw denied(); };
  await assert.rejects(whenAdmitted(busy), /busy/);
  await assert.rejects(whenAdmitted(busy, { waitMs: 5, retryMs: 10 }), /busy/);
  await assert.rejects(whenAdmitted(busy, { waitMs: 1000, retryMs: 1, signal: AbortSignal.abort() }), /busy/);
  await assert.rejects(whenAdmitted(async () => { calls += 1; throw new Error('upstream failed'); }, { waitMs: 1000, retryMs: 1 }), /upstream failed/);
  assert.equal(calls, 4);
});
