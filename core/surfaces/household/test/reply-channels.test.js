'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReplyChannels, storedDisplay, historyText, contract, plainReply } = require('../reply-channels');

function run(deltas, options = {}) {
  const said = [], shown = [];
  const channels = createReplyChannels({ ...options, onSay: text => said.push(text), onShow: block => shown.push(block) });
  for (const delta of deltas) channels.push(delta);
  const result = channels.end();
  return { ...result, streamed: said.join(''), shown };
}

// Every character that reaches speech, split the way a model stream might.
function chunks(text, size) {
  const parts = [];
  for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
  return parts;
}

test('a show block is displayed and never spoken, even split across deltas', () => {
  const reply = 'Voilà! Je t’ai mis les étapes à l’écran.\n<show kind="list" title="Étapes">\n1. Ouvrir\n2. Brancher\n</show>\nOn commence?';
  for (const size of [1, 3, 7, reply.length]) {
    const result = run(chunks(reply, size), { allowSecrets: true });
    assert.equal(result.say, 'Voilà! Je t’ai mis les étapes à l’écran.\n\nOn commence?', `chunk size ${size}`);
    assert.equal(result.streamed.trim(), result.say);
    assert.deepEqual(result.display, [{ id: 'b1', kind: 'list', title: 'Étapes', body: '1. Ouvrir\n2. Brancher' }]);
    assert.equal(result.shown.length, 1);
    assert.doesNotMatch(result.streamed, /show|Brancher/);
  }
});

test('an unclosed block is shown, never spoken', () => {
  const result = run(['Regarde. <show kind="code">npm ci', ' --prefix core']);
  assert.equal(result.say, 'Regarde.');
  assert.equal(result.display[0].kind, 'code');
  assert.equal(result.display[0].body, 'npm ci --prefix core');
});

test('an unknown kind is plain text and a stray closing tag is not spoken', () => {
  const result = run(['<show kind="poem">Une ligne</show> Bon. </show>Fin.']);
  assert.equal(result.display[0].kind, 'text');
  assert.equal(result.say, 'Bon. Fin.');
});

test('the safety net diverts links, paths and key-like tokens from speech', () => {
  const key = 'sk-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c';
  const text = `Ta clé est ${key}. La doc est sur https://example.test/docs?a=1, le fichier dans /srv/agentx/config.env et l'id 123e4567-e89b-12d3-a456-426614174000.`;
  const result = run(chunks(text, 5), { allowSecrets: true, language: 'fr' });
  assert.doesNotMatch(result.streamed, /sk-|https|example|\/srv|123e4567/);
  assert.match(result.say, /Ta clé est \(à l’écran\)\./);
  assert.deepEqual(result.display.map(block => block.kind), ['secret', 'link', 'code', 'secret']);
  assert.equal(result.display[0].body, key);
});

test('Famille never displays or speaks a secret', () => {
  const result = run(['Code: <show kind="secret">hunter2</show> et abc123def456ghi789jkl012mno.'], { allowSecrets: false });
  assert.equal(result.display.length, 0);
  assert.doesNotMatch(result.streamed, /hunter2|abc123/);
  assert.doesNotMatch(result.streamed, /écran/, 'no cue points at a screen that shows nothing');
});

test('a long model or package identifier is code, not a secret', () => {
  const result = run(['Le modèle qwen2.5-coder:32b-instruct-q4_K_M répond.'], { allowSecrets: false });
  assert.deepEqual(result.display.map(block => block.kind), ['code']);
  assert.equal(result.say, 'Le modèle (à l’écran) répond.');
});

test('ordinary long words and numbers stay spoken', () => {
  const text = 'C’est anticonstitutionnellement drôle : 3,5 kilos pour 12 enfants, et/ou 1/2 tasse.';
  const result = run(chunks(text, 4));
  assert.equal(result.say, text);
  assert.equal(result.display.length, 0);
});

