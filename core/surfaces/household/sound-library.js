'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A child asking "c'est quoi le bruit d'une vache?" gets the spoken answer AND
// the real recording. This catalog is the whole allowlist: the model never
// names, chooses, or invents a file, so a turn can only ever play a clip listed
// here whose audio is actually on disk. Adding a sound means adding one row,
// its clip under public/sounds/, and its licence line in public/sounds/CREDITS.md.
//
// Matching is deterministic for the same reason the safety escalation is: a
// bounded rule a parent can read beats a model deciding when to make noise.

const DEFAULT_SOUND_DIR = path.join(__dirname, 'public', 'sounds');
const PUBLIC_SOUND_PATH = '/assets/household/sounds';

const MIME_BY_EXTENSION = Object.freeze({
  // These must equal what express.static actually puts on the wire, because the
  // production asset gate compares the served content-type against them.
  // express.static resolves through send -> mime@1, NOT the mime-types package:
  // the two disagree on .wav (audio/wav vs audio/wave), so asking mime-types is
  // the wrong source and cost one failed production deploy. The only answer that
  // counts comes from serving a file and reading the header:
  //
  //   docker exec agentx-core node -e 'const e=require("express"),f=require("fs");
  //     f.mkdirSync("/tmp/m",{recursive:true}); f.writeFileSync("/tmp/m/a.wav","x");
  //     const a=e(); a.use("/s", e.static("/tmp/m"));
  //     const s=a.listen(0, async()=>{ const r=await fetch("http://127.0.0.1:"+
  //       s.address().port+"/s/a.wav"); console.log(r.headers.get("content-type"));
  //       s.close(); });'
  //   audio/wav
  '.flac': 'audio/x-flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav'
});

