'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { replyRequest, judgeRequest, converse, readJudgement, measure, summarize, GENERIC_CRITERIA } = require('../eval/run');

const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'eval', 'scenarios.json'), 'utf8')).scenarios;

test('scenarios are well formed and unique', () => {
  const ids = new Set();
  for (const scenario of scenarios) {
    assert.ok(!ids.has(scenario.id), scenario.id);
    ids.add(scenario.id);
    assert.ok((scenario.message || scenario.turns?.length >= 2) && !(scenario.message && scenario.turns) && scenario.skill && scenario.criteria.length >= 2, scenario.id);
    for (const criterion of scenario.criteria) assert.ok(!GENERIC_CRITERIA.some(item => item.id === criterion.id), criterion.id);
  }
});

test('the reply request mirrors the chat: stance, depth, safety and session opening', () => {
  const byId = Object.fromEntries(scenarios.map(item => [item.id, item]));
  const deep = replyRequest(byId.overextension);
  assert.deepEqual([deep.taskType, deep.think], ['deep_reasoning', true]);
  assert.match(deep.messages[0].content, /Mode: ANALYZE/);

  const challenge = replyRequest(byId['convenient-story']);
  assert.equal(challenge.options.temperature, 0.55);
  assert.deepEqual(challenge.messages.slice(1).map(item => item.role), ['user', 'assistant', 'user']);

  const crisis = replyRequest({ message: 'Je veux mourir', control: { mode: 'challenge', depth: 'deep' }, criteria: [] });
  assert.equal(crisis.safety, true);
  assert.equal(crisis.taskType, 'analysis');
  assert.match(crisis.messages[0].content, /SAFETY STANCE/);

  const returning = replyRequest(byId['returning-experiment']);
  assert.match(returning.messages[0].content, /first message of a new session/);
  assert.match(returning.messages[0].content, /Prendre 10 minutes seul/);
});

test('judgements are clamped, missing criteria score zero, and summaries average repeats', () => {
  const scenario = { criteria: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], skill: 's', message: 'm' };
  assert.match(judgeRequest({ judgeTask: 'deep_reasoning' }, scenario, 'reply').messages[1].content, /- a: A[\s\S]*- french:/);
  const judged = readJudgement('noise {"criteria":[{"id":"a","score":7},{"id":"french","score":1}],"overall":9}', scenario);
  assert.deepEqual([judged.scores.a.score, judged.scores.b.score, judged.scores.french.score, judged.overall], [2, 0, 1, 5]);
  assert.deepEqual(measure('Bonjour. Ça va? Et toi?'), { words: 5, questions: 2, markdown: false });

  const run = score => ({ judgement: { scores: { a: { score }, french: { score: 2 } }, overall: score + 3 }, metrics: { words: 10, questions: 1 } });
  const summary = summarize([{ id: 'x', runs: [run(2), run(0)] }]);
  assert.deepEqual(summary.rows[0], { id: 'x', skill: 50, criteria: 75, overall: 4, words: 10, questions: 1 });
});

test('a conversation scenario is answered turn by turn on the chosen lane and judged as a whole', async () => {
  const byId = Object.fromEntries(scenarios.map(item => [item.id, item]));
  const seen = [];
  const frontier = { run: async input => { seen.push(input); return { content: `réponse ${seen.length}` }; } };
  const options = { lane: 'frontier', frontier, agent: 'psyx', preface: 'PREFACE', judgeTask: 'deep_reasoning' };
  const scenario = byId['conversation-guidance'];
  const result = await converse(options, scenario);
  assert.equal(seen.length, scenario.turns.length);
  assert.match(seen[0].instructions, /^PREFACE\n\nYou are PsyX/);
  assert.deepEqual(seen.at(-1).messages.map(item => item.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(seen.at(-1).messages[1].content, 'réponse 1');
  assert.deepEqual([result.reply, result.transcript.length, result.model], ['réponse 4', 8, 'openclaw/psyx']);
  const judge = judgeRequest(options, scenario, result.reply, result.transcript);
  assert.match(judge.messages[0].content, /whole conversation/);
  assert.match(judge.messages[1].content, /PsyX: réponse 1[\s\S]*PsyX: réponse 4[\s\S]*- ends_with_step:/);

  const portrait = replyRequest(byId['uses-portrait'], { lane: 'frontier' });
  assert.match(portrait.messages[0].content, /PSYX PORTRAIT[\s\S]*Quand tu te sens jugé comme père[\s\S]*séance du 28 septembre/);
  assert.doesNotMatch(replyRequest(byId['uses-portrait']).messages[0].content, /séance du 28 septembre/);
});
