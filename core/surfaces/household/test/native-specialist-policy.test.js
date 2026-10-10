'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestsSecretary, requestsSecretaryRead } = require('../native-specialist-policy');

test('personal mail work and explicit Secretary requests retain native specialist execution', () => {
  for (const text of ['Résume mes courriels récents.', 'Quels sont mes nouveaux mails ?', 'Cherche dans mon Gmail.',
    'What is in my latest emails?', 'Please draft a reply to my email.', 'Demande à la Secrétaire quels outils sont disponibles.',
    'Consulte la secrétaire et regarde mes tâches.']) assert.equal(requestsSecretary(text), true, text);
  for (const text of ['Bonjour.', 'Regarde mes tâches.', 'Comment fonctionne le protocole email ?',
    'La secrétaire est un personnage de ce roman.', 'Ne consulte pas la Secrétaire.', "Don't search my mail."])
    assert.equal(requestsSecretary(text), false, text);
});

test('only conservative personal mail reads enter background consultation', () => {
  for (const text of ['Résume mes courriels récents.', 'Quels sont mes nouveaux mails ?', 'Cherche dans mon Gmail.',
    'What is in my latest emails?', 'Consulte la Secrétaire pour vérifier quels outils de lecture de mes courriels sont disponibles.',
    'Consulte la secrétaire et regarde mes tâches.']) assert.equal(requestsSecretaryRead(text), true, text);
  for (const text of ['Envoie un mail à mon collègue.', 'Please draft a reply to my email.', 'Réponds à mes mails.',
    'Archive mes courriels.', 'Marque mes mails comme lus.', 'Regarde mes mails et supprime les anciens.',
    'Regarde mes mails puis crée une tâche.', 'Ne consulte pas la Secrétaire.', 'Comment fonctionne le protocole email ?'])
    assert.equal(requestsSecretaryRead(text), false, text);
});
