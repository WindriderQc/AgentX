'use strict';

// A child's "danger" said in passing ("ton STT est en danger", "je n'ai pas de danger")
// no longer replaces Nestor's answer with the 911 sentence; a person in danger still does.
// The background reviewer knows which replies were fixed safety sentences, and the next
// turn knows whether the reviewer's remark was spoken, only shown or withheld.

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessSafety } = require('../persona-prompt');
const { createBrain, transcript, reviewerPrompt, remarkNote } = require('../brain');

const child = text => assessSafety(text);
const adult = text => assessSafety(text, { adult: true });

test('a negated danger raises nothing, for a child or an adult', () => {
  for (const text of ["je n'ai pas de danger", 'je n’ai pas de danger', 'Il n’y a plus de danger', 'Je ne suis pas en danger', 'There is no danger']) {
    for (const safety of [child(text), adult(text)]) {
      assert.deepEqual(safety.flagIds, [], text);
      assert.equal(safety.deterministicEscalation, false, text);
      assert.equal(safety.requiresParentAttention, false, text);
      assert.equal(safety.advisoryNote, '', text);
    }
  }
});

test('a child\'s bare "danger" or a danger to the addressee\'s things goes to the agent with a strict note and still alerts a parent', () => {
  for (const text of ['ton STT est en danger', 'Ta voix est en danger', 'Il y a un danger', 'C’est quoi un danger ?', 'Your mic is in danger']) {
    const safety = child(text);
    assert.equal(safety.deterministicEscalation, false, text);
    assert.deepEqual(safety.flagIds, ['immediate_danger'], text);
    assert.equal(safety.requiresParentAttention, true, text);
    assert.match(safety.advisoryNote, /go to a trusted adult right now and to call 911 if the danger is immediate/, text);
  }
});

test('a person in danger, another danger word or self-harm keeps the immediate reply for a child', () => {
  for (const text of ['Je suis en danger', 'Maman est en danger', 'Ma sœur est en danger', 'On est en danger', 'Le chien est en danger',
    'Danger, il y a le feu', 'Y a-t-il une urgence ?', 'Je ne suis pas en danger mais je saigne', 'Au secours, danger', 'Je veux mourir']) {
    const safety = child(text);
    assert.equal(safety.deterministicEscalation, true, text);
    assert.equal(safety.advisoryNote, '', text);
  }
});

test('an adult\'s "en danger" said of the addressee\'s thing gets the adult note; a person in danger stays immediate', () => {
  assert.equal(adult('ton STT est en danger').deterministicEscalation, false);
  assert.match(adult('ton STT est en danger').advisoryNote, /call 911 now\. Otherwise answer his request normally/);
  for (const text of ['Mon fils est en danger', 'Ma femme est en danger', 'Elle est en danger']) assert.equal(adult(text).deterministicEscalation, true, text);
});

test('the reviewer is told which replies were fixed safety sentences and must not apologise for them', () => {
  const shown = transcript([
    { inputText: 'ton STT est en danger', replyText: 'Va voir un adulte de confiance maintenant.', safetyReply: 'escalation' },
    { inputText: 'mon mot de passe', replyText: 'Je ne peux pas aider.', safetyReply: 'child_boundary' },
    { inputText: 'Bonjour', replyText: 'Salut!' }
  ]);
  assert.match(shown, /Nestor \(fixed safety reply chosen by a rule, not written by a model; spoken\): Va voir/);
  assert.match(shown, /Nestor \(fixed child-safety boundary reply chosen by a rule, not written by a model; spoken\): Je ne peux pas/);
  assert.match(shown, /Nestor \(spoken\): Salut!/);
  assert.match(reviewerPrompt({ family: true }), /fixed safety reply was chosen by a safety rule, not by Nestor: never apologise for it/);
});

test('the next turn learns whether the remark was spoken, only shown or withheld', () => {
  const remark = { text: 'Petite précision.' };
  assert.match(remarkNote(remark, 'spoken'), /already said this remark aloud at a pause: "Petite précision\."\. Do not repeat it\./);
  assert.match(remarkNote(remark, 'shown'), /shown on screen only and never spoken; say it only if it still fits/);
  assert.match(remarkNote(remark, 'withheld'), /not presented because the person asked for quiet/);
  assert.match(remarkNote(remark, undefined), /it may already have been said at a pause/);
});

