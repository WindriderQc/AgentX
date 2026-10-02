'use strict';

// A child's counting or addition question becomes a picture beside Nestor
// (#131, agentx.math-scene.v1): count to 100, additions to 20, look-only.
// Core recognises the question, computes the answer and says it itself: the
// model took ~16 s to answer "8 + 5" while the picture was already done, so a
// pure math question never waits for inference. Anything outside those bounds
// gets no picture (never a clamped one) and goes to the model as before.

const SCHEMA = 'agentx.math-scene.v1';
const LIMITS = Object.freeze({ countMax: 100, sumMax: 20 });

const FR_UNITS = ['zero', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix',
  'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
const FR_TENS = { 20: 'vingt', 30: 'trente', 40: 'quarante', 50: 'cinquante', 60: 'soixante' };
const EN_UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = { 20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty', 60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety' };

function french(n) {
  if (n <= 16) return FR_UNITS[n];
  if (n < 20) return `dix ${FR_UNITS[n - 10]}`;
  if (n === 100) return 'cent';
  if (n >= 80) {
    const rest = n - 80;
    return rest === 0 ? 'quatre vingts' : `quatre vingt ${french(rest)}`;
  }
  if (n >= 60) {
    const rest = n - 60;
    if (rest === 0) return 'soixante';
    return rest === 1 || rest === 11 ? `soixante et ${french(rest)}` : `soixante ${french(rest)}`;
  }
  const tens = Math.floor(n / 10) * 10, unit = n % 10;
  if (unit === 0) return FR_TENS[tens];
  return unit === 1 ? `${FR_TENS[tens]} et un` : `${FR_TENS[tens]} ${FR_UNITS[unit]}`;
}

function english(n) {
  if (n < 20) return EN_UNITS[n];
  if (n === 100) return 'one hundred';
  const tens = Math.floor(n / 10) * 10, unit = n % 10;
  return unit ? `${EN_TENS[tens]} ${EN_UNITS[unit]}` : EN_TENS[tens];
}

// Every spelling of 0..100 as a token sequence, longest first, so "dix sept"
// wins over "dix" and "quatre vingt dix" over "quatre".
const PHRASES = (() => {
  const rows = [];
  for (let n = 0; n <= LIMITS.countMax; n += 1) {
    for (const words of new Set([french(n), english(n)])) rows.push({ tokens: words.split(' '), value: n });
  }
  rows.push({ tokens: ['une'], value: 1 }, { tokens: ['quatre', 'vingt'], value: 80 }, { tokens: ['hundred'], value: 100 },
    { tokens: ['a', 'hundred'], value: 100 }, { tokens: ['cent'], value: 100 });
  return rows.sort((a, b) => b.tokens.length - a.tokens.length);
})();

function tokens(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'`-]/g, ' ').replace(/\+/g, ' + ').replace(/=/g, ' = ')
    .replace(/[^a-z0-9+= ]/g, ' ').split(/\s+/).filter(Boolean);
}

/** The number that starts at `index`, as { value, next }, or null. */
function numberAt(words, index) {
  const word = words[index];
  if (word === undefined) return null;
  if (/^\d{1,3}$/.test(word)) return { value: Number(word), next: index + 1 };
  for (const phrase of PHRASES) {
    if (phrase.tokens.every((token, offset) => words[index + offset] === token)) {
      return { value: phrase.value, next: index + phrase.tokens.length };
    }
  }
  return null;
}

const QUESTION = new Set(['combien', 'font', 'fait', 'egal', 'egale', 'egalent', '=', 'how', 'equals', 'makes', 'is']);
const COUNT_VERB = /^(?:compt|count)/;

function additionIn(words) {
  // "et"/"and" join numbers in ordinary talk ("2 et 3 ans"); they count as a
  // plus only when the sentence asks a sum. "+" and "plus" always do.
  const asksSum = words.some(word => QUESTION.has(word));
  for (let i = 0; i < words.length; i += 1) {
    const first = numberAt(words, i);
    if (!first) continue;
    const operator = words[first.next];
    if (!(operator === '+' || operator === 'plus' || (asksSum && (operator === 'et' || operator === 'and')))) continue;
    const second = numberAt(words, first.next + 1);
    if (!second) continue;
    const a = first.value, b = second.value;
    if (a + b === 0 || a + b > LIMITS.sumMax) return { outOfBounds: true };
    return { kind: 'add', a, b };
  }
  return null;
}

function countIn(words) {
  for (let i = 0; i < words.length; i += 1) {
    if (!COUNT_VERB.test(words[i])) continue;
    // compte jusqu'a 30 / compter jusqu a trente / count to 30 / count up to 30 / count 30
    let j = i + 1;
    if (words[j] === 'jusqu' || words[j] === 'jusqua') j += words[j] === 'jusqu' && words[j + 1] === 'a' ? 2 : 1;
    else if (words[j] === 'up' && words[j + 1] === 'to') j += 2;
    else if (words[j] === 'to' || words[j] === 'a') j += 1;
    const number = numberAt(words, j);
    if (!number) continue;
    if (number.value < 1 || number.value > LIMITS.countMax) return { outOfBounds: true };
    return { kind: 'count', to: number.value };
  }
  return null;
}

/** The picture for a child's question, or null when it asks for none (or one out of bounds). */
function mathSceneFor(text) {
  const words = tokens(text).slice(0, 80);
  const found = additionIn(words) || countIn(words);
  if (!found || found.outOfBounds) return null;
  return { schema: SCHEMA, ...found };
}

const ENGLISH = new Set(['what', 'whats', 'how', 'much', 'many', 'count', 'is', 'equals', 'makes', 'can', 'you', 'up', 'and', 'to']);
const FRENCH = new Set(['combien', 'font', 'fait', 'compte', 'compter', 'jusqu', 'egal', 'egale', 'et', 'ca', 'peux', 'tu', 'quoi', 'est']);

/** The language of the question: French unless its words say English. */
function questionLanguage(words) {
  let en = 0, fr = 0;
  for (const word of words) { if (ENGLISH.has(word)) en += 1; if (FRENCH.has(word)) fr += 1; }
  return en > fr ? 'en' : 'fr';
}

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

/**
 * What Nestor says, in the order the picture moves: the result first, then
 * what the child is watching (the second number completing the ten).
 */
function mathReply(scene, language = 'fr') {
  const en = language === 'en';
  if (scene.kind === 'add') {
    const { a, b } = scene, sum = a + b;
    const head = en ? `${a} plus ${b} makes ${sum}!` : `${a} plus ${b}, ça fait ${sum} !`;
    let look;
    if (sum > 10 && a < 10) {
      const fill = 10 - a, rest = sum - 10;
      look = en ? `Look: ${plural(fill, 'orange cube completes', 'orange cubes complete')} the ten, and ${rest} ${rest > 1 ? 'are' : 'is'} left over.`
        : `Regarde : ${plural(fill, 'cube orange complète', 'cubes orange complètent')} la dizaine, et il en reste ${rest}.`;
    } else if (sum > 10) {
      look = en ? `Look: one full ten, and ${sum - 10} more.` : `Regarde : une dizaine complète, et ${sum - 10} de plus.`;
    } else if (sum === 10) {
      look = en ? 'Look: that makes a full ten!' : 'Regarde : ça fait une dizaine complète !';
    } else {
      look = en ? `Look: ${plural(a, 'blue cube', 'blue cubes')} and ${plural(b, 'orange cube', 'orange cubes')}.`
        : `Regarde : ${plural(a, 'cube bleu', 'cubes bleus')} et ${plural(b, 'cube orange', 'cubes orange')}.`;
    }
    return `${head} ${look}`;
  }
  const { to } = scene, tens = Math.floor(to / 10), ones = to % 10;
  if (to <= 10) {
    const numbers = Array.from({ length: to }, (_, i) => String(i + 1)).join(', ');
    return en ? `Let's count together: ${numbers}!` : `On compte ensemble : ${numbers} !`;
  }
  if (en) return `Let's count to ${to}! Look: ${plural(tens, 'ten', 'tens')}${ones ? ` and ${ones} more` : ''} make ${to}.`;
  return `On compte jusqu’à ${to} ! Regarde : ${plural(tens, 'dizaine', 'dizaines')}${ones ? ` et ${plural(ones, 'unité', 'unités')}` : ''}, ça fait ${to}.`;
}

/** A pure math question: its picture and Nestor's immediate answer, or null. */
function mathTurnFor(text) {
  const scene = mathSceneFor(text);
  if (!scene) return null;
  return { scene, reply: mathReply(scene, questionLanguage(tokens(text))) };
}

module.exports = { mathSceneFor, mathReply, mathTurnFor, LIMITS, SCHEMA };
