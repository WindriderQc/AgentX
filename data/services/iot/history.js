'use strict';

/**
 * History of a device's measures, as buckets of one size.
 *
 * Bucket sizes below an hour are computed from the minute tier (90 days), an
 * hour and above from the hour tier (unlimited). The hours the rollup has not
 * written yet (normally the current hour and the one before) are derived on
 * the fly from minute buckets, and an hour still open is marked `partial`.
 * `auto` picks the smallest size that keeps a measure under 1,500 points.
 */

const { MINUTE_MS, HOUR_MS, floorTo, median, round, rebucket } = require('./buckets');
const store = require('./bucketStore');

const RESOLUTIONS = Object.freeze({
  minute: { ms: MINUTE_MS, source: 'minute' },
  '5min': { ms: 5 * MINUTE_MS, source: 'minute' },
  '30min': { ms: 30 * MINUTE_MS, source: 'minute' },
  hour: { ms: HOUR_MS, source: 'hour' },
  '2hour': { ms: 2 * HOUR_MS, source: 'hour' },
  day: { ms: 24 * HOUR_MS, source: 'hour' }
});
const AUTO_TARGET_POINTS = 1500;
const MAX_POINTS = 5000;
const MAX_MEASURES = 12;
const DEFAULT_SPAN_MS = 24 * HOUR_MS;
// Hours older than this that the rollup has not written yet are not derived on the fly.
const TAIL_MAX_MS = 48 * HOUR_MS;

