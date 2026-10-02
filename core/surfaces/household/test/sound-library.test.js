'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const soundLibrary = require('../sound-library');
const { voiceContract } = require('../voice-contract');

const SOUNDS_DIR = path.join(__dirname, '..', 'public', 'sounds');

function selected(text) {
  const entry = soundLibrary.selectSound(text);
  return entry ? entry.id : null;
}

test('a French sound request selects the animal it names', () => {
  assert.equal(selected('quel bruit fait la vache?'), 'cow');
  assert.equal(selected("c'est quoi le son du chat"), 'cat');
  assert.equal(selected('le cri du loup, ça ressemble à quoi?'), 'wolf');
  assert.equal(selected("j'veux entendre un éléphant"), 'elephant');
  assert.equal(selected("le chant de l'oiseau"), 'bird');
  assert.equal(selected('comment fait le mouton'), 'sheep');
  assert.equal(selected('écoute le coq'), 'rooster');
});

test('an English sound request selects the animal it names', () => {
  assert.equal(selected('what does a cow sound like'), 'cow');
  assert.equal(selected('can i hear the elephant'), 'elephant');
  assert.equal(selected('what noise does a frog make'), 'frog');
  assert.equal(selected('play me the sound of an owl'), 'owl');
  assert.equal(selected('how does a horse sound'), 'horse');
});

test('the expanded pack selects the requested animal in both languages', () => {
  const library = soundLibrary.createSoundLibrary();
  const cases = [
    ['fais le son du tigre', 'tiger'], ['fais rugir le tigre', 'tiger'],
    ['le rugissement du T-Rex', 'trex'], ['fais rugir le tyrannosaure', 'trex'],
    ['can I hear a T. rex', 'trex'], ['T Rex', 'trex'], ['TRex', 'trex'],
    ['le tyrannosaurus rex', 'trex'], ["l'âne", 'donkey'],
    ["quel bruit fait le cochon d'Inde", 'guinea-pig'],
    ['what sound does a guinea pig make', 'guinea-pig'],
    ["le cochon d'Inde", 'guinea-pig'], ['cochon d inde', 'guinea-pig'],
    ['la grue du Canada', 'crane'], ['le colin de Virginie', 'quail'],
    ['le bruit du coucou', 'cuckoo'], ['coucou gris', 'cuckoo'],
    ['imite la souris', 'mouse'], ['le son du yak', 'yak'],
    ['le cri du raton laveur', 'raccoon'], ['le son du dauphin', 'dolphin'],
    ['le chant de la baleine à bosse', 'whale'], ['humpback', 'whale'],
    ['le son du chimpanzé', 'monkey'], ['chimpanzee', 'monkey'],
    ['fais le son du singe', 'monkey'], ['le chant de la cigale', 'cicada'],
    ['can I hear the camel', 'camel'], ['quel bruit fait le gorille', 'gorilla']
  ];
  for (const [text, id] of cases) {
    assert.equal(selected(text), id, text);
    assert.equal(library.select(text)?.id ?? null, library.missing.includes(id) ? null : id, text);
  }
  assert.equal(library.select('coucou'), null, 'a French greeting is not a bird request');
  assert.equal(library.select('coucou Nestor'), null);
  assert.equal(library.select('combien de pattes a le T-Rex'), null);
  assert.equal(library.select('rugit'), null, 'roaring alone does not identify a lion');
});

