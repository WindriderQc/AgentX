'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse, handler } = require('../public/screen-commands');
const { Conversation } = require('../public/browser-conversation');
const tick = () => new Promise(resolve => setImmediate(resolve));

const COMMANDS = {
  expand: ['Agrandis', 'agrandis !', 'Agrandis l’écran.', 'agrandi', 'Nestor, agrandis la page', 'plus grand', 'Mets-le en grand', 'plein écran',
    'Expand', 'expand it', 'Make it bigger, please', 'bigger', 'full screen'],
  shrink: ['Réduis', 'réduit', 'Réduis l’écran', 'plus petit', 'taille normale', 'Smaller', 'make it smaller', 'shrink', 'normal size'],
  close: ['Ferme', 'Ferme !', 'ferme l’écran', 'Ferme le contenu, Nestor', 'ferme ça', 'Cache l’écran', 'cache le contenu', 'Close', 'close it', 'hide the screen'],
  show: ['Réaffiche', 'ré-affiche le contenu', 'réafficher', 'rouvre', 'Affiche l’écran', 'montre le contenu de nouveau', 'affiche-le encore',
    'Show it again', 'show again', 'reopen', 'show the content'],
  previous: ['Précédent', 'précédente', 'le précédent', 'contenu précédent', 'page précédente', 'Reviens', 'reviens en arrière', 'retour', 'en arrière',
    'Previous', 'previous page', 'go back', 'back'],
  next: ['Suivant', 'suivante', 'le suivant', 'contenu suivant', 'page suivante', 'Next', 'next one', 'next page', 'Suivant, s’il te plaît']
};

// Real requests: they must reach Nestor even when content is on screen.
const REQUESTS = ['', 'Nestor', 'ferme la tâche 0918', 'agrandis la photo et explique-la', 'ferme la porte', 'Ferme-la', 'cache',
  'ferme la tâche', 'close the task', 'show me the pipeline', 'affiche le pipeline', 'affiche', 'montre-moi', 'ouvre Analytics',
  'reviens demain', 'précédent rendez-vous', 'suivant la météo', 'next week', 'what is next', 'go back to the task', 'back up the disk',
  'plus grand que', 'agrandis la photo', 'réduis le volume', 'stop', 'arrête', 'tais-toi', 'expand on that idea',
  'pourquoi tu as fermé', 'ferme le contenu et explique', 'suivant suivant suivant suivant'];

test('each screen command is recognized as one complete short phrase', () => {
  for (const [action, phrases] of Object.entries(COMMANDS)) {
    for (const phrase of phrases) assert.equal(parse(phrase)?.action, action, phrase);
  }
});

test('a phrase with anything more is left to Nestor', () => {
  for (const phrase of REQUESTS) assert.equal(parse(phrase), null, phrase);
});

test('the name or a wake phrase marks the command as addressed', () => {
  assert.deepEqual(parse('agrandis'), { action: 'expand', addressed: false });
  assert.deepEqual(parse('Nestor, agrandis'), { action: 'expand', addressed: true });
  assert.deepEqual(parse('Eille Nestor, ferme l’écran'), { action: 'close', addressed: true });
  assert.deepEqual(parse('suivant Nestor'), { action: 'next', addressed: true });
});

test('the handler only takes a command the workspace can receive', () => {
  const calls = [];
  const screen = { command: action => { calls.push(action); return action === 'next' ? null : { action, applied: true, message: 'ok' }; } };
  const run = handler(screen);
  assert.deepEqual(run('Agrandis'), { action: 'expand', applied: true, message: 'ok', addressed: false });
  assert.equal(run('suivant'), null, 'a workspace with nothing to show leaves the phrase to Nestor');
  assert.equal(run('ferme la tâche 0918'), null);
  assert.equal(run('agrandis', { followup: false }), null, 'on standby, a bare command is not addressed');
  assert.equal(run('Nestor, agrandis', { followup: false })?.action, 'expand');
  assert.deepEqual(calls, ['expand', 'next', 'expand']);
  assert.equal(handler(null)('agrandis'), null, 'Famille has no workspace');
  assert.equal(handler({})('agrandis'), null, 'a screen without commands takes nothing');
});

test('the page loads screen commands before the conversation, and only Nestor mounts them', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.indexOf('screen-commands.js') > 0 && html.indexOf('screen-commands.js') < html.indexOf('conversation-page.js'));
  const page = fs.readFileSync(path.join(__dirname, '../public/conversation-page.js'), 'utf8');
  assert.match(page, /const screenCommand = family \? null : window\.NestorScreenCommands\?\.handler\(board\)/);
  assert.match(page, /localControl: \(text, options\) => screenCommand\?\.\(text, options\) \|\| null/);
  assert.match(page, /if \(!draftFiles\.length && screenCommand\?\.\(typed\.value\)\)/, 'a typed command passes the same filter; files mean a request');
});

