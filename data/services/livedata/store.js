/**
 * Live Data store layer — uniform write + retention across feeds.
 *
 *   - append:  insert docs into a typed collection, then prune by retention.
 *   - replace: atomic temp-collection rename swap (USGS quakes pattern).
 *   - points:  generic `livedata_points` time-series for the long tail,
 *              scoped/pruned per feedId.
 *   - latest:  one `livedata_points` document per topic, replaced in place
 *              at most once a minute: the current value, no history.
 *
 * Generalizes the original ISS bulk-prune + quakes atomic swap.
 */

async function write(db, feed, docs) {
  switch (feed.store && feed.store.mode) {
    case 'append': return appendDocs(db, feed, docs);
    case 'replace': return replaceDocs(db, feed, docs);
    case 'points': return writePoints(db, feed, docs);
    case 'latest': return writeLatest(db, feed, docs);
    default: throw new Error(`Unknown store mode: ${feed.store && feed.store.mode}`);
  }
}

async function appendDocs(db, feed, docs) {
  if (!docs || docs.length === 0) return 0;
  const col = db.collection(feed.store.collection);
  await col.insertMany(docs);
  await pruneCollection(db, feed);
  return docs.length;
}

// Prune a typed collection by retention { maxDocs } and/or { maxAgeMs }.
async function pruneCollection(db, feed) {
  const r = feed.store.retention;
  if (!r) return;
  const col = db.collection(feed.store.collection);
  const tsField = feed.store.tsField || 'timeStamp';
  await pruneBy(col, {}, tsField, r);
}

// Shared prune — used by typed collections and (feed-scoped) livedata_points.
// maxAgeMs deletes anything older than now-maxAgeMs; maxDocs batch-deletes the
// oldest rows beyond the cap (the original ISS bulk-prune, generalized).
async function pruneBy(col, filter, tsField, r) {
  if (r.maxAgeMs) {
    const cutoff = new Date(Date.now() - r.maxAgeMs);
    await col.deleteMany({ ...filter, [tsField]: { $lt: cutoff } });
  }
  if (r.maxDocs) {
    const count = await col.countDocuments(filter);
    if (count > r.maxDocs) {
      const excess = count - r.maxDocs;
      const oldest = await col.find(filter, { projection: { _id: 1 } })
        .sort({ [tsField]: 1 }).limit(excess).toArray();
      if (oldest.length > 0) {
        await col.deleteMany({ _id: { $in: oldest.map(d => d._id) } });
      }
    }
  }
}

// Atomic refresh: write to a temp collection, then rename over the target
// (replaces the target's data instantly). Cleans up the temp on failure.
async function replaceDocs(db, feed, docs) {
  const target = feed.store.collection;
  const tempName = `${target}_temp_${Date.now()}`;
  const tempCol = db.collection(tempName);
  try {
    if (!docs || docs.length === 0) {
      if (typeof db.createCollection === 'function') {
        await db.createCollection(tempName);
        await tempCol.rename(target, { dropTarget: true });
      } else {
        await db.collection(target).deleteMany({});
      }
      return 0;
    }

    await tempCol.insertMany(docs, { ordered: false });
    await tempCol.rename(target, { dropTarget: true });
  } catch (e) {
    try { await tempCol.drop(); } catch { /* may not exist */ }
    throw e;
  }
  return docs ? docs.length : 0;
}

// Generic time-series writer — long-tail feeds land in `livedata_points` as
// { feedId, ts, payload, geo? }. A doc may arrive already-shaped ({ payload,
// geo }) or raw (the whole doc becomes the payload; lat/lon lift to geo).
// Retention is scoped to this feedId so feeds can't prune each other.
async function writePoints(db, feed, docs) {
  if (!docs || docs.length === 0) return 0;
  const col = db.collection('livedata_points');
  const now = new Date();
  const stamped = docs.map(d => {
    const point = { feedId: feed.id, ts: d.ts || d.timeStamp || now, payload: d.payload !== undefined ? d.payload : d };
    const geo = d.geo || (Number.isFinite(d.lat) && Number.isFinite(d.lon) ? { lat: d.lat, lon: d.lon } : null);
    if (geo) point.geo = geo;
    return point;
  });
  await col.insertMany(stamped);
  const r = feed.store.retention;
  if (r) await pruneBy(col, { feedId: feed.id }, 'ts', r);
  return stamped.length;
}

// Latest-only writer for push-in feeds that speak every few seconds: one
// document per topic ({ feedId, latest: true, key, ts, payload, geo? }),
// replaced at most once per LATEST_MIN_INTERVAL_MS, for at most
// LATEST_MAX_KEYS topics. Messages in between are not written at all.
const LATEST_MIN_INTERVAL_MS = 60_000;
const LATEST_MAX_KEYS = 500;
const LATEST_MAX_KEY_BYTES = 256;
const latestWrites = new Map(); // "feedId\nkey" -> time of the last write

async function writeLatest(db, feed, docs) {
  if (!docs || docs.length === 0) return 0;
  const col = db.collection('livedata_points');
  let written = 0;
  for (const d of docs) {
    const payload = d.payload !== undefined ? d.payload : d;
    const key = typeof payload?.topic === 'string' ? payload.topic : '';
    if (!key || Buffer.byteLength(key, 'utf8') > LATEST_MAX_KEY_BYTES) continue;
    const slot = `${feed.id}\n${key}`;
    const nowMs = Date.now();
    const last = latestWrites.get(slot);
    if (last === undefined ? latestWrites.size >= LATEST_MAX_KEYS : nowMs - last < LATEST_MIN_INTERVAL_MS) continue;
    latestWrites.set(slot, nowMs); // before the write: two messages of one topic never upsert together
    const point = { feedId: feed.id, latest: true, key, ts: d.ts || d.timeStamp || new Date(nowMs), payload };
    const geo = d.geo || (Number.isFinite(d.lat) && Number.isFinite(d.lon) ? { lat: d.lat, lon: d.lon } : null);
    await col.updateOne(
      { feedId: feed.id, latest: true, key },
      geo ? { $set: { ...point, geo } } : { $set: point, $unset: { geo: '' } },
      { upsert: true }
    );
    written += 1;
  }
  const r = feed.store.retention;
  if (written && r) await pruneBy(col, { feedId: feed.id, latest: true }, 'ts', r);
  return written;
}

module.exports = {
  write, appendDocs, replaceDocs, writePoints, writeLatest, pruneCollection, pruneBy,
  LATEST_MIN_INTERVAL_MS, LATEST_MAX_KEYS,
  _resetLatestWrites: () => latestWrites.clear()
};