test('a short list is spoken; a long list, a table and code go on screen', () => {
  const short = run(['Deux choses :\n- le pain\n- le lait\nC’est tout.']);
  assert.equal(short.display.length, 0);
  assert.match(short.say, /le pain\n- le lait/);

  const long = run(chunks('Voici :\n- a\n- b\n- c\n- d\nVoilà.', 2), { language: 'fr' });
  assert.deepEqual(long.display.map(block => [block.kind, block.body]), [['list', '- a\n- b\n- c\n- d']]);
  assert.equal(long.say, 'Voici :\n(à l’écran)\nVoilà.');

  const table = run(['| a | b |\n|---|---|\n| 1 | 2 |\nFini.'], { language: 'en' });
  assert.equal(table.display[0].kind, 'table');
  assert.equal(table.say, '(on screen)\nFini.');

  const code = run(chunks('Lance ça :\n```bash\nnpm test\n```\nEnsuite on verra.', 3));
  assert.deepEqual(code.display.map(block => [block.kind, block.body]), [['code', 'npm test']]);
  assert.doesNotMatch(code.streamed, /npm|```/);
});

test('a reply made only of screen content still says something', () => {
  const result = run(['<show kind="table">| a |</show>'], { language: 'en' });
  assert.equal(result.say, 'I put it on screen.');
});

test('prose is released word by word, not held until the end of a line', () => {
  const said = [];
  const channels = createReplyChannels({ onSay: text => said.push(text) });
  channels.push('Bonjour mon ami, comment');
  assert.equal(said.join(''), 'Bonjour mon ami,');
  channels.push(' vas-tu?');
  channels.end();
  assert.equal(said.join(''), 'Bonjour mon ami, comment vas-tu?');
});

test('stored display redacts secrets and history shows the model its own blocks', () => {
  const display = [{ id: 'b1', kind: 'list', title: 'Étapes', body: '1. a' }, { id: 'b2', kind: 'secret', title: 'Clé', body: 'sk-x' }];
  const stored = storedDisplay(display);
  assert.deepEqual(stored[1], { id: 'b2', kind: 'secret', title: 'Clé', body: '', redacted: true });
  const history = historyText('Voilà.', stored);
  assert.match(history, /^Voilà\.\n<show kind="list" title="Étapes">\n1\. a\n<\/show>/);
  assert.match(history, /secret was shown masked/);
  assert.doesNotMatch(history, /sk-x/);
  assert.equal(historyText('Seul.', undefined), 'Seul.');
});

test('the prompt contract offers secrets only outside Famille', () => {
  assert.match(contract(), /kind="secret"/);
  assert.doesNotMatch(contract({ family: true }), /\|secret/);
  assert.match(contract({ family: true }), /Never show passwords/);
});

test('plainReply keeps its previous behaviour', () => {
  assert.equal(plainReply('**Bon** [lien](http://x) `code`\n- item'), 'Bon lien code\nitem');
  assert.equal(plainReply(''), '');
});

test('a generated picture reference becomes an image block; other harness files keep their handling', () => {
  const picture = run(['Le voici: MEDIA:/home/example/.openclaw/media/tool-image-generation/mind.png Fatigué mais pas vaincu.']);
  assert.equal(picture.say, 'Le voici: Fatigué mais pas vaincu.');
  assert.deepEqual(picture.display, [{ id: 'b1', kind: 'image', title: '', body: 'mind.png', source: 'generated',
    ref: '/home/example/.openclaw/media/tool-image-generation/mind.png' }]);
  const sound = 'Voici le son. MEDIA:/home/example/.openclaw/media/tool-speech-synthesis/voice---11111111-1111-4111-8111-111111111111.mp3';
  const kept = run([sound]);
  assert.equal(kept.say, sound, 'speech and display strip it exactly as before');
  assert.equal(kept.display.length, 0);
});

test('removing a generated picture reference leaves single spaces, even across stream chunks', () => {
  const picture = 'MEDIA:/home/example/.openclaw/media/tool-image-generation/mind.png';
  for (const deltas of [[`Voici: ${picture} Fin.`], [`Voici: ${picture}`, ' Fin.'], ['Voici:', ` ${picture}`, ' Fin.']]) {
    const result = run(deltas);
    assert.equal(result.say, 'Voici: Fin.', JSON.stringify(deltas));
    assert.equal(result.streamed.trim(), 'Voici: Fin.');
    assert.equal(result.display[0].source, 'generated');
  }
});
