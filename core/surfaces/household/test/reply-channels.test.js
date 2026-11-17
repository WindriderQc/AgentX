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

test('Markdown references become complete link cards across stream boundaries', () => {
  const url = 'https://www.example.test/astronomy/night-sky-2026?source=reference';
  for (const label of ['example.test', 'Le ciel de novembre']) {
    const reply = `Consulte [${label}](${url}), puis on continue.`;
    for (const size of [1, 2, 5, 17, reply.length]) {
      const result = run(chunks(reply, size));
      assert.equal(result.say, 'Consulte (à l’écran), puis on continue.', `chunk size ${size}`);
      assert.deepEqual(result.display, [{ id: 'b1', kind: 'link', title: label, body: url }]);
      assert.doesNotMatch(result.streamed, /https|example|\[|\]|novembre/);
      assert.deepEqual(storedDisplay(result.display), result.display);
    }
  }
});

test('Markdown links retain balanced target parentheses, adjacent references and ordinary brackets', () => {
  const url = 'https://example.test/wiki/Sky_(astronomy)?year=2026';
  const result = run(chunks(`[Ciel](${url})[Suite](https://example.test/next).\nNote [à vérifier] demain.`, 1));
  assert.deepEqual(result.display.map(block => block.body), [url, 'https://example.test/next']);
  assert.equal(result.say, '(à l’écran)(à l’écran).\nNote [à vérifier] demain.');
  const fenced = run(['```markdown\n[Exemple](https://example.test/2026)\n```']);
  assert.equal(fenced.display[0].kind, 'code');
  assert.equal(fenced.display[0].body, '[Exemple](https://example.test/2026)');
});

test('Markdown help references keep their resource name audible', () => {
  const result = run(chunks('Aide : [Ressource](https://988.ca/fr).', 1));
  assert.equal(result.say, 'Aide : 988.ca.');
  assert.deepEqual(result.display.map(block => block.kind), ['link']);
});

