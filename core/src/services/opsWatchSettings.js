'use strict';

/**
 * Operations watch settings: what the Nerve Center saved, else the environment.
 * The environment only bootstraps; a saved setting wins and applies at once.
 */

const { watchIntervalMs } = require('./opsWatchService');

const KEY = 'ops-watch';
const MIN_MINUTES = 5;
const MAX_MINUTES = 24 * 60;
const DEFAULT_MINUTES = 15;
const LANGUAGE_PATTERN = /^[\p{L}][\p{L} -]{1,29}$/u;

function settingsError(message) {
  return Object.assign(new Error(message), { status: 400, code: 'OPS_WATCH_SETTINGS_INVALID' });
}

function fromEnvironment(env = process.env) {
  const intervalMs = watchIntervalMs(env);
  return {
    enabled: intervalMs > 0,
    intervalMs: intervalMs || DEFAULT_MINUTES * 60000,
    language: String(env.OPS_WATCH_LANGUAGE || '').trim() || 'English',
    source: 'environment'
  };
}

async function effective({ Model = require('../../models/OpsWatchSettings'), env = process.env } = {}) {
  const stored = await Model.findOne({ key: KEY }).lean();
  if (!stored) return fromEnvironment(env);
  return { enabled: stored.enabled === true, intervalMs: stored.intervalMs, language: stored.language, source: 'saved' };
}

function validate(input = {}) {
  if (typeof input.enabled !== 'boolean') throw settingsError('enabled must be true or false');
  const minutes = Number(input.intervalMinutes);
  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    throw settingsError(`intervalMinutes must be a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}`);
  }
  const language = String(input.language || '').trim();
  if (!LANGUAGE_PATTERN.test(language)) throw settingsError('language must be a language name, letters only, at most 30 characters');
  return { enabled: input.enabled, intervalMs: minutes * 60000, language };
}

async function save(input, { Model = require('../../models/OpsWatchSettings') } = {}) {
  const settings = validate(input);
  await Model.findOneAndUpdate({ key: KEY }, { $set: { key: KEY, ...settings } },
    { upsert: true, runValidators: true, setDefaultsOnInsert: true });
  return { ...settings, source: 'saved' };
}

module.exports = { effective, save, validate, fromEnvironment, MIN_MINUTES, MAX_MINUTES };
