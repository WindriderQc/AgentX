'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestsWebRead, webCheckObserved } = require('../native-web-policy');

test('current public questions and explicitly requested web reads use the native owner', () => {
  for (const text of ['Est-ce que l’équipe de hockey joue ce soir?', 'L’équipe ne joue pas ce soir?', 'What is the weather tomorrow?',
    'Quel est le prix actuel de ce produit?', 'Cherche sur le web la documentation de ce protocole.',
    'Lis https://synthetic.example/article pour me résumer cette page.']) assert.equal(requestsWebRead(text), true, text);
});

test('personal records, system checks, effects, declined searches and ordinary conversation retain their own paths', () => {
  for (const text of ['Regarde mes tâches pour aujourd’hui.', 'Est-ce que mon serveur fonctionne aujourd’hui?',
    'Lis mes courriels récents.', 'Achète ce produit au prix actuel.', 'Ne cherche pas sur le web.',
    'Bonjour.', 'Comment jouer au hockey?', 'Raconte une histoire de météo.']) assert.equal(requestsWebRead(text), false, text);
});

test('tool discovery, foreign observations and loops never establish a current web lookup', () => {
  const runId = 'synthetic-run';
  const evidence = names => ({ toolChecks: { status: 'observed', runId, completedTools: names, loop: null } });
  assert.equal(webCheckObserved(evidence(['tool_search', 'tool_describe']), runId), false);
  assert.equal(webCheckObserved(evidence(['web_search']), 'another-run'), false);
  assert.equal(webCheckObserved({ toolChecks: { ...evidence(['web_search']).toolChecks, loop: { repetitions: 4 } } }, runId), false);
  assert.equal(webCheckObserved(evidence(['web_search']), runId), true);
  assert.equal(webCheckObserved(evidence(['web_fetch']), runId), true);
});
