'use strict';

const { shareToolEvidence } = require('../../src/services/conversations/sharedToolEvidence');
const { shareContextText } = require('../../src/services/conversations/sharedContextText');
const { assertContextSize, formatTurnContext } = require('../../src/services/conversations/turnContext');

// Decode only the documented wire contract, independently of the encoder.
function expandText(encoded) {
  function visit(value) {
    if (!value || typeof value !== 'object' || value instanceof Date) return value;
    if (Object.keys(value).length === 1 && Object.hasOwn(value, '$textRef')) {
      const target = value.$textRef.slice(2).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce((parent, key) => parent[key], encoded);
      expect(typeof target).toBe('string');
      return target;
    }
    if (Array.isArray(value)) return value.map(visit);
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'sharedTextEncoding')
      .map(([key, item]) => [key, visit(item)]));
  }
  return visit(encoded);
}

test('growing complete conversation fits by sharing repeated native answer text without dropping its tail', () => {
  const answer = 'École 🐈 and owner restriction. '.repeat(180) + ' LAST_CANONICAL_DETAIL';
  const original = { authority: 'core.conversations', coverage: { complete: true, turnCount: 2 }, turns: [
    { turnId: 'original', inputText: 'Current task list', replyText: 'Acknowledged', workResults: [{
      workId: 'work', text: answer, receiptIds: ['receipt'], presentation: { state: 'completed' },
      toolEvidence: [{ id: 'receipt', runId: 'native-run', data: { answer: { text: answer }, status: 'observed' } }] }] },
    { turnId: 'latest', inputText: 'Fresh task read', replyText: 'New guardian reply', historicalPresentation: 'x'.repeat(87000) }
  ] };
  const snapshot = structuredClone(original);
  expect(JSON.stringify(original).length).toBeGreaterThan(96000);
  const projected = shareToolEvidence(original);
  expect(() => assertContextSize(formatTurnContext(original), 96000)).not.toThrow();
  expect(expandText(projected)).toEqual(original);
  expect(original).toEqual(snapshot);
  expect(projected.turns[0].workResults[0].toolEvidence[0].data.answer.text)
    .toEqual({ $textRef: '#/turns/0/workResults/0/text' });
  expect(shareToolEvidence(projected)).toBe(projected);
  expect(formatTurnContext(original)).toContain('LAST_CANONICAL_DETAIL');
});

test('escaped JSON pointers, arrays and dates round trip; distinct values keep their identities', () => {
  const text = 'First exact text. '.repeat(100);
  const original = { turns: [{ 'a/b~c': text, nested: [text, text + ' CHANGED'], date: new Date('2026-01-01T00:00:00Z') }] };
  const projected = shareContextText(original);
  expect(projected.turns[0].nested[0]).toEqual({ $textRef: '#/turns/0/a~1b~0c' });
  expect(projected.turns[0].nested[1]).toBe(text + ' CHANGED');
  expect(expandText(projected)).toEqual(original);
});

test('several medium native answers can cross the budget after a guardian reply and still fit losslessly', () => {
  const turns = Array.from({ length: 6 }, (_, index) => {
    const answer = `Verified answer ${index}: ` + String(index).repeat(500);
    return { turnId: `turn-${index}`, workResults: [{ text: answer,
      toolEvidence: [{ id: `receipt-${index}`, data: { answer: { text: answer } } }] }] };
  });
  const original = { turns: [...turns, { inputText: 'x'.repeat(91000), replyText: 'New guardian reply' }] };
  expect(JSON.stringify(original).length).toBeGreaterThan(96000);
  const projected = shareToolEvidence(original);
  expect(() => assertContextSize(formatTurnContext(original), 96000)).not.toThrow();
  expect(expandText(projected)).toEqual(original);
});

test('literal caller reference markers remain literal and unique oversized text still refuses', () => {
  const text = 'Repeated text. '.repeat(100);
  const literal = { turns: [{ a: text, b: text, data: { $textRef: '#/turns/0/a' } }] };
  expect(shareContextText(literal)).toBe(literal);
  const unique = { turns: [{ inputText: 'x'.repeat(97000) }] };
  expect(shareContextText(unique)).toBe(unique);
  expect(() => assertContextSize(formatTurnContext(unique), 96000)).toThrow(expect.objectContaining({ code: 'CONVERSATION_CONTEXT_REQUIRED' }));
  const short = { turns: [{ inputText: 'Hello', replyText: 'Hello' }] };
  expect(shareContextText(short)).toBe(short);
});
