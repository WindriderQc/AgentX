'use strict';

// Life Atlas projection of Core's personal history and its contexts. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const atlas = path.join(__dirname, '..', 'public', 'atlas');
const load = () => import(path.join(atlas, 'projection.js'));
const sha = c => c.repeat(64);
const id = n => String(n).padStart(24, 'a');
const entry = (n, extra = {}) => ({ id: id(n), kind: 'fact', text: `Synthetic person moved to a new street ${n}.`,
  actor: '', sourceDate: '2014-06-02T14:00:00.000Z', eventDate: '', eventDateAsWritten: '', eventDatePrecision: 'unknown',
  assertionState: 'unknown', sourceStatus: '', people: ['Synthetic Friend'], places: ['Synthetic street'], relatedSources: [],
  reviewState: 'candidate', revision: 0, souvenirNoteId: '', contextRevision: 0, timeline: null, context: null,
  source: { system: 'gmail', threadId: 'thread000001', messageId: `message0000${n}`, sourceSha256: sha('b'), findingId: sha('c') }, ...extra });
const context = (legacyId, timeline = {}, extra = {}) => ({ contextRevision: 2,
  timeline: { legacyId, title: `Synthetic moment ${legacyId}`, category: 'home', date: '2004', precision: 'year', endDate: '2006-08', endPrecision: 'month',
    ongoing: false, hypothesis: false, occurrenceStatus: 'documented', sourceIds: ['doc-1'], ...timeline },
  context: { sources: [{ id: 'doc-1', kind: 'document', subject: 'Synthetic lease', nativePath: '/Host/datalake/lease.pdf', contentSha256: sha('d') }],
    relations: [], media: [], ownerEditedAt: null, ...extra } });

test('native dates come from Core or a written date, never from the source date', async () => {
  const { projectDate } = await load();
  assert.deepEqual(projectDate(entry(1, { eventDate: '2014-07-01', eventDatePrecision: 'day' })), { date: '2014-07-01', precision: 'day', dateOrigin: 'core' });
  assert.equal(projectDate(entry(1, { eventDate: '2014-07-01T02:00:00.000Z', eventDatePrecision: 'instant' })).date, '2014-06-30');
  assert.equal(projectDate(entry(1, { eventDateAsWritten: '2014-07' })).precision, 'month');
  assert.equal(projectDate(entry(1, { eventDateAsWritten: '2014-02-30' })).date, null);
  assert.equal(projectDate(entry(1)).date, null);
});

test('a context gives the moment its title, partial dates, period, quotes and editable state', async () => {
  const { projectEntry, parseSourceId } = await load();
  const event = projectEntry(entry(1, context('lease', { claimsWithExactQuotes: [{ sourceId: 'doc-1', quote: 'lease signed' }],
    narrative: { chapterId: 'c1', pathId: 'p1', order: 2, label: 'First home' } })));
  assert.equal(event.title, 'Synthetic moment lease');
  assert.deepEqual([event.date, event.precision, event.endDate, event.endPrecision], ['2004-07-01', 'year', '2006-08-15', 'month']);
  assert.equal(event.occurrenceStatus, 'documented');
  assert.deepEqual(event.sourceIds, [`gmail|${sha('b')}|message00001`, `ctx|${id(1)}|doc-1`]);
  assert.deepEqual(parseSourceId(event.sourceIds[1]), { system: 'ctx', entryId: id(1), sourceId: 'doc-1' });
  assert.equal(event.claimsWithExactQuotes[0].sourceId, `ctx|${id(1)}|doc-1`);
  assert.deepEqual(event.evidenceCheck, { status: 'passed', quoteCount: 1 });
  assert.equal(event.core.canEdit, true);
  assert.equal(event.contextRevision, 2);
  assert.equal(event.narrative.label, 'First home');
});

test('a kept souvenir shows its corrections and can no longer be edited as a candidate', async () => {
  const { projectEntry } = await load();
  const event = projectEntry(entry(1, { ...context('lease'), souvenirNoteId: 'f'.repeat(24), reviewState: 'retained',
    souvenir: { id: 'f'.repeat(24), revision: 2, text: 'Corrected synthetic text.', eventDate: '2005', eventDatePrecision: 'year', people: ['A'], places: ['Town'] } }));
  assert.equal(event.description, 'Corrected synthetic text.');
  assert.deepEqual([event.date, event.precision], ['2005-07-01', 'year']);
  assert.equal(event.link, `#souvenir:${'f'.repeat(24)}`);
  assert.equal(event.core.canKeep, false);
  assert.equal(event.core.canEdit, false);
  assert.equal(event.reviewState, 'unreviewed');
});

test('context relations keep their quoted evidence; derived comparisons still apply', async () => {
  const { projectEntry, buildRelations } = await load();
  const relation = { id: 'r1', kind: 'sequence', title: 'From lease to purchase', eventIds: ['lease', 'purchase'], summary: 'Synthetic steps',
    claimsWithExactQuotes: [{ sourceId: 'doc-1', quote: 'lease signed' }] };
  const events = [projectEntry(entry(1, context('lease', {}, { relations: [relation] }))), projectEntry(entry(2, context('purchase'))),
    projectEntry(entry(3)), projectEntry(entry(4, { source: entry(3).source }))];
  const relations = buildRelations(events);
  const recorded = relations.find(r => r.key === 'r1');
  assert.deepEqual(recorded.eventIds, [`core-${id(1)}`, `core-${id(2)}`]);
  assert.equal(recorded.kind, 'sequence');
  assert.equal(recorded.claimsWithExactQuotes[0].sourceId, `ctx|${id(1)}|doc-1`);
  assert.ok(relations.some(r => r.kind === 'hypothesis' && r.eventIds.includes(`core-${id(3)}`)));
});

test('photos bound in a context are served by Core and linked to their moments', async () => {
  const { projectEntry, collectMedia } = await load();
  const media = [{ id: 'm1', originalPath: '/Host/images/trip/beach.jpg', sourceContentSha256: sha('e'), candidateEventIds: ['lease', 'purchase'], date: '2005-05', datePrecision: 'month', album: 'Trip' }];
  const events = [projectEntry(entry(1, context('lease', {}, { media }))), projectEntry(entry(2, context('purchase')))];
  const [photo] = collectMedia(events);
  assert.equal(photo.url, `/api/secretary/files/content?nativePath=${encodeURIComponent('/Host/images/trip/beach.jpg')}&sha256=${sha('e')}`);
  assert.equal(photo.thumb, `${photo.url}&width=480`);
  assert.deepEqual(photo.eventIds.sort(), [`core-${id(1)}`, `core-${id(2)}`]);
  assert.deepEqual([photo.date, photo.precision], ['2005-05-15', 'month']);
});

test('the page code carries no personal detail and calls Core routes only', () => {
  for (const file of fs.readdirSync(atlas).filter(name => /\.(js|html|css)$/.test(name))) {
    const text = fs.readFileSync(path.join(atlas, file), 'utf8');
    assert.doesNotMatch(text, /https?:\/\/(?!mail\.google\.com)[a-z]/i, `${file} must not load an external resource`);
    assert.doesNotMatch(text, /fetch\((['"`])(?!\/api\/(?:secretary|photos)\/)/, `${file} must call Core routes only`);
  }
});
