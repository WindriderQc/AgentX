'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMA, normalizeEnvelope, normalizeMessage, tableFallback, isCompleteFallback } = require('./answerBlocks');
const envelope = () => ({ schema: SCHEMA, blocks: [{ kind: 'table', title: 'Recorded values', columns: ['Name', 'Value'], rows: [['Example', 'Unknown']] }] });

test('canonical fallback preserves prose, all values and empty tables without duplication', () => {
  const input = { role: 'assistant', content: 'These values remain uncertain.', answerBlocks: envelope() };
  const normalized = normalizeMessage(input);
  assert.ok(normalized.content.startsWith(input.content));
  for (const text of ['Recorded values', 'Name | Value', 'Example | Unknown']) assert.ok(normalized.content.includes(text));
  assert.equal(isCompleteFallback(normalized.content, normalized.answerBlocks), true);
  assert.deepEqual(normalizeMessage(normalized), normalized);
  assert.equal(input.content, 'These values remain uncertain.');
  input.answerBlocks.blocks[0].rows = [];
  assert.match(normalizeMessage(input).content, /\(No rows\)/);
});

test('literal text fallback uses a fence longer than hostile data and retains every value', () => {
  const input = envelope();
  input.blocks[0] = { kind: 'table', title: '<img src="https://example.test/leak">', columns: ['Column'],
    rows: [['``````'], ['![pixel](https://example.test/steal)'], ['<script>alert(1)</script>']] };
  const fallback = tableFallback(input);
  assert.ok(fallback.startsWith('```````text\n'));
  for (const value of [input.blocks[0].title, ...input.blocks[0].rows.flat()]) assert.ok(fallback.includes(value));
  assert.ok(fallback.endsWith('\n```````'));
});

test('rejects unsupported envelopes, authority fields, malformed shapes and absent fallback', () => {
  const invalid = [null, [], { ...envelope(), schema: 'future/v2' }, { ...envelope(), action: '/api/execute' },
    { schema: SCHEMA, blocks: [] }, { schema: SCHEMA, blocks: new Array(1) }];
  for (const value of invalid) assert.throws(() => normalizeEnvelope(value), { code: 'ANSWER_BLOCKS_INVALID' });
  for (const role of ['user', 'system', 'tool']) assert.throws(() => normalizeMessage({ role, content: 'Text', answerBlocks: envelope() }));
  for (const content of ['', '   ', null, 3]) assert.throws(() => normalizeMessage({ role: 'assistant', content, answerBlocks: envelope() }));
  for (const change of [{ kind: 'form' }, { title: '' }, { title: 'a\nb' }, { columns: [''] }, { columns: new Array(2) },
    { rows: [[3, 'x']] }, { rows: [['one']] }, { rows: new Array(1) }, { rows: [new Array(2)] },
    { endpoint: '/api/execute' }, { rows: [['x\0y', 'z']] }]) {
    const value = envelope(); Object.assign(value.blocks[0], change);
    assert.throws(() => normalizeEnvelope(value), { code: 'ANSWER_BLOCKS_INVALID' });
  }
});

test('enforces structural and aggregate bounds without truncating accepted data', () => {
  for (const mutate of [value => { value.blocks = Array(6).fill(value.blocks[0]); },
    value => { value.blocks[0].columns = Array(9).fill('Column'); },
    value => { value.blocks[0].rows = Array(51).fill(['a', 'b']); },
    value => { value.blocks[0].title = 'x'.repeat(121); },
    value => { value.blocks[0].rows = [['x'.repeat(501), 'b']]; },
    value => { value.blocks[0].rows = Array(50).fill(['x'.repeat(200), 'y'.repeat(200)]); }]) {
    const value = envelope(); mutate(value); assert.throws(() => normalizeEnvelope(value));
  }
  const value = envelope(); value.blocks[0].rows = Array(50).fill(['a'.repeat(100), 'b'.repeat(100)]);
  assert.deepEqual(normalizeEnvelope(value), value);
});