// `names` identify the animal but need a separate sound request to fire, so
// "mon chien aboie la nuit, pourquoi?" stays a plain question. `cries` are pure
// imitations -- a child writing "ouaf ouaf" is already asking for the sound.
const CATALOG = Object.freeze([
  { id: 'cow', emoji: '🐄', file: 'cow-reviewed.ogg', label: { fr: 'une vache', en: 'a cow' }, names: ['vache', 'vaches', 'veau', 'veaux', 'boeuf', 'bœuf', 'taureau', 'cow', 'cows', 'cattle', 'calf', 'bull'], cries: ['meuh', 'moo', 'mooo'] },
  { id: 'cat', emoji: '🐱', file: 'cat-reviewed.ogg', label: { fr: 'un chat', en: 'a cat' }, names: ['chat', 'chats', 'chatte', 'chaton', 'minou', 'miauler', 'miaule', 'cat', 'cats', 'kitten', 'kitty'], cries: ['miaou', 'meow', 'miaow'] },
  { id: 'dog', emoji: '🐶', file: 'dog-reviewed.ogg', label: { fr: 'un chien', en: 'a dog' }, names: ['chien', 'chiens', 'chienne', 'chiot', 'toutou', 'aboyer', 'aboie', 'dog', 'dogs', 'puppy', 'bark', 'barks'], cries: ['ouaf', 'wouf', 'wouaf', 'woof', 'arf'] },
  { id: 'horse', emoji: '🐴', file: 'horse-reviewed.ogg', label: { fr: 'un cheval', en: 'a horse' }, names: ['cheval', 'chevaux', 'jument', 'poulain', 'poney', 'hennir', 'hennit', 'horse', 'horses', 'pony', 'mare', 'foal'], cries: ['neigh'] },
  { id: 'sheep', emoji: '🐑', file: 'sheep-reviewed.ogg', label: { fr: 'un mouton', en: 'a sheep' }, names: ['mouton', 'moutons', 'brebis', 'agneau', 'agneaux', 'sheep', 'lamb', 'ewe', 'bleat'], cries: ['baa', 'baaa', 'mee'] },
  { id: 'pig', emoji: '🐷', file: 'pig-reviewed.ogg', label: { fr: 'un cochon', en: 'a pig' }, names: ['cochon', 'cochons', 'porc', 'truie', 'porcelet', 'pig', 'pigs', 'hog', 'piglet'], cries: ['groin', 'oink'] },
  { id: 'rooster', emoji: '🐓', file: 'rooster-reviewed.ogg', label: { fr: 'un coq', en: 'a rooster' }, names: ['coq', 'coqs', 'rooster', 'roosters', 'cockerel'], cries: ['cocorico', 'cock-a-doodle-doo', 'cockadoodledoo'] },
  { id: 'hen', emoji: '🐔', file: 'hen-reviewed.ogg', label: { fr: 'une poule', en: 'a hen' }, names: ['poule', 'poules', 'poulette', 'poulet', 'poussin', 'hen', 'hens', 'chicken', 'chickens', 'chick'], cries: ['cot cot', 'cluck'] },
  { id: 'duck', emoji: '🦆', file: 'duck-reviewed.ogg', label: { fr: 'un canard', en: 'a duck' }, names: ['canard', 'canards', 'cane', 'caneton', 'duck', 'ducks', 'duckling'], cries: ['coin coin', 'quack'] },
  { id: 'goat', emoji: '🐐', file: 'goat-reviewed.ogg', label: { fr: 'une chèvre', en: 'a goat' }, names: ['chevre', 'chèvre', 'chevres', 'chèvres', 'chevreau', 'bouc', 'biquette', 'goat', 'goats'], cries: [] },
  { id: 'donkey', emoji: '🫏', file: 'donkey-reviewed.ogg', label: { fr: 'un âne', en: 'a donkey' }, names: ['ane', 'âne', 'anes', 'ânes', 'anesse', 'donkey', 'donkeys'], cries: ['hi-han', 'hihan', 'hee-haw'] },
  { id: 'lion', emoji: '🦁', file: 'lion-reviewed.ogg', label: { fr: 'un lion', en: 'a lion' }, names: ['lion', 'lions', 'lionne', 'lionceau'], cries: [] },
  { id: 'elephant', emoji: '🐘', file: 'elephant-reviewed.ogg', label: { fr: 'un éléphant', en: 'an elephant' }, names: ['elephant', 'éléphant', 'elephants', 'éléphants', 'elephanteau', 'barrit'], cries: [] },
  { id: 'wolf', emoji: '🐺', file: 'wolf-reviewed.ogg', label: { fr: 'un loup', en: 'a wolf' }, names: ['loup', 'loups', 'louve', 'louveteau', 'wolf', 'wolves'], cries: [] },
  { id: 'owl', emoji: '🦉', file: 'owl-reviewed.ogg', label: { fr: 'une chouette', en: 'an owl' }, names: ['chouette', 'chouettes', 'owl', 'owls'], cries: ['hou hou', 'hoot'] },
  { id: 'frog', emoji: '🐸', file: 'frog-reviewed.ogg', label: { fr: 'une grenouille', en: 'a frog' }, names: ['grenouille', 'grenouilles', 'frog', 'frogs'], cries: ['croa', 'coa coa', 'ribbit'] },
  { id: 'bird', emoji: '🐦', file: 'bird-reviewed.ogg', label: { fr: 'un oiseau', en: 'a bird' }, names: ['oiseau', 'oiseaux', 'moineau', 'bird', 'birds', 'songbird'], cries: ['cui cui', 'cuicui', 'tweet', 'chirp'] },
  { id: 'crow', emoji: '🐦‍⬛', file: 'crow-reviewed.ogg', label: { fr: 'une corneille', en: 'a crow' }, names: ['corneille', 'corneilles', 'crow', 'crows'], cries: ['croa croa', 'caw'] },
  { id: 'bee', emoji: '🐝', file: 'bee-reviewed.ogg', label: { fr: 'une abeille', en: 'a bee' }, names: ['abeille', 'abeilles', 'bee', 'bees'], cries: ['bzz', 'bzzz', 'buzz'] },
  { id: 'cricket', emoji: '🦗', file: 'cricket-reviewed.ogg', label: { fr: 'un grillon', en: 'a cricket' }, names: ['grillon', 'grillons', 'cricket', 'crickets'], cries: [] },
  { id: 'whale', emoji: '🐋', file: 'whale-humpback.ogg', label: { fr: 'une baleine à bosse', en: 'a humpback whale' }, names: ['baleine', 'baleines', 'baleine à bosse', 'baleines à bosse', 'rorqual à bosse', 'whale', 'whales', 'humpback', 'humpback whale', 'humpback whales'], cries: [] },
  { id: 'bear', emoji: '🐻', file: 'bear-reviewed.ogg', label: { fr: 'un ours', en: 'a bear' }, names: ['ours', 'ourse', 'ourson', 'oursons', 'grizzly', 'bear', 'bears'], cries: [] },
  { id: 'fox', emoji: '🦊', file: 'fox-reviewed.ogg', label: { fr: 'un renard', en: 'a fox' }, names: ['renard', 'renards', 'renarde', 'fox', 'foxes'], cries: [] },
  { id: 'deer', emoji: '🦌', file: 'deer-reviewed.ogg', label: { fr: 'un cerf', en: 'a deer' }, names: ['cerf', 'cerfs', 'biche', 'faon', 'deer'], cries: [] },
  { id: 'squirrel', emoji: '🐿️', file: 'squirrel-red.ogg', label: { fr: 'un écureuil roux', en: 'an American red squirrel' }, names: ['ecureuil', 'écureuil', 'ecureuils', 'écureuils', 'écureuil roux', 'écureuils roux', 'squirrel', 'squirrels', 'red squirrel', 'American red squirrel'], cries: [] },
  { id: 'loon', emoji: '🐦', file: 'loon-reviewed.ogg', label: { fr: 'un huard', en: 'a loon' }, names: ['huard', 'huards', 'plongeon', 'loon', 'loons'], cries: [] },
  { id: 'monkey', emoji: '🐒', file: 'monkey-chimpanzee.ogg', label: { fr: 'un singe (chimpanzé)', en: 'a chimpanzee' }, names: ['singe', 'singes', 'monkey', 'monkeys', 'chimpanzé', 'chimpanzés', 'chimpanzee', 'chimpanzees', 'chimp', 'chimps'], cries: [] },
  { id: 'zebra', emoji: '🦓', file: 'zebra-reviewed.ogg', label: { fr: 'un zèbre', en: 'a zebra' }, names: ['zebre', 'zèbre', 'zebres', 'zèbres', 'zebra', 'zebras'], cries: [] },
  { id: 'penguin', emoji: '🐧', file: 'penguin-reviewed.ogg', label: { fr: 'un manchot', en: 'a penguin' }, names: ['manchot', 'manchots', 'penguin', 'penguins'], cries: [] },
  { id: 'eagle', emoji: '🦅', file: 'eagle-reviewed.ogg', label: { fr: 'un aigle', en: 'an eagle' }, names: ['aigle', 'aigles', 'pygargue', 'eagle', 'eagles'], cries: [] },
  { id: 'peacock', emoji: '🦚', file: 'peacock-reviewed.ogg', label: { fr: 'un paon', en: 'a peacock' }, names: ['paon', 'paons', 'peacock', 'peafowl'], cries: [] },
  { id: 'parrot', emoji: '🦜', file: 'parrot-reviewed.ogg', label: { fr: 'un perroquet', en: 'a parrot' }, names: ['perroquet', 'perroquets', 'parrot', 'parrots'], cries: [] },
  { id: 'seagull', emoji: '🦢', file: 'seagull-reviewed.ogg', label: { fr: 'une mouette', en: 'a seagull' }, names: ['mouette', 'mouettes', 'goeland', 'goéland', 'seagull', 'seagulls', 'gull'], cries: [] },
  { id: 'pigeon', emoji: '🕊️', file: 'pigeon-reviewed.ogg', label: { fr: 'un pigeon', en: 'a pigeon' }, names: ['pigeon', 'pigeons'], cries: ['roucoule'] },
  { id: 'woodpecker', emoji: '🪵', file: 'woodpecker-reviewed.ogg', label: { fr: 'un pic-bois', en: 'a woodpecker' }, names: ['pic-bois', 'pic bois', 'woodpecker', 'woodpeckers'], cries: [] },
  { id: 'turkey', emoji: '🦃', file: 'turkey-reviewed.ogg', label: { fr: 'un dindon', en: 'a turkey' }, names: ['dinde', 'dindes', 'dindon', 'dindons', 'turkey', 'turkeys'], cries: ['glou glou', 'gobble'] },
  { id: 'goose', emoji: '🪿', file: 'goose-reviewed.ogg', label: { fr: 'une oie', en: 'a goose' }, names: ['oie', 'oies', 'bernache', 'outarde', 'jars', 'goose', 'geese'], cries: [] },
  { id: 'bat', emoji: '🦇', file: 'bat-reviewed.ogg', label: { fr: 'une chauve-souris', en: 'a bat' }, names: ['chauve-souris', 'chauve souris', 'chauves-souris', 'bat', 'bats'], cries: [] },
  { id: 'cicada', emoji: '🦗', file: 'cicada-field.ogg', label: { fr: 'une cigale', en: 'a cicada' }, names: ['cigale', 'cigales', 'cicada', 'cicadas'], cries: [] },
  { id: 'tiger', emoji: '🐅', file: 'tiger-reviewed.ogg', label: { fr: 'un tigre', en: 'a tiger' }, names: ['tigre', 'tigres', 'tigresse', 'tigreau', 'tiger', 'tigers'], cries: [] },
  { id: 'coyote', emoji: '🐺', file: 'coyote-reviewed.ogg', label: { fr: 'un coyote', en: 'a coyote' }, names: ['coyote', 'coyotes'], cries: [] },
  { id: 'raccoon', emoji: '🦝', file: 'raccoon-reviewed.ogg', label: { fr: 'un raton laveur', en: 'a raccoon' }, names: ['raton', 'ratons', 'raton laveur', 'ratons laveurs', 'raccoon', 'raccoons'], cries: [] },
  { id: 'giraffe', emoji: '🦒', file: 'giraffe-reviewed.ogg', label: { fr: 'une girafe (bourdonnement)', en: 'a giraffe (hum)' }, names: ['girafe', 'girafes', 'girafon', 'giraffe', 'giraffes'], cries: [] },
  { id: 'camel', emoji: '🐪', file: 'camel-reviewed.ogg', label: { fr: 'un chameau', en: 'a camel' }, names: ['chameau', 'chameaux', 'chamelle', 'camel', 'camels'], cries: [] },
  { id: 'gorilla', emoji: '🦍', file: 'gorilla-reviewed.ogg', label: { fr: 'un gorille', en: 'a gorilla' }, names: ['gorille', 'gorilles', 'gorilla', 'gorillas'], cries: [] },
  { id: 'jaguar', emoji: '🐆', file: 'jaguar-reviewed.ogg', label: { fr: 'un jaguar', en: 'a jaguar' }, names: ['jaguar', 'jaguars'], cries: [] },
  { id: 'seal', emoji: '🦭', file: 'seal-reviewed.ogg', label: { fr: 'un phoque', en: 'a seal' }, names: ['phoque', 'phoques', 'seal', 'seals'], cries: [] },
  { id: 'dolphin', emoji: '🐬', file: 'dolphin-reviewed.ogg', label: { fr: 'un dauphin (clics)', en: 'a dolphin (clicks)' }, names: ['dauphin', 'dauphins', 'dolphin', 'dolphins'], cries: [] },
  { id: 'guinea-pig', emoji: '🐹', file: 'guinea-pig-reviewed.ogg', label: { fr: "un cochon d'Inde", en: 'a guinea pig' }, names: ["cochon d'inde", "cochons d'inde", 'cochon d inde', 'cobaye', 'cobayes', 'guinea pig', 'guinea pigs', 'cavy'], cries: [] },
  { id: 'toucan', emoji: '🐦', file: 'toucan-reviewed.ogg', label: { fr: 'un toucanet', en: 'a toucanet' }, names: ['toucan', 'toucans', 'toucanet'], cries: [] },
  { id: 'cuckoo', emoji: '🐦', file: 'cuckoo-reviewed.ogg', label: { fr: 'un coucou', en: 'a cuckoo' }, names: ['coucou', 'coucous', 'coucou gris', 'oiseau coucou', 'cuckoo', 'cuckoos'], bareNames: ['coucou gris', 'oiseau coucou', 'cuckoo', 'cuckoos'], cries: [] },
  { id: 'crane', emoji: '🐦', file: 'crane-reviewed.ogg', label: { fr: 'une grue du Canada', en: 'a sandhill crane' }, names: ['grue', 'grues', 'grue du canada', 'sandhill crane', 'crane', 'cranes'], cries: [] },
  { id: 'quail', emoji: '🐦', file: 'quail-reviewed.ogg', label: { fr: 'un colin de Virginie', en: 'a bobwhite quail' }, names: ['colin', 'colin de virginie', 'bobwhite', 'bobwhite quail', 'quail'], cries: [] },
  { id: 'osprey', emoji: '🦅', file: 'osprey-reviewed.ogg', label: { fr: 'un balbuzard', en: 'an osprey' }, names: ['balbuzard', 'balbuzards', 'balbuzard pecheur', 'osprey', 'ospreys'], cries: [] },
  { id: 'grasshopper', emoji: '🦗', file: 'grasshopper-reviewed.ogg', label: { fr: 'une sauterelle', en: 'a grasshopper' }, names: ['sauterelle', 'sauterelles', 'grasshopper', 'grasshoppers'], cries: [] },
  { id: 'mouse', emoji: '🐭', file: 'mouse-reviewed.ogg', kind: 'imitation', label: { fr: 'une souris (imitation)', en: 'a mouse (imitation)' }, names: ['souris', 'souriceau', 'mouse', 'mice'], cries: [] },
  { id: 'yak', emoji: '🐂', file: 'yak-reviewed.ogg', kind: 'imitation', label: { fr: 'un yak (imitation)', en: 'a yak (imitation)' }, names: ['yak', 'yaks', 'yack', 'yacks'], cries: [] },
  { id: "alligator", emoji: "🐊", file: "alligator-google.ogg", label: { fr: "un alligator", en: "an alligator" }, names: ["alligator", "alligators"], cries: [] },
  { id: "alpaca", emoji: "🦙", file: "alpaca-google.ogg", label: { fr: "un alpaga", en: "an alpaca" }, names: ["alpaga", "alpagas", "alpaca", "alpacas"], cries: [] },
  { id: "antelope", emoji: "🦌", file: "antelope-google.ogg", label: { fr: "une antilope", en: "an antelope" }, names: ["antilope", "antilopes", "antelope", "antelopes"], cries: [] },
  { id: "buffalo", emoji: "🐃", file: "buffalo-google.ogg", label: { fr: "un buffle", en: "a buffalo" }, names: ["buffle", "buffles", "buffalo", "buffaloes"], cries: [] },
  { id: "dove", emoji: "🕊️", file: "dove-google.ogg", label: { fr: "une colombe", en: "a dove" }, names: ["colombe", "colombes", "dove", "doves"], cries: [] },
  { id: "swan", emoji: "🦢", file: "swan-google.ogg", label: { fr: "un cygne", en: "a swan" }, names: ["cygne", "cygnes", "swan", "swans"], cries: [] },
  { id: "komodo-dragon", emoji: "🦎", file: "komodo-dragon-google.ogg", label: { fr: "un dragon de Komodo", en: "a Komodo dragon" }, names: ["dragon de komodo", "dragons de komodo", "komodo", "komodo dragon", "komodo dragons"], cries: [] },
  { id: "falcon", emoji: "🦅", file: "falcon-google.ogg", label: { fr: "un faucon", en: "a falcon" }, names: ["faucon", "faucons", "falcon", "falcons"], cries: [] },
  { id: "ferret", emoji: "🐾", file: "ferret-google.ogg", label: { fr: "un furet", en: "a ferret" }, names: ["furet", "furets", "ferret", "ferrets"], cries: [] },
  { id: "hippopotamus", emoji: "🦛", file: "hippopotamus-google.ogg", label: { fr: "un hippopotame", en: "a hippopotamus" }, names: ["hippopotame", "hippopotames", "hippo", "hippos", "hippopotamus", "hippopotamuses"], cries: [] },
  { id: "hyena", emoji: "🐾", file: "hyena-google.ogg", label: { fr: "une hyène", en: "a hyena" }, names: ["hyène", "hyènes", "hyena", "hyenas"], cries: [] },
  { id: "hedgehog", emoji: "🦔", file: "hedgehog-google.ogg", label: { fr: "un hérisson", en: "a hedgehog" }, names: ["hérisson", "hérissons", "hedgehog", "hedgehogs"], cries: [] },
  { id: "rabbit", emoji: "🐇", file: "rabbit-google.ogg", label: { fr: "un lapin", en: "a rabbit" }, names: ["lapin", "lapins", "lapine", "lapereau", "rabbit", "rabbits", "bunny"], cries: [] },
  { id: "otter", emoji: "🦦", file: "otter-google.ogg", label: { fr: "une loutre", en: "an otter" }, names: ["loutre", "loutres", "otter", "otters"], cries: [] },
  { id: "leopard", emoji: "🐆", file: "leopard-google.ogg", label: { fr: "un léopard", en: "a leopard" }, names: ["léopard", "léopards", "leopard", "leopards"], cries: [] },
  { id: "moose", emoji: "🫎", file: "moose-google.ogg", label: { fr: "un orignal", en: "a moose" }, names: ["orignal", "orignaux", "élan", "élans", "moose"], cries: [] },
  { id: "panda", emoji: "🐼", file: "panda-google.ogg", label: { fr: "un panda", en: "a panda" }, names: ["panda", "pandas"], cries: [] },
  { id: "rat", emoji: "🐀", file: "rat-google.ogg", label: { fr: "un rat", en: "a rat" }, names: ["rat", "rats"], cries: [] },
  { id: "rhinoceros", emoji: "🦏", file: "rhinoceros-google.ogg", label: { fr: "un rhinocéros", en: "a rhinoceros" }, names: ["rhinocéros", "rhino", "rhinos", "rhinoceros", "rhinoceroses"], cries: [] },
  { id: "rattlesnake", emoji: "🐍", file: "rattlesnake-google.ogg", label: { fr: "un serpent à sonnette", en: "a rattlesnake" }, names: ["serpent à sonnette", "serpents à sonnette", "serpent", "serpents", "crotale", "crotales", "rattlesnake", "rattlesnakes", "snake", "snakes"], cries: [] },
  { id: 'trex', emoji: '🦖', file: 'trex-reviewed.ogg', kind: 'effect', label: { fr: 'un T-Rex (bruitage)', en: 'a T-Rex (sound effect)' }, names: ['t-rex', 't rex', 'trex', 'tyrannosaure', 'tyrannosaures', 'tyrannosaurus', 'tyrannosaurus rex'], cries: [] },
].map((entry) => Object.freeze({
  ...entry,
  label: Object.freeze(entry.label),
  names: Object.freeze(entry.names),
  ...(entry.bareNames ? { bareNames: Object.freeze(entry.bareNames) } : {}),
  cries: Object.freeze(entry.cries)
})));

