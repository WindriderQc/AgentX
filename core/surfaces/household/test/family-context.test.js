'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { choreSummary, familyCaptureKind, familyTurn, householdMembers } = require('../family-context');

test('a child idea or reminder is told apart from an ordinary "remember" note', () => {
  assert.equal(familyCaptureKind("J'ai une idée : une cabane"), 'idea');
  assert.equal(familyCaptureKind('Note mon idée pour papa'), 'idea');
  assert.equal(familyCaptureKind('Salut Nestor, je voudrais que tu me rappelles de regarder la lune.'), 'reminder');
  assert.equal(familyCaptureKind('Could you please remind me to take my scarf?'), 'reminder');
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
  assert.deepEqual(await familyTurn({ ...base, userText: 'Rappelle-moi de lire', ideaInbox }), { savedNow: false, captured: 'reminder', chores: '', plants: '' });
  assert.deepEqual(captured, [{ text: 'Rappelle-moi de lire', origin: 'family', kind: 'reminder' }]);
  assert.equal(recorded.length, 0);
  const failing = { captureIdea: async () => { throw new Error('offline'); } };
  assert.equal((await familyTurn({ ...base, userText: "J'ai une idée", ideaInbox: failing })).captured, 'failed');
  assert.equal((await familyTurn({ ...base, userText: 'Retiens que je joue au soccer', ideaInbox })).savedNow, true);
  assert.equal(recorded.length, 1);
});

test('Quebec family speech writes only explicit requests and keeps the original wording', async () => {
  const { detectMemoryRequest } = require('../persona-prompt');
  const inbox = [], memory = [];
  const options = { detectMemoryRequest, withChores: false,
    ideaInbox: { captureIdea: async row => inbox.push(row) },
    notes: { record: async row => memory.push(row) } };

  const idea = 'Euh, Nestor, j’ai une idée : on construit une cabane.';
  const reminder = 'Tu peux-tu me rappeler de pas oublier mon sac demain?';
  const withArticle = 'Fais-moi penser aux mitaines';
  const withNegativeObject = 'Fais-moi penser à ne pas oublier mes mitaines.';
  const note = 'Peux-tu retenir que mon dinosaure préféré est le tricératops?';
  for (const userText of [idea, reminder, withArticle, withNegativeObject, note]) await familyTurn({ ...options, userText });
  assert.deepEqual(inbox.map(row => [row.kind, row.text]),
    [['idea', idea], ['reminder', reminder], ['reminder', withArticle], ['reminder', withNegativeObject]]);
  assert.deepEqual(memory.map(row => row.text), [note]);

  for (const userText of [
    'Rappelle-moi pas demain de sortir mes bottes.', 'Retiens surtout pas mon histoire.',
    'Ne retiens pas cette anecdote.', 'Il m’a dit “prends note”.', '« Rappelle-moi de lire »',
    'Retiens que j’aime le patin, euh non, laisse faire.', 'J’ai une idée, mais non, laisse faire.',
    'J’ai une idée de jeu mais j’veux pas que tu la notes.', 'Retiens que j’aime le hockey, garde-le pas finalement.',
    'Ça veut dire quoi, rappelle-moi?', 'Rappelle-moi de quoi on parlait?', 'Tu peux-tu me rappeler comment ça marche?',
    'Me rappeler de lire, ça veut dire quoi?', 'Can you tell me what “remind me to go” means?',
    'Rappelle-moi de prendre mes mitaines ah non laisse faire', 'J’ai une idée, mais je veux pas la garder',
    'Rappelle-moi de sortir mes mitaines, ça veut dire quoi ?', 'Rappelle-moi de sortir mes mitaines ça veut dire quoi',
    'Do not save my idea.', 'Don’t remind me to go.'
  ]) {
    const result = await familyTurn({ ...options, userText });
    assert.equal(result.savedNow, false, userText);
    assert.equal(result.captured, null, userText);
  }
  assert.equal(inbox.length, 4);
  assert.equal(memory.length, 1);
});

test('a family write respects the speaker, the recipient and a withdrawal even after a positive opening', async () => {
  const { detectMemoryRequest } = require('../persona-prompt');
  const inbox = [], memory = [];
  const options = { detectMemoryRequest, withChores: false,
    ideaInbox: { captureIdea: async item => inbox.push(item) }, notes: { record: async item => memory.push(item) } };

  for (const userText of [
    'Retiens-tu bien les histoires?', 'Retiens tu mon histoire?', 'Remember this? It was fun.', 'Remember my first bike?',
    'J’ai une idée, mais garde-la juste pour toi.', 'J’ai une idée, mais tu vas pas l’enregistrer, OK?',
    'J’ai une idée mais c’est un secret, dis-le pas à papa.', 'Note mon idée de vélo mais surtout n’en parle pas à papa.',
    'Rappelle-moi de lire non laisse faire', 'Rappelle-moi de lire puis laisse faire.',
    'Rappelle-moi de lire, ne me le rappelle pas.', 'Garde mon idée, disait le petit loup.'
  ]) {
    const effect = await familyTurn({ ...options, userText });
    assert.equal(effect.captured, null, userText);
    assert.equal(effect.savedNow, false, userText);
  }
  assert.deepEqual(memory, []);
  assert.deepEqual(inbox, []);

  const explicit = [
    'Rappelle-moi à 8 heures de me brosser les dents.', 'Rappelle-moi demain matin d’apporter mes bottes.',
    'Rappelle-moi demain à midi de ne pas oublier mon sac.', 'Rappelle-moi dans cinq minutes de sortir le chien.',
    'Can you remind me at noon to bring my boots?'
  ];
  for (const userText of explicit) await familyTurn({ ...options, userText });
  assert.deepEqual(inbox, explicit.map(text => ({ kind: 'reminder', origin: 'family', text })));
  assert.deepEqual(memory, []);
});

