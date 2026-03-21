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
 * Note: day boundaries use UTC (00:00Z–23:59Z). Cron expressions are resolved
 * in the requested timezone. Late-night local tasks may fall outside the UTC day
 * window — a known limitation for v1.
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
        sourceId: entry.sourceId,
        taskType: entry.taskType,
        host: entry.host,
        model: entry.model,
        agent: entry.agent,
        priority: entry.priority,
        estimatedDurationMs: entry.estimatedDurationMs,
        vramMb: entry.vramMb,
        scheduleType: entry.schedule?.type || null,
        metadata: entry.metadata || {},
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
        msFromNow: next.getTime() - now.getTime(),
        scheduleType: entry.schedule.type,
        intervalMs: entry.schedule.intervalMs || null,
        dailyCount: estimateDailyCount(entry)
      });
    }
  }

  upcoming.sort((a, b) => a.msFromNow - b.msFromNow);
  return upcoming.slice(0, count);
}

/**
 * Estimate how many times an entry fires per day.
 * Used to classify service ticks vs meaningful scheduled jobs.
 */
function estimateDailyCount(entry) {
  if (entry.schedule?.type === 'interval' && entry.schedule.intervalMs > 0) {
    return Math.round(86400000 / entry.schedule.intervalMs);
  }
  if (entry.schedule?.type === 'cron' && entry.schedule.cron) {
    try {
      const tz = entry.schedule.timezone || 'America/Toronto';
      const now = new Date();
      const iter = CronExpressionParser.parse(entry.schedule.cron, { currentDate: now, tz });
      const t1raw = iter.next();
      const t2raw = iter.next();
      const t1 = t1raw.toDate ? t1raw.toDate().getTime() : new Date(t1raw).getTime();
      const t2 = t2raw.toDate ? t2raw.toDate().getTime() : new Date(t2raw).getTime();
      const gapMs = t2 - t1;
      return gapMs > 0 ? Math.round(86400000 / gapMs) : 1;
    } catch { return 1; }
  }
  return 1;
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

/**
 * Pivot timeline data by host — rows are hosts, each containing their tasks.
 * Includes unassigned tasks (host=null) in a separate bucket.
 */
async function getTimelineByHost(dateStr, timezone = 'America/Toronto') {
  const { getConfiguredHosts } = require('../helpers/ollamaHostConfig');
  const timeline = await getTimeline(dateStr, timezone);
  const hosts = getConfiguredHosts();

  const hostMap = {};
  for (const h of hosts) {
    hostMap[h.id] = { hostId: h.id, hostName: h.name, vramCapacityMb: h.vramMb || null, tasks: [] };
  }
  hostMap['unassigned'] = { hostId: 'unassigned', hostName: 'Unassigned', vramCapacityMb: null, tasks: [] };

  for (const entry of timeline) {
    const key = entry.host && hostMap[entry.host] ? entry.host : 'unassigned';
    hostMap[key].tasks.push(entry);
  }

  // Only return hosts that have tasks or are configured
  return Object.values(hostMap).filter(h => h.tasks.length > 0 || hosts.some(c => c.id === h.hostId));
}

/**
 * Detect scheduling conflicts: overlapping time slots on the same host.
 */
async function getConflicts(dateStr, timezone = 'America/Toronto') {
  const timeline = await getTimeline(dateStr, timezone);
  const byHost = {};

  for (const entry of timeline) {
    // Entries with no model consume no GPU — skip from conflict detection
    if (!entry.model) continue;
    const h = entry.host || 'unassigned';
    if (!byHost[h]) byHost[h] = [];
    byHost[h].push(entry);
  }

  const conflicts = [];
  for (const [hostId, entries] of Object.entries(byHost)) {
    // Flatten all slots with their parent entry info
    const allSlots = [];
    for (const entry of entries) {
      for (const slot of entry.slots) {
        if (slot.continuous) continue; // continuous tasks always overlap, skip
        allSlots.push({ start: new Date(slot.start), end: new Date(slot.end), entryId: entry.id, name: entry.name, taskType: entry.taskType });
      }
    }
    for (let i = 0; i < allSlots.length; i++) {
      for (let j = i + 1; j < allSlots.length; j++) {
        const a = allSlots[i];
        const b = allSlots[j];
        if (a.start < b.end && b.start < a.end) {
          conflicts.push({
            hostId,
            taskA: { id: a.entryId, name: a.name, taskType: a.taskType, start: a.start.toISOString(), end: a.end.toISOString() },
            taskB: { id: b.entryId, name: b.name, taskType: b.taskType, start: b.start.toISOString(), end: b.end.toISOString() }
          });
        }
      }
    }
  }

  return conflicts;
}

module.exports = { getAllEntries, getTimeline, getTimelineByHost, getConflicts, getNextTasks, syncEntries };