// `son` and `chant` are ambiguous in French -- "son chien" is a possessive and
// "un chant" can be a song -- so each is anchored to the shape a real sound
// request takes instead of being matched as a bare word.
const SOUND_INTENT_PATTERNS = Object.freeze([
  /\bbruits?\b/,
  /\bcris?\b/,
  /\brugissements?\b/,
  /\bfais(?:[- ]moi)?\s+rugir\b/,
  /\b(?:le|la|les|un|une|du|des|quel|quels|quelle|quelles|ce|son|leur)\s+sons?\b/,
  /\bsons?\s+(?:de|du|des|d')/,
  /\b(?:chant|chante|chantent|chanter)\s+(?:de|du|des|d'|le|la|les|un|une)/,
  /\b(?:le|la|un|une)\s+chant\b/,
  /\b(?:fait|font)\s+(?:quoi|comme)\b/,
  /\bcomment\s+(?:est-ce\s+)?(?:qu'|ca\s+|il\s+|elle\s+|on\s+)?(?:fait|font|crie|crient|chante|chantent|parle|aboie|miaule)\b/,
  /\b(?:qu'est-ce\s+que|que|quoi)\s+(?:ca\s+|il\s+|elle\s+|le\s+|la\s+|les\s+|un\s+|une\s+)?\w*\s*(?:fait|font)\b/,
  /\b(?:veux|voudrais|aimerais)\s+(?:bien\s+)?(?:entendre|ecouter)\b/,
  /\b(?:peux|pourrais)\s*-\s*tu\s+(?:me\s+)?(?:faire\s+)?(?:entendre|ecouter)\b/,
  /^ecoute\b/,
  /\bimite/,
  /\bimitation\b/,
  /\bfais\s+(?:moi\s+)?(?:le|la|un|une)?\s*(?:bruit|son|cri|comme)/,
  /\bsounds?\s+(?:like|of|does)\b/,
  /\b(?:what|which|whats)\s+(?:kind\s+of\s+)?(?:sound|noise|call)\b/,
  /\b(?:the|a|an|its|his|her|their)\s+sounds?\b/,
  /\b(?:what|which)\s+(?:kind\s+of\s+)?noises?\b/,
  /\bwhat\s+does\s+(?:a\s+|an\s+|the\s+)?[a-z' ]{0,24}\s(?:say|says|sound|go|goes)\b/,
  /\bhow\s+does\s+(?:a\s+|an\s+|the\s+)?[a-z' ]{0,24}\s(?:sound|go|goes|sing|sings)\b/,
  /\b(?:can|could|may)\s+i\s+hear\b/,
  /\blet\s+me\s+(?:hear|listen)\b/,
  /\b(?:want|wanna|would\s+like)\s+to\s+(?:hear|listen)\b/,
  /^listen\b/,
  /\bplay\s+(?:me\s+)?(?:the|a|an)?\s*(?:sound|noise|call|cry)/,
  /\bcall\s+of\b/
]);

// Determiners a small child drops in front of a bare word: "la vache" is the
// same request as "vache".
const BARE_DETERMINERS = /^(?:(?:le|la|les|un|une|des|du|de\s+la|de\s+l'|the|a|an)\s+|l'\s*)/;

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[^a-z0-9'\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Terms match on non-alphanumeric boundaries with an optional plural, so
// "vaches" hits "vache" while "toujours" never hits "ours".
function termPattern(terms) {
  const escaped = [...new Set(terms.map(normalize).filter(Boolean))]
    .map(escapeRegExp)
    .sort((left, right) => right.length - left.length);
  if (!escaped.length) return null;
  return new RegExp(`(?:^|[^a-z0-9])(?:${escaped.join('|')})s?(?![a-z0-9])`);
}

function bareTermPattern(terms) {
  const escaped = [...new Set(terms.map(normalize).filter(Boolean))].map(escapeRegExp);
  if (!escaped.length) return null;
  return new RegExp(`^(?:${escaped.join('|')})s?$`);
}

function imitationPattern(terms) {
  const escaped = [...new Set(terms.map(normalize).filter(Boolean))].map(escapeRegExp);
  if (!escaped.length) return null;
  const cry = `(?:${escaped.join('|')})`;
  return new RegExp(`^(?:(?:fais(?:[- ]moi)?|imite|do(?: the| a)?|make(?: the| a)?)\\s+)?${cry}(?:\\s+${cry}){0,3}$`);
}

const COMPILED = CATALOG.map((entry) => Object.freeze({
  entry,
  namePattern: termPattern(entry.names),
  criePattern: termPattern(entry.cries),
  imitationPattern: imitationPattern(entry.cries),
  // "Coucou" is also a greeting; its bird meaning needs a sound request.
  barePattern: bareTermPattern(entry.bareNames || entry.names)
}));

function hasSoundIntent(value) {
  return SOUND_INTENT_PATTERNS.some((pattern) => pattern.test(value));
}

function earliestMatch(value, key, allowed) {
  let best = null;
  for (const row of COMPILED) {
    if (allowed && !allowed.has(row.entry.id)) continue;
    const pattern = row[key];
    if (!pattern) continue;
    const found = value.match(pattern);
    if (!found) continue;
    // At the same position, "cochon d'Inde" is more specific than "cochon".
    if (!best || found.index < best.index || (found.index === best.index && found[0].length > best.length)) {
      best = { entry: row.entry, index: found.index, length: found[0].length };
    }
  }
  return best ? best.entry : null;
}

/**
 * Decide which catalog sound a child utterance is asking for, or null.
 *
 * Three ways to ask, in order:
 *  1. an imitation: "ouaf ouaf", "fais miaou", "cocorico!"
 *  2. an explicit request naming the animal: "quel bruit fait la vache?",
 *     "what does a cow sound like?"
 *  3. the whole utterance is the animal, which is how the youngest kids and the
 *     Reader lane ask: "vache", "le chat"
 */
function selectSound(text, { ids = null, explicitSoundIntent = false } = {}) {
  const value = normalize(text);
  if (!value) return null;
  const allowed = ids ? new Set(ids) : null;
  const directImitation = COMPILED.find((row) => (
    (!allowed || allowed.has(row.entry.id))
    && row.imitationPattern
    && row.imitationPattern.test(value)
  ));
  if (directImitation) return directImitation.entry;
  if (explicitSoundIntent || hasSoundIntent(value)) {
    const named = earliestMatch(value, 'namePattern', allowed);
    if (named) return named;
    const imitation = earliestMatch(value, 'criePattern', allowed);
    if (imitation) return imitation;
  }
  const bare = value.replace(BARE_DETERMINERS, '').trim();
  if (bare) {
    const row = COMPILED.find((candidate) => (
      (!allowed || allowed.has(candidate.entry.id))
      && candidate.barePattern
      && candidate.barePattern.test(bare)
    ));
    if (row) return row.entry;
  }
  return null;
}

function mimeTypeFor(file) {
  return MIME_BY_EXTENSION[path.extname(String(file || '')).toLowerCase()] || 'application/octet-stream';
}

function describe(entry, bytes = 0) {
  return {
    id: entry.id,
    emoji: entry.emoji,
    label: { fr: entry.label.fr, en: entry.label.en },
    kind: entry.kind || 'recording',
    url: `${PUBLIC_SOUND_PATH}/${entry.file}`,
    mimeType: mimeTypeFor(entry.file),
    // Reviewed assets already carry their level adjustment. Keep the optional
    // gain contract for other packs; every shipped clip uses unity playback.
    gain: Number(entry.gain) > 0 ? Number(entry.gain) : 1,
    bytes
  };
}

/**
 * Resolve the catalog against the clips actually present on disk. A row without
 * its audio is never advertised and never selected, so a missing or trimmed
 * pack degrades to "no sound" instead of a broken player.
 */
function createSoundLibrary({ soundsDir = DEFAULT_SOUND_DIR, logger = null } = {}) {
  const available = [];
  const missing = [];
  for (const entry of CATALOG) {
    let bytes = 0;
    try {
      const stat = fs.statSync(path.join(soundsDir, entry.file));
      if (stat.isFile() && stat.size > 0) bytes = stat.size;
    } catch (_error) { bytes = 0; }
    if (bytes) available.push(describe(entry, bytes));
    else missing.push(entry.id);
  }
  if (missing.length) {
    logger?.warn?.('Household sound library is missing clips', { soundsDir, missing: missing.join(',') });
  }
  const ids = new Set(available.map((sound) => sound.id));
  const byId = new Map(available.map((sound) => [sound.id, sound]));
  return {
    dir: soundsDir,
    sounds: available,
    missing,
    status: {
      status: available.length ? 'ready' : 'unavailable',
      available: available.length,
      catalog: CATALOG.length,
      missing
    },
    get(id) { return byId.get(String(id || '')) || null; },
    select(text, { explicitSoundIntent = false } = {}) {
      const entry = selectSound(text, { ids, explicitSoundIntent });
      return entry ? byId.get(entry.id) || null : null;
    }
  };
}

module.exports = {
  CATALOG,
  DEFAULT_SOUND_DIR,
  PUBLIC_SOUND_PATH,
  createSoundLibrary,
  describe,
  hasSoundIntent,
  mimeTypeFor,
  normalize,
  selectSound
};
