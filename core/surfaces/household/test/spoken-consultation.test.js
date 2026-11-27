'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const spoken = require('../spoken-consultation');
const { runLocalConversation } = require('../conversation-inference');
const { readReplyFrames } = require('../persona-catalog');
const { prepare } = require('../persona-relay-turn');
const { personalReads } = require('../spoken-personal-reads');

const env = { HOUSEHOLD_SPOKEN_HOST: 'speaker', HOUSEHOLD_THINKER_HOST: 'worker' };
const family = { sessionId: 'f', packId: 'kidx_nestor', scopeId: 'family', modeId: 'family' };
const personal = { sessionId: 'p', packId: 'personal_operator', scopeId: 'personal', modeId: 'operator' };
const target = key => ({ model: key, hostUrl: 'http://' + key, contextSize: 8192 });
const pack = { id: 'kidx_nestor', childSafe: true, maxTokens: 512, systemPrompt: 'Family scope.' };
const request = () => ({ backend: 'agentx', session: family, channel: 'voice', text: 'Question originale',
  agentxInstructions: 'Scoped worker instructions', pack, history: [], spoken: { context: 'Source publique', consulting() {} } });
const result = (model, content, fields = {}) => ({ ok: true, metadata: { model, hostUrl: target(model).hostUrl },
  ...(model !== 'worker' && { stream: [JSON.stringify({ model, done: true, done_reason: 'stop', message: { content }, ...fields })],
    completion: Promise.resolve({ completed: true, terminalComplete: true }) }),
  body: { model, done: true, done_reason: 'stop', message: { content }, ...fields } });
const run = (req, execute) => runLocalConversation({ request: req, prepared: [{ role: 'user', content: req.text }],
  inference: { execute }, consumerContract: 'household-test', env });

test('only ordinary scoped microphone sessions can use a local pair', () => {
  assert.ok(spoken.enabled(family, 'voice', env)); assert.ok(spoken.enabled(personal, 'voice', env));
  for (const invalid of [{ ...family, scopeId: 'personal' }, { ...personal, agentId: 'other' },
    { ...personal, ephemeral: true }, { ...personal, modeId: 'open' }, { ...family, llmx: {} }]) assert.equal(spoken.enabled(invalid, 'voice', env), false);
  assert.equal(spoken.enabled(family, 'text', env), false);
  assert.equal(spoken.enabled(family, 'voice', {}), false);
});

test('a direct spoken reply has a single nonthinking call, canonical voice text, no tools', async t => {
  t.mock.method(spoken, 'pinned', target);
  const req = request(), deltas = [], calls = [];
  req.onDelta = delta => deltas.push(delta);
  const reply = await run(req, async (body, options) => {
    calls.push(body); assert.equal(options.hostUrl, 'http://speaker'); assert.equal(body.think, false); assert.equal(body.stream, true);
    assert.equal(body.tools, undefined); assert.ok(body.format); assert.match(body.messages.at(-1).content, /Question originale$/);
    return result('speaker', JSON.stringify({ mode: 'parler', texte: 'Oui.' }));
  });
  assert.equal(calls.length, 1); assert.deepEqual(deltas, ['Oui.']); assert.equal(reply.tools.spokenDialogue, 'direct');
});

test('interrupting the foreground waits for verified release and discards its decision', async () => {
  for (const verified of [true, false]) {
    const controller = new AbortController();
    let settled = false, release;
    const receipt = new Promise((resolve, reject) => { release = () => verified ? resolve({ completed: true }) : reject(new Error('unverified release')); });
    const reply = spoken.decide({ ...request(), signal: controller.signal, onSettled: () => { settled = true; } },
      { execute: async () => {
        controller.abort();
        return { ...result('speaker', '{"mode":"consulter","texte":""}'), completion: receipt };
      } }, 'test', env, target);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release();
    await assert.rejects(reply, verified ? { name: 'AbortError' } : /unverified release/);
    assert.equal(settled, verified);
  }
});

test('a consultation uses the original request, same scope and only its own tools', async t => {
  t.mock.method(spoken, 'pinned', target);
  const req = request(), called = [];
  req.spoken.consulting = () => called.push('consulting');
  req.familyTools = { names: ['family_read'], definitions: ['only family'], maxRounds: 1, maxCallsPerRound: 1,
    execute: async () => { called.push('read'); return { message: { role: 'tool', content: '42' }, receipt: { tool: 'family_read' } }; } };
  const reply = await run(req, async (body, options) => {
    if (body.model === 'speaker') return result('speaker', JSON.stringify({ mode: 'consulter', texte: 'Une autre intention' }));
    assert.equal(body.thinkingMode, 'auto'); assert.equal(options.hostUrl, 'http://worker'); assert.equal(options.retry.enabled, false);
    assert.equal(body.messages[1].content, req.text); assert.equal(body.messages[0].content, req.agentxInstructions);
    if (body.tools) { assert.deepEqual(body.tools, ['only family']); return result('worker', '', { message: { tool_calls: [{ function: { name: 'family_read' } }] } }); }
    return result('worker', 'Quarante-deux.');
  });
  assert.deepEqual(called, ['consulting', 'read']); assert.equal(reply.text, 'Quarante-deux.'); assert.equal(reply.tools.spokenDialogue, 'consulted');
});