function harness(overrides = {}) {
  const calls = [], messages = [], ended = [], applied = [];
  let utterance, speech, listening = {};
  const audio = {
    listen(callback, onSpeech, options = {}) { calls.push('listen'); utterance = callback; speech = onSpeech; listening = options; },
    holdPlayback() { calls.push('holdPlayback'); }, resumePlayback() { calls.push('resumePlayback'); },
    quiet() { calls.push('quiet'); }, close() { calls.push('close'); },
    async play() { calls.push('play'); }
  };
  const screen = { command: action => { applied.push(action); return { action, applied: true, message: 'ok' }; } };
  const run = handler(screen);
  const io = {
    wakeAckDelayMs: 0, holdingDelayMs: null,
    async openAudio() { return audio; },
    async createSession() { return { sessionId: 'private-1' }; },
    async transcribe() { return 'Bonjour'; },
    async turn() { calls.push('turn'); return { text: 'Salut', language: 'fr' }; },
    async synthesize() { return new ArrayBuffer(10); },
    transcriptionEnded: (_id, receipt) => ended.push(receipt.outcome),
    localControl: (text, options) => { calls.push(['localControl', text, options.followup]); return run(text, options); },
    message(role, text) { messages.push({ role, text }); }, ...overrides
  };
  const conversation = new Conversation(io, () => {});
  return { conversation, audio, calls, messages, ended, applied, beginSpeech: () => speech(), say: capture => utterance(new Blob(['sample']), capture),
    probe: () => listening.onProbe?.(new Blob(['so far'])) };
}

for (const phrase of ['Agrandis', 'Ferme l’écran.', 'suivant']) {
  test(`a spoken screen command acts locally without a model turn: ${phrase}`, async () => {
    const h = harness({ transcribe: async () => phrase });
    await h.conversation.start({ language: 'fr' });
    await h.say();
    assert.deepEqual(h.applied, [parse(phrase).action]);
    assert.equal(h.calls.includes('turn'), false, 'the model is not called');
    assert.deepEqual(h.messages, [], 'no turn is written to the transcript');
    assert.deepEqual(h.ended, ['local']);
    assert.equal(h.conversation.state, 'listening', 'recognition goes on, as after Stop');
    assert.equal(h.conversation.activeTurn, null);
    h.conversation.stop();
  });
}

test('a real request that starts like a command still reaches Nestor', async () => {
  const h = harness({ transcribe: async () => 'Ferme la tâche 0918' });
  await h.conversation.start({ language: 'fr' });
  await h.say();
  assert.deepEqual(h.applied, []);
  assert.ok(h.calls.includes('turn'));
  h.conversation.stop();
});

test('a command spoken over a reply leaves the reply playing', async () => {
  let transcriptions = 0, turns = 0, stopped = 0, interrupts = 0;
  const h = harness({ transcribe: async () => ++transcriptions === 1 ? 'Montre-moi le pipeline' : 'Agrandis',
    turn: async () => { turns++; return { text: 'Voici le pipeline et ses tâches.' }; },
    interrupt: async () => { interrupts++; return {}; } });
  h.audio.canInterrupt = true;
  let finish;
  h.audio.play = (_bytes, signal) => new Promise(resolve => { finish = resolve; signal.addEventListener('abort', () => { stopped++; resolve(); }, { once: true }); });
  await h.conversation.start({}); const first = h.say(); await tick();
  h.beginSpeech(); await h.probe();
  assert.ok(h.calls.includes('holdPlayback'), 'words hold the reply until they are recognized');
  await h.say();
  assert.deepEqual(h.applied, ['expand']);
  assert.ok(h.calls.includes('resumePlayback'), 'the held reply resumes');
  assert.equal(stopped, 0, 'the reply is not cancelled');
  assert.equal(interrupts, 0, 'Core is not told about an interruption');
  finish(); await first;
  assert.equal(turns, 1, 'no second model turn');
  assert.equal(h.conversation.state, 'listening');
  h.conversation.stop();
});

test('on wake-word standby, only a command that names Nestor acts', async () => {
  let heard = 'agrandis';
  const h = harness({ transcribe: async () => heard });
  await h.conversation.start({ wakeWord: true, language: 'fr' });
  await h.say();
  assert.deepEqual(h.applied, [], 'a bare word in the room is not addressed');
  assert.equal(h.calls.includes('turn'), false);
  assert.deepEqual(h.ended, ['not_addressed']);
  heard = 'Eille Nestor, agrandis';
  await h.say();
  assert.deepEqual(h.applied, ['expand']);
  assert.equal(h.conversation.wake.active(), true, 'naming Nestor opens the conversation, as the wake phrase does');
  assert.equal(h.calls.includes('turn'), false);
  heard = 'réduis';
  await h.say();
  assert.deepEqual(h.applied, ['expand', 'shrink'], 'once open, a bare command acts');
  h.conversation.stop();
});

test('a surface without local controls keeps the previous behaviour', async () => {
  const h = harness({ transcribe: async () => 'Agrandis', localControl: undefined });
  await h.conversation.start({ language: 'fr' });
  await h.say();
  assert.ok(h.calls.includes('turn'));
  h.conversation.stop();
});
