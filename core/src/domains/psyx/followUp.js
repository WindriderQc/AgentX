'use strict';

// Closing the loop: experiments carry a check-in date and an outcome, and the
// user can record short 0-10 check-ins of how heavy things feel.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHECK_IN_DAYS = 3;
const EXPERIMENT_OUTCOMES = Object.freeze(['worked', 'partly', 'did_not_work', 'not_done']);
const CHECK_IN_PHASES = Object.freeze(['start', 'during']);
const CHECK_IN_LIMIT = 200;

const clean = (value, max) => String(value || '').trim().slice(0, max);

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function checkInAtFrom(days, now = Date.now()) {
  const value = days === null || days === undefined || days === '' ? NaN : Number(days);
  const bounded = Number.isFinite(value) ? Math.max(1, Math.min(30, Math.round(value))) : DEFAULT_CHECK_IN_DAYS;
  return new Date(now + bounded * DAY_MS).toISOString();
}

function isDue(experiment, now = Date.now()) {
  return ['planned', 'active'].includes(experiment?.status)
    && Boolean(experiment.checkInAt) && new Date(experiment.checkInAt).getTime() <= now;
}

// What recording an outcome changes on the experiment. "Not done" reopens it
// and asks again in a few days; any other outcome completes it.
function outcomeChanges(outcome, now = Date.now()) {
  if (!EXPERIMENT_OUTCOMES.includes(outcome)) {
    const error = new Error('Invalid experiment outcome');
    error.statusCode = 400;
    throw error;
  }
  return outcome === 'not_done'
    ? { outcome, status: 'active', checkInAt: checkInAtFrom(DEFAULT_CHECK_IN_DAYS, now) }
    : { outcome, status: 'completed' };
}

function normalizeCheckIn(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Only a real number or digit string: Number(null), Number('') and Number(true) would pass as 0 or 1.
  const score = typeof raw.score === 'number' || /^\d{1,2}$/.test(String(raw.score)) ? Number(raw.score) : NaN;
  const at = dateOrNull(raw.at);
  const id = clean(raw.id, 80);
  if (!id || !Number.isInteger(score) || score < 0 || score > 10 || !at) return null;
  return {
    id,
    score,
    phase: CHECK_IN_PHASES.includes(raw.phase) ? raw.phase : 'during',
    at
  };
}

function normalizeCheckIns(value) {
  return (Array.isArray(value) ? value : []).map(normalizeCheckIn).filter(Boolean).slice(-CHECK_IN_LIMIT);
}

module.exports = {
  DAY_MS,
  DEFAULT_CHECK_IN_DAYS,
  EXPERIMENT_OUTCOMES,
  CHECK_IN_PHASES,
  CHECK_IN_LIMIT,
  dateOrNull,
  checkInAtFrom,
  isDue,
  outcomeChanges,
  normalizeCheckIn,
  normalizeCheckIns
};
