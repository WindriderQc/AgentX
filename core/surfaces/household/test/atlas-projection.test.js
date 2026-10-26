'use strict';

// Life Atlas projection of Core's personal history. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const atlas = path.join(__dirname, '..', 'public', 'atlas');
const load = () => import(path.join(atlas, 'projection.js'));
const sha = c => c.repeat(64);
const entry = (n, extra = {}) => ({ id: String(n).padStart(24, 'a'), kind: 'fact', text: `Synthetic person moved to a new street ${n}.`,
  actor: '', sourceDate: '2014-06-02T14:00:00.000Z', eventDate: '', eventDateAsWritten: '', eventDatePrecision: 'unknown',
  assertionState: 'unknown', sourceStatus: '', people: ['Synthetic Friend'], places: ['Synthetic street'], relatedSources: [],
  reviewState: 'candidate', revision: 0, souvenirNoteId: '',
  source: { system: 'gmail', threadId: 'thread000001', messageId: `message0000${n}`, sourceSha256: sha('b'), findingId: sha('c') }, ...extra });

test('dates come from Core or a written date, never from the source date', async () => {
  const { projectDate } = await load();
  assert.deepEqual(projectDate(entry(1, { eventDate: '2014-07-01', eventDatePrecision: 'day' })), { date: '2014-07-01', precision: 'day', dateOrigin: 'core' });
  assert.equal(projectDate(entry(1, { eventDate: '2014-07-01T02:00:00.000Z', eventDatePrecision: 'instant' })).date, '2014-06-30');
  assert.equal(projectDate(entry(1, { eventDateAsWritten: '2014-07' })).precision, 'month');
  assert.equal(projectDate(entry(1, { eventDateAsWritten: '1997' })).precision, 'year');
  assert.equal(projectDate(entry(1, { eventDateAsWritten: '2014-02-30' })).date, null);
  assert.equal(projectDate(entry(1)).date, null);
});

test('every source system gets a stable id, and a kept souvenir shows its corrections', async () => {
  const { projectEntry, parseSourceId, isPhotoSource } = await load();
  const folder = { system: 'owner-file', locator: 'photos:Pictures/2014 synthetic trip', sourceSha256: sha('d'), findingId: sha('c') };
  const event = projectEntry(entry(1, { relatedSources: [folder, { system: 'owner-statement', sourceSha256: sha('e'), findingId: sha('c') }],
    souvenirNoteId: 'f'.repeat(24), reviewState: 'retained',
    souvenir: { id: 'f'.repeat(24), revision: 2, text: 'Corrected synthetic text.', eventDate: '2014-07-01', eventDatePrecision: 'day', people: ['A', 'B'], places: ['Town'] } }));
  assert.deepEqual(event.sourceIds, [`gmail|${sha('b')}|message00001`, `owner-file|${sha('d')}|photos:Pictures/2014 synthetic trip`, `owner-statement|${sha('e')}|`]);
  assert.deepEqual(parseSourceId(event.sourceIds[1]), { system: 'owner-file', sourceSha256: sha('d'), locator: 'photos:Pictures/2014 synthetic trip' });
  assert.deepEqual(event.photoSourceIds, [event.sourceIds[1]]);
  assert.equal(isPhotoSource(event.sourceIds[0]), false);
  assert.equal(event.date, '2014-07-01');
  assert.equal(event.description, 'Corrected synthetic text.');
  assert.deepEqual(event.people, ['A', 'B']);
  assert.equal(event.link, `#souvenir:${'f'.repeat(24)}`);
  assert.deepEqual(event.core.souvenir, { id: 'f'.repeat(24), revision: 2 });
  assert.equal(event.core.canKeep, false);
  const testimony = projectEntry(entry(2, { source: { system: 'owner-statement', sourceSha256: sha('e'), findingId: sha('c') } }));
  assert.equal(testimony.confirmationBasis, 'owner-testimony');
  assert.equal(testimony.link, `#entry:${'2'.padStart(24, 'a')}`);
});

test('comparisons group moments citing the same source and the same person on the same day', async () => {
  const { projectEntry, buildRelations } = await load();
  const events = [entry(1), entry(2, { source: entry(1).source }),
    entry(3, { source: { ...entry(3).source, sourceSha256: sha('9') }, eventDate: '2014-07-01', eventDatePrecision: 'day' }),
    entry(4, { source: { ...entry(4).source, sourceSha256: sha('8') }, eventDate: '2014-07-01', eventDatePrecision: 'day' })].map(projectEntry);
  const relations = buildRelations(events);
  assert.ok(relations.some(r => r.kind === 'hypothesis' && r.eventIds.length === 2));
  assert.ok(relations.some(r => r.kind === 'agreement' && r.title.includes('2014-07-01')));
});

test('the page code carries no personal detail and loads Core routes only', () => {
  for (const file of fs.readdirSync(atlas).filter(name => /\.(js|html|css)$/.test(name))) {
    const text = fs.readFileSync(path.join(atlas, file), 'utf8');
    assert.doesNotMatch(text, /https?:\/\/(?!mail\.google\.com)[a-z]/i, `${file} must not load an external resource`);
    assert.doesNotMatch(text, /fetch\((['"`])(?!\/api\/secretary\/)/, `${file} must call Core routes only`);
  }
});
