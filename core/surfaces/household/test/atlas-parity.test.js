'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const atlas = path.join(__dirname, '..', 'public', 'atlas');
const load = name => import(path.join(atlas, `${name}.js`));
const id = 'a'.repeat(24), hash = 'b'.repeat(64);
const base = (timeline = {}, extra = {}) => ({ id, revision: 2, contextRevision: 4, reviewState: 'candidate', assertionState: 'unknown',
  kind: 'fact', text: 'A synthetic childhood period.', source: { system: 'testimony' },
  timeline: { legacyId: 'school', title: 'Synthetic school', category: 'work', date: '1990', precision: 'year',
    endDate: '1994', endPrecision: 'year', sourceIds: ['source'], claimsWithExactQuotes: [], ...timeline },
  context: { sources: [{ id: 'source', bodySha256: hash }], ownerEdits: [], relations: [], media: [] }, ...extra });

test('retention and a souvenir do not confirm facts; current explicit confirmation does', async () => {
  const { projectEntry } = await load('projection');
  assert.equal(projectEntry(base({}, { reviewState: 'retained', souvenirNoteId: 'f'.repeat(24) })).reviewState, 'unreviewed');
  assert.equal(projectEntry(base({ reviewState: 'hypothesis' })).reviewState, 'hypothesis');
  assert.equal(projectEntry(base({ claimType: 'hypothesis' })).reviewState, 'hypothesis');
  assert.equal(projectEntry(base({ confirmationBasis: 'owner-tentative' })).reviewState, 'hypothesis');
  assert.equal(projectEntry(base({ confirmationBasis: 'owner-testimony' })).reviewState, 'unreviewed');
  assert.equal((await load('review')).reviewLabel(projectEntry(base({ confirmationBasis: 'owner-tentative' }))), 'Déclaré par toi');
  assert.equal(projectEntry(base({ confirmationBasis: 'owner-testimony' }, { context: { sources: [], ownerEdits: [{}] } })).reviewState, 'unreviewed');
  assert.equal(projectEntry(base({}, { assertionState: 'confirmed', confirmationCurrent: true })).reviewState, 'confirmed');
  const stale = projectEntry(base({}, { assertionState: 'unknown', recordedAssertionState: 'confirmed', confirmationCurrent: false }));
  assert.equal(stale.reviewState, 'unreviewed');
  assert.match((await load('review')).reviewLabel(stale), /Modifié depuis/);
});

test('keeping a typed context preserves age uncertainty, including after a later import', async () => {
  const { projectEntry } = await load('projection'), { temporalExtent } = await load('temporal');
  const temporal = { date: '1990', precision: 'year', endDate: '1994', endPrecision: 'year',
    ageStartWindow: { start: '1989-09-03', end: '1990-09-03' }, ageEndWindow: { start: '1993-09-03', end: '1994-09-03' }, ownerTimeLabel: 'Vers cet âge' };
  const raw = base(temporal, { souvenirNoteId: 'f'.repeat(24), souvenir: { revision: 0, eventDate: '1990', eventDatePrecision: 'year',
    historyContext: { contextRevision: 4, temporal } } });
  const event = projectEntry(raw), extent = temporalExtent(event);
  assert.equal(extent.kind, 'period');assert.equal(extent.start, Date.parse('1989-09-03T00:00:00Z'));
  assert.equal(extent.end, Date.parse('1994-09-03T00:00:00Z'));assert.equal(event.ownerTimeLabel, 'Vers cet âge');
  const later = projectEntry({ ...raw, contextRevision: 5, timeline: { ...raw.timeline, date: '1992', endDate: '1996' } });
  assert.equal(later.date, '1990-07-01');assert.equal(later.endDate, '1994-07-01');assert.equal(later.core.souvenirContextCurrent, false);
  const corrected = projectEntry({ ...raw, souvenir: { ...raw.souvenir, revision: 1, eventDate: '1991-02-04', eventDatePrecision: 'day' } });
  assert.equal(corrected.date, '1991-02-04');assert.equal(corrected.ageStartWindow, null);assert.equal(corrected.ownerTimeLabel, null);
  const textOnly = projectEntry({ ...raw, souvenir: { ...raw.souvenir, revision: 1, text: 'Only the wording was corrected.' } });
  assert.deepEqual(textOnly.ageStartWindow, temporal.ageStartWindow);assert.equal(textOnly.core.canConfirm, false);
  const confirmedDifferentMemory = projectEntry({ ...raw, assertionState: 'confirmed', confirmationCurrent: true,
    souvenir: { ...raw.souvenir, revision: 1, text: 'A different claim in memory.' } });
  assert.notEqual(confirmedDifferentMemory.reviewState, 'confirmed');
});

