'use strict';

/**
 * The two stored tiers of sensor history and the rollup between them.
 *
 *   iot_minute_buckets  one document per device, measure and minute; expires
 *                       90 days after its minute (TTL index).
 *   iot_hour_buckets    one document per device, measure and hour; never
 *                       expires. Derived from the minute buckets of a closed
 *                       hour.
 *   iot_state           the rollup's position and the backfill's state.
 *
 * An hour is rolled up once it has been closed for five minutes, which is
 * longer than the two minutes a late reading is accepted. The rollup replaces
 * the hour's documents, so running it again gives the same result; it resumes
 * from its stored position and skips straight to the next hour that has data.
 */

const { HOUR_MS, floorTo, rebucket } = require('./buckets');

const MINUTES = 'iot_minute_buckets';
const HOURS = 'iot_hour_buckets';
const STATE = 'iot_state';
const MINUTE_RETENTION_DAYS = 90;
const MINUTE_RETENTION_MS = MINUTE_RETENTION_DAYS * 86_400_000;
const ROLLUP_GRACE_MS = 5 * 60_000;
const ROLLUP_MAX_HOURS_PER_RUN = 2400; // more than the whole minute tier
// Minute buckets this close to their expiry may already be partly deleted.
const EXPIRY_MARGIN_MS = 2 * 86_400_000;
const WRITE_BATCH = 500;

const INDEX_SPECS = Object.freeze([
  // History reads one device and measure over a time range; also the upsert key.
  { collection: MINUTES, key: { device: 1, measure: 1, ts: 1 }, options: { name: 'device_measure_ts_unique', unique: true } },
  // Retention, and the rollup's read of one hour across devices.
  { collection: MINUTES, key: { ts: 1 }, options: { name: 'ttl_90d', expireAfterSeconds: MINUTE_RETENTION_MS / 1000 } },
  { collection: HOURS, key: { device: 1, measure: 1, ts: 1 }, options: { name: 'device_measure_ts_unique', unique: true } }
]);

const keyOf = (bucket) => ({ device: bucket.device, measure: bucket.measure, ts: bucket.ts });

/**
 * A minute bucket merged into what the minute already holds: a late reading,
 * or the part written at shutdown followed by the rest after a restart.
 * Counts, extremes, mean and times merge exactly; the readings of the earlier
 * part are gone, so the median kept is that of the part with more readings.
 * `parts` counts the writes a bucket was made of (1 in the normal case).
 */
function mergeUpdate(bucket) {
  const prior = { $ifNull: ['$count', 0] };
  const total = { $add: [prior, bucket.count] };
  return [{
    $set: {
      count: total,
      min: { $min: ['$min', bucket.min] },
      max: { $max: ['$max', bucket.max] },
      mean: {
        $round: [{ $divide: [{ $add: [{ $multiply: [{ $ifNull: ['$mean', 0] }, prior] }, bucket.mean * bucket.count] }, total] }, 6]
      },
      median: { $cond: [{ $gt: [prior, bucket.count] }, '$median', bucket.median] },
      first: { $min: ['$first', bucket.first] },
      last: { $max: ['$last', bucket.last] },
      parts: { $add: [{ $ifNull: ['$parts', 0] }, 1] }
    }
  }];
}

async function inBatches(collection, operations) {
  for (let index = 0; index < operations.length; index += WRITE_BATCH) {
    await collection.bulkWrite(operations.slice(index, index + WRITE_BATCH), { ordered: false });
  }
  return operations.length;
}

/** Write closed minute buckets, merging into a minute that already has a document. */
function writeMinuteBuckets(db, buckets) {
  return inBatches(db.collection(MINUTES), buckets.map((bucket) => ({
    updateOne: { filter: keyOf(bucket), update: mergeUpdate(bucket), upsert: true }
  })));
}