test('Google carousel additions resolve in French and English without confusing nearby animals', () => {
  const cases = [
    ['alligator', 'alligator'], ['un alpaga', 'alpaca'], ['an antelope', 'antelope'],
    ['le buffle', 'buffalo'], ['une colombe', 'dove'], ['a swan', 'swan'],
    ['le dragon de Komodo', 'komodo-dragon'], ['le faucon', 'falcon'],
    ['le furet', 'ferret'], ['what sound does a hippopotamus make', 'hippopotamus'],
    ['le cri de la hyène', 'hyena'], ['un hérisson', 'hedgehog'], ['a rabbit', 'rabbit'],
    ['une loutre', 'otter'], ['le léopard', 'leopard'], ['le son de l’orignal', 'moose'],
    ['un panda', 'panda'], ['le rat', 'rat'], ['un rhinocéros', 'rhinoceros'],
    ['le serpent à sonnette', 'rattlesnake'], ['le serpent', 'rattlesnake'],
    ['le son du raton laveur', 'raccoon'], ['le son du rat', 'rat'],
    ['le son du dragon de Komodo', 'komodo-dragon']
  ];
  for (const [text, id] of cases) assert.equal(selected(text), id, text);
  for (const text of ['un crocodile', 'un lama', 'un dragon', 'le requin',
    'pourquoi le rat mange du fromage', 'mon lapin se cache']) {
    assert.equal(selected(text), null, text);
  }
});

test('recordings, imitations and imagined effects retain their meaning in the payload', () => {
  const library = soundLibrary.createSoundLibrary();
  assert.equal(library.get('tiger').kind, 'recording');
  assert.equal(library.get('trex').kind, 'effect');
  assert.match(library.get('trex').label.fr, /bruitage/);
  for (const id of ['mouse', 'yak']) {
    assert.equal(library.get(id).kind, 'imitation');
    assert.match(library.get(id).label.fr, /imitation/);
  }
});

test('an imitation is itself the request, without a separate sound word', () => {
  assert.equal(selected('ouaf ouaf!'), 'dog');
  assert.equal(selected('fais miaou'), 'cat');
  assert.equal(selected('cocorico'), 'rooster');
  assert.equal(selected('meuh meuh meuh'), 'cow');
  assert.equal(selected('coin coin'), 'duck');
  assert.equal(selected('fais-moi miaou'), 'cat');
  assert.equal(selected('make a meow'), 'cat');
});

test('a bare animal name is how the youngest kids and the Reader ask', () => {
  assert.equal(selected('vache'), 'cow');
  assert.equal(selected('le chat'), 'cat');
  assert.equal(selected('Les grenouilles'), 'frog');
  assert.equal(selected('a lion'), 'lion');
});

test('merely mentioning an animal selects nothing', () => {
  assert.equal(selected('la vache fait du lait, pourquoi?'), null);
  assert.equal(selected('mon chien aboie la nuit, pourquoi?'), null);
  assert.equal(selected("j'ai lu un livre sur les chats"), null);
  assert.equal(selected('où est son chien?'), null);
  assert.equal(selected('combien de pattes a une vache et un cheval ensemble'), null);
  assert.equal(selected('is a whale a fish or a mammal'), null);
  assert.equal(selected("j'entends un hibou dehors"), null);
  assert.equal(selected('I hear a cow outside'), null);
  assert.equal(selected('noise pollution hurts whales'), null);
  assert.equal(selected('mon chien'), null);
  assert.equal(selected('the word woof has four letters'), null);
});

test('an explicit named request wins over a stray imitation', () => {
  assert.equal(selected('quel bruit fait le chat? ouaf'), 'cat');
  assert.equal(selected('what sound does a cow make, meow?'), 'cow');
});

test('ordinary questions and homework select nothing', () => {
  assert.equal(selected('pourquoi le ciel est bleu'), null);
  assert.equal(selected('aide-moi avec mes devoirs de maths'), null);
  assert.equal(selected('toujours'), null);
  assert.equal(selected(''), null);
  assert.equal(selected(null), null);
  assert.equal(selected('   '), null);
});

test('word boundaries keep near-misses out', () => {
  assert.equal(selected("j'écris une histoire"), null);
  assert.equal(selected('la categorie des animaux'), null);
  assert.equal(selected('mon ourson en peluche'), null);
});

