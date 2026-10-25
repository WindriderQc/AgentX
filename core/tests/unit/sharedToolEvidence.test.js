'use strict';

const { shareToolEvidence } = require('../../src/services/conversations/sharedToolEvidence');
const { formatTurnContext, assertContextSize } = require('../../src/services/conversations/turnContext');

function expand(value) {
  const decoded = structuredClone(value);
  for (const turn of decoded.turns) for (const work of turn.workResults || []) for (const receipt of work.toolEvidence) {
    const ref = receipt.data?.$ref;
    if (ref?.startsWith('#/sharedToolEvidence/')) receipt.data = structuredClone(decoded.sharedToolEvidence[ref.split('/').at(-1)]);
  }
  delete decoded.sharedToolEvidence;
  delete decoded.evidenceEncoding;
  return decoded;
}

const source = () => ({ authority: 'core.conversations', sessionId: 'synthetic-owner-session',
  coverage: { complete: true, turnCount: 3, workResultCount: 3 },
  turns: Array.from({ length: 3 }, (_, index) => ({ turnId: `turn-${index}`, inputText: `Complete request ${index}`,
    replyText: `Guardian ${index}`, workResults: [{ workId: `work-${index}`, text: `Complete answer ${index}`,
      receiptIds: [`receipt-${index}`], presentation: { state: index ? 'available' : 'completed' },
      toolEvidence: [{ id: `receipt-${index}`, runId: `run-${index}`, tool: 'tasks.personal.list', status: 'verified',
        data: { tasks: [{ id: 'synthetic-task', title: 'école 🐈 '.repeat(4000) + ' LAST_SOURCE_DETAIL' }], totalCount: 1 } }] }] })) });

test('complete repeated evidence fits without losing any turn, value, receipt or presentation', () => {
  const original = source(), snapshot = structuredClone(original), projected = shareToolEvidence(original);
  expect(JSON.stringify(original).length).toBeGreaterThan(96000);
  expect(() => assertContextSize(formatTurnContext(original), 96000)).not.toThrow();
  expect(Object.keys(projected.sharedToolEvidence)).toHaveLength(1);
  expect(expand(projected)).toEqual(original);
  expect(original).toEqual(snapshot);
  expect(shareToolEvidence(projected)).toBe(projected);
  expect(formatTurnContext(original)).toContain('LAST_SOURCE_DETAIL');
});

test('changed evidence, small data and caller strings that look like references stay distinct', () => {
  const original = source();
  original.turns[2].workResults[0].toolEvidence[0].data.totalCount = 2;
  original.turns[0].workResults[0].toolEvidence.push({ id: 'literal-reference', data: { $ref: '#/untrusted-source' } });
  const projected = shareToolEvidence(original);
  expect(expand(projected)).toEqual(original);
  expect(projected.turns[2].workResults[0].toolEvidence[0].data.totalCount).toBe(2);
  expect(projected.turns[0].workResults[0].toolEvidence[1].data.$ref).toBe('#/untrusted-source');
});

test('unique oversized evidence still refuses and ordinary conversations retain their existing shape', () => {
  const original = source(); original.turns = original.turns.slice(0, 1);
  original.turns[0].workResults[0].toolEvidence[0].data.tasks[0].title = 'x'.repeat(100000);
  expect(shareToolEvidence(original)).toBe(original);
  expect(() => assertContextSize(formatTurnContext(original), 96000)).toThrow(expect.objectContaining({ code: 'CONVERSATION_CONTEXT_REQUIRED' }));
  const short = { turns: [{ inputText: 'Bonjour', replyText: 'Bonjour.' }] };
  expect(shareToolEvidence(short)).toBe(short);
});
