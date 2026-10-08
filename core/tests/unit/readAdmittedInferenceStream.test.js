'use strict';
const { Readable } = require('node:stream');
const { readAdmittedInferenceStream: read } = require('../../src/services/readAdmittedInferenceStream');
const streamOf = rows => Readable.from(rows.map(row => JSON.stringify(row) + '\n'));
const complete = () => Promise.resolve({ completed: true, terminalComplete: true });

test('decodes split UTF-8, forwards thinking and awaits the admission release receipt', async () => {
  const bytes = Buffer.from(JSON.stringify({ message: { content: 'évidence', thinking: 'synthetic' } }) + '\n' + JSON.stringify({ done: true, model: 'example' }));
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  let settle;
  const completion = new Promise(resolve => { settle = resolve; });
  const onToken = jest.fn(), onThinking = jest.fn();
  const task = read({ ok: true, stream: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]), completion }, { onToken, onThinking });
  let done = false;
  task.then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(done).toBe(false);
  settle({ completed: true, terminalComplete: true });
  expect(await task).toMatchObject({ content: 'évidence', model: 'example', thinkingObserved: true });
  expect(onToken).toHaveBeenCalledWith('évidence');
  expect(onThinking).toHaveBeenCalledWith('synthetic');
});

test('EOF and failed host settlement cannot become a completed private response', async () => {
  await expect(read({ ok: true, stream: streamOf([{ response: 'partial' }]), completion: complete() })).rejects.toThrow('before completion');
  const failed = Promise.reject(new Error('host release failed'));
  failed.catch(() => {});
  await expect(read({ ok: true, stream: streamOf([{ done: true }]), completion: failed })).rejects.toThrow('host release failed');
});

test('cancellation drains the attempt but never emits or returns cancelled text', async () => {
  const controller = new AbortController(); controller.abort();
  const onToken = jest.fn(); let drained = false;
  const stream = Readable.from((async function* () { yield '{"response":"private"}\n'; yield '{"done":true}\n'; drained = true; })());
  await expect(read({ ok: true, stream, completion: complete() }, { signal: controller.signal, onToken })).rejects.toMatchObject({ name: 'AbortError' });
  expect(drained).toBe(true); expect(onToken).not.toHaveBeenCalled();
});

test('malformed streams and oversized replies fail without returning a truncated transcript', async () => {
  await expect(read({ ok: true, stream: Readable.from(['not json\n']), completion: complete() })).rejects.toThrow();
  await expect(read({ ok: true, stream: streamOf([{ response: '123456', done: true }]), completion: complete() }, { maxContentChars: 5 })).rejects.toThrow('conversation limit');
});

test('unknown host settlement refuses completion and exposes the complete received prefix', async () => {
  await expect(read({ ok: true, stream: streamOf([{ response: 'Keep the full received response', done: true }]),
    completion: Promise.resolve({ completed: false, terminalComplete: true }) })).rejects.toMatchObject({
    code: 'INFERENCE_COMPLETION_UNVERIFIED', partialResponse: 'Keep the full received response'
  });
});