/** Insert minute buckets only where the minute has none (backfill): returns how many were new. */
async function insertMinuteBucketsIfAbsent(db, buckets) {
  let inserted = 0;
  for (let index = 0; index < buckets.length; index += WRITE_BATCH) {
    const result = await db.collection(MINUTES).bulkWrite(buckets.slice(index, index + WRITE_BATCH).map((bucket) => {
      const { device, measure, ts, ...fields } = bucket;
      return { updateOne: { filter: { device, measure, ts }, update: { $setOnInsert: { ...fields, parts: 1 } }, upsert: true } };
    }), { ordered: false });
    inserted += result.upsertedCount || 0;
  }
  return inserted;
}

/** Hour buckets computed from the minute buckets stored for the hour starting at `hourMs`. */
async function deriveHour(db, hourMs) {
  const minutes = await db.collection(MINUTES)
    .find({ ts: { $gte: new Date(hourMs), $lt: new Date(hourMs + HOUR_MS) } })
    .project({ _id: 0, device: 1, measure: 1, ts: 1, count: 1, min: 1, max: 1, mean: 1, median: 1, first: 1, last: 1 })
    .toArray();
  return rebucket(minutes, HOUR_MS).map(({ buckets, ...hour }) => ({ ...hour, minutes: buckets }));
}

async function rollupState(db) {
  return db.collection(STATE).findOne({ _id: 'rollup' });
}

/**
 * Roll up every closed hour from the stored position. Returns
 * `{ hours, buckets, through, more }`; `more` says the per-run bound was hit.
 */
async function runRollup(db, now = new Date(), { maxHours = ROLLUP_MAX_HOURS_PER_RUN } = {}) {
  const nowMs = now.getTime();
  const closedBefore = floorTo(nowMs - ROLLUP_GRACE_MS, HOUR_MS);
  const state = await rollupState(db);
  let cursor = state?.through instanceof Date ? state.through.getTime() : 0;
  let hours = 0;
  let written = 0;
  let more = false;

  while (cursor < closedBefore) {
    if (hours >= maxHours) { more = true; break; }
    const next = await db.collection(MINUTES)
      .find({ ts: { $gte: new Date(cursor), $lt: new Date(closedBefore) } })
      .project({ ts: 1 }).sort({ ts: 1 }).limit(1).next();
    if (!next) { cursor = closedBefore; break; }
    const hourMs = floorTo(next.ts.getTime(), HOUR_MS);
    const derived = await deriveHour(db, hourMs);
    // An hour about to leave the minute tier may have lost minutes to the TTL
    // already: it never replaces an hour bucket, and is marked partial when new.
    const expiring = hourMs < nowMs - (MINUTE_RETENTION_MS - EXPIRY_MARGIN_MS);
    written += await inBatches(db.collection(HOURS), derived.map((hour) => {
      const { device, measure, ts, ...fields } = hour;
      return {
        updateOne: {
          filter: { device, measure, ts },
          update: expiring ? { $setOnInsert: { ...fields, partial: true } } : { $set: fields, $unset: { partial: '' } },
          upsert: true
        }
      };
    }));
    hours += 1;
    cursor = hourMs + HOUR_MS;
  }

  const through = new Date(cursor);
  await db.collection(STATE).updateOne(
    { _id: 'rollup' },
    { $set: { through, lastRunAt: now, lastHours: hours, lastBuckets: written, more } },
    { upsert: true }
  );
  return { hours, buckets: written, through, more };
}

/** Make the rollup redo everything from `date` on (minute buckets were added in the past). */
async function rewindRollup(db, date) {
  await db.collection(STATE).updateOne({ _id: 'rollup', through: { $gt: date } }, { $set: { through: date } });
}

module.exports = {
  MINUTES, HOURS, STATE, INDEX_SPECS,
  MINUTE_RETENTION_DAYS, MINUTE_RETENTION_MS, ROLLUP_GRACE_MS, ROLLUP_MAX_HOURS_PER_RUN, EXPIRY_MARGIN_MS,
  writeMinuteBuckets, insertMinuteBucketsIfAbsent, deriveHour, runRollup, rollupState, rewindRollup
};
