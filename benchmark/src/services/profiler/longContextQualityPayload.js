'use strict';

/**
 * Long-context quality probe payload and scorer (#367).
 *
 * A deterministic document of varied filler sentences carries five planted
 * facts at fixed depths (retrieval) and a two-hop chain with distractors
 * (multi-hop). The model answers six numbered lines; the scorer checks each
 * line for the exact planted value. No judge, no randomness at run time: the
 * same size and seed always produce the same document and expected answers.
 */

const RETRIEVAL_DEPTHS = Object.freeze([0.05, 0.25, 0.5, 0.75, 0.95]);
// Depths of the multi-hop chain (courier, then key) and of its distractors.
const HOP_DEPTHS = Object.freeze({ courier: 0.15, key: 0.85, distractorCourier: 0.4, distractorKey: 0.6 });
const PAYLOAD_VERSION = 1;

const NAMES = ['Arlo', 'Brielle', 'Cassian', 'Delphine', 'Emrys', 'Fenna', 'Gideon', 'Hollis', 'Isolde', 'Jory',
  'Kestrel', 'Lisbet', 'Marek', 'Nadia', 'Orrin', 'Perpetua', 'Quill', 'Rosalind', 'Soren', 'Tamsin'];
const SURNAMES = ['Ashdown', 'Blackwood', 'Corriveau', 'Dunmore', 'Ellery', 'Fairbairn', 'Greaves', 'Halloran',
  'Ingleby', 'Jarrow', 'Kittredge', 'Lowther', 'Merriman', 'Northcott', 'Osgood', 'Pemberton'];
const VERBS = ['repaired', 'inspected', 'painted', 'measured', 'catalogued', 'photographed', 'cleaned', 'moved',
  'described', 'compared', 'sketched', 'weighed'];
const ADJECTIVES = ['quiet', 'narrow', 'faded', 'copper', 'wooden', 'northern', 'crowded', 'distant', 'tall',
  'ancient', 'small', 'bright'];
const NOUNS = ['bridge', 'lantern', 'harbor', 'orchard', 'ledger', 'workshop', 'tower', 'market', 'canal',
  'garden', 'archive', 'mill'];
const PLACES = ['the river bend', 'the old station', 'the east gate', 'the hill road', 'the fish market',
  'the town square', 'the lower field', 'the stone quay'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const CONNECTORS = ['Later that week,', 'Meanwhile,', 'Before noon,', 'After the rain,', 'In the evening,', 'Once again,'];
const LOCKER_WORDS = ['Amber', 'Basalt', 'Cobalt', 'Dune', 'Ember', 'Flint', 'Garnet', 'Heron', 'Indigo', 'Juniper'];
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// Mulberry32: a small deterministic generator.
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length)];

function code(random) {
  const letters = () => CODE_LETTERS[Math.floor(random() * CODE_LETTERS.length)];
  return `${letters()}${letters()}-${1000 + Math.floor(random() * 9000)}-${Math.floor(random() * 10)}`;
}

function fillerSentence(random) {
  const subject = `${pick(random, NAMES)} ${pick(random, SURNAMES)}`;
  const body = `${subject} ${pick(random, VERBS)} the ${pick(random, ADJECTIVES)} ${pick(random, NOUNS)} near ${pick(random, PLACES)} on ${pick(random, DAYS)}.`;
  return random() < 0.3 ? `${pick(random, CONNECTORS)} ${body.charAt(0).toLowerCase()}${body.slice(1)}` : body;
}

function uniqueValues(random, count, make) {
  const values = new Set();
  while (values.size < count) values.add(make(random));
  return [...values];
}

/**
 * The planted facts and expected answers for one seed.
 */
function plantFacts(seed) {
  const random = createRandom(seed ^ 0x5eed);
  const lockers = uniqueValues(random, RETRIEVAL_DEPTHS.length, r => `${pick(r, LOCKER_WORDS)}-${10 + Math.floor(r() * 90)}`);
  const codes = uniqueValues(random, RETRIEVAL_DEPTHS.length + 2, code);
  const people = uniqueValues(random, 2, r => `${pick(r, NAMES)} ${pick(r, SURNAMES)}`);
  const shipments = uniqueValues(random, 2, r => `S-${100 + Math.floor(r() * 900)}`);
  const retrieval = RETRIEVAL_DEPTHS.map((depth, index) => ({
    depth,
    question: `the access code for locker ${lockers[index]}`,
    sentence: `Registry note: the access code for locker ${lockers[index]} is ${codes[index]}.`,
    expected: codes[index],
  }));
  const [courier, decoy] = people;
  const [shipment, decoyShipment] = shipments;
  const [cabinet, decoyCabinet] = codes.slice(RETRIEVAL_DEPTHS.length);
  const chain = [
    { depth: HOP_DEPTHS.courier, sentence: `Dispatch log: the courier for shipment ${shipment} is ${courier}.` },
    { depth: HOP_DEPTHS.distractorCourier, sentence: `Dispatch log: the courier for shipment ${decoyShipment} is ${decoy}.` },
    { depth: HOP_DEPTHS.distractorKey, sentence: `Key register: ${decoy} keeps the master key in cabinet ${decoyCabinet}.` },
    { depth: HOP_DEPTHS.key, sentence: `Key register: ${courier} keeps the master key in cabinet ${cabinet}.` },
  ];
  return {
    retrieval,
    multiHop: {
      question: `the cabinet where the courier for shipment ${shipment} keeps the master key`,
      expected: cabinet,
      distractor: decoyCabinet,
      chain,
    },
  };
}