test('catalog ids and files are unique, and every row carries both labels', () => {
  const ids = soundLibrary.CATALOG.map((entry) => entry.id);
  const files = soundLibrary.CATALOG.map((entry) => entry.file);
  assert.equal(new Set(ids).size, ids.length, 'duplicate catalog id');
  assert.equal(new Set(files).size, files.length, 'duplicate catalog file');
  for (const entry of soundLibrary.CATALOG) {
    assert.match(entry.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(entry.label.fr && entry.label.en, `${entry.id} is missing a label`);
    assert.ok(entry.names.length, `${entry.id} has no names`);
    assert.ok(entry.emoji, `${entry.id} has no emoji`);
  }
});

test('an alias never resolves to two different animals', () => {
  const owner = new Map();
  for (const entry of soundLibrary.CATALOG) {
    for (const term of [...entry.names, ...entry.cries]) {
      const key = soundLibrary.normalize(term);
      assert.ok(!owner.has(key) || owner.get(key) === entry.id, `"${term}" is claimed by ${owner.get(key)} and ${entry.id}`);
      owner.set(key, entry.id);
    }
  }
});

test('requests for a different species never borrow a similar animal recording', () => {
  for (const animal of ['chevreuil', 'macaque', 'corbeau', 'raven',
    'hibou', 'bourdon', 'petit rorqual', 'tamia', 'pivert', 'perruche', 'crapaud', 'merle']) {
    assert.equal(selected(`le son du ${animal}`), null, animal);
  }
  assert.equal(selected('le son du cerf'), 'deer');
  assert.equal(selected('le cri de la corneille'), 'crow');
  assert.equal(selected('le bruit du pic bois'), 'woodpecker');
  assert.equal(soundLibrary.createSoundLibrary().get('deer').label.fr, 'un cerf');
});

test('the shipped pack resolves: every advertised sound is a real file', () => {
  const library = soundLibrary.createSoundLibrary({ soundsDir: SOUNDS_DIR });
  assert.equal(soundLibrary.CATALOG.length, 78);
  assert.equal(library.sounds.length, 57);
  assert.equal(library.missing.length, 21);
  for (const id of ['whale', 'rabbit', 'alligator']) {
    assert.equal(library.get(id), null, `${id} belongs to an external private pack`);
  }
  // Pinned to what express actually serves from mime-db, because the
  // production asset gate compares the served content-type against these
  // exact strings. These are what express.static (send -> mime@1) writes on the
  // wire for legacy containers, confirmed by serving a file
  // from the running Core container and reading the header -- not by asking the
  // mime-types package, which disagrees about .wav.
  assert.equal(soundLibrary.mimeTypeFor('unrelated.flac'), 'audio/x-flac');
  assert.equal(soundLibrary.mimeTypeFor('unrelated.wav'), 'audio/wav');
  assert.equal(library.get('bat').mimeType, 'audio/ogg');
  assert.equal(library.get('wolf').mimeType, 'audio/ogg');
  for (const sound of library.sounds) {
    const entry = soundLibrary.CATALOG.find((row) => row.id === sound.id);
    const file = path.join(SOUNDS_DIR, entry.file);
    assert.ok(fs.statSync(file).size > 0, `${entry.file} is empty`);
    assert.equal(sound.url, `/assets/household/sounds/${entry.file}`);
    assert.match(sound.mimeType, /^audio\//);
    assert.ok(sound.label.fr && sound.label.en);
    assert.ok(sound.gain >= 1 && sound.gain <= 6, `${sound.id} has an implausible playback gain`);
  }
});

test('decoded level receipts match every shipped file and leave playback headroom', () => {
  // Measurements are taken from actual decoding, not inferred from encoded
  // bytes. The hash prevents a file replacement from silently reusing an old
  // level measurement; browser decoding is checked separately at release.
  const review = require('../sound-review.json');
  const library = soundLibrary.createSoundLibrary();
  assert.equal(review.sounds.length, library.sounds.length);
  for (const sound of library.sounds) {
    const row = review.sounds.find((item) => item.id === sound.id);
    assert.ok(row, `${sound.id} has no content/level review`);
    assert.equal(sound.url, `/assets/household/sounds/${row.file}`);
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(SOUNDS_DIR, row.file))).digest('hex'), row.sha256, `${sound.id} level receipt is stale`);
    assert.ok(row.decodedPeak > 0 && row.decodedPeak * sound.gain < 0.8, `${sound.id} would exceed playback headroom`);
    assert.ok(row.seconds > 0 && row.seconds <= 8, `${sound.id} excerpt is too long`);
    assert.equal(row.sampleRate, 44100, `${sound.id} must be browser-audible without ultrasonic conversion`);
    assert.ok(row.review, `${sound.id} has no content disposition`);
  }
});

