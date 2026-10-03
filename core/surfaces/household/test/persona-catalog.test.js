'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, PassThrough } = require('node:stream');
const { generatedPersonas, snapshot, speechFor, readReplyStream, instanceVoice } = require('../persona-catalog');

test('generated private catalog preserves every former voice preset and the requested voice defaults', () => {
  const rows = generatedPersonas();
  assert.deepEqual(rows.map(row => row.name), ['native_personality', 'nestor', 'nestor_strategist', 'nestor_challenger', 'jarvis', 'nestor_companion', 'nestor_concise', 'secretary', 'comptable']);
  const jarvis = rows.find(row => row.name === 'jarvis');
  assert.ok(jarvis.systemPrompt.startsWith('For this conversation, use the name Jarvis.'));
  assert.equal(jarvis.systemPrompt.includes('You are Nestor'), false);
  const secretary = rows.find(row => row.name === 'secretary');
  assert.ok(secretary.systemPrompt.startsWith('For this conversation, use the name Secretary.'));
  assert.equal(secretary.systemPrompt.includes('You are Nestor'), false);
  assert.ok(rows.find(row => row.name === 'native_personality').systemPrompt.includes('Keep your native agent name'));
  for (const row of rows) {
    assert.equal(row.uiConfig.layoutConfig.kind, 'personality');
    assert.doesNotMatch(row.systemPrompt, /Alex|Quebec|lane Jarvis|You are Nestor|model:|workspace|roles\//);
  }
  for (const [name, voice] of [['nestor', 'am_michael'], ['jarvis', 'bm_lewis']]) assert.equal(speechFor(snapshot({ ...rows.find(row => row.name === name), _id: name, version: 1 }), 'en').voice, voice);
  assert.equal(speechFor(snapshot({ ...rows.find(row => row.name === 'secretary'), _id: 'secretary', version: 1 }), 'fr').voice, 'ff_siwis');
  // The accountant keeps Nestor's former Kokoro French blend and declares its own agent.
  const comptable = rows.find(row => row.name === 'comptable');
  assert.equal(speechFor(snapshot({ ...comptable, _id: 'comptable', version: 1 }), 'fr').voice, 'am_michael:0.50+ff_siwis:0.50');
  assert.equal(comptable.uiConfig.layoutConfig.agentId, 'comptable');
});

test('split Unicode reply chunks stream intact and require a terminal completion record', async () => {
  const bytes = Buffer.from(JSON.stringify({ message: { content: 'Voilà, terminé.' } }) + '\n' + JSON.stringify({ done: true }) + '\n');
  const received = [];
  const result = await readReplyStream(Readable.from([...bytes].map(value => Buffer.from([value]))), delta => received.push(delta));
  assert.equal(result, 'Voilà, terminé.');
  assert.equal(received.join(''), result);
  await assert.rejects(readReplyStream(Readable.from([JSON.stringify({ response: 'partial' })]), () => {}), /before completion/);
  await assert.rejects(readReplyStream(Readable.from([JSON.stringify({ error: 'failed' })]), () => {}), /failed/);
});

test('empty persisted voice preferences use the persona default', () => {
  assert.equal(speechFor({ voice: { presentation: 'masculine' } }, 'en', null).voice, 'am_michael');
});

test('cancelled voice replies drain to EOF without delivering or returning late text', async () => {
  const stream = new PassThrough();
  const controller = new AbortController();
  const received = [];
  const reply = readReplyStream(stream, delta => { received.push(delta); controller.abort(); }, controller.signal);
  stream.write(`${JSON.stringify({ done: false, response: 'first' })}\n${JSON.stringify({ done: false, response: 'late' })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stream.destroyed, false);
  stream.end(`${JSON.stringify({ done: true })}\n`);
  assert.equal(await reply, '');
  assert.deepEqual(received, ['first']);
  assert.equal(stream.readableEnded, true);
});

test('an instance voice replaces catalog voices per persona or for every persona, and a browser selection still wins', () => {
  const catalog = { provider: 'kokoro', presentation: 'masculine', voices: { fr: 'catalog-fr', en: 'catalog-en' } };
  const env = { HOUSEHOLD_PERSONA_VOICES: JSON.stringify({ '*': 'voxcpm|example-clone', jarvis: 'kokoro|example-jarvis' }) };
  const nestor = instanceVoice('nestor', catalog, env);
  assert.deepEqual(nestor, { provider: 'voxcpm', presentation: 'masculine', voices: { fr: 'example-clone', en: 'example-clone' }, source: 'instance',
    fallback: { provider: 'kokoro', presentation: 'masculine', voices: { fr: 'catalog-fr', en: 'catalog-en' } } });
  assert.equal(instanceVoice('jarvis', catalog, env).voices.fr, 'example-jarvis');
  for (const language of ['fr', 'en']) assert.deepEqual(speechFor({ voice: nestor }, language), { provider: 'voxcpm', language, voice: 'example-clone', presentation: 'masculine' });
  assert.equal(speechFor({ voice: nestor }, 'fr', { presentation: 'feminine' }).voice, 'example-clone');
  assert.equal(speechFor({ voice: nestor }, 'fr', { selections: { fr: 'kokoro|ff_siwis' } }).voice, 'ff_siwis');
  for (const value of ['', 'not json', JSON.stringify({ '*': 'unknown|x' }), JSON.stringify({ '*': 'voxcpm|' }), JSON.stringify({ '*': 'voxcpm|a\nb' })]) {
    assert.equal(instanceVoice('nestor', catalog, { HOUSEHOLD_PERSONA_VOICES: value }), catalog);
  }
});

test('turn speech refreshes an instance override and restores the frozen catalog voice after removal or invalidation', () => {
  const base = { provider: 'kokoro', presentation: 'masculine', voices: { fr: 'catalog-fr', en: 'catalog-en' } };
  const persona = { id: 'jarvis', version: 3, voice: instanceVoice('jarvis', base, { HOUSEHOLD_PERSONA_VOICES: '{"jarvis":"voxcpm|synthetic-old"}' }) };
  for (const language of ['fr', 'en']) {
    assert.equal(speechFor(persona, language, {}, { HOUSEHOLD_PERSONA_VOICES: '{"jarvis":"windows_sapi|synthetic-new"}' }).voice, 'synthetic-new');
    assert.equal(speechFor(persona, language, {}, { HOUSEHOLD_PERSONA_VOICES: '{"*":"voxcpm|synthetic-all"}' }).voice, 'synthetic-all');
    for (const env of [{}, { HOUSEHOLD_PERSONA_VOICES: 'invalid' }, { HOUSEHOLD_PERSONA_VOICES: '{"jarvis":"unknown|bad"}' }]) {
      assert.deepEqual(speechFor(persona, language, {}, env), { provider: 'kokoro', language, voice: base.voices[language], presentation: 'masculine' });
    }
    assert.equal(speechFor(persona, language, { selections: { [language]: 'kokoro|synthetic-selected' } },
      { HOUSEHOLD_PERSONA_VOICES: '{"jarvis":"voxcpm|synthetic-new"}' }).voice, 'synthetic-selected');
  }
  assert.equal(persona.voice.voices.fr, 'synthetic-old', 'reply resolution does not mutate the personality snapshot');
});
