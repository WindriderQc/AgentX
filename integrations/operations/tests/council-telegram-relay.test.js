'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { pendingMessages, run, validateConfig } = require('../council-telegram-relay');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghij';
const NOW = Date.parse('2026-10-03T04:00:00Z');
const CONFIG = { chatId: '-1001234567890', topicId: '77', tokenFile: '/synthetic/token', councilUrl: 'https://agentx.example.test' };

function session(overrides = {}) {
  return {
    _id: 'rt1', question: 'Faut-il refinancer la marge de crédit?', createdAt: '2026-10-03T03:50:00Z',
    panelConfig: [{ agentId: 'main', runtime: 'openclaw' }, { agentId: 'comptable', runtime: 'openclaw' }],
    turns: [
      { agentId: 'main', role: 'Nestor', round: 1, response: 'Je pencherais pour attendre.' },
      { agentId: 'comptable', role: 'Comptable', round: 1, response: '', error: null }
    ],
    synthesis: { response: '', error: null },
    ...overrides
  };
}

function core(sessions, sent) {
  return async (url, options = {}) => {
    if (String(url).includes('/api/roundtable')) return { ok: true, json: async () => ({ data: sessions }) };
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
}

test('a session owes its header, each finished turn under the speaker name, then the synthesis', () => {
  const messages = pendingMessages(session(), {}, CONFIG);
  assert.deepEqual(messages.map((m) => m.key), ['header', 'turn:1:main']);
  assert.match(messages[0].text, /^🧭 Table ronde\nFaut-il refinancer.*\nhttps:\/\/agentx\.example\.test\/council\?id=rt1$/s);
  assert.equal(messages[1].text, '🗣 Nestor · tour 1\nJe pencherais pour attendre.');
  const later = session({ turns: [...session().turns.slice(0, 1), { agentId: 'comptable', role: 'Comptable', round: 1, error: 'Timeout after 300000ms' }],
    synthesis: { response: 'Attendre la prochaine révision du taux.' } });
  assert.deepEqual(pendingMessages(later, { header: true, turns: ['1:main'] }, CONFIG).map((m) => m.text),
    ['⚠️ Comptable · tour 1 : Timeout after 300000ms', '🧾 Synthèse\nAttendre la prochaine révision du taux.']);
  // A team member who chairs the table signs the verdict.
  const chaired = { ...later, synthesizerConfig: { runtime: 'openclaw', agentId: 'main' } };
  const settled = { header: true, turns: ['1:main', '1:comptable'] };
  assert.equal(pendingMessages(chaired, settled, { ...CONFIG, agentNames: { main: 'Nestor' } })[0].text,
    '🧾 Synthèse · Nestor (président)\nAttendre la prochaine révision du taux.');
  assert.match(pendingMessages(chaired, settled, CONFIG)[0].text, /^🧾 Synthèse · main \(président\)/);
});

test('only sessions that seat agents are mirrored unless all is set, and each message is sent once', async () => {
  const sent = [];
  const modelOnly = session({ _id: 'rt0', panelConfig: [{ agentId: 'a', runtime: 'model' }] });
  const state = { sessions: {} };
  const deps = { config: CONFIG, state, now: () => NOW, readFile: () => TOKEN, fetchImpl: core([session(), modelOnly], sent) };
  const first = await run({ send: true }, deps);
  assert.deepEqual({ sessions: first.sessions, sent: first.sent, failed: first.failed }, { sessions: 1, sent: 2, failed: 0 });
  assert.equal(sent[0].message_thread_id, 77);
  assert.equal(sent[1].text, '🗣 Nestor · tour 1\nJe pencherais pour attendre.');
  const again = await run({ send: true }, deps);
  assert.equal(again.sent, 0);
  const everything = await run({ send: false }, { ...deps, config: { ...CONFIG, all: true }, state: { sessions: {} } });
  assert.equal(everything.sessions, 2);
});

test('a failed send keeps the order and is retried first; preview never needs the token', async () => {
  const sent = [];
  let fail = true;
  const fetchImpl = async (url, options) => {
    if (String(url).includes('/api/roundtable')) return { ok: true, json: async () => ({ data: [session()] }) };
    if (fail) { fail = false; return { ok: false, status: 429, json: async () => ({ ok: false, description: `Too Many Requests ${TOKEN}` }) }; }
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  const state = { sessions: {} };
  const failed = await run({ send: true }, { config: CONFIG, state, now: () => NOW, readFile: () => TOKEN, fetchImpl });
  assert.equal(failed.failed, 1);
  assert.equal(failed.items[0].error.includes(TOKEN), false);
  const retried = await run({ send: true }, { config: CONFIG, state, now: () => NOW, readFile: () => TOKEN, fetchImpl });
  assert.deepEqual(sent.map((m) => m.text.split('\n')[0]), ['🧭 Table ronde', '🗣 Nestor · tour 1']);
  assert.equal(retried.sent, 2);
  const preview = await run({ send: false }, { config: CONFIG, state: { sessions: {} }, now: () => NOW,
    readFile: () => { throw new Error('token must not be read'); }, fetchImpl: core([session()], []) });
  assert.equal(preview.items.length, 2);
  assert.throws(() => validateConfig({ chatId: 'x', tokenFile: '/t' }), /chatId/);
});
