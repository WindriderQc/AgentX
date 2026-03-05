/**
 * Cluster Schedule Service
 *
 * Manages scheduled task entries across the cluster.
 * Resolves cron expressions to timelines and upcoming occurrences.
 */
const { CronExpressionParser } = require('cron-parser');
const logger = require('../../config/logger');
const ClusterScheduleEntry = require('../../models/ClusterScheduleEntry');

/**
 * Get all schedule entries with optional filters.
 * @param {Object} filters - { host, taskType, source, enabled }
 * @returns {Promise<Array>}
 */
async function getAllEntries(filters = {}) {
  const query = {};
  if (filters.host) query.host = filters.host;
  if (filters.taskType) query.taskType = filters.taskType;
  if (filters.source) query.source = filters.source;
  if (filters.enabled !== undefined) query.enabled = filters.enabled;
  return ClusterScheduleEntry.find(query).sort({ priority: 1, name: 1 }).lean();
}

/**
 * Resolve all enabled entries into time slots for a given date.
 * @param {string} dateStr - ISO date string (YYYY-MM-DD)
 * @param {string} timezone - IANA timezone
 * @returns {Promise<Array>} - Array of { entry, slots: [{ start, end }] }
 */
async function getTimeline(dateStr, timezone = 'America/Toronto') {
  const entries = await ClusterScheduleEntry.find({ enabled: true }).lean();
  const dayStart = new Date(`${dateStr}T00:00:00Z`);
  const dayEnd = new Date(`${dateStr}T23:59:59Z`);
  const timeline = [];

  for (const entry of entries) {
    const slots = resolveSlots(entry, dayStart, dayEnd, timezone);
    if (slots.length > 0) {
      timeline.push({
        id: entry._id,
        name: entry.name,
        source: entry.source,
        taskType: entry.taskType,
        host: entry.host,
        model: entry.model,
        priority: entry.priority,
        slots
      });
    }
  }

  return timeline;
}

/**
 * Resolve time slots for a single entry within a day range.
 */
function resolveSlots(entry, dayStart, dayEnd, timezone) {
  const schedType = entry.schedule?.type;

  if (schedType === 'continuous') {
    return [{ start: dayStart.toISOString(), end: dayEnd.toISOString(), continuous: true }];
  }

  if (schedType === 'interval') {
    const intervalMs = entry.schedule.intervalMs;
    if (!intervalMs || intervalMs < 60000) {
      return [{ start: dayStart.toISOString(), end: dayEnd.toISOString(), continuous: true }];
    }
    const slots = [];
    let cursor = new Date(dayStart);
    while (cursor < dayEnd) {
      const end = new Date(cursor.getTime() + (entry.estimatedDurationMs || intervalMs));
      slots.push({
        start: cursor.toISOString(),
        end: (end > dayEnd ? dayEnd : end).toISOString()
      });
      cursor = new Date(cursor.getTime() + intervalMs);
    }
    return slots;
  }

  if (schedType === 'cron' && entry.schedule.cron) {
    try {
      const options = {
        currentDate: dayStart,
        endDate: dayEnd,
        tz: timezone || entry.schedule.timezone || 'America/Toronto'
      };
      const interval = CronExpressionParser.parse(entry.schedule.cron, options);
      const slots = [];
      while (true) {
        try {
          const next = interval.next();
          const start = next.toDate ? next.toDate() : new Date(next);
          const durationMs = entry.estimatedDurationMs || 300000; // default 5 min
          const end = new Date(start.getTime() + durationMs);
          slots.push({
            start: start.toISOString(),
            end: (end > dayEnd ? dayEnd : end).toISOString()
          });
        } catch {
          break; // iteration complete
        }
      }
      return slots;
    } catch (err) {
      logger.warn('Failed to parse cron expression', {
        name: entry.name,
        cron: entry.schedule.cron,
        error: err.message
      });
      return [];
    }
  }

  return [];
}

/**
 * Get the next N upcoming tasks across all enabled cron entries.
 * @param {number} count - Max results
 * @returns {Promise<Array>}
 */
async function getNextTasks(count = 5) {
  const entries = await ClusterScheduleEntry.find({
    enabled: true,
    'schedule.type': { $in: ['cron', 'interval'] }
  }).lean();

  const now = new Date();
  const upcoming = [];

  for (const entry of entries) {
    const next = getNextOccurrence(entry, now);
    if (next) {
      upcoming.push({
        id: entry._id,
        name: entry.name,
        source: entry.source,
        taskType: entry.taskType,
        host: entry.host,
        model: entry.model,
        priority: entry.priority,
        nextRun: next.toISOString(),
        msFromNow: next.getTime() - now.getTime()
      });
    }
  }

  upcoming.sort((a, b) => a.msFromNow - b.msFromNow);
  return upcoming.slice(0, count);
}

/**
 * Get next occurrence for a single entry.
 */
function getNextOccurrence(entry, now) {
  if (entry.schedule?.type === 'cron' && entry.schedule.cron) {
    try {
      const interval = CronExpressionParser.parse(entry.schedule.cron, {
        currentDate: now,
        tz: entry.schedule.timezone || 'America/Toronto'
      });
      const next = interval.next();
      return next.toDate ? next.toDate() : new Date(next);
    } catch {
      return null;
    }
  }

  if (entry.schedule?.type === 'interval' && entry.schedule.intervalMs) {
    const lastRun = entry.lastRun ? new Date(entry.lastRun) : now;
    const next = new Date(lastRun.getTime() + entry.schedule.intervalMs);
    return next > now ? next : new Date(now.getTime() + entry.schedule.intervalMs);
  }

  return null;
}

/**
 * Upsert entries by source+sourceId. Idempotent.
 * @param {Array} entries - Array of entry objects
 * @returns {Promise<{ created: number, updated: number, unchanged: number }>}
 */
async function syncEntries(entries) {
  const stats = { created: 0, updated: 0, unchanged: 0 };

  for (const entry of entries) {
    if (!entry.source || !entry.sourceId) {
      logger.warn('Skipping entry missing source/sourceId', { name: entry.name });
      continue;
    }

    const existing = await ClusterScheduleEntry.findOne({
      source: entry.source,
      sourceId: entry.sourceId
    });

    if (!existing) {
      await ClusterScheduleEntry.create(entry);
      stats.created++;
    } else {
      const changed = hasChanges(existing, entry);
      if (changed) {
        await ClusterScheduleEntry.updateOne(
          { source: entry.source, sourceId: entry.sourceId },
          { $set: entry }
        );
        stats.updated++;
      } else {
        stats.unchanged++;
      }
    }
  }

  logger.info('Cluster schedule sync complete', stats);
  return stats;
}

/**
 * Check if an entry has meaningful changes compared to existing.
 */
function hasChanges(existing, incoming) {
  const fields = ['name', 'taskType', 'host', 'model', 'agent', 'estimatedDurationMs', 'vramMb', 'priority', 'enabled'];
  for (const f of fields) {
    if (incoming[f] === undefined) continue;
    const a = existing[f] == null ? null : existing[f];
    const b = incoming[f] == null ? null : incoming[f];
    if (String(a) !== String(b)) return true;
  }
  if (incoming.schedule) {
    const es = existing.schedule || {};
    if ((incoming.schedule.cron || null) !== (es.cron || null)) return true;
    if ((incoming.schedule.intervalMs || null) !== (es.intervalMs || null)) return true;
    if (incoming.schedule.type !== es.type) return true;
  }
  return false;
}

module.exports = { getAllEntries, getTimeline, getNextTasks, syncEntries };
