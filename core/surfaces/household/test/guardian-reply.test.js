'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAIN_REQUIRED, createGuardianReply } = require('../guardian-reply');
const { createConversationExecutor } = require('../conversation-executor');

test('an unmarked promise to return Main’s result cannot be classified as an answered request', () => {
  for (const text of [
    "C'est fait, je demande au cerveau principal de faire le calcul pour toi. Je te reviens dès qu'il a le résultat.",
    'Je te reviens dès que le résultat est disponible.',
    'Je confie la vérification à Main.',
    'Je regarde ça.', 'Je vais vérifier ce document.', 'I will check it.',
    "I'll ask Main to calculate it and get back to you.",
    'Main va vérifier le résultat.'
  ]) assert.equal(createGuardianReply().finish(text).disposition, 'awaiting_main', text);
  for (const text of [
    'Il était une fois Main, qui disait : je te reviens avec le résultat.',
    'La blague : Main demande pourquoi le pingouin passe par ici.',
    'Le calcul est fait : 317 × 29 = 9193.',
    'Je regarde ce chiffre : 9193.',
    "Je vais te raconter une histoire. Il était une fois un renard.",
    'Je pense que tu pourrais demander ce calcul à Main.'
  ]) assert.equal(createGuardianReply().finish(text).disposition, 'answered', text);
});

test('a fragmented routing prefix never reaches spoken deltas, including an exact-prefix chunk', () => {
  const raw = '  ' + MAIN_REQUIRED + '\n Je vérifie ça pour toi.';
  for (let split = 1; split < raw.length; split++) {
    const spoken = [], reply = createGuardianReply(delta => spoken.push(delta));
    reply.push(raw.slice(0, split)); reply.push(raw.slice(split));
    assert.deepEqual(reply.finish(raw), { text: 'Je vérifie ça pour toi.', disposition: 'awaiting_main' });
    assert.equal(spoken.join(''), 'Je vérifie ça pour toi.');
  }
});
test('ordinary replies stream immediately and retain literal markers inside the answer', () => {
  const spoken = [], reply = createGuardianReply(delta => spoken.push(delta));
  reply.push('Il était'); assert.equal(spoken.join(''), 'Il était');
  reply.push(' une fois.'); assert.deepEqual(reply.finish('Il était une fois.'), { text: 'Il était une fois.', disposition: 'answered' });
  const quoted = createGuardianReply();
  assert.equal(quoted.finish('Texte ' + MAIN_REQUIRED).disposition, 'answered');
});
test('missing acknowledgment or incomplete routing cannot be presented as a completed answer', () => {
  for (const text of [MAIN_REQUIRED, MAIN_REQUIRED + '  ', MAIN_REQUIRED.slice(0, -1)]) {
    assert.throws(() => createGuardianReply().finish(text));
  }
});
test('only the dedicated guardian transforms verified native routing text', async () => {
  const text = MAIN_REQUIRED + ' Je consulte cette information.';
  const deltas = [], run = createConversationExecutor({ env: {}, inference: {}, agentClient: async request => {
    request.onDelta?.(text); return { text, metadata: { model: 'synthetic-native' }, runId: 'retained-original-run' };
  } });
  const body = { backend: 'openclaw', session: {}, pack: {}, history: [], text: 'Question', onDelta: delta => deltas.push(delta) };
  const result = await run({ ...body, guardianStreaming: true });
  assert.equal(result.text, 'Je consulte cette information.');
  assert.equal(result.metadata.guardianDisposition, 'awaiting_main');
  assert.equal(result.runId, 'retained-original-run'); assert.deepEqual(deltas, [result.text]);
  assert.equal((await run(body)).text, text, 'Main retains its exact native answer');
});