function refuse(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function parseTime(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw refuse(`${name} must be an ISO 8601 date or epoch milliseconds`);
  const date = /^\d{10,15}$/.test(value.trim()) ? new Date(Number(value)) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw refuse(`${name} must be an ISO 8601 date or epoch milliseconds`);
  return date.getTime();
}

const pointsFor = (fromMs, toMs, size) => Math.ceil((toMs - floorTo(fromMs, size)) / size);

/** The smallest bucket size giving at most 1,500 points, among those whose tier still holds `from`. */
function chooseResolution(fromMs, toMs, nowMs) {
  const minuteTierHolds = fromMs >= nowMs - store.MINUTE_RETENTION_MS;
  let last = null;
  for (const [name, { ms, source }] of Object.entries(RESOLUTIONS)) {
    if (source === 'minute' && !minuteTierHolds) continue;
    last = name;
    if (pointsFor(fromMs, toMs, ms) <= AUTO_TARGET_POINTS) return name;
  }
  return last;
}

/** Validate the query of a history read against the device's known measures. */
function parseQuery(query, knownMeasures, now = new Date()) {
  const nowMs = now.getTime();
  for (const name of ['measure', 'from', 'to', 'resolution']) {
    if (query[name] !== undefined && typeof query[name] !== 'string') throw refuse(`${name} must be given once`);
  }
  let measures = knownMeasures;
  if (query.measure !== undefined && query.measure !== '') {
    measures = [...new Set(query.measure.split(',').map((name) => name.trim()).filter(Boolean))];
    const unknown = measures.filter((name) => !knownMeasures.includes(name));
    if (unknown.length) throw refuse(`Unknown measure for this device: ${unknown.slice(0, 5).map((name) => name.slice(0, 48)).join(', ')}`);
  }
  if (measures.length > MAX_MEASURES) throw refuse(`At most ${MAX_MEASURES} measures per call: name them with measure=a,b`);

  const toMs = query.to !== undefined && query.to !== '' ? parseTime(query.to, 'to') : nowMs;
  const fromMs = query.from !== undefined && query.from !== '' ? parseTime(query.from, 'from') : toMs - DEFAULT_SPAN_MS;
  if (fromMs >= toMs) throw refuse('from must be before to');

  const asked = query.resolution === undefined || query.resolution === '' ? 'auto' : query.resolution;
  if (asked !== 'auto' && !Object.prototype.hasOwnProperty.call(RESOLUTIONS, asked)) {
    throw refuse(`resolution must be one of: auto, ${Object.keys(RESOLUTIONS).join(', ')}`);
  }
  const bucket = asked === 'auto' ? chooseResolution(fromMs, toMs, nowMs) : asked;
  const size = RESOLUTIONS[bucket].ms;
  if (pointsFor(fromMs, toMs, size) > MAX_POINTS) {
    throw refuse(`This range holds more than ${MAX_POINTS} buckets of that size: use resolution=auto or a shorter range`);
  }
  // The first bucket is whole: the range starts on a bucket boundary.
  return { measures, fromMs: floorTo(fromMs, size), toMs, resolution: asked, bucket, size, source: RESOLUTIONS[bucket].source };
}

/** Stored buckets of one tier grouped in MongoDB into spans of `size`, medians kept as lists. */
async function grouped(db, collection, device, measures, fromMs, toMs, size) {
  if (fromMs >= toMs) return [];
  const ts = { $toLong: '$ts' };
  return db.collection(collection).aggregate([
    { $match: { device, measure: { $in: measures }, ts: { $gte: new Date(fromMs), $lt: new Date(toMs) } } },
    {
      $group: {
        _id: { measure: '$measure', ts: { $subtract: [ts, { $mod: [ts, size] }] } },
        count: { $sum: '$count' }, min: { $min: '$min' }, max: { $max: '$max' },
        weighted: { $sum: { $multiply: ['$mean', '$count'] } }, medians: { $push: '$median' },
        first: { $min: '$first' }, last: { $max: '$last' }, buckets: { $sum: 1 }, partial: { $max: '$partial' }
      }
    }
  ]).toArray();
}

function addGroup(groups, measure, tsMs, part) {
  const key = `${measure}\n${tsMs}`;
  const group = groups.get(key);
  if (!group) { groups.set(key, { measure, ts: tsMs, ...part }); return; }
  group.count += part.count;
  group.min = Math.min(group.min, part.min);
  group.max = Math.max(group.max, part.max);
  group.weighted += part.weighted;
  group.medians = group.medians.concat(part.medians);
  if (part.first < group.first) group.first = part.first;
  if (part.last > group.last) group.last = part.last;
  group.buckets += part.buckets;
  group.partial = group.partial || part.partial;
}

/** Buckets for an hour-tier size: stored hours, then the hours not rolled up yet from minutes. */
async function hourGroups(db, device, params, nowMs) {
  const { measures, fromMs, toMs, size } = params;
  const state = await store.rollupState(db);
  const through = state?.through instanceof Date ? state.through.getTime() : 0;
  const tailFrom = Math.max(fromMs, through, floorTo(nowMs - TAIL_MAX_MS, HOUR_MS));
  const groups = new Map();
  for (const row of await grouped(db, store.HOURS, device, measures, fromMs, Math.min(toMs, tailFrom), size)) {
    addGroup(groups, row._id.measure, Number(row._id.ts), { ...row, partial: row.partial === true });
  }
  if (tailFrom < toMs) {
    const minutes = await db.collection(store.MINUTES)
      .find({ device, measure: { $in: measures }, ts: { $gte: new Date(tailFrom), $lt: new Date(toMs) } })
      .project({ _id: 0 }).toArray();
    for (const hour of rebucket(minutes, HOUR_MS)) {
      const hourMs = hour.ts.getTime();
      addGroup(groups, hour.measure, floorTo(hourMs, size), {
        count: hour.count, min: hour.min, max: hour.max, weighted: hour.mean * hour.count, medians: [hour.median],
        first: hour.first, last: hour.last, buckets: 1, partial: hourMs + HOUR_MS > nowMs
      });
    }
  }
  return [...groups.values()];
}

async function minuteGroups(db, device, params) {
  const rows = await grouped(db, store.MINUTES, device, params.measures, params.fromMs, params.toMs, params.size);
  return rows.map((row) => ({ ...row, measure: row._id.measure, ts: Number(row._id.ts), partial: false }));
}

function toPoint(group) {
  const point = {
    ts: new Date(group.ts).toISOString(),
    count: group.count, min: group.min, max: group.max,
    mean: round(group.weighted / group.count), median: median(group.medians),
    first: new Date(group.first).toISOString(), last: new Date(group.last).toISOString(),
    buckets: group.buckets
  };
  if (group.partial) point.partial = true;
  return point;
}

/**
 * Read history. `device` is a registry entry; `params` comes from parseQuery.
 * Every asked measure is present in the answer, with an empty list when it has
 * no bucket in the range.
 */
async function read(db, device, params, now = new Date()) {
  const groups = params.source === 'minute'
    ? await minuteGroups(db, device.id, params)
    : await hourGroups(db, device.id, params, now.getTime());
  groups.sort((a, b) => a.ts - b.ts);
  const measures = {};
  for (const key of params.measures) {
    const known = device.measures.get(key);
    measures[key] = { name: known?.name ?? null, unit: known?.unit ?? null, points: [] };
  }
  for (const group of groups) measures[group.measure]?.points.push(toPoint(group));
  return {
    device: device.id,
    from: new Date(params.fromMs).toISOString(),
    to: new Date(params.toMs).toISOString(),
    resolution: params.resolution,
    bucket: params.bucket,
    bucketSeconds: params.size / 1000,
    source: params.source,
    measures
  };
}

module.exports = {
  RESOLUTIONS, AUTO_TARGET_POINTS, MAX_POINTS, MAX_MEASURES, DEFAULT_SPAN_MS, TAIL_MAX_MS,
  chooseResolution, parseQuery, read
};
