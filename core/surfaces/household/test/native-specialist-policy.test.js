'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestsSecretary, requestsSecretaryRead, requestsDirectSecretaryRead, requestsReadEffects } = require('../native-specialist-policy');

test('personal mail work and explicit Secretary requests retain native specialist execution', () => {
  for (const text of ['Résume mes courriels récents.', 'Quels sont mes nouveaux mails ?', 'Cherche dans mon Gmail.', 'Lis les nouveaux messages de ma boîte.', 'Read my inbox.',
    'What is in my latest emails?', 'Please draft a reply to my email.', 'Demande à la Secrétaire quels outils sont disponibles.',
    'Consulte la secrétaire et regarde mes tâches.']) assert.equal(requestsSecretary(text), true, text);
  for (const text of ['Bonjour.', 'Regarde mes tâches.', 'Comment fonctionne le protocole email ?',
    'Lis le numéro de ma boîte à outils.', 'Lis les messages de ma boîte vocale.', 'La secrétaire est un personnage de ce roman.', 'Ne consulte pas la Secrétaire.', "Don't search my mail."])
    assert.equal(requestsSecretary(text), false, text);
});

test('only conservative personal mail reads enter background consultation', () => {
  for (const text of ['Résume mes courriels récents.', 'Quels sont mes nouveaux mails ?', 'Cherche dans mon Gmail.', 'Lis les nouveaux messages de ma boîte.', 'Read my inbox.',
    'What is in my latest emails?', 'Consulte la Secrétaire pour vérifier quels outils de lecture de mes courriels sont disponibles.',
    'Consulte la secrétaire et regarde mes tâches.']) assert.equal(requestsSecretaryRead(text), true, text);
  for (const text of ['Envoie un mail à mon collègue.', 'Please draft a reply to my email.', 'Réponds à mes mails.',
    'Archive mes courriels.', 'Marque mes mails comme lus.', 'Regarde mes mails et supprime les anciens.',
    'Regarde mes mails puis crée une tâche.', 'Ne consulte pas la Secrétaire.', 'Comment fonctionne le protocole email ?'])
    assert.equal(requestsSecretaryRead(text), false, text);
});


test('an explicit tool-free reply style does not select external effects', () => {
  for (const text of [
    'Bonjour Nestor. Pour cet échange, ma couleur choisie est le bleu. Réponds brièvement sans outil.',
    'Quelle couleur ai-je choisie pour cet échange ? Réponds en une phrase sans outil.',
    'Remember blue. Reply briefly without tools.',
    'Which colour did I choose? Reply in one sentence without any tools.'
  ]) assert.equal(requestsReadEffects(text), false, text);
});

test('addressed replies and other effects retain Main even beside a tool-free style instruction', () => {
  for (const text of ['Réponds à mon courriel. Réponds brièvement sans outil.',
    'Réponds brièvement à Paul sans outil.', 'Reply briefly to my email without tools.',
    'Envoie mon message. Réponds en une phrase sans outil.',
    'Crée une tâche. Réponds brièvement sans outil.', 'Send my reply. Reply briefly without tools.']) {
    assert.equal(requestsReadEffects(text), true, text);
  }
  assert.equal(requestsSecretaryRead('Réponds à mon courriel. Réponds brièvement sans outil.'), false);
});

test('only a complete translation of one quoted operand can enter the isolated session', () => {
  const { quotedTranslation } = require('../../../../shared/quotedTranslation.cjs');
  for (const text of ['Traduis en anglais « lis mes derniers courriels ».', 'Traduis en anglais “lis mes derniers courriels”.',
    'Translate "lis mes derniers courriels" into English.']) {
    assert.equal(quotedTranslation(text).source, 'lis mes derniers courriels');
  }
  for (const text of ['Lis mon courriel intitulé « en anglais ».', 'Exécute « lis mes courriels ».',
    'Traduis en anglais mon dernier courriel.', 'Traduis en anglais « A », puis envoie « B ».',
    'Traduis en anglais « A » puis lis mes courriels.', 'Traduis en anglais « A”.', 'Traduis en anglais «  ».']) {
    assert.equal(quotedTranslation(text), null, text);
  }
});

test('the direct mailbox evidence requirement applies to the requested read clause', () => {
  for (const text of ['Lis les nouveaux messages de ma boîte.', 'Please read my inbox.',
    'Traduis « lis ce livre », puis lis mes courriels.']) assert.equal(requestsDirectSecretaryRead(text), true, text);
  for (const text of ['Traduis en anglais « lis mes courriels ».', 'Explique la phrase “read my inbox”.',
    'Comment lire mes nouveaux courriels ?', 'Read the line "check my inbox".', 'Ne lis pas mes courriels.']) {
    assert.equal(requestsDirectSecretaryRead(text), false, text);
  }
});
