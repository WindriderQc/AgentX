'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const sha = 'b'.repeat(64), workId = 'a'.repeat(64), requestId = '174c1870-6f09-4b77-a83b-e493238b928a';
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.value = ''; this.dataset = {}; this.attributes = {}; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
}
const all = (root, tag) => [root, ...root.children.flatMap(child => all(child, tag))].filter(el => el.tag === tag);
const tick = () => new Promise(resolve => setImmediate(resolve));
const item = () => ({ id: workId, sessionId: 'owner', nativeQuestions: { supported: true, intents: [], questions: [{
  basis: { version: 1, workId, requestSha256: 'c'.repeat(64), attemptId: 'attempt', questionId: 'ask_fixture', incarnation: 'fixture', questionSha256: sha },
  answerable: true, questions: [{ questionId: 'constructor', header: 'Day', question: 'Choose a day.', options: [{ label: 'Tuesday' }], isOther: true, multiSelect: false }] }] } });
function panel(api, { entries = [], failStorage = false } = {}) {
  const memory = new Map([['agentx.question-intents:owner', JSON.stringify(entries)]]);
  let refreshed = 0;
  const context = { document: { createElement: tag => new Element(tag) }, crypto: { randomUUID },
    sessionStorage: { getItem: key => memory.get(key), setItem: (key, value) => { if (failStorage) throw Error('Unavailable'); memory.set(key, value); } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/conversation-questions'), 'utf8'), context);
  const questions = context.NestorQuestions.create({ api, base: '/sessions', getLanguage: () => 'fr', onRefresh: () => { refreshed++; } });
  questions.reset('owner'); const host = new Element('main');
  return { questions, host, memory, refreshed: () => refreshed };
}

test('an unsupported native contract is visible and cannot submit anything', () => {
  const p = panel(() => { throw Error('No request allowed'); });
  p.questions.render(p.host, { id: workId, sessionId: 'owner', nativeQuestions: { supported: false, questions: [], intents: [] } });
  assert.match(all(p.host, 'p')[0].textContent, /indisponible/);
  assert.equal(all(p.host, 'button').length, 0);
});

test('missing browser persistence refuses before sending even for prototype-name question IDs', async () => {
  let calls = 0; const p = panel(async () => { calls++; }, { failStorage: true });
  p.questions.render(p.host, item());
  all(p.host, 'input')[0].checked = true;
  await all(p.host, 'form')[0].onsubmit({ preventDefault() {} });
  assert.equal(calls, 0); assert.match(all(p.host, 'p').at(-1).textContent, /Aucune réponse envoyée/);
});

test('a restored reference performs only the exact original lookup, never another submit', async () => {
  const calls = [], ref = { requestId, workId, state: 'unknown' };
  const p = panel(async (url, options) => { calls.push({ url, options }); return { workId, intent: { requestId, resolutionId: requestId, state: 'answered' } }; },
    { entries: [[sha, ref]] });
  p.questions.render(p.host, item()); await tick();
  assert.equal(all(p.host, 'form').length, 0); assert.equal(calls.length, 1);
  assert.equal(calls[0].options, undefined); assert.ok(calls[0].url.endsWith('/question-intents/' + requestId));
});

test('resume uses the retained accepted UUID with an empty body and no replacement decision', async () => {
  const calls = [], p = panel(async (url, options) => { calls.push({ url, options }); return { workId, intent: { requestId, resolutionId: requestId, state: 'answered' } }; });
  const current = item(); current.nativeQuestions.intents.push({ requestId, resolutionId: requestId, questionSha256: sha, state: 'accepted' });
  p.questions.render(p.host, current);
  await all(p.host, 'button').find(button => button.textContent === 'Reprendre cet envoi').onclick();
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/question-intents/' + requestId + '/resume'));
  assert.equal(calls[0].options.body, '{}');
});

test('a late submit response cannot publish or journal into a newly selected conversation', async () => {
  let resolve; const pending = new Promise(r => { resolve = r; });
  const p = panel(async () => pending); p.questions.render(p.host, item());
  all(p.host, 'input')[0].checked = true;
  const sent = all(p.host, 'form')[0].onsubmit({ preventDefault() {} });
  const journal = JSON.parse(p.memory.get('agentx.question-intents:owner'));
  const originalId = journal[0][1].requestId;
  assert.equal(JSON.stringify(journal).includes('Tuesday'), false);
  p.questions.reset('different-owner-session');
  resolve({ workId, intent: { requestId: originalId, resolutionId: originalId, state: 'answered' } });
  await sent; assert.equal(p.refreshed(), 0);
  assert.equal(p.memory.has('agentx.question-intents:different-owner-session'), false);
});
