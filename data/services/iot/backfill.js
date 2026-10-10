'use strict';

/**
 * One-off conversion of the raw points the `sensors` live feed used to store
 * (one `livedata_points` document per MQTT message) into minute buckets.
 *
 * It works one hour of raw points at a time, oldest first: build the hour's
 * minute buckets, insert those that do not exist yet, then delete the hour's
 * raw points. Interrupted anywhere, the next start resumes with whatever raw
 * points are left: a bucket already inserted is never overwritten, so a
 * half-deleted hour cannot replace a complete bucket with a smaller one. Once
 * no raw point is left the state is `done` and it never runs again.
 *
 * Raw points that are not a numeric `sensors/<device>/<measure>` reading
 * (availability texts, JSON payloads) are counted as skipped and deleted too.
 */

const { HOUR_MS, MINUTE_MS, floorTo, summarize } = require('./buckets');
const { parseTopic } = require('./topics');
const store = require('./bucketStore');

const STATE_ID = 'backfill_livedata_sensors';
const POINTS = 'livedata_points';
// The live feed's own latest-only documents carry `latest: true` and stay.
const RAW_FILTER = Object.freeze({ feedId: 'sensors', latest: { $ne: true } });
const MAX_WINDOWS_PER_RUN = 5000;

function getState(db) {
  return db.collection(store.STATE).findOne({ _id: STATE_ID });
}

async function convertWindow(db, windowMs, registry) {
  const range = { ...RAW_FILTER, ts: { $gte: new Date(windowMs), $lt: new Date(windowMs + HOUR_MS) } };
  const groups = new Map();
  let points = 0;
  let skipped = 0;
  const cursor = db.collection(POINTS).find(range).project({ ts: 1, 'payload.topic': 1, 'payload.value': 1 });
  for await (const doc of cursor) {
    const parsed = parseTopic(doc.payload?.topic);
    const value = doc.payload?.value;
    if (parsed.kind !== 'reading' || typeof value !== 'number' || !Number.isFinite(value)) { skipped += 1; continue; }
    const at = doc.ts.getTime();
    const key = `${parsed.device}\n${parsed.measure}\n${floorTo(at, MINUTE_MS)}`;
    let group = groups.get(key);
    if (!group) { group = { device: parsed.device, measure: parsed.measure, ts: floorTo(at, MINUTE_MS), readings: [] }; groups.set(key, group); }
    group.readings.push({ at, value });
    points += 1;
  }
  const buckets = [...groups.values()].map((group) => ({
    device: group.device, measure: group.measure, ts: new Date(group.ts), ...summarize(group.readings)
  }));
  const inserted = await store.insertMinuteBucketsIfAbsent(db, buckets);
  if (registry) for (const bucket of buckets) registry.historical(bucket.device, bucket.measure, bucket.first, bucket.last);
  if (buckets.length) await store.rewindRollup(db, new Date(windowMs));
  const removed = (await db.collection(POINTS).deleteMany(range)).deletedCount || 0;
  return { points, skipped, buckets: inserted, removed };
}

/**
 * Run or resume the backfill. `shouldStop` is polled between hours. Returns
 * the state document: `state` is `done`, or `running` when it was stopped or
 * hit its per-run bound and will resume at the next start.
 */
async function run(db, { registry = null, now = () => new Date(), shouldStop = () => false, maxWindows = MAX_WINDOWS_PER_RUN } = {}) {
  const states = db.collection(store.STATE);
  const previous = await getState(db);
  if (previous?.state === 'done') return previous;
  const totals = {
    points: previous?.points || 0, skipped: previous?.skipped || 0,
    buckets: previous?.buckets || 0, removed: previous?.removed || 0, windows: previous?.windows || 0
  };
  const startedAt = previous?.startedAt || now();
  const save = (state, extra = {}) => states.findOneAndUpdate(
    { _id: STATE_ID },
    { $set: { state, startedAt, updatedAt: now(), ...totals, ...extra } },
    { upsert: true, returnDocument: 'after' }
  ).then((result) => (result && Object.prototype.hasOwnProperty.call(result, 'value') && !('state' in result) ? result.value : result));

  for (let windows = 0; windows < maxWindows; windows++) {
    if (shouldStop()) return save('running');
    const oldest = await db.collection(POINTS).find(RAW_FILTER).project({ ts: 1 }).sort({ ts: 1 }).limit(1).next();
    if (!oldest) return save('done', { finishedAt: now() });
    if (!(oldest.ts instanceof Date) || !Number.isFinite(oldest.ts.getTime())) {
      // A point without a usable time cannot be placed in a minute.
      await db.collection(POINTS).deleteOne({ _id: oldest._id });
      totals.skipped += 1;
      totals.removed += 1;
      continue;
    }
    const result = await convertWindow(db, floorTo(oldest.ts.getTime(), HOUR_MS), registry);
    totals.points += result.points;
    totals.skipped += result.skipped;
    totals.buckets += result.buckets;
    totals.removed += result.removed;
    totals.windows += 1;
    await save('running');
  }
  return save('running');
}

module.exports = { STATE_ID, RAW_FILTER, MAX_WINDOWS_PER_RUN, getState, run };