test('every shipped clip is credited', () => {
  const credits = fs.readFileSync(path.join(SOUNDS_DIR, 'CREDITS.md'), 'utf8');
  const library = soundLibrary.createSoundLibrary({ soundsDir: SOUNDS_DIR });
  for (const sound of library.sounds) {
    const entry = soundLibrary.CATALOG.find((row) => row.id === sound.id);
    assert.ok(credits.includes(`\`${entry.file}\``), `${entry.file} has no credit line`);
  }
  // Anything sitting in the folder is served by the static mount, so nothing
  // may live there uncredited either.
  for (const file of fs.readdirSync(SOUNDS_DIR)) {
    if (file === 'CREDITS.md') continue;
    assert.ok(credits.includes(`\`${file}\``), `${file} is in the pack but not in CREDITS.md`);
  }
});

test('a missing clip is never advertised and never selected', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'household-sounds-'));
  try {
    const library = soundLibrary.createSoundLibrary({ soundsDir: empty });
    assert.deepEqual(library.sounds, []);
    assert.equal(library.status.status, 'unavailable');
    assert.equal(library.select('quel bruit fait la vache?'), null);
    assert.equal(library.get('cow'), null);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('a partial pack only offers what it has', () => {
  const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'household-sounds-'));
  try {
    const file = soundLibrary.CATALOG.find((entry) => entry.id === 'cow').file;
    fs.copyFileSync(path.join(SOUNDS_DIR, file), path.join(partial, file));
    const library = soundLibrary.createSoundLibrary({ soundsDir: partial });
    assert.deepEqual(library.sounds.map((sound) => sound.id), ['cow']);
    assert.equal(library.select('quel bruit fait la vache?').id, 'cow');
    assert.equal(library.select('quel bruit fait le chat?'), null);
    assert.ok(library.status.missing.includes('cat'));
  } finally {
    fs.rmSync(partial, { recursive: true, force: true });
  }
});

test('the voice contract publishes the sound capability honestly', () => {
  const contract = voiceContract({
    soundStatus: { status: 'ready', available: 38, catalog: 39, missing: ['donkey'] }
  });
  assert.equal(contract.capabilities.sounds.status, 'available');
  assert.equal(contract.capabilities.sounds.available, 38);
  assert.equal(contract.capabilities.sounds.catalog, 39);
  assert.deepEqual(contract.capabilities.sounds.missing, ['donkey']);
  assert.equal(contract.capabilities.sounds.modelSelectsClip, false);
  assert.equal(contract.capabilities.sounds.nativeVoixPlayback, false);
  assert.equal(contract.capabilities.sounds.playsOnSafetyEscalation, false);
  assert.equal(contract.capabilities.sounds.catalogRoute, '/api/voice-personas/sounds');
  assert.equal(contract.capabilities.sounds.auditMeaning, 'clip-selected-for-browser-offer-not-playback-receipt');

  const unavailable = voiceContract();
  assert.equal(unavailable.capabilities.sounds.status, 'unavailable');
  assert.equal(unavailable.capabilities.sounds.available, 0);
});


test('an external pack can retain an optional private animal without bundling it', () => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'household-private-sounds-'));
  try {
    const whale = soundLibrary.CATALOG.find((entry) => entry.id === 'whale');
    fs.writeFileSync(path.join(external, whale.file), 'synthetic audio fixture');
    const library = soundLibrary.createSoundLibrary({ soundsDir: external });
    assert.equal(library.select('le chant de la baleine à bosse')?.id, 'whale');
    assert.equal(library.get('whale').url, `/assets/household/sounds/${whale.file}`);
    assert.equal(soundLibrary.createSoundLibrary().select('le chant de la baleine à bosse'), null);
  } finally {
    fs.rmSync(external, { recursive: true, force: true });
  }
});
