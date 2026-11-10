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
