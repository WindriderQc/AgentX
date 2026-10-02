'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSoundLibrary } = require('../sound-library');
const { callSecretaryTool, secretaryMcpMiddleware } = require('../secretary-mcp');
const sounds = createSoundLibrary();

test('the common MCP tool returns existing recordings with playback explicitly unconfirmed', async () => {
  for (const query of ['elephant', "Est-tu capable de me faire le son de l'éléphant?", "Fais-moi entendre un éléphant"]) {
    const result = await callSecretaryTool('get_sound', { query }, { sounds });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.status, 'available');
    assert.equal(result.structuredContent.sound.id, 'elephant');
    assert.equal(result.structuredContent.sound.url, '/assets/household/sounds/elephant-reviewed.ogg');
    assert.equal(result.structuredContent.playback, 'client_required');
    assert.equal(result.structuredContent.sound.kind, 'recording');
  }
  assert.equal((await callSecretaryTool('get_sound', { query: 'trex' }, { sounds })).structuredContent.sound.kind, 'effect');
  for (const query of ['not-a-real-sound', '../../private.mp3']) {
    const result = await callSecretaryTool('get_sound', { query }, { sounds });
    assert.equal(result.structuredContent.status, 'unavailable');
    assert.equal(result.structuredContent.sound, null);
  }
  assert.equal((await callSecretaryTool('get_sound', { query: '' }, { sounds })).isError, true);
});

test('any connected MCP caller can retrieve a sound without personal-task storage', async () => {
  let answer;
  await secretaryMcpMiddleware({ sounds })({ method: 'POST', body: { jsonrpc: '2.0', id: 7,
    method: 'tools/call', params: { name: 'get_sound', arguments: { query: 'elephant' } } } },
  { json(body) { answer = body; } }, () => assert.fail('Sound requests must use the registered extension'));
  assert.equal(answer.id, 7); assert.equal(answer.result.structuredContent.sound.id, 'elephant');
});

test('the shared tool preserves catalog curation and never substitutes a similar species', async () => {
  for (const query of ['chevreuil', 'macaque', 'corbeau', 'raven', 'hibou', 'bourdon', 'petit rorqual', 'tamia', 'pivert', 'perruche', 'crapaud', 'merle', 'crocodile', 'lama', 'dragon']) {
    const result = await callSecretaryTool('get_sound', { query }, { sounds });
    assert.equal(result.structuredContent.sound, null, query);
  }
  for (const [query, expected] of [['cochon d’Inde', 'guinea-pig'], ['cerf', 'deer'], ['corneille', 'crow'], ['pic bois', 'woodpecker']]) {
    assert.equal((await callSecretaryTool('get_sound', { query }, { sounds })).structuredContent.sound.id, expected);
  }
  const unavailablePack = createSoundLibrary({ soundsDir: require('node:path').join(__dirname, 'absent-sound-pack') });
  assert.equal((await callSecretaryTool('get_sound', { query: 'elephant' }, { sounds: unavailablePack })).structuredContent.sound, null);
});
