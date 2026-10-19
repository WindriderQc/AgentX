'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { childPlant, managedPlant, plantInput, publishProblems } = require('../../../src/domains/household/plants');

const toxic = { level: 'toxic', note: 'Irritates the mouth', sources: ['https://example.org/toxicity'] };
const ready = {
  _id: '0123456789abcdef01234567', __v: 3, nickname: 'Synthetic plant', room: 'Salon', status: 'published',
  identification: { commonName: 'Pothos', latinName: 'Epipremnum aureum', confidence: 0.86, source: 'model', model: 'synthetic',
    candidates: [{ commonName: 'Pothos', latinName: 'Epipremnum aureum', confidence: 0.86, traits: 'heart leaves' }] },
  careSheet: { light: { text: 'Bright, indirect', sources: ['https://example.org/light'] },
    water: { text: 'When the top is dry', sources: [] }, soil: { text: 'Light mix', sources: [] } },
  toxicity: { children: toxic, cats: toxic, dogs: { level: 'mild', note: null, sources: [] }, reviewed: true },
  funFact: 'It climbs trees.',
  carePlan: [{ key: 'water', title: 'Water the plant', cadence: 'interval', intervalDays: 7, stars: 2, minAgeBand: 'school' }],
  photos: [{ _id: 'abcdefabcdefabcdefabcdef', mimeType: 'image/jpeg', size: 10, sha256: 'x' }]
};

test('a card needs a species, a reviewed toxicity for every subject and a care action before publishing', () => {
  assert.deepEqual(publishProblems(ready), []);
  assert.deepEqual(publishProblems({}), ['species', 'toxicity', 'care_plan']);
  assert.deepEqual(publishProblems({ ...ready, toxicity: { ...ready.toxicity, reviewed: false } }), ['toxicity_review']);
  assert.deepEqual(publishProblems({ ...ready, toxicity: { ...ready.toxicity, dogs: { level: 'unknown' } } }), ['toxicity']);
  assert.deepEqual(publishProblems({ ...ready, carePlan: [] }), ['care_plan']);
});

test('the child projection keeps needs, the eat warning and photos, never sources, candidates or review state', () => {
  const child = childPlant(ready);
  assert.deepEqual(child, {
    id: '0123456789abcdef01234567', nickname: 'Synthetic plant', room: 'Salon', spot: null,
    commonName: 'Pothos', latinName: 'Epipremnum aureum',
    needs: { light: 'Bright, indirect', water: 'When the top is dry' },
    toxicity: { children: 'toxic', pets: 'toxic' }, doNotEat: true, funFact: 'It climbs trees.',
    photos: [{ id: 'abcdefabcdefabcdefabcdef', url: '/api/family/plants/0123456789abcdef01234567/photos/abcdefabcdefabcdefabcdef' }]
  });
  assert.doesNotMatch(JSON.stringify(child), /example\.org|candidates|reviewed|synthetic"|carePlan/);
  assert.equal(childPlant({ ...ready, toxicity: { children: { level: 'none' }, cats: { level: 'none' }, dogs: { level: 'none' } } }).doNotEat, false);
});

test('the parent projection carries the revision, problems and photo links', () => {
  const managed = managedPlant({ ...ready, status: 'draft', toxicity: { ...ready.toxicity, reviewed: false } });
  assert.equal(managed.revision, 3); assert.equal(managed.status, 'draft');
  assert.deepEqual(managed.problems, ['toxicity_review']);
  assert.equal(managed.photos[0].url, '/api/family/plants/0123456789abcdef01234567/photos/abcdefabcdefabcdefabcdef');
  assert.equal(managed.identification.candidates.length, 1);
});

test('plant input is bounded, typed and rejects unknown fields', () => {
  assert.throws(() => plantInput({}, { create: true }), { code: 'PLANT_NICKNAME_REQUIRED' });
  assert.throws(() => plantInput({ nickname: 'A', status: 'published' }), /unknown fields: status/);
  assert.throws(() => plantInput({ careSheet: { sunlight: { text: 'x' } } }), /unknown fields: sunlight/);
  assert.throws(() => plantInput({ careSheet: { light: { text: 'x', sources: ['javascript:alert(1)'] } } }), /http\(s\) URLs/);
  assert.throws(() => plantInput({ toxicity: { children: { level: 'deadly' } } }), /level must be/);
  assert.throws(() => plantInput({ identification: { commonName: 'A', confidence: 2 } }), /between 0 and 1/);
  assert.throws(() => plantInput({ identification: { commonName: 'A', candidates: [{}, {}, {}, {}] } }), /at most 3 candidates/);
  assert.throws(() => plantInput({ carePlan: [{ title: 'Water', cadence: 'interval' }] }), { code: 'FAMILY_CHORE_BAD_INTERVAL' });
  assert.throws(() => plantInput({ carePlan: [{ title: 'Water' }, { title: 'Water' }] }), /keys must be unique/);
  assert.throws(() => plantInput({ carePlan: [{ title: 'Water', minAgeBand: 'adult' }] }), /minAgeBand/);
  const input = plantInput({ nickname: '  Synthetic  ', careSheet: { light: { text: 'Bright', sources: ['https://example.org/a'] }, water: { text: '' } },
    toxicity: { children: { level: 'toxic' } }, carePlan: [{ title: 'Arroser la plante', cadence: 'weekly', stars: 9 }] }, { create: true });
  assert.equal(input.nickname, 'Synthetic');
  assert.deepEqual(Object.keys(input.careSheet), ['light']);
  assert.deepEqual(input.toxicity.cats, { level: 'unknown', note: null, sources: [] });
  assert.equal(input.toxicity.reviewed, false);
  assert.deepEqual(input.carePlan[0], { key: 'arroser-la-plante', title: 'Arroser la plante', note: '', cadence: 'weekly',
    intervalDays: null, winterIntervalDays: null, stars: 5, minAgeBand: 'school', profileId: null });
});