test('incomplete and misrouted decisions cannot be spoken or execute a tool', async () => {
  const req = request();
  const limited = await spoken.decide(req, { execute: async () => result('speaker', '{"mode":', { done_reason: 'length' }) }, 'test', env, target);
  assert.equal(limited.mode, 'consulter');
  await assert.rejects(spoken.decide(req, { execute: async () => result('wrong', '{}') }, 'test', env, target));
  await assert.rejects(readReplyFrames([JSON.stringify({ done: true, done_reason: 'length', message: { content: 'part' } })], () => {}), { code: 'VOICE_REPLY_INCOMPLETE' });
  await assert.rejects(readReplyFrames([JSON.stringify({ done: false })], () => {}), /before completion/);
  req.history = [{ role: 'user', content: 'a'.repeat(2300) }, { role: 'assistant', content: 'Fin.' }];
  assert.equal(spoken.messagesFor(req), null);
});

test('private reads enforce the operation before invoking Core', async () => {
  let invoked = 0;
  const tools = personalReads(personal, {}, async (name, args) => {
    invoked++; assert.equal(name, 'personal_calendar'); assert.equal(args.action, 'list'); return { structuredContent: { events: [] } };
  });
  assert.equal(personalReads(family, {}), null);
  const filters = { timeMin: '2030-01-01T01:00:00Z', timeMax: '2030-01-02T01:00:00Z' };
  for (const [name, args] of [['personal_calendar', { ...filters, action: 'create' }], ['other', {}]]) {
    assert.equal((await tools.execute({ function: { name, arguments: args } })).receipt.status, 'refused');
  }
  assert.equal((await tools.execute({ function: { name: 'personal_calendar', arguments: filters } })).receipt.status, 'completed');
  assert.equal(invoked, 1);
});

test('only a pending consulted turn detaches and its original id owns the worker', async () => {
  const entry = { abort: new AbortController() }, active = new Map([['f', entry]]), started = [];
  await prepare({ entry, session: family, backend: 'agentx', conversationEnv: env, channel: 'voice', clientTurnId: 'turn-a',
    streaming: true, memberWork: { start: (...args) => started.push(args) }, activePersonaTurns: active, res: { end() {} },
    conversations: { acceptTurn: async () => ({ duplicate: false }) }, userText: 'Question' });
  assert.equal(entry.detach(), false); entry.consulting = true;
  entry.generated = 'Audible'; assert.equal(entry.detach(), false); entry.generated = '';
  assert.equal(entry.detach(), true); assert.equal(entry.detach(), false); assert.equal(active.size, 0);
  assert.deepEqual(started[0].slice(0, 2), ['f', 'turn-a']);
});

test('the foreground sees completed exchanges while an accepted lookup owns its unanswered question', async t => {
  t.mock.method(spoken, 'pinned', target);
  const rows = [{ clientTurnId: 'active', outcome: 'pending', inputText: 'lookup' },
    { clientTurnId: 'prior', outcome: 'completed', inputText: 'old', replyText: 'resolved' }];
  const memberWork = { active: () => [{ turnId: 'active' }] };
  const selected = spoken.followupHistory(rows, family, memberWork, 'agentx', 'voice', env);
  assert.deepEqual(selected, [rows[1]]);
  const req = request();
  req.history = require('../persona-records').sessionHistoryMessages(selected, { ...pack, historyTurns: 4 });
  const reply = await run(req, async body => {
    assert.equal(body.model, 'speaker'); assert.deepEqual(body.messages.slice(1,3).map(m => m.content), ['old','resolved']);
    return result('speaker', JSON.stringify({ mode: 'parler', texte: 'Pip.' }));
  });
  assert.equal(reply.tools.spokenDialogue, 'direct');
  assert.equal(spoken.followupHistory(rows, family, memberWork, 'agentx', 'text', env), rows);
});

test('the spoken screen context keeps complete scoped facts and defers large panels', () => {
  const compact = spoken.screenReference({ kind: 'text', status: 'visible', title: 'Panorama', text: 'Twelve' });
  assert.match(compact, /Twelve/);
  const large = spoken.screenReference({ kind: 'page', status: 'visible', title: 'Panorama', read: 'x'.repeat(2000),
    artx: { status: 'available', caption: 'Lune' } });
  assert.match(large, /Panorama/); assert.match(large, /consult the scoped source/); assert.match(large, /Lune/);
  assert.ok(!large.includes('x'.repeat(20))); assert.equal(spoken.screenReference({ status: 'none' }), '');
});
