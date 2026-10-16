'use strict';
const Conversation = require('../../models/Conversation');
const contract = require('../../../shared/answerBlocks');
const envelope = () => ({ schema: contract.SCHEMA, blocks: [{ kind: 'table', title: 'Evidence', columns: ['Result'], rows: [['Unknown']] }] });
const message = () => contract.normalizeMessage({ role: 'assistant', content: 'Not yet verified.', answerBlocks: envelope() });

test('declared assistant schema retains normalized table data and required complete fallback', () => {
  const row = new Conversation({ messages: [message()] });
  expect(row.validateSync()).toBeUndefined();
  expect(row.messages[0].answerBlocks.toObject()).toEqual(envelope());
  const missing = message(); missing.content = 'A summary without the table.';
  expect(new Conversation({ messages: [missing] }).validateSync().errors['messages.0.answerBlocks']).toBeDefined();
});

test.each(['user', 'system', 'tool'])('direct model writes reject answer tables on %s messages', role => {
  expect(new Conversation({ messages: [{ ...message(), role }] }).validateSync()).toBeDefined();
});

test('raw model assignment cannot coerce cell types, strip actions, or bypass table budgets', () => {
  for (const change of [{ rows: [[4]] }, { action: 'execute' }, { columns: Array(9).fill('a') }, { rows: [['x'.repeat(501)]] }]) {
    const value = message(); Object.assign(value.answerBlocks.blocks[0], change);
    expect(new Conversation({ messages: [value] }).validateSync()).toBeDefined();
  }
  const legacy = new Conversation({ messages: [{ role: 'assistant', content: 'Legacy text.' }] });
  expect(legacy.validateSync()).toBeUndefined();
  expect(legacy.messages[0].answerBlocks).toBeUndefined();
});
