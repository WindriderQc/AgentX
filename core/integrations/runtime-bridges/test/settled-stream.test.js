const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { setImmediate: tick } = require('node:timers/promises');
const { settledStream } = require('../openclaw/settled-stream');

test('ordinary content streams but the terminal/tool turn waits for durable release', async () => {
  const source = new PassThrough();
  let released;
  const completion = new Promise(resolve => { released = resolve; });
  const output = settledStream(source, completion);
  const chunks = [];
  output.on('data', chunk => chunks.push(chunk.toString()));
  source.write('{"message":{"content":"partial"},"done":false}\n');
  source.end('{"message":{"tool_calls":[]},"done":true}\n');
  await tick();
  assert.equal(chunks.length, 1);
  assert.equal(output.readableEnded, false);
  const ended = new Promise(resolve => output.once('end', resolve));
  released({ completed: true });
  await ended;
  assert.equal(chunks.length, 2);
  assert.match(chunks[1], /"done":true/);
});

test('a failed release cannot deliver a successful terminal frame', async () => {
  const source = new PassThrough();
  let reject;
  const completion = new Promise((_resolve, fail) => { reject = fail; });
  const output = settledStream(source, completion);
  const chunks = [];
  output.on('data', chunk => chunks.push(chunk.toString()));
  const failed = new Promise(resolve => output.once('error', resolve));
  source.end('{"done":true}\n');
  await tick();
  reject(new Error('admission release not acknowledged'));
  assert.match((await failed).message, /release not acknowledged/);
  assert.deepEqual(chunks, []);
});
