'use strict';

const { shareContextValues } = require('../../src/services/conversations/sharedContextValues');
const { shareToolEvidence } = require('../../src/services/conversations/sharedToolEvidence');
const { formatTurnContext, assertContextSize } = require('../../src/services/conversations/turnContext');
const { expandedContext } = require('../helpers/expandedContext');

const envelope = snapshots => ({ authority: 'core.conversations', turns: snapshots.map((data, index) => ({
  turnId: `turn-${index}`, workResults: [{ workId: `work-${index}`, receiptIds: [`receipt-${index}`],
    toolEvidence: [{ id: `receipt-${index}`, runId: `run-${index}`, status: 'verified', data }] }]
})) });

test('changed task snapshots retain every version and identity, including calculated ages and changed titles', () => {
  const snapshots = Array.from({ length: 3 }, (_, version) => ({ tasks: Array.from({ length: 8 }, (_, index) => ({
    id: `synthetic-task-${index}`, title: `Task ${index}: ` + 'Complete subject. '.repeat(20),
    details: 'Complete source detail. '.repeat(20), ageDays: 20 + version,
    dueDate: version && !index ? '2026-02-01' : null, revision: version && !index ? 2 : 1
  })), totalCount: 8 }));
  snapshots[2].tasks[0].title = 'Corrected current task: ' + 'Exact new title. '.repeat(20);
  const original = envelope(snapshots), snapshot = structuredClone(original);
  const projected = shareToolEvidence(original);
  expect(projected.sharedValueEncoding.name).toBe('core.shared-context-values/v1');
  expect(JSON.stringify(projected)).toContain('$valuePatch');
  expect(expandedContext(projected)).toEqual(original);
  expect(original).toEqual(snapshot);
  expect(shareToolEvidence(projected)).toBe(projected);
  expect(projected.turns.map(turn => turn.workResults[0].toolEvidence[0].id))
    .toEqual(['receipt-0', 'receipt-1', 'receipt-2']);
  expect(projected.turns.map(turn => turn.workResults[0].toolEvidence[0].runId)).toEqual(['run-0', 'run-1', 'run-2']);
  const complete = { ...original, unrelatedCompleteHistory: 'UNIQUE_HISTORY '.repeat(5600) };
  expect(JSON.stringify(complete).length).toBeGreaterThan(96000);
  expect(() => assertContextSize(formatTurnContext(complete), 96000)).not.toThrow();
  expect(expandedContext(shareToolEvidence(complete))).toEqual(complete);
});

test('nested and overlapping repeated values, arrays and escaped paths reconstruct without reference cycles', () => {
  const leaf = { 'a/b~c': 'Exact nested string. '.repeat(40) };
  const data = { first: { nested: leaf, note: 'first' }, copies: [leaf, { nested: leaf, note: 'second' }],
    date: new Date('2026-01-01T00:00:00Z') };
  const original = envelope([data, { ...data, copies: [leaf, leaf], date: new Date('2026-01-02T00:00:00Z') }]);
  expect(expandedContext(shareToolEvidence(original))).toEqual(original);
});

test.each(['$valueRef', '$valueBase', '$valuePatch'])('literal caller marker %s disables value projection', marker => {
  const data = { details: 'Exact data. '.repeat(100), [marker]: '#/caller-literal' };
  const original = envelope([data, data]);
  expect(shareContextValues(original)).toBe(original);
});

test('whole-result dictionary forward references never become patch bases or introduce cross-encoding cycles', () => {
  const text = 'Exact large value. '.repeat(100);
  const original = { ...envelope([{ text, child: { $ref: '#/sharedToolEvidence/one' } }]),
    sharedToolEvidence: { one: { text, child: { leaf: 'Final source detail' } } },
    evidenceEncoding: { name: 'core.shared-tool-evidence/v1' } };
  const expected = expandedContext(original), projected = shareToolEvidence(original);
  expect(expandedContext(projected)).toEqual(expected);
  expect(projected.sharedToolEvidence.one.$valueBase).toBeUndefined();
});

test('property deletions, changed key ordering, nulls and false values survive JSON reconstruction', () => {
  const details = 'Complete detail. '.repeat(80);
  const original = envelope([{ details, a: true, b: null }, { b: false, details, a: 0 },
    { details, b: null }, { details, b: null, a: undefined }]);
  expect(JSON.stringify(expandedContext(shareToolEvidence(original)))).toBe(JSON.stringify(original));
});
