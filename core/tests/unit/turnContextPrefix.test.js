'use strict';

const { formatTurnContext, assertContextSize } = require('../../src/services/conversations/turnContext');
const { expandedContext } = require('../helpers/expandedContext');

const wire = value => formatTurnContext(value);
const decoded = text => JSON.parse(text.slice(text.indexOf('\n') + 1));
const commonPrefix = (a, b) => {
  let index = 0;
  while (index < Math.min(a.length, b.length) && a[index] === b[index]) index++;
  return index;
};

test('appending a turn preserves the complete old turn prefix despite changed coverage and metadata', () => {
  const old = { authority: 'core.conversations', sessionId: 'synthetic-session',
    coverage: { complete: true, turnCount: 1, lastTurnId: 'one' },
    observedAt: '2030-01-01', turns: [{ turnId: 'one', inputText: 'Exact restriction. '.repeat(500), replyText: 'Retained.' }] };
  const next = { ...old, coverage: { complete: true, turnCount: 2, lastTurnId: 'two' }, observedAt: '2030-01-02',
    turns: [...old.turns, { turnId: 'two', inputText: 'Next question.' }] };
  const first = wire(old), second = wire(next);
  const boundary = first.indexOf('],"coverage"');
  expect(commonPrefix(first, second)).toBe(boundary);
  expect(commonPrefix(first, second)).toBeGreaterThan(9000);
  expect(decoded(first)).toEqual(old);
  expect(decoded(second)).toEqual(next);
  expect(old.coverage.turnCount).toBe(1);
});

test('wire ordering retains exact shared evidence, receipt identity, extensions and context refusal', () => {
  const value = { authority: 'core.conversations', sessionId: 'synthetic-session',
    coverage: { complete: true, turnCount: 2 }, customMetadata: { retained: false },
    turns: [0, 1].map(index => ({ turnId: `turn-${index}`, workResults: [{ workId: `work-${index}`,
      toolEvidence: [{ id: `receipt-${index}`, data: { details: 'Exact source. '.repeat(1000) } }] }] })) };
  const text = wire(value);
  expect(expandedContext(decoded(text))).toEqual(value);
  expect(text.indexOf('"turns"')).toBeLessThan(text.indexOf('"coverage"'));
  expect(() => assertContextSize(text, text.length)).not.toThrow();
  expect(() => assertContextSize(text, text.length - 1)).toThrow(expect.objectContaining({
    code: 'CONVERSATION_CONTEXT_REQUIRED', requiredChars: text.length, maxChars: text.length - 1
  }));
});
