'use strict';

/**
 * Settings and run state of the coverage job, stored by the service.
 * Off until the operator switches it on.
 */

const BenchmarkConfig = require('../../../models/BenchmarkConfig');

const SETTINGS_KEY = 'coverage-settings';
const STATE_KEY = 'coverage-state';
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const DEFAULTS = Object.freeze({
  enabled: false,
  quietStart: '01:00',
  quietEnd: '06:00',
  timeZone: process.env.TZ || 'UTC',
  idleMinutes: 10,
  bitePrompts: 8
});

function settingsError(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'COVERAGE_SETTINGS_INVALID' });
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Merge a partial update over `current`, refusing anything out of range. */
function validate(input = {}, current = DEFAULTS) {
  const next = { ...current };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw settingsError('enabled must be true or false');
    next.enabled = input.enabled;
  }
  for (const key of ['quietStart', 'quietEnd']) {
    if (input[key] === undefined) continue;
    if (!TIME.test(String(input[key]))) throw settingsError(`${key} must be a time such as 01:00`);
    next[key] = String(input[key]);
  }
  if (next.quietStart === next.quietEnd) throw settingsError('quietStart and quietEnd must differ');
  if (input.timeZone !== undefined) {
    if (!validTimeZone(String(input.timeZone))) throw settingsError('timeZone must be an IANA zone such as America/Toronto');
    next.timeZone = String(input.timeZone);
  }
  for (const [key, min, max] of [['idleMinutes', 0, 240], ['bitePrompts', 1, 50]]) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw settingsError(`${key} must be a whole number from ${min} to ${max}`);
    next[key] = value;
  }
  return next;
}

async function read(key, fallback) {
  const doc = await BenchmarkConfig.findOne({ key }).lean();
  return doc?.value && typeof doc.value === 'object' ? doc.value : fallback;
}

async function write(key, value) {
  await BenchmarkConfig.findOneAndUpdate({ key }, { $set: { key, value } }, { upsert: true });
  return value;
}

async function getSettings() {
  return { ...DEFAULTS, ...(await read(SETTINGS_KEY, {})) };
}

async function saveSettings(input) {
  return write(SETTINGS_KEY, validate(input, await getSettings()));
}

/** { last: {...}, cells: { key: { failures, lastAttemptAt, lastError } } } */
async function getState() {
  const state = await read(STATE_KEY, {});
  return { last: state.last || null, cells: state.cells || {} };
}

const saveState = state => write(STATE_KEY, state);

module.exports = { DEFAULTS, validate, getSettings, saveSettings, getState, saveState };