test('the voice turn gives the family model only the actual parent-inbox outcome', async t => {
  const { harness } = require('./fixtures/persona-journey.cjs');
  const capture = t.mock.method(require('../../../src/services/ideaInboxService'), 'captureIdea',
    async () => ({ review: 'parent' }));
  const h = harness({ packId: 'kidx_nestor', backend: 'agentx' });
  const original = 'Nestor, tu peux-tu me rappeler de prendre mes mitaines?';
  await h.turn(original, 'voice');
  assert.deepEqual(capture.mock.calls[0].arguments, [{ text: original, origin: 'family', kind: 'reminder' }]);
  assert.match(h.sent[0].request, /saved in the parent review inbox.*No notification or scheduled alarm/);
  assert.match(h.sent[0].prefix, /préciser ce mot avant de choisir un outil/);

  await h.turn('Je veux pas que tu gardes cette idée.', 'voice');
  assert.equal(capture.mock.callCount(), 1);
  assert.doesNotMatch(h.sent[1].request, /saved in the parent review inbox/);

  capture.mock.mockImplementation(async () => { throw Error('synthetic inbox failure'); });
  await h.turn('Nestor, peux-tu garder mon idée de jeu?', 'voice');
  assert.equal(capture.mock.callCount(), 2);
  assert.match(h.sent[2].request, /could not be saved/);
  assert.doesNotMatch(h.sent[2].request, /saved in the parent review inbox/);
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

test('Famille uses natural Quebec French and honest capabilities on both backends', () => {
  const { FAMILY_TONE } = require('../family-context');
  const { packById } = require('../packs');
  const { FAMILY_SURFACE_CONTRACT } = require('../persona-turn');
  assert.match(FAMILY_TONE, /français québécois naturel, chaleureux et clair/);
  assert.match(FAMILY_TONE, /sans promesse de mise en file/);
  assert.doesNotMatch(FAMILY_TONE, /like a fun guide at a science museum/);
  assert.match(FAMILY_TONE, /replaces the selected personality's adult temperament/);
  assert.match(FAMILY_TONE, /Fun never overrides accuracy or the safety rules/);
  // AgentX backend: the family pack prompt; OpenClaw backend: the family surface contract sent each turn.
  assert.ok(packById('kidx_nestor').systemPrompt.endsWith(FAMILY_TONE));
  assert.ok(FAMILY_SURFACE_CONTRACT.endsWith(FAMILY_TONE));
  assert.ok(!(packById('personal_operator').systemPrompt || '').includes(FAMILY_TONE));
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


test('family notes use the accepted browser turn or the legacy server trace as their source', async () => {
  const { harness } = require('./fixtures/persona-journey.cjs');
  const id = 'e35b869d-221b-47a2-9d1b-6b535a68dc9b';
  const h = harness({ packId: 'kidx_nestor', backend: 'agentx', validClientTurnId: value => value === id });
  const req = { params: { sessionId: h.session.sessionId }, body: { text: 'Retiens que je joue au soccer', channel: 'text', turnId: id } };
  const res = { on() {}, removeListener() {}, writableEnded: false, headersSent: false };
  const { packId, modeId, scopeId } = h.session;
  await h.handle(req, res, 'child', { packId, modeId, scopeId, browser: true });
  assert.equal(res.failure, undefined);
  assert.deepEqual(h.state.recordedNotes.map(({ source, sourceTraceId }) => [source, sourceTraceId]),
    [['explicit-ui', 'household:' + h.session.sessionId + ':' + id]]);
  const reply = await h.turn('Retiens que je préfère les jeux.', 'voice');
  assert.equal(h.state.recordedNotes[1].source, 'voix-explicit');
  assert.equal(h.state.recordedNotes[1].sourceTraceId, 'household:' + h.session.sessionId + ':' + reply.audit.traceId);
});

test('a family note without a successful receipt is reported as unconfirmed', async () => {
  const { capturedPrompt } = require('../family-context');
  const result = await familyTurn({ userText: 'Retiens que je préfère les jeux.', detectMemoryRequest: () => true,
    notes: { record: async () => { throw new Error('unconfirmed'); } }, withChores: false });
  assert.equal(result.savedNow, false);
  assert.match(capturedPrompt(result.captured), /could not confirm saving it/);
});
