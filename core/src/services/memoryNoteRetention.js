'use strict';

const MemoryNote = require('../../models/MemoryNote');
const logger = require('../../config/logger');

// Forgetting a note and letting it expire hide it immediately (every read
// filters status and expiresAt). This sweep removes the stored text once the
// grace period has passed, so "forget" eventually means gone.
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = DAY_MS;
const FIRST_DELAY_MS = 10 * 60 * 1000;

function retentionDays(env = process.env) {
  const raw = env.MEMORY_NOTE_RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const value = Number(raw);
  // 0 (or an invalid value) disables the sweep: hidden notes are then kept.
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function retentionFilter(now, days) {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  return { $or: [
    { status: 'forgotten', forgottenAt: { $lt: cutoff } },
    // Notes forgotten before forgottenAt existed fall back to their last update.
    { status: 'forgotten', forgottenAt: null, updatedAt: { $lt: cutoff } },
    { expiresAt: { $ne: null, $lt: cutoff } }
  ] };
}

async function sweepMemoryNotes({ now = new Date(), days = retentionDays(), dryRun = false } = {}) {
  if (!days) return { enabled: false, matched: 0, deleted: 0 };
  const filter = retentionFilter(now, days);
  if (dryRun) return { enabled: true, dryRun: true, days, matched: await MemoryNote.countDocuments(filter), deleted: 0 };
  const result = await MemoryNote.deleteMany(filter);
  return { enabled: true, days, matched: result.deletedCount, deleted: result.deletedCount };
}

function createMemoryNoteRetention({ sweep = sweepMemoryNotes, intervalMs = SWEEP_INTERVAL_MS } = {}) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return null;
    running = true;
    try {
      const result = await sweep();
      if (result.deleted) logger.info('[MemoryNoteRetention] removed hidden notes past retention', result);
      return result;
    } catch (err) {
      logger.warn('[MemoryNoteRetention] sweep failed (non-fatal)', { error: err.message });
      return null;
    } finally {
      running = false;
    }
  }

  function start({ firstDelayMs = FIRST_DELAY_MS } = {}) {
    if (timer) return false;
    timer = setTimeout(() => {
      tick();
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    }, firstDelayMs);
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (timer) { clearTimeout(timer); clearInterval(timer); }
    timer = null;
  }

  return { tick, start, stop };
}

module.exports = { DEFAULT_RETENTION_DAYS, retentionDays, retentionFilter, sweepMemoryNotes, createMemoryNoteRetention };
