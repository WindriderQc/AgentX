'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreSpeechLanguage, speechText, synthesisText, transcriptionLanguage, withoutMediaReferences } = require('../public/speech-language');

test('a verified recording displays its prose without raw delivery metadata', () => {
  const text = 'Voici un éléphant. 🐘\n\nMEDIA:/assets/household/sounds/elephant-reviewed.ogg';
  assert.equal(withoutMediaReferences(text), 'Voici un éléphant. 🐘');
  assert.equal(speechText(text), 'Voici un éléphant.');
  assert.equal(withoutMediaReferences('Le fichier elephant.ogg contient le son.'), 'Le fichier elephant.ogg contient le son.');
});

test('native audio references never become spoken filenames', () => {
  const reference = 'MEDIA:/home/example/.openclaw/media/tool-speech-synthesis/voice---11111111-1111-4111-8111-111111111111.mp3';
  assert.equal(speechText('Voilà le son. ' + reference), 'Voilà le son.');
  assert.equal(speechText(reference), '');
  assert.equal(speechText('Voici. MEDIA:"/home/example/audio file.mp3" Merci.'), 'Voici. Merci.');
  assert.equal(speechText('Le fichier audio.mp3 contient un son.'), 'Le fichier audio.mp3 contient un son.');
});

test('Kokoro never receives a quote-only sentence after spoken punctuation', () => {
  const quoted = 'Le hibou dit : « Tu gagnes. » Puis il repart.';
  assert.equal(synthesisText(quoted), 'Le hibou dit : « Tu gagnes. Puis il repart.');
  assert.equal(synthesisText('Il dit : “Bonjour !”'), 'Il dit : “Bonjour !');
  assert.equal(synthesisText('He said: "Ready?" Next turn.'), 'He said: "Ready? Next turn.');
  assert.equal(synthesisText('Il dit « bonjour » et repart.'), 'Il dit « bonjour » et repart.');
  assert.equal(synthesisText('C’est l’aventure. L’ombre sourit.'), 'C’est l’aventure. L’ombre sourit.');
  assert.equal(speechText(quoted), quoted, 'display and stored text keep their punctuation');
  assert.equal(synthesisText(quoted, 'voxcpm'), quoted, 'VoxCPM keeps its full prosodic text');
});

test('spoken lists omit enumeration markers while preserving numbers in their content', () => {
  const reply = 'Voici les étapes :\n1. Prépare 3 billets à 7 dollars.\n2) Il reste 2 dollars.\n10. Garde la version 2.5 et 192.0.2.1.';
  assert.equal(speechText(reply), 'Voici les étapes :\nPrépare 3 billets à 7 dollars.\nIl reste 2 dollars.\nGarde la version 2.5 et 192.0.2.1.');
  assert.equal(speechText('1.5 dollars restent. 2026. Le projet continue.'), '1.5 dollars restent. 2026. Le projet continue.');
});

test('spoken tables retain help contacts and crisis resource URLs without reading Markdown separators', () => {
  const text = '| Ressource | Contact |\n| :--- | ---: |\n| Prévention du suicide | 9-8-8 |\n| Info-Social | 811 |\n| Québec | 1 866 APPELLE (277-3553) |';
  const spoken = speechText(text);
  for (const contact of ['9-8-8', '811', '1 866 APPELLE (277-3553)']) assert.ok(spoken.includes(contact), contact);
  assert.doesNotMatch(spoken, /\||---/);
  assert.equal(speechText('Aide : https://suicide.ca/fr et https://988.ca/fr'), 'Aide : suicide.ca et 988.ca');
  assert.equal(speechText('Lien technique https://example.com/private/path'), 'Lien technique');
});

test('the advertised automatic French/English mode requests bounded bilingual recognition', () => {
  assert.equal(transcriptionLanguage('auto'), 'fr-en');
  assert.equal(transcriptionLanguage(''), 'fr-en');
  assert.equal(transcriptionLanguage('fr'), 'fr');
  assert.equal(transcriptionLanguage('en'), 'en');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/conversation-page.js'), 'utf8');
  assert.match(source, /body.append\('language', NestorSpeech.transcriptionLanguage\(lang\)\)/);
});

test('the reported French answer loses owl icons and escaped Markdown, not its facts', () => {
  const source = '🦉 Nestor — Tout est vert côté AgentX. Le check\\_health vient de confirmer : MongoDB connecté, Ollama connecté, RAG en état « green » (138 docs, 3281 chunks, vector store Qdrant sain, embedding nomic-embed-text opérationnel). La fraîcheur du corpus est OK — dernier ingest le 10 sept., bien dans le TTL de 7 jours. Rien à signaler, tout roule. 🦉';
  assert.equal(speechText(source), source.replaceAll('🦉', '').replace('check\\_health', 'check_health').trim());
});

test('composed emoji are silent while natural words, numbers, math and identifiers survive', () => {
  assert.equal(speechText('🦉 👨‍👩‍👧‍👦 👍🏽 🇨🇦 ❤️ 1️⃣ #️⃣ *️⃣ 🏴\u{E0067}\u{E0062}\u{E007F}'), '');
  const literal = 'C’est chouette ! AgentX, MongoDB, check_health, nomic-embed-text : 138 documents, 3281 passages, 7 jours. 2 * 3 = 6; −5 °C; 80 %; 4/2; x_y.';
  assert.equal(speechText(literal), literal);
  assert.equal(speechText('Hello 🦉 Alex, **all clear**.'), 'Hello Alex, all clear.');
  assert.equal(speechText('## Bilan\n- **Disponible** : `MongoDB`\n> _À vérifier_ : __Ollama__'), 'Bilan\nDisponible : MongoDB\nÀ vérifier : Ollama');
  assert.equal(speechText('```sh\ncheck_health --timeout=7\n```'), '');
  assert.equal(speechText(speechText('🦉 **C’est prêt.**')), 'C’est prêt.');
});

test('Québécois French is the default: English needs more English than French words', () => {
  assert.equal(scoreSpeechLanguage('OK').language, 'fr');
  assert.equal(scoreSpeechLanguage('Le build a passé, le deploy est OK.').language, 'fr');
  assert.equal(scoreSpeechLanguage('Can you check the hosts?').language, 'en');
});

test('one language per turn: a chosen language wins, automatic modes follow the speech', () => {
  const { explicitSpeechLanguage, turnSpeechLanguage } = require('../public/speech-language');
  for (const [value, expected] of [['fr', 'fr'], ['en', 'en'], ['fr-CA', 'fr'], ['en_US', 'en'], ['auto', ''], ['fr-en', ''], ['', ''], [undefined, '']]) {
    assert.equal(explicitSpeechLanguage(value), expected, String(value));
  }
  assert.equal(turnSpeechLanguage('Can you check the hosts?', 'en', 'fr'), 'fr');
  assert.equal(turnSpeechLanguage('Bonjour, comment ça va ?', 'fr', 'en'), 'en');
  assert.equal(turnSpeechLanguage('OK', 'en', 'auto'), 'en');
  assert.equal(turnSpeechLanguage('Can you check the hosts?', '', 'fr-en'), 'en');
  assert.equal(turnSpeechLanguage('OK', '', 'auto'), 'fr');
});

test('the Household page speaks each clause in the language the voice loop chose', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/conversation-page.js'), 'utf8');
  assert.match(source, /const lang = NestorSpeech\.normalizeSpeechLanguage\(reply\.language\) \|\| 'fr';/);
  assert.doesNotMatch(source, /replySpeechLanguage/);
});