const SESSION = { sessionId: 'family-1', packId: 'kidx_nestor', scopeId: 'family' };
const REVIEW = JSON.stringify({ suggestions: [], corrections: [], interjection: { text: 'Petite précision.', urgent: false } });
const LIVE = { revision: 2, values: { backgroundReview: true, reviewDelaySeconds: 0 } };

function store() {
  const row = { ...SESSION, turnCount: 1 }, queries = [];
  return { row, queries, getSession: async ({ sessionId }) => (sessionId === row.sessionId ? structuredClone(row) : null),
    updateSession: async (query, update) => {
      queries.push(query);
      if (query.sessionId !== row.sessionId || query.packId !== row.packId || query.scopeId !== row.scopeId) return null;
      if ('turnCount' in query && query.turnCount !== row.turnCount) return null;
      if (query['backgroundReview.review.adviceId'] && row.backgroundReview?.review?.adviceId !== query['backgroundReview.review.adviceId']) return null;
      row.backgroundReview = structuredClone(row.backgroundReview || {});
      for (const [path, value] of Object.entries(update.$set || {})) {
        const keys = path.split('.').slice(1), last = keys.pop();
        let target = row.backgroundReview;
        for (const key of keys) target = target[key] ||= {};
        target[last] = value;
      }
      return structuredClone(row);
    } };
}

function router() {
  const routes = {};
  return { routes, get: (path, handler) => { routes['GET ' + path] = handler; }, post: (path, handler) => { routes['POST ' + path] = handler; } };
}

async function call(handler, req) {
  let status = 200, body;
  const res = { status(code) { status = code; return res; }, json(value) { body = value; return res; }, on() {} };
  await handler(req, res);
  return { status, body };
}

test('the page reports the remark presentation; the stored review and the next turn keep it', async () => {
  const conversations = store();
  const brain = createBrain({ conversations, env: {}, preferencesFor: async () => structuredClone(LIVE), loadTurns: async () => [{ inputText: 'a', replyText: 'b' }],
    inference: { execute: async () => ({ ok: true, body: { response: REVIEW } }) } });
  brain.schedule({ session: SESSION, pack: { childSafe: true }, traceId: 't1' });
  const review = await brain.wait(SESSION.sessionId, 't1');
  assert.ok(review.adviceId);
  const r = router();
  brain.register(r);
  const route = r.routes['POST /family/sessions/:sessionId/brain/presentation'];
  assert.ok(route, 'a family presentation route is registered');
  assert.equal((await call(route, { params: { sessionId: SESSION.sessionId }, body: { adviceId: review.adviceId, presented: 'loud' } })).status, 400);
  assert.equal((await call(r.routes['POST /private/sessions/:sessionId/brain/presentation'], { params: { sessionId: SESSION.sessionId },
    body: { adviceId: review.adviceId, presented: 'shown' } })).status, 404, 'another space cannot report on this conversation');
  const unknown = await call(route, { params: { sessionId: SESSION.sessionId }, body: { adviceId: 'other-advice', presented: 'spoken' } });
  assert.equal(unknown.body.data.recorded, false, 'an older or unknown advice changes nothing');
  const ok = await call(route, { params: { sessionId: SESSION.sessionId }, body: { adviceId: review.adviceId, presented: 'shown' } });
  assert.equal(ok.body.data.recorded, true);
  assert.equal(conversations.row.backgroundReview.review.interjectionPresented, 'shown');
  assert.match(await brain.contextFor(SESSION.sessionId), /shown on screen only and never spoken/);
  // After a restart, the stored record carries the same answer.
  const restarted = createBrain({ conversations, env: {}, preferencesFor: async () => structuredClone(LIVE), loadTurns: async () => [] });
  assert.match(await restarted.contextFor(SESSION.sessionId, await conversations.getSession(SESSION)), /shown on screen only and never spoken/);
});
