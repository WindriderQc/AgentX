'use strict';

const { createHash } = require('node:crypto');
const { referenceEarlierToolEvidence, summarizeToolEvidence } = require('../../src/services/conversations/toolEvidenceReferences');

const id = n => String(n).repeat(64).slice(0, 64);
const tasks = (label, size = 3000) => ({ tasks: [{ id: 't', title: label + ' ' + 'x'.repeat(size) }, { title: 'Second' }], totalCount: 7 });
const work = (n, data, tool = 'tasks.personal.list') => ({ workId: id(n), text: `Answer ${n}`, receiptIds: [id(n + 1)],
  toolEvidence: [{ id: id(n + 1), tool, status: 'verified', runId: 'resp_x', data }] });
const conversation = works => ({ coverage: { complete: true }, turns: works.map((w, i) => ({ turnId: `t${i}`, inputText: `Q${i}`, workResults: [w] })) });

test('earlier evidence becomes an exact ref with a deterministic summary; the latest work stays inline', () => {
  const source = conversation([work(1, tasks('OLD')), work(3, tasks('MID')), work(5, tasks('NEW'))]);
  const before = JSON.stringify(source);
  const projected = referenceEarlierToolEvidence(source);
  expect(JSON.stringify(source)).toBe(before);
  const evidence = projected.turns.map(turn => turn.workResults[0].toolEvidence[0]);
  expect(evidence[2].data).toEqual(source.turns[2].workResults[0].toolEvidence[0].data);
  for (const [index, item] of evidence.slice(0, 2).entries()) {
    const original = source.turns[index].workResults[0].toolEvidence[0];
    const text = JSON.stringify(original.data);
    expect(item.data.$evidence).toEqual({ ref: `${source.turns[index].workResults[0].workId}/${original.id}`,
      sha256: createHash('sha256').update(text).digest('hex'), chars: text.length,
      summary: { kind: 'tasks', totalCount: 7, returned: 2, titles: [expect.stringMatching(/…$/), 'Second'] } });
    expect(item).toMatchObject({ id: original.id, tool: original.tool, status: 'verified', runId: 'resp_x' });
  }
  expect(projected.turns.map(turn => turn.workResults[0].text)).toEqual(['Answer 1', 'Answer 3', 'Answer 5']);
  expect(projected.evidenceReferenceEncoding).toMatchObject({ name: 'core.tool-evidence-references/v1', keepLatestWorks: 1, referenced: 2 });
  // Both earlier 3,000-character payloads leave the wire; their summaries stay bounded.
  expect(JSON.stringify(projected).length).toBeLessThan(before.length - 4000);
  expect(referenceEarlierToolEvidence(projected)).toBe(projected);
});

test('small evidence, a single work and malformed identities stay unchanged', () => {
  const small = conversation([work(1, { tasks: [], totalCount: 0 }), work(3, tasks('NEW'))]);
  expect(referenceEarlierToolEvidence(small)).toBe(small);
  const single = conversation([work(1, tasks('ONLY'))]);
  expect(referenceEarlierToolEvidence(single)).toBe(single);
  const malformed = conversation([{ ...work(1, tasks('OLD')), workId: 'not-a-work' }, work(3, tasks('NEW'))]);
  expect(referenceEarlierToolEvidence(malformed)).toBe(malformed);
});

test('summaries name native consultation outcomes and bound generic previews', () => {
  expect(summarizeToolEvidence('native.consultation', { run: { status: 'completed' }, answer: { text: 'abc' },
    toolChecks: { completedTools: ['conversation_work', 'web_fetch'] } }))
    .toEqual({ kind: 'native_consultation', runStatus: 'completed', answerChars: 3, completedTools: ['conversation_work', 'web_fetch'] });
  const generic = summarizeToolEvidence('other', { a: 'y'.repeat(1000), b: 1 });
  expect(generic).toMatchObject({ kind: 'object', keys: ['a', 'b'] });
  expect(generic.preview.length).toBeLessThanOrEqual(240);
  expect(summarizeToolEvidence('other', [1, 2, 3])).toMatchObject({ kind: 'array', length: 3 });
});
