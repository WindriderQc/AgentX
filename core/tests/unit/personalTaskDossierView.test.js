'use strict';

const { toolView, validateView } = require('../../src/services/personalTaskDossierView');

const fixture = () => ({ id: 'a'.repeat(24), observedAt: '2030-01-01T12:00:00Z', stale: false, proposalHash: 'b'.repeat(64), decision: null,
  task: { id: '0001', revision: 2, title: 'Prepare the confirmed appointment', status: 'queued', dueAt: '2030-01-03', personalReview: { state: 'accepted' } },
  coverage: { mail: 'read', calendar: 'read', tasks: 'read', documents: 'partial' }, gaps: ['One attachment is not read.'],
  selection: { threadIds: ['a'.repeat(16)], calendarIds: ['primary'] }, existingTasks: [{ id: '0002', title: 'Another exact task' }],
  proposalSchema: { required: ['state', 'action'], properties: { action: { enum: ['keep'] } } },
  proposal: { state: 'active', action: 'keep', summary: 'Keep preparing.', actor: 'Example Person', appointment: 'Confirmed on the third.',
    remainingWork: ['Prepare the documents.'], openQuestions: ['Room unknown.'], uncertainties: ['Attachment not read.'], citations: [{ sourceId: 'mail:one', quote: 'Exact confirmation.' }] },
  sources: [{ id: 'mail:one', kind: 'mail', date: '2030-01-01T00:00:00Z', direction: 'received', relation: 'authored', truncated: false,
    text: 'Exact confirmation. ' + 'A quoted "detail", emoji 🦉 and newline\n'.repeat(900), sourceHash: 'c'.repeat(64), url: 'https://example.invalid/source' }],
  evidenceSignals: [{ sourceStatus: 'uncertain' }] });

function recover(current, view, sourceId, pageChars = 101) {
  let offset = 0, expectedHash, combined = '', pages = 0;
  do {
    const page = toolView(current, { view, ...(sourceId && { sourceId }), offset, pageChars, ...(expectedHash && { expectedHash }) });
    expect(page.offset).toBe(offset);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(6000);
    expect(page.complete).toBe(page.nextOffset === null);
    combined += page.content; pages++;
    if (page.complete) return { value: JSON.parse(combined), pages };
    expect(page.nextOffset).toBeGreaterThan(offset);
    expect(page.content.at(-1)).not.toMatch(/[\uD800-\uDBFF]/);
    offset = page.nextOffset; expectedHash = page.contentHash;
  } while (pages < 2000);
  throw Error('Pagination did not terminate');
}

test('native default is bounded metadata with explicit unread evidence; full legacy response remains exact', () => {
  const current = fixture(), before = structuredClone(current), summary = toolView(current);
  expect(summary).toMatchObject({ id: current.id, view: 'summary', sourceCount: 1, gapCount: 1, coverage: current.coverage,
    proposal: { action: 'keep', remainingWorkCount: 1, openQuestionCount: 1, citationCount: 1 } });
  expect(summary.sources).toBeUndefined();
  expect(summary.reading).toMatch(/Metadata only/);
  expect(JSON.stringify(summary).length).toBeLessThanOrEqual(6000);
  expect(toolView(current, { view: 'full' })).toBe(current);
  expect(current).toEqual(before);
});

test.each(['source', 'sources', 'proposal', 'schema', 'tasks', 'document'])('%s pages independently reconstruct exact saved values', view => {
  const current = fixture(), sourceId = view === 'source' ? 'mail:one' : undefined;
  const expected = { source: current.sources[0], sources: [{ id: 'mail:one', kind: 'mail', date: '2030-01-01T00:00:00Z',
    direction: 'received', relation: 'authored', textChars: current.sources[0].text.length, truncated: false }],
  proposal: { proposal: current.proposal, gaps: current.gaps, selection: current.selection }, schema: current.proposalSchema,
  tasks: current.existingTasks, document: current }[view];
  expect(recover(current, view, sourceId).value).toEqual(expected);
});

test('changed content cannot be spliced into a prior page, and continuation never creates another dossier', () => {
  const current = fixture(), first = toolView(current, { view: 'proposal', pageChars: 100 });
  current.proposal.remainingWork.push('A later exact change.');
  expect(() => toolView(current, { view: 'proposal', offset: first.nextOffset, expectedHash: first.contentHash }))
    .toThrow(expect.objectContaining({ status: 409, code: 'PERSONAL_DOSSIER_VIEW_CONFLICT' }));
  for (const input of [{ view: 'source', sourceId: 'other' }, { view: 'sources', offset: -1 },
    { view: 'sources', offset: 1 }, { view: 'sources', pageChars: 99999 }, { view: 'summary', offset: 0 }]) {
    expect(() => toolView(current, input)).toThrow();
  }
  expect(() => validateView({ action: 'read', view: 'source', sourceId: 'mail:one' })).toThrow();
});

test('escape-heavy input stays bounded without losing a character or hiding a source limitation', () => {
  const current = fixture();current.sources[0].text = '\u0001"\n🦉'.repeat(2000);current.sources[0].truncated = true;
  current.proposal.summary = '\u0001'.repeat(1200);
  const overview = toolView(current);
  expect(JSON.stringify(overview).length).toBeLessThanOrEqual(6000);
  expect(overview.proposal.fieldsInPagedProposal).toContain('summary');
  expect(recover(current, 'source', 'mail:one', 2000).value).toEqual(current.sources[0]);
  expect(recover(current, 'proposal', undefined, 2000).value.proposal.summary).toBe(current.proposal.summary);
});
