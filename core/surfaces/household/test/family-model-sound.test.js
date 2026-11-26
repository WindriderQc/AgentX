'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./fixtures/persona-journey.cjs');
const { createSoundLibrary } = require('../sound-library');
const { familyToolset } = require('../family-tools');

const env = { HOUSEHOLD_FAMILY_TOOLS: 'get_sound' };
const sounds = createSoundLibrary();
const toolCall = (query, play = true) => ({ function: { name: 'get_sound', arguments: { query, play } } });

for (const [text, query, expected] of [
  ['Fais-moi entendre le loup', 'wolf', 'wolf'],
  ['Pourquoi le loup hurle ?', null, null],
  ['Explique-moi son cri, puis fais-le entendre', 'wolf', 'wolf'],
  ['« Fais le son du loup » est une citation.', null, null],
  ['Ne joue pas le son du loup', null, null],
  ['Fais-moi le son du loup', null, null],
  ['Fais-moi entendre un diplodocus', 'diplodocus', null]
]) {
  test('the sound on the turn follows the model decision for ' + text, async () => {
    const reply = 'Une explication synthétique.';
    const h = harness({ packId: 'kidx_nestor', backend: 'agentx', sounds, conversationEnv: env,
      response: body => query && !body.messages.some(m => m.role === 'tool')
        ? { message: { tool_calls: [toolCall(query), toolCall(query)] } } : reply });
    const result = await h.turn(text, 'voice', { soundPlayback: true });
    assert.equal(h.sent.length, query ? 2 : 1);
    assert.equal(result.reply.text, reply);
    assert.equal(result.sound?.id || null, expected);
    assert.equal(h.turns[0].soundId, expected || '');
    assert.equal(result.tools.receipts.length, query ? 1 : 0);
    if (query) assert.equal(result.tools.receipts[0].availability, expected ? 'available' : 'unavailable');
    if (expected) assert.deepEqual(result.sound, { ...sounds.get(expected), play: 'after-reply' });
  });
}

test('the native VoiX session cannot advertise playback or receive a browser asset', async () => {
  const h = harness({ packId: 'kidx_nestor', backend: 'agentx', sounds, conversationEnv: env, response: 'Pas de lecteur audio ici.' });
  const res = {};
  await h.handle({ params: { sessionId: h.session.sessionId }, body: { text: 'Fais le son du loup', channel: 'voice', soundPlayback: true } },
    res, 'child', { packId: h.session.packId, modeId: h.session.modeId, scopeId: 'family' });
  assert.equal(res.failure, undefined);
  assert.equal(res.payload.sound, null);
  assert.ok(!h.sent[0].tools?.some(t => t.function.name === 'get_sound'));
  assert.match(h.sent[0].request, /cannot play audio clips/);
});

test('family playback requires a turn-bound catalog and only its first lookup can select an asset', async () => {
  assert.equal(familyToolset(env), null);
  const set = familyToolset(env, { soundTurnId: 'fixture-turn', toolDeps: { sounds } });
  assert.deepEqual(set.names, ['get_sound']);
  const wolf = await set.execute(toolCall('wolf'));
  assert.equal(wolf.receipt.soundId, 'wolf');
  assert.equal(wolf.receipt.turnId, 'fixture-turn');
  assert.equal((await set.execute(toolCall('owl'))).receipt, undefined);
  assert.deepEqual(Object.keys(set.definitions[0].function.parameters.properties), ['query', 'play']);
});

test('Reader grants only the configured sound tool and cannot add another Family capability', async () => {
  const h = harness({ packId: 'kidx_reader', backend: 'agentx', sounds,
    conversationEnv: { HOUSEHOLD_FAMILY_TOOLS: 'get_sound,network_devices,source_read' },
    response: body => body.messages.at(-1).role === 'tool' ? 'Un exemple.' : { message: { tool_calls: [toolCall('wolf')] } } });
  assert.equal((await h.turn('Un exemple sonore ?', 'voice', { soundPlayback: true })).sound.id, 'wolf');
  assert.deepEqual(h.sent[0].tools.map(row => row.function.name), ['get_sound']);
});

test('a recording removed from the mounted catalog cannot be attached to a later reply', t => {
  const fs = require('node:fs'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'household-sound-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'wolf-reviewed.ogg');
  fs.writeFileSync(fixture, 'fixture audio');
  const library = createSoundLibrary({ soundsDir: dir });
  assert.equal(library.get('wolf').id, 'wolf');
  fs.unlinkSync(fixture);
  assert.equal(library.get('wolf'), null);
  assert.equal(library.select('wolf', { explicitSoundIntent: true }), null);
});

test('a successful catalog lookup can support an explanation with no playback', async () => {
  const h = harness({ packId: 'kidx_nestor', backend: 'agentx', sounds, conversationEnv: env,
    response: body => body.messages.at(-1).role === 'tool' ? 'Le cri est un hurlement.' : {
      message: { tool_calls: [toolCall('wolf', false)] } } });
  const turn = await h.turn('Décris son cri sans le jouer.', 'voice', { soundPlayback: true });
  assert.equal(turn.sound, null);
  assert.equal(turn.tools.receipts[0].availability, 'available');
  assert.equal(turn.tools.receipts[0].playbackRequested, false);
});

test('an explanation returned with the tool and again after verification is spoken once', async () => {
  const explanation = 'Le loup hurle pour communiquer avec sa meute.';
  const h = harness({ packId: 'kidx_nestor', backend: 'agentx', sounds, conversationEnv: env,
    response: body => body.messages.at(-1).role === 'tool' ? explanation : {
      message: { content: explanation, tool_calls: [toolCall('wolf')] } } });
  const turn = await h.turn('Explique-moi son cri, puis fais-le entendre.', 'voice', { soundPlayback: true });
  assert.equal(turn.sound.id, 'wolf');
  assert.equal(turn.reply.text, explanation);
});