test('native partial dates and ongoing periods retain their actual precision', async () => {
  const { projectDate, projectEntry } = await load('projection'), { temporalExtent } = await load('temporal');
  assert.deepEqual(projectDate({ eventDate: '1990', eventDatePrecision: 'year' }), { date: '1990-07-01', precision: 'year', dateOrigin: 'core' });
  assert.equal(projectDate({ eventDate: '1990-02', eventDatePrecision: 'month' }).precision, 'month');
  const e = projectEntry(base({ date: '1990-02', precision: 'month', ongoing: true, endDate: null }));
  assert.equal(temporalExtent(e, Date.parse('1995-01-01')).end, Date.parse('1995-01-01'));
});

test('one-moment source comparisons and distinct recorded relations survive projection', async () => {
  const { projectEntry, buildRelations } = await load('projection');
  const relation = n => ({ id: `r${n}`, title: `Comparison ${n}`, kind: 'conflict', eventIds: ['old-school'],
    sourceIndependence: 'not-established', claimsWithExactQuotes: [{ sourceId: 'source', quote: 'two dates' }] });
  const event = projectEntry(base({ legacyIds: ['old-school'] }, { context: { sources: [{ id: 'source' }], relations: [relation(1), relation(2)] } }));
  const recorded = buildRelations([event]).filter(r => r.recorded);
  assert.equal(recorded.length, 2);assert.deepEqual(recorded[0].eventIds, [`core-${id}`]);
  assert.equal(recorded[0].id, 'recorded-r1');assert.equal(recorded[0].sourceIndependence, 'not-established');
});

test('photos resolve explicit native and legacy bindings, leaving unbound media unbound', async () => {
  const { projectEntry, collectMedia } = await load('projection');
  const assetId = '12345678-abcd-1234-abcd-123456789abc';
  const m = { id: 'library-photo', provenance: { system: 'agentx.photos', assetId }, candidateEventIds: [id] };
  const events = [projectEntry(base({}, { context: { sources: [], media: [m, { ...m, id: 'unbound', candidateEventIds: [] }] } }))];
  const photos = collectMedia(events);
  assert.equal(photos[0].url, `/api/photos/assets/${assetId}/thumbnail?size=preview`);
  assert.deepEqual(photos[0].eventIds, [`core-${id}`]);assert.deepEqual(photos[1].eventIds, []);
});

test('filters and personal subjects group records without changing their truth state', async () => {
  const { projectEntry } = await load('projection'), { matchesSubject, matchesIntent } = await load('filters');
  const { storyThreads, threadMatches } = await load('story-threads');
  const event = projectEntry(base({ confirmationBasis: 'owner-tentative', metadata: { subject: 'owner' }, occurrenceStatus: 'planned' }));
  assert.equal(matchesSubject(event, 'owner'), true);assert.equal(matchesSubject(event, 'thirdparty'), false);
  assert.equal(matchesSubject({ ...event, metadata: {} }, 'owner'), false);assert.equal(matchesSubject({ ...event, metadata: {} }, 'unknown'), true);
  assert.equal(matchesSubject({ ...event, metadata: { subject: 'related' } }, 'related'), true);
  assert.equal(matchesIntent(event, 'without-intentions'), false);assert.equal(matchesIntent(event, 'intentions'), true);
  const [thread] = storyThreads([{ id: 'school', label: 'School', eventIds: ['school'], queries: [] }]);
  assert.equal(threadMatches([event], thread).length, 1);assert.equal(event.reviewState, 'hypothesis');
});

