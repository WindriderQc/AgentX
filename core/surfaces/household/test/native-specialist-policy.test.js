'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestsSecretary } = require('../native-specialist-policy');

test('personal mail work and explicit Secretary requests retain native specialist execution', () => {
  for (const text of ['Résume mes courriels récents.', 'Quels sont mes nouveaux mails ?', 'Cherche dans mon Gmail.',
    'What is in my latest emails?', 'Please draft a reply to my email.', 'Demande à la Secrétaire quels outils sont disponibles.',
    'Consulte la secrétaire et regarde mes tâches.']) assert.equal(requestsSecretary(text), true, text);
  for (const text of ['Bonjour.', 'Regarde mes tâches.', 'Comment fonctionne le protocole email ?',
    'La secrétaire est un personnage de ce roman.', 'Ne consulte pas la Secrétaire.', "Don't search my mail."])
    assert.equal(requestsSecretary(text), false, text);
});
