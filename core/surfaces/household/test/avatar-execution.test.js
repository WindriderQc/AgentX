'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { describe, workText } = require('../public/avatar-execution');

test('scene uses actual model evidence, distinguishes relay and never infers busy from a selected backend', () => {
  assert.match(describe({ routing: { backend: 'hermes' } }), /attente de confirmation/);
  assert.match(describe({ model: { model: 'observed-cloud' }, routing: { backend: 'hermes' } }), /Dernière réponse · Big Brain · observed-cloud · Hermes/);
  assert.match(describe({ execution: { model: 'observed-local', backend: 'agentx', continuity: { state: 'backup', reason: 'hermes_active' } } }, false), /Réponse en cours · Gardien.*observed-local.*demande précédente/);
  assert.match(describe({ model: 'observed-local', routingSource: 'conversation_continuity', fallbackUsed: true }), /Motif du relais non précisé/);
  assert.doesNotMatch(describe({ model: 'observed-local', routing: { fallbackUsed: true } }), /occupé|traite une autre demande/);
  assert.match(describe({ model: 'agentx-status' }), /aucun modèle/);
});

test('scene work names come from observed pending requests, with stale and uncertain disclosures', () => {
  assert.equal(workText({ works: [{ state: 'running', requestText: 'Vérifier le calendrier' }, { state: 'completed', requestText: 'Ancienne demande' }] }), 'Vérifier le calendrier · en cours');
  assert.equal(workText({ turns: [{ works: [{ state: 'running', requestText: 'Demande suivie' }] }] }), 'Demande suivie · en cours');
  assert.match(workText({ works: [{ state: 'uncertain' }] }), /issue non confirmée/);
  assert.equal(workText({ stale: true, works: [{ state: 'running', requestText: 'Stale work' }] }), 'Suivi du travail indisponible');
});

test('the badge role comes from the same evidence as the detail line', () => {
  const { classify, openWorks } = require('../public/avatar-execution');
  assert.equal(classify(null), null);
  assert.equal(classify({ routing: { backend: 'hermes' } }).role, 'pending', 'a selected backend is not a reply model');
  assert.equal(classify({ model: { model: 'observed-cloud' } }).role, 'brain');
  assert.equal(classify({ execution: { model: 'observed-local', continuity: { state: 'backup', reason: 'primary_busy' } } }).role, 'guardian');
  assert.equal(classify({ model: 'observed-local', tools: { conversationRelay: { role: 'relay' } } }).role, 'guardian');
  assert.equal(classify({ model: 'observed-local', routing: { fallbackUsed: true } }).role, 'fallback');
  assert.equal(classify({ model: 'agentx-status' }).role, 'status');
  assert.deepEqual(openWorks({ works: [{ state: 'running', requestText: 'Vérifier le calendrier' }, { state: 'completed', requestText: 'Fini' }, { state: 'queued' }] }),
    [{ text: 'Vérifier le calendrier', state: 'running', words: 'en cours' }, { text: 'Demande conservée', state: 'queued', words: 'en attente' }]);
  assert.deepEqual(openWorks({ stale: true, works: [{ state: 'running', requestText: 'x' }] }), [], 'stale tracking lists nothing as current');
});
