/**
 * janitorScheduler.js — per-profile interval timers.
 *
 * init(db)         — arm a setInterval for each enabled profile.
 * reload(db, id)   — re-read one profile and (re)arm or clear its timer.
 *                    Called from CRUD endpoints; idempotent.
 * close()          — clear all timers (called from server shutdown).
 *
 * No timer is ever armed unless background jobs are enabled
 * (utils/backgroundJobs): init and reload then only clear. Stale runs are
 * swept by server startup, which does not depend on that setting.
 */
const janitorProfiles = require('./janitorProfiles');
const janitorRunner = require('./janitorRunner');
const { log } = require('../utils/logger');
const { backgroundJobsEnabled } = require('../utils/backgroundJobs');

const { MIN_INTERVAL_MINUTES } = janitorProfiles;

// profileId → NodeJS.Timeout
const timers = new Map();

const MIN_INTERVAL_MS = MIN_INTERVAL_MINUTES * 60 * 1000;

function _hasValidSchedule(profile) {
  return !!(
    profile &&
    profile.schedule &&
    profile.schedule.enabled === true &&
    typeof profile.schedule.intervalMinutes === 'number' &&
    profile.schedule.intervalMinutes >= MIN_INTERVAL_MINUTES
  );
}

function _clearTimer(key) {
  const t = timers.get(key);
  if (t) {
    clearInterval(t);
    timers.delete(key);
  }
}

function _armTimer(db, profile) {
  const key = String(profile._id);
  // Clear first: reload() may race if two CRUD calls yield concurrently;
  // _armTimer always wins because the last write to the Map wins.
  _clearTimer(key);
  // Single gate for every caller: a profile saved while background jobs are
  // off keeps its schedule in the database and starts with the next enabled start.
  if (!backgroundJobsEnabled()) {
    log(`[janitorScheduler] Background jobs disabled — profile "${profile.name}" schedule not armed`);
    return;
  }
  const intervalMs = Math.max(MIN_INTERVAL_MS, profile.schedule.intervalMinutes * 60 * 1000);
  const handle = setInterval(() => {
    janitorRunner.runProfile(db, key)
      .catch(err => log(`[janitorScheduler] runProfile ${profile.name} failed: ${err.message}`, 'warn'));
  }, intervalMs);
  // Don't keep the event loop alive just for this timer
  if (typeof handle.unref === 'function') handle.unref();
  timers.set(key, handle);
  log(`[janitorScheduler] Armed profile "${profile.name}" every ${profile.schedule.intervalMinutes}m`);
}

async function init(db) {
  if (!backgroundJobsEnabled()) {
    log('[janitorScheduler] Background jobs disabled — no profile timer armed');
    return;
  }

  let profiles;
  try {
    profiles = await janitorProfiles.list(db);
  } catch (err) {
    log(`[janitorScheduler] list profiles failed: ${err.message}`, 'error');
    return;
  }

  for (const profile of profiles) {
    try {
      if (_hasValidSchedule(profile)) _armTimer(db, profile);
    } catch (err) {
      log(`[janitorScheduler] arm ${profile?.name} failed: ${err.message}`, 'warn');
    }
  }
  log(`[janitorScheduler] Initialized — ${timers.size} active profile timer(s)`);
}

async function reload(db, profileId) {
  const key = String(profileId);
  let profile;
  try {
    profile = await janitorProfiles.get(db, profileId);
  } catch (err) {
    log(`[janitorScheduler] reload get(${key}) failed: ${err.message}`, 'warn');
    _clearTimer(key);
    return;
  }
  if (!profile || !_hasValidSchedule(profile)) {
    _clearTimer(key);
    return;
  }
  _armTimer(db, profile);
}

async function close() {
  for (const key of [...timers.keys()]) _clearTimer(key);
}

function _activeProfileIds() {
  return [...timers.keys()];
}

module.exports = { init, reload, close, _activeProfileIds };
