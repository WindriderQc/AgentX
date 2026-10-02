'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { choreSummary, familyCaptureKind, familyTurn, householdMembers } = require('../family-context');

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
  assert.deepEqual(await familyTurn({ ...base, userText: 'Rappelle-moi de lire', ideaInbox }), { savedNow: false, captured: 'reminder', chores: '' });
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
  const familyTasks = { listProfiles: async () => ({ profiles: [
    { id: 'kid-a', displayName: 'Alex', ageBand: 'school', active: true },
    { id: 'kid-b', displayName: 'Sam', ageBand: 'little', active: true },
    { id: 'old', displayName: 'Retired', ageBand: 'teen', active: false }
  ] }) };
  const line = await householdMembers(familyTasks);
  assert.match(line, /^Enfants de la maison .*fait foi sur les notes/);
  assert.match(line, /Alex \(âge scolaire\), Sam \(petite enfance\)\.$/);
  assert.doesNotMatch(line, /Retired/);
  assert.equal(await householdMembers({ listProfiles: async () => ({ profiles: [] }) }), '');
  const warnings = [];
  assert.equal(await householdMembers({ listProfiles: async () => { throw new Error('down'); } },
    { logger: { warn: (...args) => warnings.push(args) } }), '');
  assert.equal(warnings.length, 1);
});
