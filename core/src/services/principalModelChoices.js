'use strict';

// The two models the principal switch offers. The operator names them in the
// Nerve Center and the product ships no model name. An existing install keeps
// what it ran: the first read stores it once, and deployment env is not read
// for these choices afterwards.
const PrincipalModelChoices = require('../../models/PrincipalModelChoices');
const RouterTaskConfig = require('../../models/RouterTaskConfig');

const PRINCIPAL_OPTIONS = Object.freeze([
  { value: 'standard', label: 'Standard' },
  { value: 'abliterated', label: 'Abliterated' }
]);
const KEY = 'principal';
// The deployment env an install used for these two choices before #901.
const LEGACY_ENV = Object.freeze({
  standard: ['AGENTX_DAILY_OPERATOR_MODEL', 'AGENTX_DAILY_MODEL', 'AGENTX_DEFAULT_CHAT_MODEL', 'AGENTX_CHAT_MODEL', 'OLLAMA_MODEL']
});

function cleanModel(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= 512 ? text : null;
}

function envFirst(env, keys) {
  for (const key of keys) {
    const value = cleanModel(env[key]);
    if (value) return value;
  }
  return null;
}

function publicChoices(doc) {
  return {
    standard: doc?.standard || null,
    abliterated: doc?.abliterated || null,
    revision: doc?.revision || 0,
    source: doc?.source || null,
    updatedAt: doc?.updatedAt || null,
    updatedBy: doc?.updatedBy || null
  };
}

/**
 * What an install ran before the choices were stored: Standard from its env,
 * and a principal pin the switch moved off Standard (the switch writes the
 * daily_operator route with it), which can only have been Abliterated.
 */
async function legacyChoices({ env = process.env, pinnedModel = null } = {}) {
  const standard = envFirst(env, LEGACY_ENV.standard);
  let abliterated = null;
  const pin = cleanModel(pinnedModel);
  if (!abliterated && standard && pin && pin !== standard) {
    const route = await RouterTaskConfig.findOne({ taskType: 'daily_operator' }).lean();
    if (route?.model === pin) abliterated = pin;
  }
  return { standard, abliterated: abliterated === standard ? null : abliterated };
}

/** The stored choices; the first read seeds them once from the legacy install. */
async function getChoices(context = {}) {
  const existing = await PrincipalModelChoices.findOne({ key: KEY }).lean();
  if (existing) return publicChoices(existing);
  const seed = await legacyChoices(context);
  const doc = await PrincipalModelChoices.findOneAndUpdate(
    { key: KEY },
    { $setOnInsert: { key: KEY, ...seed, revision: 0, source: 'migrated', updatedBy: null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return publicChoices(doc);
}

function refusal(message, code, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

/** Validate one change against the current choices. */
function validateChoice(choices, { option, model } = {}) {
  if (!PRINCIPAL_OPTIONS.some(entry => entry.value === option)) {
    throw refusal('Choose Standard or Abliterated', 'PRINCIPAL_MODEL_INVALID', 400);
  }
  const name = cleanModel(model);
  if (!name) throw refusal('Name a model', 'PRINCIPAL_MODEL_INVALID', 400);
  const other = PRINCIPAL_OPTIONS.find(entry => entry.value !== option).value;
  if (choices[other] === name) {
    throw refusal(`${name} is already the ${other === 'standard' ? 'Standard' : 'Abliterated'} model`, 'PRINCIPAL_CHOICES_DUPLICATE');
  }
  return name;
}

/** Store one choice if the revision the operator saw is still current. */
async function saveChoice({ option, model, expectedRevision, principal = null } = {}) {
  const current = await getChoices();
  const name = validateChoice(current, { option, model });
  if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) {
    throw refusal('The choices changed; reload and retry', 'PRINCIPAL_CHOICES_CHANGED');
  }
  const doc = await PrincipalModelChoices.findOneAndUpdate(
    { key: KEY, revision: expectedRevision },
    { $set: { [option]: name, source: 'operator', updatedBy: principal ? String(principal).slice(0, 200) : null },
      $inc: { revision: 1 } },
    { new: true }
  ).lean();
  if (!doc) throw refusal('The choices changed; reload and retry', 'PRINCIPAL_CHOICES_CHANGED');
  return publicChoices(doc);
}

/** The Abliterated model, or a typed refusal naming where to set it. */
async function requireAbliteratedModel() {
  const { abliterated } = await getChoices();
  if (!abliterated) {
    throw refusal('Choose the Abliterated model in the Nerve Center first.', 'PRINCIPAL_ABLITERATED_UNSET', 503);
  }
  return abliterated;
}

module.exports = {
  PRINCIPAL_OPTIONS, getChoices, saveChoice, validateChoice, requireAbliteratedModel, legacyChoices
};
