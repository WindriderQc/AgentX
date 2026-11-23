'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversationImages, scopeFor } = require('../conversation-images');
const { harness } = require('./fixtures/persona-journey.cjs');

const id = '12345678-1234-4123-8123-123456789abc';
const ready = { id, state: 'completed', runtimeRestored: true, artifact: { sha256: 'a'.repeat(64) } };
const block = { kind: 'image', source: 'local', title: 'Synthetic drawing', status: 'accepted', operation: { id } };
const question = 'Est-ce que mon dessin est prêt ?';

function fixture(backend = 'agentx', options = {}) {
  const images = {}, h = harness({ packId: 'kidx_nestor', backend, conversationImages: images, ...options });
  const reads = [], operations = [{ id, state: 'failed', runtimeRestored: true }];
  const service = {
    status: () => ({ configured: false }),
    listForConversation: async scope => {
      reads.push(scope);
      return Object.entries(scopeFor(h.session)).every(([key, value]) => scope[key] === value) ? operations : [];
    }
  };
  Object.assign(images, createConversationImages({ conversations: h.conversations, service }));
  h.turns.push({ display: [block], inputText: 'Synthetic request', replyText: 'Synthetic admission' });
  return { h, images, reads, operations };
}

test('a historical admission cannot put a failed drawing in the reference list', async () => {
  const { h, images, operations } = fixture();
  const failed = await images.contextFor(h.session);
  assert.match(failed, /failed; ready=false/);
  assert.doesNotMatch(failed, /Synthetic drawing|Pictures already on screen/);
  operations[0] = ready;
  const verified = await images.contextFor(h.session);
  assert.match(verified, /1\. Synthetic drawing/);
  assert.doesNotMatch(verified, /already on screen/i);
});

for (const backend of ['agentx', 'openclaw']) {
  test('the Family turn answers from the failed receipt before dispatch on ' + backend, async () => {
    const { h, reads } = fixture(backend);
    await h.turn(question, 'voice');
    assert.equal(h.sent.length, 0);
    assert.match(h.turns[0].replyText, /échoué/);
    assert.deepEqual(h.turns[0].display || [], []);
    assert.deepEqual(reads, [scopeFor(h.session)]);
  });
}

