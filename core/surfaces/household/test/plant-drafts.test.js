'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { careDraft, identificationCandidates, safeAgeBand } = require('../../../src/domains/household/plantDrafts');

test('identification keeps up to three cleaned candidates, most likely first, and refuses non-JSON output', () => {
  const candidates = identificationCandidates(JSON.stringify({ candidates: [
    { commonName: 'Philodendron', latinName: 'Philodendron hederaceum', confidence: 0.1, traits: 'feuilles fines' },
    { commonName: '  Pothos doré ', latinName: 'Epipremnum aureum', confidence: 1.4, traits: 'panachures jaunes' },
    { commonName: '', latinName: 'Nameless', confidence: 0.5 },
    { commonName: 'Scindapsus', latinName: 'Scindapsus pictus', confidence: 0.03, traits: 'taches argentées' },
    { commonName: 'Fourth', latinName: 'Ignored', confidence: 0.9 }
  ] }));
  assert.deepEqual(candidates.map(candidate => [candidate.commonName, candidate.confidence]),
    [['Pothos doré', 1], ['Philodendron', 0.1]]);
  assert.deepEqual(identificationCandidates('{"candidates":[]}'), []);
  assert.throws(() => identificationCandidates('Sure! It is a pothos.'), { code: 'PLANT_ASSIST_INVALID_OUTPUT' });
  assert.throws(() => identificationCandidates('{"species":"pothos"}'), { code: 'PLANT_ASSIST_INVALID_OUTPUT' });
});

const results = [{ url: 'https://example.org/care' }, { url: 'https://example.org/toxicity' }];
const answer = (overrides = {}) => JSON.stringify({
  careSheet: { light: { text: 'Lumière vive, indirecte.', sources: [1] }, water: { text: 'Quand le dessus est sec.', sources: [1, 7, 'x'] },
    humidity: { text: 'Normale.', sources: [] }, invented: { text: 'ignored', sources: [1] } },
  toxicity: { children: { level: 'toxic', note: 'Irrite la bouche.', sources: [2] }, cats: { level: 'toxic', note: '', sources: [2] },
    dogs: { level: 'deadly', note: '', sources: [] } },
  funFact: 'Il grimpe aux arbres.',
  carePlan: [
    { title: 'Vérifier la terre', note: 'Avec ton doigt.', cadence: 'weekly', stars: 1, minAgeBand: 'little' },
    { title: 'Arroser le pothos', note: 'Un verre d’eau.', cadence: 'interval', intervalDays: 7, winterIntervalDays: 14, stars: 2, minAgeBand: 'school' },
    { title: 'Donner de l’engrais', note: 'Une fois par mois.', cadence: 'interval', intervalDays: 400, stars: 3, minAgeBand: 'little' },
    { title: 'arroser le pothos', note: 'duplicate', cadence: 'weekly', stars: 1, minAgeBand: 'little' }
  ],
  ...overrides
});

test('a care draft cites only the searched results, never confirms toxicity and bounds every action for children', () => {
  const draft = careDraft(answer(), results);
  assert.deepEqual(draft.careSheet.light, { text: 'Lumière vive, indirecte.', sources: ['https://example.org/care'] });
  assert.deepEqual(draft.careSheet.water.sources, ['https://example.org/care']);
  assert.equal(draft.careSheet.invented, undefined);
  assert.deepEqual(draft.toxicity.children, { level: 'toxic', note: 'Irrite la bouche.', sources: ['https://example.org/toxicity'] });
  assert.equal(draft.toxicity.dogs.level, 'unknown');
  assert.equal(draft.toxicity.reviewed, false);
  assert.equal(draft.unsourced, false);
  assert.deepEqual(draft.carePlan.map(action => [action.title, action.cadence, action.intervalDays, action.winterIntervalDays, action.minAgeBand]), [
    ['Vérifier la terre', 'weekly', null, null, 'school'],
    ['Arroser le pothos', 'interval', 7, 14, 'school'],
    ['Donner de l’engrais', 'weekly', null, null, 'school']
  ]);
  assert.doesNotMatch(JSON.stringify(draft), /example\.com|invented/);
});

test('without search results the draft is marked unsourced; malformed drafts are refused', () => {
  const draft = careDraft(answer(), []);
  assert.equal(draft.unsourced, true);
  assert.deepEqual(draft.careSheet.light.sources, []);
  assert.throws(() => careDraft('not json', results), { code: 'PLANT_ASSIST_INVALID_OUTPUT' });
  assert.throws(() => careDraft('[]', results), { code: 'PLANT_ASSIST_INVALID_OUTPUT' });
  // Oversized or misshapen parts are bounded, not trusted.
  const bounded = careDraft(answer({ funFact: 'x'.repeat(5000), carePlan: 'many' }), results);
  assert.equal(bounded.funFact.length, 300);
  assert.deepEqual(bounded.carePlan, []);
});

test('risky actions and toxic plants never reach the youngest children', () => {
  const safe = { children: { level: 'none' } }, toxic = { children: { level: 'mild' } };
  assert.equal(safeAgeBand({ title: 'Toucher la terre', minAgeBand: 'little' }, safe), 'little');
  assert.equal(safeAgeBand({ title: 'Toucher la terre', minAgeBand: 'little' }, toxic), 'school');
  for (const title of ['Tailler les feuilles', 'Rempoter', 'Mettre de l’engrais', 'Pesticide doux', 'Couper une tige'])
    assert.equal(safeAgeBand({ title, minAgeBand: 'little' }, safe), 'school', title);
  assert.equal(safeAgeBand({ title: 'Rempoter', minAgeBand: 'teen' }, safe), 'teen');
  assert.equal(safeAgeBand({ title: 'Arroser', minAgeBand: 'adult' }, safe), 'school');
});
