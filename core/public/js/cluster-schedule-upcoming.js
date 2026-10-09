/**
 * Pure projection helpers for Cluster Schedule's Upcoming Tasks panel.
 *
 * Timeline APIs return one slot for every occurrence. The panel is a job
 * summary, so frequent cron/interval entries are represented by their next
 * occurrence plus an explicit count instead of consuming the entire list.
 */
(function initClusterScheduleUpcoming(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.ClusterScheduleUpcoming = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  const HOUR_MS = 60 * 60 * 1000;
  const CLOCK_SKEW_MS = 60 * 1000;

  function toMillis(value) {
    const millis = new Date(value).getTime();
    return Number.isFinite(millis) ? millis : null;
  }

  function deriveIntervalMs(entry) {
    if (entry?.scheduleType === 'interval' && Number(entry.intervalMs) > 0) {
      return Number(entry.intervalMs);
    }

    const starts = (entry?.slots || [])
      .map(candidate => toMillis(candidate?.start))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (starts.length > 1) {
      const delta = starts[1] - starts[0];
      if (delta > 0) return delta;
    }

    return null;
  }

  function isHighFrequencyRecurring(entry, intervalMs) {
    const slots = entry?.slots || [];
    const scheduleType = entry?.scheduleType || (slots.length > 1 ? 'cron' : null);
    if (scheduleType !== 'cron' && scheduleType !== 'interval') return false;
    return (Number(intervalMs) > 0 && Number(intervalMs) < HOUR_MS)
      || (entry?.dailyCount || slots.length) > 12;
  }

  // Timeline filters and Upcoming Tasks use the same light-job threshold.
  function isHighFrequencyLightJob(entry) {
    if (!entry || entry.model || entry.source === 'ollama-persistent') return false;
    if (entry.scheduleType === 'continuous' || entry.slots?.some(slot => slot.continuous)) return true;
    return isHighFrequencyRecurring(entry, entry.intervalMs || deriveIntervalMs(entry));
  }

  function formatCadenceInterval(ms) {
    if (!(Number(ms) > 0)) return '';
    const units = [[86_400_000, 'day'], [HOUR_MS, 'h'], [60_000, 'min'], [1000, 's']];
    const [unitMs, unit] = units.find(([value]) => ms >= value) || units[units.length - 1];
    return `every ${Number((ms / unitMs).toFixed(2))} ${unit}`;
  }

  function getCadenceLabel(entry, formatTime = defaultFormatTime) {
    if (entry?.scheduleType === 'continuous' || entry?.slots?.some(slot => slot.continuous)) return '24/7';
    if (entry?.scheduleType === 'interval') return formatCadenceInterval(entry.intervalMs);

    const starts = [...new Set((entry?.slots || []).map(slot => toMillis(slot.start)))]
      .filter(Number.isFinite).sort((a, b) => a - b);
    if (!starts.length) return '';
    if (starts.length === 1) return `daily ${formatTime(starts[0])}`;
    const spacing = deriveIntervalMs({ ...entry, slots: starts.map(start => ({ start })) });
    const regular = starts.length > 2 && starts.slice(1).every((start, i) => start - starts[i] === spacing);
    return regular ? formatCadenceInterval(spacing) : `${starts.length}×/day`;
  }

  // The timeline API omits intervalMs; join the existing schedule-list response.
  function withScheduleDetails(entries, schedules) {
    const byId = new Map((schedules || []).map(entry => [String(entry._id || entry.id), entry.schedule]));
    return (entries || []).map(entry => {
      const schedule = byId.get(String(entry.id));
      return { ...entry, scheduleType: schedule?.type || entry.scheduleType,
        intervalMs: schedule?.intervalMs ?? entry.intervalMs };
    });
  }

  function defaultFormatTime(value) {
    return new Date(value).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
  }

  function buildRemainingTimelineSlots(entries, now = Date.now()) {
    return (entries || []).flatMap(entry => (entry.slots || []).map(slot => ({
      entry, slot, startMs: toMillis(slot.start), endMs: toMillis(slot.end)
    }))).filter(item => item.startMs !== null && item.endMs !== null
      && item.endMs > item.startMs && item.endMs >= now)
      .sort((a, b) => a.startMs - b.startMs || String(a.entry.name).localeCompare(String(b.entry.name)));
  }

  function buildUpcomingTasks(entries, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const todaySelected = options.todaySelected !== false;
    const formatTime = options.formatTime || defaultFormatTime;
    const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0
      ? options.maxItems
      : 25;
    const occurrences = [];

    for (const entry of (entries || [])) {
      const slots = (entry?.slots || [])
        .map(slot => ({
          slot,
          startMs: toMillis(slot?.start),
          endMs: toMillis(slot?.end)
        }))
        .filter(candidate => candidate.startMs !== null && candidate.endMs !== null)
        // A finished occurrence is never upcoming, whichever day is selected.
        .filter(candidate => candidate.endMs >= now)
        .sort((a, b) => a.startMs - b.startMs);

      if (!slots.length) continue;

      const dailyCount = entry.slots?.length || slots.length;
      const intervalMs = deriveIntervalMs(entry, slots[0].slot);
      const collapseOccurrences = isHighFrequencyRecurring(entry, intervalMs);
      const visibleSlots = collapseOccurrences ? slots.slice(0, 1) : slots;

      for (const candidate of visibleSlots) {
        const { slot, startMs } = candidate;
        const occurrenceCount = collapseOccurrences ? slots.length : 1;
        occurrences.push({
          id: `${entry.id || entry.sourceId || entry.name}-${slot.start}`,
          name: entry.name,
          source: entry.source,
          taskType: entry.taskType,
          host: entry.host,
          slots: entry.slots,
          model: entry.model,
          priority: entry.priority,
          lastRun: entry.lastRun || null,
          metadata: entry.metadata || {},
          scheduleType: entry.scheduleType || (dailyCount > 1 ? 'cron' : null),
          intervalMs,
          dailyCount,
          nextRun: slot.start,
          msFromNow: Math.max(0, startMs - now),
          running: startMs <= now,
          displayMode: todaySelected ? 'countdown' : 'time',
          displayText: formatTime(slot.start),
          collapsedOccurrences: collapseOccurrences,
          occurrenceCount,
          occurrenceLabel: collapseOccurrences
            ? (todaySelected
              ? `${occurrenceCount} remaining today`
              : `${occurrenceCount} on selected day`)
            : ''
        });
      }
    }

    occurrences.sort((a, b) => {
      if (a.msFromNow !== b.msFromNow) return a.msFromNow - b.msFromNow;
      return toMillis(a.nextRun) - toMillis(b.nextRun);
    });

    return occurrences.slice(0, maxItems);
  }

  /**
   * Overdue needs execution evidence: an entry is overdue only when it records
   * a lastRun older than a projected start that is already past its grace.
   * Entries without lastRun are unknown, not overdue.
   */
  function findOverdueEntries(entries, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 10 * 60 * 1000;
    const overdue = [];
    for (const entry of (entries || [])) {
      const lastRunMs = entry?.lastRun ? toMillis(entry.lastRun) : null;
      if (lastRunMs === null) continue;
      const expectedMs = (entry.slots || [])
        .filter(slot => !slot?.continuous)
        .map(slot => toMillis(slot?.start))
        .filter(start => start !== null && start <= now - graceMs)
        .reduce((latest, start) => Math.max(latest, start), -Infinity);
      if (!Number.isFinite(expectedMs) || lastRunMs >= expectedMs - CLOCK_SKEW_MS) continue;
      overdue.push({
        id: entry.id || entry.sourceId || entry.name,
        name: entry.name,
        expectedAt: new Date(expectedMs).toISOString(),
        lastRun: new Date(lastRunMs).toISOString()
      });
    }
    return overdue;
  }

  return Object.freeze({
    buildUpcomingTasks,
    findOverdueEntries,
    deriveIntervalMs,
    isHighFrequencyRecurring,
    isHighFrequencyLightJob,
    getCadenceLabel,
    formatCadenceInterval,
    withScheduleDetails,
    buildRemainingTimelineSlots
  });
}));
