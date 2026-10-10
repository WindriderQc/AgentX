'use strict';

/**
 * Bucket arithmetic for the IoT store. Pure functions: no clock, no database.
 *
 * A bucket summarises the readings of one measure of one device over a span:
 * `count`, `min`, `max`, `mean`, `median`, and the times of its `first` and
 * `last` reading. `median` is the central value: a stray glitch does not move
 * it, while `min` and `max` keep every real peak visible.
 *
 * Buckets combine into larger ones (minutes into an hour, hours into a day):
 * `count` adds up, `min`/`max` are the true extremes, `mean` is weighted by
 * `count`, and `median` is the median of the combined buckets' medians, since
 * the readings themselves are no longer there.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
// A device publishing ten times a second still fits; beyond that the median
// is taken on the first readings of the minute while the rest stays exact.
const MAX_VALUES_PER_BUCKET = 600;
// How long after its minute a reading is still accepted (see README).
const LATE_ACCEPT_MS = 2 * MINUTE_MS;
const FUTURE_ACCEPT_MS = 5_000;
// A minute is written this long after it ends.
const CLOSE_GRACE_MS = 5_000;

const round = (value) => Math.round(value * 1e6) / 1e6;
const floorTo = (ms, size) => ms - (((ms % size) + size) % size);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** One bucket from raw readings `[{ at: ms, value }]`, in any order. Null when empty. */
function summarize(readings) {
  if (!readings.length) return null;
  let min = Infinity; let max = -Infinity; let sum = 0; let first = Infinity; let last = -Infinity;
  for (const { at, value } of readings) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    if (at < first) first = at;
    if (at > last) last = at;
  }
  return {
    count: readings.length, min, max,
    mean: round(sum / readings.length),
    median: median(readings.map((reading) => reading.value)),
    first: new Date(first), last: new Date(last)
  };
}

/** One bucket from smaller buckets (see the header for each field). Null when empty. */
function combine(buckets) {
  if (!buckets.length) return null;
  let count = 0; let min = Infinity; let max = -Infinity; let weighted = 0;
  let first = Infinity; let last = -Infinity;
  for (const bucket of buckets) {
    count += bucket.count;
    if (bucket.min < min) min = bucket.min;
    if (bucket.max > max) max = bucket.max;
    weighted += bucket.mean * bucket.count;
    const start = new Date(bucket.first).getTime();
    const end = new Date(bucket.last).getTime();
    if (start < first) first = start;
    if (end > last) last = end;
  }
  return {
    count, min, max,
    mean: round(weighted / count),
    median: median(buckets.map((bucket) => bucket.median)),
    first: new Date(first), last: new Date(last)
  };
}

/** Group `buckets` (each with device, measure, ts) into spans of `sizeMs` aligned on UTC. */
function rebucket(buckets, sizeMs) {
  const groups = new Map();
  for (const bucket of buckets) {
    const ts = floorTo(new Date(bucket.ts).getTime(), sizeMs);
    const key = `${bucket.device}\n${bucket.measure}\n${ts}`;
    let group = groups.get(key);
    if (!group) { group = { device: bucket.device, measure: bucket.measure, ts, parts: [] }; groups.set(key, group); }
    group.parts.push(bucket);
  }
  return [...groups.values()].map((group) => ({
    device: group.device, measure: group.measure, ts: new Date(group.ts),
    ...combine(group.parts), buckets: group.parts.length
  }));
}

/**
 * Readings held in memory until their minute closes. Out-of-order readings
 * inside an open minute are fine. A reading older than `lateMs`, or further
 * ahead than a few seconds, is refused: `add` says which.
 */
function createMinuteAggregator({ maxValues = MAX_VALUES_PER_BUCKET, lateMs = LATE_ACCEPT_MS } = {}) {
  const open = new Map(); // "device\nmeasure\nminute" -> state

  function add(device, measure, value, atMs, nowMs = atMs) {
    if (atMs < nowMs - lateMs) return 'late';
    if (atMs > nowMs + FUTURE_ACCEPT_MS) return 'future';
    const minute = floorTo(atMs, MINUTE_MS);
    const key = `${device}\n${measure}\n${minute}`;
    let state = open.get(key);
    if (!state) {
      state = { device, measure, minute, count: 0, sum: 0, min: Infinity, max: -Infinity, first: Infinity, last: -Infinity, values: [] };
      open.set(key, state);
    }
    state.count += 1;
    state.sum += value;
    if (value < state.min) state.min = value;
    if (value > state.max) state.max = value;
    if (atMs < state.first) state.first = atMs;
    if (atMs > state.last) state.last = atMs;
    if (state.values.length < maxValues) state.values.push(value);
    return 'ok';
  }

  function toBucket(state) {
    return {
      device: state.device, measure: state.measure, ts: new Date(state.minute),
      count: state.count, min: state.min, max: state.max,
      mean: round(state.sum / state.count), median: median(state.values),
      first: new Date(state.first), last: new Date(state.last)
    };
  }

  /** Remove and return the buckets of every minute that ended `graceMs` ago or more. */
  function takeClosed(nowMs, graceMs = CLOSE_GRACE_MS) {
    const closed = [];
    for (const [key, state] of open) {
      if (state.minute + MINUTE_MS + graceMs > nowMs) continue;
      open.delete(key);
      closed.push(toBucket(state));
    }
    return closed;
  }

  /** Remove and return every bucket, open minute included (shutdown). */
  function takeAll() {
    const all = [...open.values()].map(toBucket);
    open.clear();
    return all;
  }

  return { add, takeClosed, takeAll, size: () => open.size };
}

module.exports = {
  MINUTE_MS,
  HOUR_MS,
  MAX_VALUES_PER_BUCKET,
  LATE_ACCEPT_MS,
  FUTURE_ACCEPT_MS,
  CLOSE_GRACE_MS,
  round,
  floorTo,
  median,
  summarize,
  combine,
  rebucket,
  createMinuteAggregator
};
