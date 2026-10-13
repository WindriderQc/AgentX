'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestsTaskCheck, taskCheckObserved } = require('../tool-turn-guard');

test('only an explicit personal task read asks for same-turn task evidence', () => {
  for (const text of ['Regarde mes tâches ouvertes et dis-moi combien il y en a.', 'Combien de mes tâches sont ouvertes ?', 'Peux-tu vérifier mes tâches ?', 'Peux-tu regarder ma liste de tâches ?', 'Consultez nos tâches.', 'Please check my to-do list.', 'Show my tasks.']) assert.equal(requestsTaskCheck(text), true, text);
  for (const text of ['Bonjour', 'Comment organiser mes tâches ?', 'How to count my tasks in a spreadsheet?', 'Ne regarde pas mes tâches.', 'Please do not check my tasks.', 'Combien de tâches dans cet exemple ?']) assert.equal(requestsTaskCheck(text), false, text);
});

test('questions about the owner’s current task priorities require a real task read; general advice stays conversational', () => {
  for (const text of ['Quelles sont mes tâches prioritaires ?', 'Je voudrais savoir quoi prioriser dans mes tâches.',
    'Peux-tu me dire ce qui est prioritaire dans mes tâches ?', 'What are my highest priority tasks?']) {
    assert.equal(requestsTaskCheck(text), true, text);
  }
  for (const text of ['Comment prioriser mes tâches ?', 'Tell me a story about my tasks.', 'Mes tâches me fatiguent.']) {
    assert.equal(requestsTaskCheck(text), false, text);
  }
});

test('task evidence must belong to this run and contain a successful task tool', () => {
  const runId = 'current';
  assert.equal(taskCheckObserved({ toolChecks: { status: 'observed', runId, completedTools: ['agents_list'] } }, runId), false);
  assert.equal(taskCheckObserved({ toolChecks: { status: 'observed', runId: 'old', completedTools: ['list_personal_tasks'] } }, runId), false);
  assert.equal(taskCheckObserved({ toolChecks: { status: 'observed', runId, completedTools: ['list_personal_tasks'] } }, runId), true);
  assert.equal(taskCheckObserved({ receipts: [{ runId, tool: 'agentx__list_personal_tasks', status: 'failed' }] }, runId), false);
  assert.equal(taskCheckObserved({ receipts: [{ runId, tool: 'agentx__list_personal_tasks', status: 'verified' }] }, runId), true);
  assert.equal(taskCheckObserved({ receipts: [{ runId, tool: 'conversation_work', status: 'verified', acceptedWork: { id: 'a'.repeat(64) } }] }, runId), false);
});
