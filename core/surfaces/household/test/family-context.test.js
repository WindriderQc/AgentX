'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { choreSummary, familyCaptureKind, familyIssEnabled, familyTurn, householdMembers, isIssQuestion, issSummary } = require('../family-context');

test('a child idea or reminder is told apart from an ordinary "remember" note', () => {
  assert.equal(familyCaptureKind("J'ai une idée : une cabane"), 'idea');
  assert.equal(familyCaptureKind('Note mon idée pour papa'), 'idea');
  assert.equal(familyCaptureKind('Rappelle-moi de prendre mon sac demain'), 'reminder');
  assert.equal(familyCaptureKind('Fais-moi penser à arroser la plante'), 'reminder');
  assert.equal(familyCaptureKind('Rappelle-toi que mon chat s’appelle Mimi'), null);
  assert.equal(familyCaptureKind('Note que j’aime les dinosaures'), null);
  assert.equal(familyCaptureKind('Pourquoi le ciel est bleu?'), null);
});

test('a capture goes to the idea inbox instead of family notes, and a failure is reported honestly', async () => {
  const recorded = [];
  const notes = { record: async (entry) => recorded.push(entry) };
  const captured = [];
  const ideaInbox = { captureIdea: async (input) => captured.push(input) };
  const base = { notes, detectMemoryRequest: () => true, withChores: false };
  assert.deepEqual(await familyTurn({ ...base, userText: 'Rappelle-moi de lire', ideaInbox }), { savedNow: false, captured: 'reminder', chores: '', plants: '', iss: '' });
  assert.deepEqual(captured, [{ text: 'Rappelle-moi de lire', origin: 'family', kind: 'reminder' }]);
  assert.equal(recorded.length, 0);
  const failing = { captureIdea: async () => { throw new Error('offline'); } };
  assert.equal((await familyTurn({ ...base, userText: "J'ai une idée", ideaInbox: failing })).captured, 'failed');
  assert.equal((await familyTurn({ ...base, userText: 'Retiens que je joue au soccer', ideaInbox })).savedNow, true);
  assert.equal(recorded.length, 1);
});

test('the chore summary is read-only Kids Room rows and fails closed to nothing', async () => {
  const familyTasks = {
    listProfiles: async () => ({ profiles: [{ id: 'a', displayName: 'Enfant A' }] }),
    room: async () => ({ room: { available: [{ title: 'Nourrir le poisson', overdue: true }], waiting: [{ title: 'Ranger' }], completedToday: 1 } })
  };
  const summary = await choreSummary(familyTasks);
  assert.match(summary, /read-only/);
  assert.match(summary, /- Enfant A : à faire : Nourrir le poisson \(en retard\) ; en attente de papa : Ranger ; approuvées aujourd’hui : 1\./);
  assert.equal(await choreSummary({ listProfiles: async () => { throw new Error('down'); } }), '');
  assert.equal(await choreSummary({ listProfiles: async () => ({ profiles: [] }) }), '');
});

test('every active child profile is listed, so notes about one child never hide another (#119)', async () => {
  const familyTasks = { listProfileDetails: async () => ({ profiles: [
    { id: 'kid-a', displayName: 'Alex', ageBand: 'school', active: true },
    { id: 'kid-b', displayName: 'Sam', ageBand: 'little', active: true },
    { id: 'old', displayName: 'Retired', ageBand: 'teen', active: false }
  ] }) };
  const line = await householdMembers(familyTasks);
  assert.match(line, /^Enfants de la maison .*fait foi sur les notes/);
  assert.match(line, /Alex \(âge scolaire\), Sam \(petite enfance\)\.$/);
  assert.doesNotMatch(line, /Retired/);
  assert.equal(await householdMembers({ listProfileDetails: async () => ({ profiles: [] }) }), '');
  const warnings = [];
  assert.equal(await householdMembers({ listProfileDetails: async () => { throw new Error('down'); } },
    { logger: { warn: (...args) => warnings.push(args) } }), '');
  assert.equal(warnings.length, 1);
});