test('recognized model tags speak their family and size while retaining the exact identifier', () => {
  const result = run(['Le modèle qwen2.5-coder:32b-instruct-q4_K_M répond.'], { allowSecrets: false });
  assert.deepEqual(result.display.map(block => block.kind), ['code']);
  assert.equal(result.say, 'Le modèle qwen2.5 coder 32b répond.');
  const tag = 'example/gemma4:12b-it-qat';
  const named = run(chunks(`Je fonctionne avec ${tag}.`, 5));
  assert.equal(named.say, 'Je fonctionne avec gemma4 12b.');
  assert.equal(named.display[0].body, tag);
  assert.equal(run([tag], { readAloud: true }).say, tag);
  assert.doesNotMatch(run([`<show kind="secret">${tag}</show>`]).say, /gemma|example/);
  const list = run([[1, 2, 3, 4].map(index => `${index}. Modèle ${tag}`).join('\n')]);
  assert.match(list.say, /gemma4 12b/);
  assert.doesNotMatch(list.say, /example\//);
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
  assert.equal(long.say, 'Voici :\nLes premiers éléments : a; b; c. La liste complète est à l’écran.\nVoilà.');

  const table = run(['| a | b |\n|---|---|\n| 1 | 2 |\nFini.'], { language: 'en' });
  assert.equal(table.display[0].kind, 'table');
  assert.equal(table.say, '(on screen)\nFini.');

  const code = run(chunks('Lance ça :\n```bash\nnpm test\n```\nEnsuite on verra.', 3));
  assert.deepEqual(code.display.map(block => [block.kind, block.body]), [['code', 'npm test']]);
  assert.doesNotMatch(code.streamed, /npm|```/);
});

test('an implicit long task list keeps three useful items and deadlines audible across stream boundaries', () => {
  const reply = '- **Synthetic invoice** — due today\n- **Synthetic call** — tomorrow\n- **Synthetic form** — Friday\n- **Synthetic errand** — next week';
  for (const size of [1, 5, 23, reply.length]) {
    const result = run(chunks(reply, size), { language: 'en' });
    assert.equal(result.say, 'First items: Synthetic invoice — due today; Synthetic call — tomorrow; Synthetic form — Friday. The full list is on screen.');
    assert.equal(result.display[0].body, reply);
    assert.doesNotMatch(result.say, /Synthetic errand|\*\*/);
  }
});

test('long-list summaries remove noisy tokens before shortening and leave explicit display blocks silent', () => {
  const key = 'sk-' + 'a1'.repeat(110);
  const reply = `- First ${key}\n- Second https://example.test/long-link\n- Third /srv/agentx/config.env\n- Fourth`;
  const result = run(chunks(reply, 7), { language: 'en', allowSecrets: true });
  assert.equal(result.say, 'First items: First; Second; Third. The full list is on screen.');
  assert.doesNotMatch(result.streamed, /sk-|a1|https|\/srv/);
  assert.equal(run([`<show kind="list">${reply}</show>`], { language: 'en' }).say, 'Here is the content for your screen.');
});

test('a reply made only of screen content still says something', () => {
  const result = run(['<show kind="table">| a |</show>'], { language: 'en' });
  assert.equal(result.say, 'Here is the content for your screen.');
});

test('an interrupted display remains explicitly partial through storage and history', () => {
  const result = run(['<show kind="list" title="Steps">- First\n- Sec']);
  assert.equal(result.display[0].partial, true);
  const stored = storedDisplay(result.display);
  assert.equal(stored[0].partial, true);
  assert.match(historyText(result.say, stored), /content is partial/);
});

test('ordinary prose streams before completion and keeps the complete answer', () => {
  const said = [];
  const channels = createReplyChannels({ onSay: text => said.push(text) });
  channels.push('Bonjour mon ami, comment');
  assert.equal(said.join(''), 'Bonjour mon ami,');
  channels.push(' vas-tu?');
  channels.end();
  assert.equal(said.join(''), 'Bonjour mon ami, comment vas-tu?');
});

test('brief speech preserves the complete written explanation through stream, storage and history', () => {
  const summary = 'La réponse repose sur trois causes, avec les détails ci-dessous.';
  const complete = 'Explication complète. '.repeat(700) + '\nDernière réserve importante.';
  const source = summary + '\n<show kind="text" title="Réponse complète">' + complete + '</show>';
  for (const size of [1, 7, 103, source.length]) {
    const result = run(chunks(source, size));
    assert.equal(result.say, summary);
    assert.equal(result.display[0].body, complete);
    assert.equal(storedDisplay(result.display)[0].body, complete);
    assert.ok(historyText(result.say, storedDisplay(result.display)).includes(complete));
    const read = run(chunks(source, size), { readAloud: true });
    assert.ok(read.say.endsWith('Dernière réserve importante.'));
    assert.ok(read.say.includes(complete));
  }
});

test('written presentation preserves interleaving and never embeds secret bodies', () => {
  const source = 'Avant.\n<show kind="text">Premier document.</show>\nEntre.\n<show kind="secret">private-secret-value</show>\nAprès.';
  let expected;
  for (const size of [1, 3, 17, source.length]) {
    const result = run(chunks(source, size), { allowSecrets: true });
    const written = result.written;
    assert.equal(written.version, 1);
    assert.deepEqual(written.segments.map(row => row.kind), ['text', 'display', 'text', 'display', 'text']);
    assert.ok(written.segments[0].text.includes('Avant.'));
    assert.equal(written.segments[1].blockId, 'b1');
    assert.ok(written.segments[2].text.includes('Entre.'));
    assert.equal(written.segments[3].blockId, 'b2');
    assert.ok(written.segments[4].text.includes('Après.'));
    assert.doesNotMatch(JSON.stringify(written), /private-secret-value/);
    assert.doesNotMatch(JSON.stringify(storedDisplay(result.display)), /private-secret-value/);
    if (expected) assert.deepEqual(written, expected);
    expected = written;
  }
});

test('partial written blocks remain partial and repeated end cannot mutate earlier snapshots', () => {
  const channels = createReplyChannels();
  channels.push('Introduction. <show kind="text">Début seulement');
  const first = channels.end();
  assert.equal(first.display[0].partial, true);
  assert.equal(first.written.segments.at(-1).blockId, 'b1');
  first.written.segments[0].text = 'MUTATED';
  assert.notEqual(channels.end().written.segments[0].text, 'MUTATED');
  channels.push('This late suffix must not appear');
  assert.doesNotMatch(JSON.stringify(channels.end()), /late suffix/);
});

test('speech guidance conditions brevity on a complete written answer without adding output limits', () => {
  const instructions = contract();
  assert.match(instructions, /complete written answer is also supplied for display/);
  assert.match(instructions, /Never shorten the written answer to fit speech/);
  assert.match(instructions, /speech brevity is not a limit on the answer/);
  assert.match(instructions, /Explicit reading: full content/);
  assert.match(instructions, /Preserve all necessary crisis resources/);
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


test('long display content and every block survive presentation and history', () => {
  const body = 'Contenu complet. '.repeat(700) + 'FIN DU DOCUMENT';
  const source = 'Voici le document à l’écran.\n' + Array.from({ length: 23 }, (_, index) => `<show kind="text" title="${index}">${body}</show>`).join('');
  const result = run(chunks(source, 103));
  assert.equal(result.display.length, 23);
  assert.ok(result.display.every(block => block.body === body));
  assert.equal(storedDisplay(result.display).at(-1).body, body);
  assert.ok(historyText(result.say, result.display).includes(body));
  assert.equal(result.say.trim(), 'Voici le document à l’écran.');
});

test('explicit reading prose remains complete beyond the former reply projection limit', () => {
  const source = 'Texte à lire entièrement. '.repeat(400) + 'DERNIERS MOTS';
  const result = run(chunks(source, 77), { readAloud: true });
  assert.equal(result.say, source);
  assert.equal(plainReply(result.say), source);
});


test('an explicit reading request reads every list item instead of the ordinary spoken introduction', () => {
  const { readingRequested } = require('../../../src/services/voice/presentation');
  for (const request of ['Lis-moi la liste entière.', 'Peux-tu me lire les étapes?', 'Read this aloud.', 'Could you read the full text?']) assert.equal(readingRequested(request), true);
  for (const request of ['Pourquoi lire ce livre?', 'Readiness status?', 'Explique-moi le document.', 'Comment vont mes tâches?']) assert.equal(readingRequested(request), false);
  const source = Array.from({ length: 12 }, (_, index) => `- Élément ${index + 1}: explication complète.`).join('\n');
  const reading = run(chunks(source, 21), { readAloud: true });
  assert.equal(reading.display[0].body, source);
  for (let index = 1; index <= 12; index++) assert.ok(reading.say.includes(`Élément ${index}: explication complète.`));
  assert.ok(!reading.say.includes('Les premiers éléments'));
  assert.ok(run(chunks(source, 21)).say.includes('La liste complète est à l’écran'));
});

test('conversation and explanations stay completely spoken across stream boundaries', () => {
  const source = 'Voici les explications. '.repeat(400) + 'DERNIERS MOTS';
  for (const size of [1, 7, 77, source.length]) {
    const result = run(chunks(source, size));
    assert.equal(result.say, source);
    assert.equal(result.streamed.trim(), source);
    assert.deepEqual(result.display, []);
    assert.ok(historyText(result.say, result.display).includes(source));
  }
});

test('complete prose still strips secrets from both speech and retained history', () => {
  const secret = 'sk-' + 'a1'.repeat(40);
  const result = run(['Explications ordinaires. '.repeat(40) + secret + ' FIN'], { allowSecrets: true });
  assert.ok(result.display.some(block => block.kind === 'secret' && block.body === secret));
  assert.doesNotMatch(result.say, /sk-/);
  assert.doesNotMatch(historyText(result.say, storedDisplay(result.display)), /sk-/);
});

test('help contacts remain audible in long prose, URLs and table rows', () => {
  const result = run(['Contexte. '.repeat(30) + '\n| Contact | https://988.ca |\n| Technique | hidden-value |']);
  assert.match(result.say, /988.ca/);
  assert.doesNotMatch(result.say, /hidden-value/);
  const prose = run(['Contexte. '.repeat(30) + ' Appelle le 988.']);
  assert.ok(prose.say.endsWith('Appelle le 988.'));
});

test('an explicit table reading preserves every cell in the spoken channel', () => {
  const result = run(['| Premier | Deuxième |\n| Troisième | Quatrième |'], { readAloud: true });
  for (const cell of ['Premier', 'Deuxième', 'Troisième', 'Quatrième']) assert.ok(result.say.includes(cell));
});

test('a page block names a Core page and a bounded focus, never an address (#924)', () => {
  const reply = 'Trois tâches bloquées. <show kind="page">Pipeline status=blocked task=812 url=https://evil.example</show>';
  const result = run(chunks(reply, 6), { allowSecrets: true, allowPages: true });
  assert.deepEqual(result.display.map(({ kind, title, body }) => ({ kind, title, body })),
    [{ kind: 'page', title: 'Pipeline', body: 'pipeline status=blocked task=812' }]);
  assert.doesNotMatch(result.say, /pipeline status|evil/);
  assert.match(result.say, /Trois tâches bloquées/);
});

test('Famille without a curated catalogue and unknown pages never open a page block', () => {
  assert.deepEqual(run(['<show kind="page">pipeline</show>'], { allowPages: false }).display, []);
  assert.deepEqual(run(['<show kind="page">/admin</show>'], { allowPages: true }).display, []);
  assert.doesNotMatch(contract({ family: true, pages: true }), /kind="page"/);
  assert.match(contract({ pages: true }), /kind="page">pipeline/);
});

// Rebuild only the retained presentation, independently of what speech says.
function writtenContent(result) {
  const blocks = new Map(storedDisplay(result.display).map(block => [block.id, block]));
  return result.written.segments.map(segment => segment.kind === 'text' ? segment.text
    : blocks.get(segment.blockId)?.body || '').join('').replace(/\s+/g, ' ').trim();
}

test('inline references retain preceding and following prose in source order', () => {
  const source = 'Avant https://example.test/docs, puis /srv/example/file.txt et example/gemma4:12b-it-qat. Apres.';
  for (const size of [1, 2, 5, 17, source.length]) {
    const result = run(chunks(source, size));
    assert.equal(writtenContent(result), source, `chunk size ${size}`);
    assert.deepEqual(result.written.segments.filter(segment => segment.kind === 'display').map(segment => segment.blockId), ['b1', 'b2', 'b3']);
    assert.doesNotMatch(result.say, /https|\/srv|example\/gemma/);
  }
});

test('Markdown references retain source order without writing their spoken cue', () => {
  const source = 'Avant [Premiere](https://example.test/one), puis [Deuxieme](https://example.test/two). Apres.';
  for (const size of [1, 7, source.length]) {
    const result = run(chunks(source, size));
    assert.equal(writtenContent(result), 'Avant https://example.test/one, puis https://example.test/two. Apres.');
    assert.deepEqual(result.display.map(block => block.title), ['Premiere', 'Deuxieme']);
    assert.equal(result.written.segments.filter(segment => segment.kind === 'display').length, 2);
  }
});

test('reading displayed content changes speech without duplicating the written source', () => {
  for (const [kind, body] of [['text', 'Texte integral.'], ['text', 'Texte integral. https://example.test/reference'], ['list', '- Premier\n- Deuxieme'],
    ['table', '| Premier | Deuxieme |'], ['code', 'const answer = 42;']]) {
    const source = `Introduction. <show kind="${kind}" title="Details">${body}</show> Conclusion.`;
    for (const size of [1, 7, source.length]) {
      const ordinary = run(chunks(source, size));
      const reading = run(chunks(source, size), { readAloud: true });
      assert.equal(writtenContent(reading), `Introduction. ${body.replace(/\s+/g, ' ')} Conclusion.`, `${kind}, chunk size ${size}`);
      assert.equal(writtenContent(reading), writtenContent(ordinary));
      assert.equal(reading.written.segments.filter(segment => segment.kind === 'display').length, 1);
      assert.equal(reading.display.length, 1, 'reading a link inside the source does not create a duplicate card');
      assert.ok(reading.say.includes(kind === 'code' ? 'answer' : kind === 'text' ? 'Texte integral.' : 'Deuxieme'));
    }
  }
});

test('implicit list, table and code projections retain their source only once', () => {
  for (const body of ['- Premier\n- Deuxieme\n- Troisieme\n- Quatrieme',
    '| Premier | Deuxieme |\n| Troisieme | Quatrieme |', '```js\nconst answer = 42;\n```']) {
    const source = `Introduction.\n${body}\nConclusion.`;
    for (const size of [1, 13, source.length]) {
      const ordinary = run(chunks(source, size));
      const reading = run(chunks(source, size), { readAloud: true });
      assert.equal(writtenContent(reading), writtenContent(ordinary), `chunk size ${size}`);
      const expected = `Introduction. ${body.replace(/```(?:js)?\n?/g, '').replace(/\s+/g, ' ').trim()} Conclusion.`;
      assert.equal(writtenContent(reading), expected);
      assert.equal(reading.written.segments.filter(segment => segment.kind === 'display').length, 1);
    }
  }
});

test('speech projections never reintroduce a retained secret or a consultation', () => {
  const secret = 'sk-' + 'a1'.repeat(40);
  for (const readAloud of [false, true]) {
    for (const allowSecrets of [false, true]) {
      const source = `Avant ${secret}. <show kind="consult" title="helper">Private request</show> Apres.`;
      const result = run(chunks(source, 3), { readAloud, allowSecrets });
      assert.doesNotMatch(writtenContent(result), /sk-|Private request/);
      assert.doesNotMatch(result.say, /sk-|Private request/);
      assert.ok(writtenContent(result).startsWith('Avant'));
      assert.ok(writtenContent(result).endsWith('Apres.'));
    }
  }
});
