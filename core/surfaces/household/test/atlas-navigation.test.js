'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const atlas = path.join(__dirname, '..', 'public', 'atlas');
const load = name => import(path.join(atlas, `${name}.js`));

test('chapters use life moments, excluding third-party archive dates while including kept owner memories', async () => {
  const { buildChapters } = await load('chapters');
  const event = (id, year, extra) => ({ id, title: id, date: `${year}-07-01`, precision: 'year', category: 'work', reviewState: 'unreviewed', ...extra });
  const thirdParty = [1, 2, 3].map(n => event(`unrelated-${n}`, 1970, { metadata: { subject: 'thirdparty' } }));
  const owner = [1, 2].map(n => event(`owner-${n}`, 2004, { curated: true }));
  const memory = event('kept-owner-memory', 2005, { core: { souvenirNoteId: 'native-owner-choice' } });
  const all = [...thirdParty, ...owner, memory], chapters = buildChapters(all);
  assert.equal(chapters.length, 1);assert.equal(chapters[0].decade, 2000);
  assert.deepEqual(chapters[0].members.map(e => e.id), ['owner-1', 'owner-2', 'kept-owner-memory']);
  assert.equal(all.length, 6); // Navigation filtering never removes archive observations.
  const ongoing = buildChapters(owner.concat(event('ongoing', 2006, { curated: true })).map(e => ({ ...e, ongoing: true })))[0];
  assert.ok(Number.isFinite(ongoing.first));assert.ok(Number.isFinite(ongoing.last));assert.ok(ongoing.last > ongoing.first);
});

test('calendar zoom retains the selected day and uses the current window after panning elsewhere', async () => {
  const { scaleCenter } = await load('navigation');
  const selected = Date.UTC(2012, 6, 13, 12), domain = [Date.UTC(1970, 0, 1), Date.UTC(2027, 0, 1)];
  assert.equal(scaleCenter(domain, domain, selected), selected);
  assert.equal(scaleCenter([Date.UTC(2012, 0, 1), Date.UTC(2013, 0, 1)], domain, selected), selected);
  assert.equal(scaleCenter([Date.UTC(2012, 6, 1), Date.UTC(2012, 7, 1)], domain, selected), selected);
  const elsewhere = [Date.UTC(2018, 0, 1), Date.UTC(2019, 0, 1)];
  assert.equal(scaleCenter(elsewhere, domain, selected), (elsewhere[0] + elsewhere[1]) / 2);
});

test('a truncated native response stays visibly partial after decisions and clears on a complete reload', async () => {
  const data = await load('data'), { coverageNotice } = await load('coverage'), { matchesReview } = await load('filters');
  const original = global.fetch;
  const entry = { id: 'a'.repeat(24), text: 'Synthetic fact', kind: 'fact', revision: 0, assertionState: 'unknown', reviewState: 'candidate',
    source: { system: 'document' }, contextRevision: 0 };
  try {
    global.fetch = async (_url, options) => ({ ok: true, json: async () => ({ status: 'success', data: options?.method === 'POST'
      ? { entry: { ...entry, revision: 1, assertionState: 'confirmed', confirmationCurrent: true } }
      : { entries: [entry], truncated: true, readAt: '2026-01-01T00:00:00Z' } }) });
    const loaded = await data.loadHistory();assert.equal(loaded.meta.truncated, true);
    assert.match(coverageNotice(loaded.meta), /Au moins 1 relevés chargés/);assert.match(coverageNotice(loaded.meta), /une partie de l’historique n’est pas affichée/);
    const confirmed = await data.confirm(loaded.events[0]);assert.equal(confirmed.meta.truncated, true);
    assert.equal(matchesReview(loaded.events[0], 'pending'), true);assert.equal(matchesReview(confirmed.event, 'pending'), false);
    global.fetch = async () => ({ ok: true, json: async () => ({ status: 'success', data: { entries: [entry], truncated: false } }) });
    assert.equal(coverageNotice((await data.loadHistory()).meta), '');
  } finally { global.fetch = original; }
});