test('a parent-set birth date gives Super Dad the current age and birthday, never the raw date', async () => {
  const previous = process.env.PLANNING_TIME_ZONE;
  process.env.PLANNING_TIME_ZONE = 'UTC';
  try {
    const familyTasks = { listProfileDetails: async () => ({ profiles: [
      { id: 'kid-a', displayName: 'Alex', ageBand: 'school', birthDate: '2016-03-14' },
      { id: 'kid-b', displayName: 'Sam', ageBand: 'little', birthDate: '2025-03-01' },
      { id: 'kid-c', displayName: 'Robin', ageBand: 'teen' }
    ] }) };
    const before = await householdMembers(familyTasks, { now: new Date('2026-03-13T12:00:00Z') });
    assert.match(before, /Alex \(9 ans, anniversaire le 14 mars\), Sam \(1 an, anniversaire le 1er mars\), Robin \(adolescence\)\.$/);
    assert.doesNotMatch(before, /2016|2025/);
    const on = await householdMembers(familyTasks, { now: new Date('2026-03-14T12:00:00Z') });
    assert.match(on, /Alex \(10 ans, anniversaire le 14 mars\)/);
  } finally {
    if (previous === undefined) delete process.env.PLANNING_TIME_ZONE; else process.env.PLANNING_TIME_ZONE = previous;
  }
});