test('only a ready scoped explicit receipt supports completion, never a claim of display', async () => {
  const { h, images, operations } = fixture();
  for (const [receipt, expected] of [
    [ready, /est prêt/], [{ ...ready, runtimeRestored: false }, /pas confirmée/],
    [{ ...ready, artifact: { sha256: 'invalid' } }, /pas confirmée/],
    [{ id, state: 'queued' }, /attente/], [{ id, state: 'generating' }, /préparation/],
    [{ id, state: 'cancelled' }, /annulée/], [{ id, state: 'unknown' }, /pas confirmée/]
  ]) {
    operations[0] = receipt;
    const text = await images.statusReply(h.session, question, 'fr');
    assert.match(text, expected);
    assert.doesNotMatch(text, /affiché|à l'écran|12345678/);
  }
  for (const receipt of [null, { ...ready, id: 'different' }, { ...ready, admissionPolicy: 'opportunistic' }]) {
    operations.splice(0, operations.length, ...(receipt ? [receipt] : []));
    assert.equal(await images.statusReply(h.session, question, 'fr'), '');
  }
  operations[0] = ready;
  assert.equal(await images.statusReply({ ...h.session, sessionId: 'other-session' }, question, 'fr'), '');
  h.turns.unshift({ display: [{ ...block, status: 'failed', operation: null }] });
  assert.equal(await images.statusReply(h.session, question, 'fr'), '');
});

test('a missing receipt leaves the normal Family turn intact', async () => {
  const { h, operations } = fixture();
  operations.length = 0;
  await h.turn(question, 'text');
  assert.equal(h.sent.length, 1);
  assert.doesNotMatch(h.sent[0].prefix, /Available conversation pictures|ready=true/);
});

test('commands and other scopes never trigger the status shortcut', async () => {
  const { h, images, reads } = fixture();
  for (const text of ['Dessine une étoile.', 'Refais mon dessin.', 'Mon dessin est prêt ? Ajoute une étoile.',
    'Est-ce que mon dessin est prêt pour le concours ?', 'Montre-moi le dessin.']) {
    assert.equal(await images.statusReply(h.session, text, 'fr'), '');
  }
  for (const session of [{ ...h.session, llmx: true }, { ...h.session, scopeId: 'personal' },
    { ...h.session, packId: 'personal_operator', scopeId: 'personal' }]) {
    assert.equal(await images.statusReply(session, question, 'fr'), '');
  }
  assert.equal(reads.length, 0);
});

test('a missing-picture report can accompany only a request to show the existing drawing', async () => {
  const { images, h, reads, operations } = fixture();
  for (const text of ['Je ne vois pas ton image.', 'Je vois pas le dessin !',
    'Peux-tu me montrer le dernier dessin, s’il te plaît ? Je ne vois pas ton image.',
    'Je ne vois pas ton image. Est-ce que tu peux me montrer le dessin que tu as fait ?',
    'Montre-moi le dernier dessin, car je ne vois pas ton image.',
    'Peux-tu me montrer le dessin que tu as fait parce que je ne vois pas ton image ?',
    "I can't see your picture.", 'Could you please show me the last drawing? I don’t see your image.',
    'I cannot see the drawing; please show me the last drawing.',
    'Show me the last drawing because I cannot see the drawing.']) {
    assert.match(await images.statusReply(h.session, text, 'fr'), /échoué/, text);
  }
  const missing = 'Je ne vois pas ton image.';
  operations[0] = ready;
  assert.match(await images.statusReply(h.session, missing, 'fr'), /prêt.*ne peux pas vérifier/i);
  assert.match(await images.statusReply(h.session, "I can't see your picture.", 'en'), /ready.*cannot verify/i);
  assert.equal(await images.statusReply({ ...h.session, sessionId: 'other-session' }, missing, 'fr'), '');
  operations[0] = { ...ready, admissionPolicy: 'opportunistic' };
  assert.equal(await images.statusReply(h.session, missing, 'fr'), '');
  const before = reads.length;
  for (const text of ['Ne me montre pas le dernier dessin. Je ne vois pas ton image.',
    'Je ne vois pas ton image. Dessine un bateau.', 'Je ne vois pas ton image, refais le dessin.',
    'Je ne vois pas ton image, ajoute des étoiles.', 'Montre-moi le radar. Je ne vois pas ton image.',
    'Je ne vois pas ton image sur la page météo.', 'Je ne veux pas voir ton image.',
    'Je ne vois pas ton image. Quelle heure est-il ?', 'Montre-moi le dernier dessin.',
    "I can’t see your picture. Please draw another.", "Don't show me the drawing. I can't see your picture.",
    'I cannot see the radar image.', 'I cannot see your picture. Try again.', 'I cannot see it.']) {
    assert.equal(await images.statusReply(h.session, text, 'fr'), '', text);
  }
  assert.equal(reads.length, before);
});

test('a configured relay keeps its intake and duplicate protection without running inference', async () => {
  const { h, reads } = fixture('agentx', { validClientTurnId: () => true, conversationEnv: { HOUSEHOLD_CONVERSATION_RELAY_ENABLED: 'true' } });
  const turnId = '23456789-1234-4123-8123-123456789abc';
  let accepted = 0, settled = 0;
  h.conversations.acceptTurn = async intake => {
    assert.equal(intake.clientTurnId, turnId);
    return { duplicate: accepted++ > 0 };
  };
  h.conversations.settleTurn = turn => {
    settled++;
    assert.equal(turn.traceId, turnId);
    return h.conversations.recordTurn(turn);
  };
  const submit = async () => {
    const res = { on() {}, removeListener() {}, writableEnded: false, headersSent: false };
    await h.handle({ params: { sessionId: h.session.sessionId }, body: { text: question, channel: 'text', turnId } },
      res, 'child', { browser: true, packId: 'kidx_nestor', modeId: 'family', scopeId: 'family' });
    assert.equal(res.failure, undefined);
    return res.payload;
  };
  await submit();
  const duplicate = await submit();
  assert.equal(duplicate.replayed, false);
  assert.equal(settled, 1);
  assert.equal(reads.length, 1);
  assert.equal(h.sent.length, 0);
});
