'use strict';

// Household plants (#866): the rules of a plant card, independent of storage.
// A card is a draft until the parent publishes it; only published cards reach
// the children, through a projection without sources, candidates or review state.

const { AGE_BANDS, FamilyInputError, familyChoreProposal } = require('./family');

const PLANT_STATUSES = Object.freeze(['draft', 'published', 'retired']);
const CARE_FIELDS = Object.freeze(['light', 'water', 'humidity', 'soil', 'repotting', 'fertilizer', 'mistakes']);
// What a child sees as "Mes besoins".
const CHILD_NEEDS = Object.freeze(['light', 'water', 'humidity']);
const TOXICITY_SUBJECTS = Object.freeze(['children', 'cats', 'dogs']);
const TOXICITY_LEVELS = Object.freeze(['unknown', 'none', 'mild', 'toxic']);
const IDENTIFICATION_SOURCES = Object.freeze(['parent', 'model']);
const LIMITS = Object.freeze({ photos: 4, actions: 8, candidates: 3, sources: 5 });

const fail = (message, code = 'PLANT_INPUT_INVALID') => new FamilyInputError(message, code);
const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function onlyKeys(value, allowed, field) {
  if (!isObject(value)) throw fail(`${field} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw fail(`${field} has unknown fields: ${unknown.join(', ')}`);
  return value;
}

function sources(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.sources) throw fail(`${field} takes at most ${LIMITS.sources} sources`);
  return value.map(entry => {
    const url = text(entry, 300);
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) throw fail(`${field} sources must be http(s) URLs`);
    return parsed.href;
  });
}

function confidence(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw fail('confidence must be between 0 and 1');
  return Math.round(number * 1000) / 1000;
}

function species(value = {}, field) {
  onlyKeys(value, ['commonName', 'latinName', 'confidence', 'traits'], field);
  const commonName = text(value.commonName, 80);
  if (!commonName) throw fail(`${field} needs a common name`);
  return { commonName, latinName: text(value.latinName, 120) || null, confidence: confidence(value.confidence),
    traits: text(value.traits, 200) || null };
}

function identificationInput(value) {
  if (value === null) return null;
  onlyKeys(value, ['commonName', 'latinName', 'confidence', 'source', 'model', 'candidates'], 'identification');
  const chosen = species({ commonName: value.commonName, latinName: value.latinName, confidence: value.confidence }, 'identification');
  const candidates = value.candidates ?? [];
  if (!Array.isArray(candidates) || candidates.length > LIMITS.candidates) {
    throw fail(`identification takes at most ${LIMITS.candidates} candidates`);
  }
  return {
    commonName: chosen.commonName, latinName: chosen.latinName, confidence: chosen.confidence,
    source: IDENTIFICATION_SOURCES.includes(value.source) ? value.source : 'parent',
    model: text(value.model, 80) || null,
    candidates: candidates.map((candidate, index) => species(candidate, `identification candidate ${index + 1}`))
  };
}

function careSheetInput(value) {
  onlyKeys(value, CARE_FIELDS, 'careSheet');
  return Object.fromEntries(CARE_FIELDS.filter(key => value[key] !== undefined && value[key] !== null).map(key => {
    const entry = onlyKeys(value[key], ['text', 'sources'], `careSheet.${key}`);
    return [key, { text: text(entry.text, 500), sources: sources(entry.sources, `careSheet.${key}`) }];
  }).filter(([, entry]) => entry.text));
}

function toxicityInput(value) {
  onlyKeys(value, [...TOXICITY_SUBJECTS, 'reviewed'], 'toxicity');
  const result = {};
  for (const subject of TOXICITY_SUBJECTS) {
    const entry = value[subject] === undefined ? {} : onlyKeys(value[subject], ['level', 'note', 'sources'], `toxicity.${subject}`);
    const level = entry.level ?? 'unknown';
    if (!TOXICITY_LEVELS.includes(level)) throw fail(`toxicity.${subject} level must be ${TOXICITY_LEVELS.join(', ')}`);
    result[subject] = { level, note: text(entry.note, 300) || null, sources: sources(entry.sources, `toxicity.${subject}`) };
  }
  // A parent confirms the whole block; any edit that does not confirm it again clears the confirmation.
  result.reviewed = value.reviewed === true;
  return result;
}

function slug(value) {
  return text(value, 80).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function carePlanInput(value) {
  if (!Array.isArray(value) || value.length > LIMITS.actions) throw fail(`carePlan takes at most ${LIMITS.actions} actions`);
  const keys = new Set();
  return value.map((action, index) => {
    onlyKeys(action, ['key', 'title', 'note', 'cadence', 'intervalDays', 'winterIntervalDays', 'stars', 'minAgeBand', 'profileId'],
      `carePlan action ${index + 1}`);
    const chore = familyChoreProposal(action);
    const key = slug(action.key || chore.title) || `action-${index + 1}`;
    if (keys.has(key)) throw fail(`carePlan action keys must be unique (${key})`);
    keys.add(key);
    const minAgeBand = action.minAgeBand ?? 'school';
    if (!AGE_BANDS.includes(minAgeBand)) throw fail(`minAgeBand must be ${AGE_BANDS.join(', ')}`);
    return { key, title: chore.title, note: chore.note, cadence: chore.cadence, intervalDays: chore.intervalDays,
      winterIntervalDays: chore.winterIntervalDays, stars: chore.stars, minAgeBand, profileId: chore.profileId };
  });
}

const FIELD_RULES = Object.freeze({
  nickname: value => {
    const nickname = text(value, 60);
    if (!nickname) throw fail('nickname is required', 'PLANT_NICKNAME_REQUIRED');
    return nickname;
  },
  room: value => text(value, 60) || null,
  spot: value => text(value, 120) || null,
  identification: identificationInput,
  careSheet: careSheetInput,
  toxicity: toxicityInput,
  funFact: value => text(value, 300) || null,
  carePlan: carePlanInput
});
const PLANT_FIELDS = Object.freeze(Object.keys(FIELD_RULES));

/** The validated fields a parent or a drafting step may set. */
function plantInput(input = {}, { create = false } = {}) {
  onlyKeys(input, PLANT_FIELDS, 'plant');
  if (create && input.nickname === undefined) throw fail('nickname is required', 'PLANT_NICKNAME_REQUIRED');
  return Object.fromEntries(PLANT_FIELDS.filter(key => input[key] !== undefined).map(key => [key, FIELD_RULES[key](input[key])]));
}

/** Why a card cannot reach the children yet; empty when it can. */
function publishProblems(plant = {}) {
  const problems = [];
  if (!plant.identification?.commonName) problems.push('species');
  const toxicity = plant.toxicity || {};
  if (TOXICITY_SUBJECTS.some(subject => !toxicity[subject] || toxicity[subject].level === 'unknown')) problems.push('toxicity');
  else if (toxicity.reviewed !== true) problems.push('toxicity_review');
  if (!Array.isArray(plant.carePlan) || !plant.carePlan.length) problems.push('care_plan');
  return problems;
}

const photoUrl = (plant, photo) => `/api/family/plants/${encodeURIComponent(String(plant._id || plant.id))}/photos/${encodeURIComponent(String(photo._id || photo.id))}`;
const photoView = plant => (plant.photos || []).map(photo => ({ id: String(photo._id || photo.id), mimeType: photo.mimeType,
  size: photo.size, url: photoUrl(plant, photo) }));

const step = entry => entry?.state ? { state: entry.state, error: entry.error || null, model: entry.model || null,
  startedAt: entry.startedAt || null, finishedAt: entry.finishedAt || null } : null;
function assistantView(assistant = {}) {
  const identify = step(assistant?.identify), care = step(assistant?.care);
  return {
    identify: identify && { ...identify, candidates: assistant.identify.candidates || [] },
    care: care && { ...care, unsourced: assistant.care.unsourced === true, draft: assistant.care.draft || null }
  };
}

/** The parent's view: everything, including sources, candidates and review state. */
function managedPlant(plant = {}, chores = null) {
  return {
    id: String(plant._id || plant.id),
    nickname: plant.nickname,
    room: plant.room || null,
    spot: plant.spot || null,
    status: PLANT_STATUSES.includes(plant.status) ? plant.status : 'draft',
    identification: plant.identification || null,
    careSheet: plant.careSheet || {},
    toxicity: plant.toxicity || null,
    funFact: plant.funFact || null,
    carePlan: plant.carePlan || [],
    photos: photoView(plant),
    assistant: assistantView(plant.assistant),
    problems: publishProblems(plant),
    ...(chores ? { mood: plantMood(chores), care: careView(chores) } : {}),
    revision: Number.isInteger(plant.__v) ? plant.__v : 0,
    publishedAt: plant.publishedAt || null,
    createdAt: plant.createdAt || null,
    updatedAt: plant.updatedAt || null
  };
}

const LEVEL_RANK = Object.freeze({ unknown: 0, none: 1, mild: 2, toxic: 3 });
const WATERING = /arros|water|eau\b|abreuv/i;

/**
 * How the plant feels, from its open chores (#869): thirsty when a watering
 * chore is due, needs_care when another care chore is due, waiting while a
 * check-in waits for a parent, happy otherwise.
 */
function plantMood(chores = []) {
  const due = chore => chore.status !== 'review' && (chore.overdue || chore.dueToday);
  const watering = chore => WATERING.test(`${chore.title} ${chore.sourceKey || ''}`);
  if (chores.some(chore => due(chore) && watering(chore))) return 'thirsty';
  if (chores.some(due)) return 'needs_care';
  if (chores.some(chore => chore.status === 'review')) return 'waiting';
  return 'happy';
}

// The care chores a card shows: what to do, for whom, and when.
const careView = chores => chores.map(chore => ({ ref: chore.id, title: chore.title, profileId: chore.profileId,
  stars: chore.stars, dueDay: chore.dueDay, dueToday: chore.dueToday, overdue: chore.overdue, waiting: chore.status === 'review' }));

/** What a child sees on a published card: no sources, candidates or review state. */
function childPlant(plant = {}, chores = []) {
  const toxicity = plant.toxicity || {};
  const level = subject => toxicity[subject]?.level || 'unknown';
  const pets = LEVEL_RANK[level('cats')] >= LEVEL_RANK[level('dogs')] ? level('cats') : level('dogs');
  return {
    id: String(plant._id || plant.id),
    nickname: plant.nickname,
    room: plant.room || null,
    spot: plant.spot || null,
    commonName: plant.identification?.commonName || null,
    latinName: plant.identification?.latinName || null,
    needs: Object.fromEntries(CHILD_NEEDS.filter(key => plant.careSheet?.[key]?.text).map(key => [key, plant.careSheet[key].text])),
    toxicity: { children: level('children'), pets },
    doNotEat: ['mild', 'toxic'].includes(level('children')) || ['mild', 'toxic'].includes(pets),
    funFact: plant.funFact || null,
    mood: plantMood(chores),
    care: careView(chores),
    photos: photoView(plant).map(({ id, url }) => ({ id, url }))
  };
}

module.exports = {
  CARE_FIELDS,
  CHILD_NEEDS,
  LIMITS,
  PLANT_FIELDS,
  PLANT_STATUSES,
  TOXICITY_LEVELS,
  TOXICITY_SUBJECTS,
  childPlant,
  managedPlant,
  plantInput,
  plantMood,
  publishProblems
};
