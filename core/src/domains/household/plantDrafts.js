'use strict';

// What a model may propose for a plant card (#867), and how its output becomes
// a reviewable draft. Model output is data: it is parsed strictly, sources are
// only those Core searched (never URLs the model writes), and the child-safety
// bounds on care actions are applied here, not trusted to the prompt.

const { AGE_BANDS } = require('./family');
const { CARE_FIELDS, TOXICITY_LEVELS, TOXICITY_SUBJECTS, plantInput } = require('./plants');

const failure = (message) => Object.assign(new Error(message), { status: 502, code: 'PLANT_ASSIST_INVALID_OUTPUT' });
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const IDENTIFY_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    candidates: {
      type: 'array', maxItems: 3,
      items: { type: 'object', properties: {
        commonName: { type: 'string' }, latinName: { type: 'string' },
        confidence: { type: 'number' }, traits: { type: 'string' }
      }, required: ['commonName', 'latinName', 'confidence', 'traits'] }
    }
  },
  required: ['candidates']
});

const sourced = { type: 'object', properties: { text: { type: 'string' }, sources: { type: 'array', items: { type: 'integer' } } }, required: ['text', 'sources'] };
const toxicitySchema = { type: 'object', properties: { level: { type: 'string', enum: TOXICITY_LEVELS.filter(level => level !== 'unknown') },
  note: { type: 'string' }, sources: { type: 'array', items: { type: 'integer' } } }, required: ['level', 'note', 'sources'] };
const CARE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    careSheet: { type: 'object', properties: Object.fromEntries(CARE_FIELDS.map(key => [key, sourced])), required: ['light', 'water', 'humidity'] },
    toxicity: { type: 'object', properties: Object.fromEntries(TOXICITY_SUBJECTS.map(key => [key, toxicitySchema])), required: [...TOXICITY_SUBJECTS] },
    funFact: { type: 'string' },
    carePlan: {
      type: 'array', maxItems: 5,
      items: { type: 'object', properties: {
        title: { type: 'string' }, note: { type: 'string' },
        cadence: { type: 'string', enum: ['weekly', 'interval'] },
        intervalDays: { type: 'integer' }, winterIntervalDays: { type: 'integer' },
        stars: { type: 'integer' }, minAgeBand: { type: 'string', enum: [...AGE_BANDS] }
      }, required: ['title', 'note', 'cadence', 'stars', 'minAgeBand'] }
    }
  },
  required: ['careSheet', 'toxicity', 'funFact', 'carePlan']
});

function parse(content) {
  try {
    const value = JSON.parse(String(content || ''));
    if (isObject(value)) return value;
  } catch { /* reported below */ }
  throw failure('The model did not return a JSON object.');
}

/** Up to three candidates, most likely first; nothing is chosen for the parent. */
function identificationCandidates(content) {
  const value = parse(content);
  if (!Array.isArray(value.candidates)) throw failure('The model returned no candidate list.');
  const candidates = value.candidates.slice(0, 3).map(candidate => {
    if (!isObject(candidate)) throw failure('A candidate is not an object.');
    const number = Number(candidate.confidence);
    return { commonName: candidate.commonName, latinName: candidate.latinName,
      confidence: Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : null, traits: candidate.traits };
  }).filter(candidate => String(candidate.commonName || '').trim());
  // The plant rules bound and clean every field; the chosen name is the parent's.
  if (!candidates.length) return [];
  return plantInput({ identification: { commonName: candidates[0].commonName, candidates } }).identification.candidates
    .sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
}

const RISKY = /engrais|fertili|tailler|taille|couper|s[ée]cateur|ciseaux|prun|pesticide|insecticide|savon noir|rempot|repot/i;
const BAND_RANK = Object.freeze({ little: 0, school: 1, teen: 2 });
const atLeast = (band, minimum) => BAND_RANK[band] >= BAND_RANK[minimum] ? band : minimum;

/**
 * The youngest age band an action may reach. Tools, fertilizer, pesticides and
 * repotting are never for the youngest; neither is handling a toxic plant.
 */
function safeAgeBand(action, toxicity) {
  let band = AGE_BANDS.includes(action.minAgeBand) ? action.minAgeBand : 'school';
  if (RISKY.test(`${action.title} ${action.note}`)) band = atLeast(band, 'school');
  if (['mild', 'toxic'].includes(toxicity?.children?.level)) band = atLeast(band, 'school');
  return band;
}

/**
 * A care draft: the sheet, toxicity (never confirmed: the parent confirms it),
 * fun fact and care plan, with sources mapped from the numbered search results.
 */
function careDraft(content, results = []) {
  const value = parse(content);
  const urls = results.map(result => result.url);
  const cite = (list) => [...new Set((Array.isArray(list) ? list : [])
    .map(index => urls[Number(index) - 1]).filter(Boolean))].slice(0, 5);
  const sheet = isObject(value.careSheet) ? value.careSheet : {};
  const careSheet = Object.fromEntries(CARE_FIELDS.filter(key => isObject(sheet[key]))
    .map(key => [key, { text: sheet[key].text, sources: cite(sheet[key].sources) }]));
  const rawToxicity = isObject(value.toxicity) ? value.toxicity : {};
  const toxicity = Object.fromEntries(TOXICITY_SUBJECTS.map(subject => {
    const entry = isObject(rawToxicity[subject]) ? rawToxicity[subject] : {};
    const level = TOXICITY_LEVELS.includes(entry.level) ? entry.level : 'unknown';
    return [subject, { level, note: entry.note, sources: cite(entry.sources) }];
  }));
  const days = value => Number.isInteger(value) && value >= 2 && value <= 90 ? value : null;
  const actions = (Array.isArray(value.carePlan) ? value.carePlan : []).slice(0, 5).filter(isObject)
    .filter((action, index, all) => {
      const title = String(action.title || '').trim().toLowerCase();
      return title && all.findIndex(other => String(other.title || '').trim().toLowerCase() === title) === index;
    }).map(action => {
      // An interval without a usable number of days falls back to weekly rather than failing the draft.
      const interval = action.cadence === 'interval' ? days(action.intervalDays) : null;
      return {
        title: action.title, note: action.note, cadence: interval ? 'interval' : 'weekly',
        ...(interval ? { intervalDays: interval, winterIntervalDays: days(action.winterIntervalDays) } : {}),
        stars: Math.max(1, Math.min(5, Math.floor(Number(action.stars) || 1))),
        minAgeBand: safeAgeBand(action, toxicity)
      };
    });
  try {
    const draft = plantInput({ careSheet, toxicity: { ...toxicity, reviewed: false }, funFact: value.funFact, carePlan: actions });
    return { ...draft, unsourced: !urls.length };
  } catch (error) {
    throw failure(`The model draft does not fit a plant card: ${error.message}`);
  }
}

module.exports = { CARE_SCHEMA, IDENTIFY_SCHEMA, careDraft, identificationCandidates, safeAgeBand };
