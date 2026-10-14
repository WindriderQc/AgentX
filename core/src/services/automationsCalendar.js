'use strict';
const { CronExpressionParser } = require('cron-parser');
const { zonedDayBounds, defaultPlanningTimeZone, zonedDateOnly } = require('./planningDateService');

function calendarForJobs(jobs, {date, timezone = defaultPlanningTimeZone()} = {}) {
  try { new Intl.DateTimeFormat('en', {timeZone: timezone}); }
  catch {throw Object.assign(new Error('Invalid time zone.'), {status: 400});}
  date = date || zonedDateOnly(new Date(), timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error('Invalid calendar date.'), {status: 400});
  const {start, end} = zonedDayBounds(date, timezone);
  if (zonedDateOnly(start, timezone) !== date) throw Object.assign(new Error('Invalid calendar date.'), {status: 400});
  const rows = [];
  for (const job of jobs.filter(job => job.enabled && !job.archived)) {
    const schedule = job.schedule;
    const occurrences = [];
    let error = null, truncated = false;
    try {
      if (schedule.type === 'interval') {
        const interval = schedule.minutes * 60_000;
        // An absent native anchor is uncertainty, never a made-up midnight start.
        const anchor = Date.parse(job.nextRunAt) || schedule.anchorMs;
        if (!Number.isFinite(interval) || interval < 1000 || !anchor) throw new Error('Anchor unavailable');
        const first = anchor + Math.ceil((start.getTime() - anchor) / interval) * interval;
        for (let cursor = first; cursor < end.getTime(); cursor += interval) {
          if (occurrences.length >= 1000) {truncated = true; break;}
          occurrences.push(new Date(cursor).toISOString());
        }
      } else if (schedule.type === 'once') {
        const at = new Date(schedule.at);
        if (at >= start && at < end) occurrences.push(at.toISOString());
      } else {
        const cron = schedule.type === 'daily' ? `${Number(schedule.at.slice(3))} ${Number(schedule.at.slice(0, 2))} * * *` : schedule.cron;
        if (!cron || !schedule.timezone) throw new Error('Schedule time zone unavailable');
        const iterator = CronExpressionParser.parse(cron, {currentDate: new Date(start.getTime() - 1), endDate: end,
          tz: schedule.timezone});
        while (iterator.hasNext()) {
          const next = iterator.next().toDate();
          if (next >= end) break;
          if (occurrences.length >= 1000) {truncated = true; break;}
          occurrences.push(next.toISOString());
        }
      }
    } catch {error = 'SCHEDULE_UNRESOLVED';}
    if (occurrences.length || error) rows.push({jobId: job.id, occurrences, error, truncated,
      conditional: !!job.gateType, nextRunAt: job.nextRunAt || null});
  }
  return {date, timezone, start: start.toISOString(), end: end.toISOString(), rows,
    note: 'Horaires prévus. Les conditions, décalages et décisions de départ restent ceux du planificateur natif.'};
}
module.exports = {calendarForJobs};