test('coverage selects the latest active objective and separates copies from complete readings', async () => {
  const { activeLifeReviews, nativeCoverage } = await load('coverage');
  const reviews = [{ objectiveId: 'life-timeline', version: 'v2', phase: 'running', counts: { sourcesTextReviewed: 4, targetSources: 20, sourcesTextCovered: 12, equivalentPages: 8 } },
    { objectiveId: 'life-timeline', version: 'v1', phase: 'done', counts: { sourcesTextReviewed: 999 } },
    { objectiveId: 'life-timeline', version: 'v3', phase: 'superseded' }];
  assert.equal(activeLifeReviews(reviews)[0].version, 'v2');
  const html = nativeCoverage({ objectiveReviews: reviews });
  assert.match(html, /4 textes de source relus au complet sur 20/);assert.match(html, /12 fichiers sont couverts/);
  assert.match(html, /Ce sont des copies/);assert.match(html, /Lecture générale|Dernière reprise/);assert.doesNotMatch(html, /999|v1/);
});

test('confirmation sends both revisions to review and never creates a souvenir; conflicts remain errors', async () => {
  const data = await load('data'), { projectEntry } = await load('projection');
  const saved = global.fetch, requests = [];
  try {
    global.fetch = async (url, options) => { requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ status: 'success', data: { entry: base({}, { assertionState: 'confirmed', confirmationCurrent: true }) } }) }; };
    const answer = await data.confirm(projectEntry(base()));
    assert.equal(requests.length, 1);assert.equal(requests[0].url, `/api/secretary/history/${id}/review`);
    assert.deepEqual([requests[0].body.revision, requests[0].body.contextRevision, requests[0].body.assertionState], [2, 4, 'confirmed']);
    assert.equal(answer.event.reviewState, 'confirmed');
    global.fetch = async () => ({ ok: false, status: 409, json: async () => ({ message: 'Context changed' }) });
    await assert.rejects(data.confirm(projectEntry(base())), /a changé/);
  } finally { global.fetch = saved; }
});

test('source panels distinguish excerpts, published selections and copies from full originals', async () => {
  const { projectContextSource } = await load('projection'), { sourcePanel } = await load('evidence');
  const selected = projectContextSource('source', { kind: 'document', subject: 'Synthetic published table', body: 'Selected cells only',
    bodySha256: hash, provenance: { bodyScope: 'selected-factual-table-cells-not-full-pdf', originalBinaryRead: false },
    nativeRef: { url: 'https://example.invalid/report.pdf', page: 3 } });
  const html = sourcePanel(selected);
  assert.match(html, /pas le PDF intégral/);assert.match(html, /binaire original n’a pas été lu/);assert.match(html, /Référence publiée · page 3/);
  assert.doesNotMatch(html, /Document de ton Datalake/);
  const copy = sourcePanel({ ...selected, bodyScope: 'verified-equivalent-unit-not-read-by-model' });
  assert.match(copy, /n’a pas été relue par le modèle/);assert.match(copy, /pas un témoignage indépendant/);
  const metadata = projectContextSource('photo-metadata', { kind: 'media', metadataOnly: true, body: '{"cameraDate":"2001-06-12"}', bodySha256: hash });
  assert.equal(metadata.body, '{"cameraDate":"2001-06-12"}');
  assert.match(sourcePanel(metadata), /Métadonnées conservées/);assert.match(sourcePanel(metadata), /cameraDate/);
});