test('Famille sounds playful with children on both conversation backends (#121)', () => {
  const { FAMILY_TONE } = require('../family-context');
  const { packById } = require('../packs');
  const { FAMILY_SURFACE_CONTRACT } = require('../persona-turn');
  assert.match(FAMILY_TONE, /playful, curious and encouraging/);
  assert.match(FAMILY_TONE, /replaces the selected personality's adult temperament/);
  assert.match(FAMILY_TONE, /Fun never overrides accuracy or the safety rules/);
  // AgentX backend: the family pack prompt; OpenClaw backend: the family surface contract sent each turn.
  assert.ok(packById('kidx_nestor').systemPrompt.endsWith(FAMILY_TONE));
  assert.ok(FAMILY_SURFACE_CONTRACT.endsWith(FAMILY_TONE));
  assert.doesNotMatch(packById('personal_operator').systemPrompt || '', /Tone with children/);
});

test('a note from mail review or another non-owner source shows its origin in the prompt (#207)', () => {
  const { memoryBlock } = require('../persona-prompt');
  const block = memoryBlock([
    { text: 'Synthetic fact from a mail', source: 'nestor-mail-review' },
    { text: 'Synthetic owner preference', source: 'explicit-ui' },
    { text: 'Synthetic agent note', source: 'nestor-conversation' }
  ]);
  assert.match(block, /- \[from mail review\] Synthetic fact from a mail/);
  assert.match(block, /\n- Synthetic owner preference/);
  assert.match(block, /\n- Synthetic agent note/);
});

test('family Nestor receives the published plant cards as its only source about the plants (#870)', async () => {
  const { plantSummary, familyTurn } = require('../family-context');
  const plants = { list: async ({ view }) => ({ plants: view === 'child' ? [
    { nickname: 'Gérard', commonName: 'Pothos', room: 'Salon', needs: { light: 'Vive', water: 'Quand c’est sec' }, doNotEat: true, mood: 'thirsty' },
    { nickname: 'Bob', commonName: 'Cactus', needs: {}, doNotEat: false, mood: 'happy' }] : [] }) };
  const summary = await plantSummary(plants);
  assert.match(summary, /seulement à partir de ces fiches/);
  assert.match(summary, /- Gérard \(Pothos, Salon\) : lumière : Vive ; eau : Quand c’est sec ; toxique : on ne mange jamais ses feuilles, les animaux non plus ; a soif aujourd’hui\./);
  assert.match(summary, /- Bob \(Cactus\) : pas toxique ; va bien\./);
  assert.equal(await plantSummary(null), '');
  assert.equal(await plantSummary({ list: async () => { throw new Error('down'); } }), '');
  const familyTasks = { listProfiles: async () => ({ profiles: [] }) };
  const turn = await familyTurn({ userText: 'Bonjour', notes: {}, familyTasks, detectMemoryRequest: () => false, plants });
  assert.match(turn.plants, /Gérard/);
  assert.equal((await familyTurn({ userText: 'Bonjour', notes: {}, familyTasks, detectMemoryRequest: () => false, plants, withChores: false })).plants, '');
});

test('ISS passes reach Famille only when enabled and asked about, with the computed times', async () => {
  assert.equal(familyIssEnabled({}), false);
  assert.equal(familyIssEnabled({ HOUSEHOLD_FAMILY_ISS_PASSES: 'true' }), true);
  assert.equal(isIssQuestion("Nestor, l'ISS passe quand?"), true);
  assert.equal(isIssQuestion('Est-ce que la station spatiale passe ce soir?'), true);
  assert.equal(isIssQuestion('Je vais à la piscine'), false);
  const visible = { start: { direction: 'N' }, end: { direction: 'ENE' }, maxElDeg: 34.1, durationSec: 170,
    startLocal: 'dim. 25 oct., 05 h 16', endLocal: 'dim. 25 oct., 05 h 18' };
  const result = { computedAtLocal: 'sam. 24 oct., 18 h 30', tle: { epochLocal: 'sam. 24 oct., 01 h 01', stale: false },
    counts: { geometric: 5, observable: 1 }, passes: [{ observable: true, visible }, { observable: false }],
    view: { url: 'https://example.test/iss#passages', label: 'Vue 3D' } };
  let asked = 0;
  const readIssPasses = async () => { asked += 1; return result; };
  const base = { notes: { record: async () => {} }, detectMemoryRequest: () => false, withChores: false, readIssPasses };
  assert.equal((await familyTurn({ ...base, userText: "L'ISS passe quand?" })).iss, '');
  assert.equal((await familyTurn({ ...base, withIss: true, userText: 'Bonjour Nestor' })).iss, '');
  assert.equal(asked, 0);
  const text = (await familyTurn({ ...base, withIss: true, userText: "L'ISS passe quand?" })).iss;
  assert.match(text, /dim\. 25 oct\., 05 h 16 → 05 h 18, du N vers ENE, 34,1° de hauteur max, environ 3 min/);
  assert.match(text, /n’en invente aucune/);
  assert.match(text, /si le ciel est dégagé/);
  assert.match(text, /4 autre\(s\) passage\(s\)/);
  assert.match(text, /<show kind="link" title="Vue 3D">https:\/\/example\.test\/iss#passages<\/show>/);
  const fallback = await issSummary("Quand passe l'ISS?", { readPasses: async () => ({ ...result,
    observer: { label: 'Québec', source: 'default', defaulted: true } }) });
  assert.match(fallback, /pour Québec \(lieu par défaut/);
  assert.match(fallback, /la position de la personne n’est pas connue/);
  assert.doesNotMatch(fallback, /au-dessus de la maison/);
});

test('ISS summary selects observable passes before limiting the list', async () => {
  const visible = { start: { direction: 'N' }, end: { direction: 'E' }, maxElDeg: 30, durationSec: 120,
    startLocal: 'lun. 26 oct., 06 h 03', endLocal: 'lun. 26 oct., 06 h 05' };
  const all = [...Array.from({ length: 12 }, () => ({ observable: false })), { observable: true, visible }];
  const readPasses = async args => ({ computedAtLocal: 'dim. 25 oct., 10 h 00',
    tle: { epochLocal: 'sam. 24 oct., 01 h 01', stale: false }, counts: { geometric: 13, observable: 1 },
    passes: (args.visible_only ? all.filter(p => p.observable) : all).slice(0, args.max_passes), view: null });
  const text = await issSummary("Quand passe l'ISS?", { readPasses });
  assert.match(text, /lun\. 26 oct\., 06 h 03/);
  assert.doesNotMatch(text, /Aucun passage visible/);
  assert.match(text, /12 autre\(s\) passage\(s\)/);
});

test('an unavailable ISS computation tells Nestor to give no time', async () => {
  const text = await issSummary("Quand passe l'ISS?", { readPasses: async () => { throw new Error('Data holds no ISS orbital elements'); } });
  assert.match(text, /indisponibles/);
  assert.match(text, /aucune heure/);
});