function instructions(facts) {
  const lines = [...facts.retrieval.map(item => item.question), facts.multiHop.question]
    .map((question, index) => `${index + 1}: ${question}`);
  return [
    '',
    'Answer from the document above only. Reply with exactly these six numbered lines,',
    'each holding only the value asked for, and nothing else:',
    ...lines,
  ].join('\n');
}

/**
 * Build the document for one size.
 *
 * @param {number} targetChars - characters of document to generate
 * @param {number} seed
 * @returns {{ prompt: string, expected: string[], facts: object, version: number }}
 */
function buildQualityPrompt(targetChars, seed) {
  const facts = plantFacts(seed);
  const random = createRandom(seed);
  const plants = [...facts.retrieval, ...facts.multiHop.chain]
    .map(item => ({ at: Math.floor(item.depth * targetChars), sentence: item.sentence }))
    .sort((a, b) => a.at - b.at);
  const parts = [];
  let length = 0;
  let next = 0;
  while (length < targetChars || next < plants.length) {
    if (next < plants.length && length >= plants[next].at) {
      parts.push(plants[next].sentence);
      length += plants[next].sentence.length + 1;
      next += 1;
      continue;
    }
    const sentence = fillerSentence(random);
    parts.push(sentence);
    length += sentence.length + 1;
  }
  const document = parts.join(' ');
  return {
    prompt: document + instructions(facts),
    expected: [...facts.retrieval.map(item => item.expected), facts.multiHop.expected],
    facts,
    version: PAYLOAD_VERSION,
  };
}

// Unicode hyphens and dashes read as the ASCII hyphen the codes use.
const normalize = value => String(value || '').toUpperCase()
  .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[^A-Z0-9-]+/g, ' ');

function answerLines(response) {
  const text = String(response || '');
  const numbered = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:\*\*)?(\d)(?:\*\*)?\s*[:.)\]-]\s*(.*)$/);
    if (match && !numbered.has(Number(match[1]))) numbered.set(Number(match[1]), match[2]);
  }
  if (numbered.size > 0) return numbered;
  // Unnumbered answers count in order.
  const plain = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return new Map(plain.map((line, index) => [index + 1, line]));
}

/**
 * Score a response against the expected values. A line is correct when it
 * holds its own value and no other planted value, so listing every code on
 * every line scores nothing.
 */
function scoreQualityResponse(response, built) {
  const answers = answerLines(response);
  const planted = [...built.expected, built.facts.multiHop.distractor].map(normalize);
  const tokens = line => new Set(normalize(line).split(/\s+/).filter(Boolean));
  const results = built.expected.map((expected, index) => {
    const line = answers.get(index + 1);
    const seen = tokens(line);
    const target = normalize(expected).trim();
    const others = planted.filter(value => value.trim() !== target).some(value => seen.has(value.trim()));
    return { line: index + 1, correct: seen.has(target) && !others };
  });
  const retrieval = results.slice(0, built.facts.retrieval.length).map((result, index) => ({
    depthPct: Math.round(built.facts.retrieval[index].depth * 100),
    correct: result.correct,
  }));
  const multiHop = results[results.length - 1].correct;
  const correct = results.filter(result => result.correct).length;
  return {
    retrieval,
    retrievalCorrect: retrieval.filter(item => item.correct).length,
    multiHopCorrect: multiHop,
    // The distractor cabinet means the model followed the wrong courier.
    multiHopDistractor: !multiHop && tokens(answers.get(results.length)).has(normalize(built.facts.multiHop.distractor).trim()),
    score: Number((correct / results.length).toFixed(3)),
    passed: correct === results.length,
  };
}

module.exports = {
  HOP_DEPTHS,
  PAYLOAD_VERSION,
  RETRIEVAL_DEPTHS,
  buildQualityPrompt,
  plantFacts,
  scoreQualityResponse,
  _internal: { answerLines, createRandom, normalize },
};
