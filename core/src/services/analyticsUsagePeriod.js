'use strict';

const Period = require('../../models/AnalyticsUsagePeriod');
const DAY = 86400000;
const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const project = row => row ? { since: new Date(row.since).toISOString() } : null;

async function readUsagePeriod() {
  return project(await Period.findById('daily-use').lean());
}

async function startUsagePeriod(since, actor, now = Date.now()) {
  if (typeof since !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(since)
    || !Number.isFinite(Date.parse(since)) || Date.parse(since) > now) {
    throw invalid('since must be an ISO timestamp with a timezone, no later than now');
  }
  const date = new Date(since);
  try {
    await Period.updateOne({ _id: 'daily-use' }, { $setOnInsert: { since: date, createdBy: actor } },
      { upsert: true, runValidators: true, writeConcern: { w: 1, j: true } });
  } catch (error) { if (error.code !== 11000) throw error; }
  const saved = await readUsagePeriod();
  if (saved?.since !== date.toISOString()) throw invalid('The daily-use boundary is already set; history has not been reset', 409);
  return saved;
}

async function usageWindow(now = new Date()) {
  const period = await readUsagePeriod();
  if (!period) throw invalid('The daily-use reporting period has not been started', 409);
  const since = new Date(period.since);
  if (since > now) throw invalid('The daily-use boundary is later than the current clock', 409);
  const retention = Number.parseInt(process.env.INFERENCE_LOG_TTL_DAYS || '30', 10);
  const retainedDays = Number.isFinite(retention) && retention > 0 ? Math.min(retention, 90) : 30;
  const from = new Date(Math.max(+since, +now - retainedDays * DAY));
  return { key: 'usage', from, to: now, since, requestedDays: (+now - +since) / DAY,
    bucketKey: +now - +from <= DAY ? '24h' : '30d' };
}

module.exports = { readUsagePeriod, startUsagePeriod, usageWindow };
