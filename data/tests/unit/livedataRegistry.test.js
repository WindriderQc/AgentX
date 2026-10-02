/**
 * Unit tests for the Live Data registry + store + parsers.
 * Pure unit tests — no live Mongo; collections are an in-memory mock.
 */
const registry = require('../../services/livedata/registry');
const parsers = require('../../services/livedata/parsers');
const store = require('../../services/livedata/store');

// ── in-memory collection mock ────────────────────────────────────
function matchFilter(filter = {}) {
  return (doc) => Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$in' in v) return v.$in.includes(doc[k]);
      if ('$lt' in v) return doc[k] < v.$lt;
    }
    return doc[k] === v;
  });
}

function makeCol(initial = []) {
  let docs = initial.map((d, i) => ({ _id: d._id != null ? d._id : `s${i}`, ...d }));
  let seq = 0;
  const col = {
    renamedTo: null,
    dropped: false,
    async insertMany(arr) {
      docs.push(...arr.map((d) => ({ _id: d._id != null ? d._id : `n${seq++}`, ...d })));
      return { insertedCount: arr.length };
    },
    async countDocuments(filter = {}) { return docs.filter(matchFilter(filter)).length; },
    find(filter = {}) {
      let result = docs.filter(matchFilter(filter));
      const cursor = {
        sort(spec) {
          const [k, dir] = Object.entries(spec)[0];
          result = [...result].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir);
          return cursor;
        },
        limit(n) { result = result.slice(0, n); return cursor; },
        async toArray() { return result; }
      };
      return cursor;
    },
    async deleteMany(filter = {}) {
      const before = docs.length;
      const keep = (d) => !matchFilter(filter)(d);
      docs = docs.filter(keep);
      return { deletedCount: before - docs.length };
    },
    async rename(target) { col.renamedTo = target; return true; },
    async drop() { col.dropped = true; return true; },
    _docs: () => docs
  };
  return col;
}

function makeDb(seed = {}) {
  const cols = {};
  for (const [name, arr] of Object.entries(seed)) cols[name] = makeCol(arr);
  return {
    _cols: cols,
    async createCollection(name) { return (cols[name] = cols[name] || makeCol()); },
    collection(name) { return (cols[name] = cols[name] || makeCol()); }
  };
}

// ── registry ─────────────────────────────────────────────────────
describe('registry.resolveRegistry', () => {
  test('seeds the three feeds with sane defaults', () => {
    const feeds = registry.resolveRegistry([], []);
    const ids = feeds.map(f => f.id);
    expect(ids).toEqual(expect.arrayContaining(['iss', 'quakes', 'weather']));
    const iss = feeds.find(f => f.id === 'iss');
    expect(iss.store).toMatchObject({ collection: 'isses', mode: 'append' });
    expect(iss.intervalMs).toBeGreaterThanOrEqual(60000); // ISS is no longer polled every 10s
    const quakes = feeds.find(f => f.id === 'quakes');
    expect(quakes.store.mode).toBe('replace');
  });

  test('merges enabled-state from livedataconfigs toggle docs', () => {
    const toggles = [
      { service: 'iss', enabled: true },
      { service: 'quakes', enabled: false }
    ];
    const feeds = registry.resolveRegistry([], toggles);
    expect(feeds.find(f => f.id === 'iss').enabled).toBe(true);
    expect(feeds.find(f => f.id === 'quakes').enabled).toBe(false);
    expect(feeds.find(f => f.id === 'weather').enabled).toBe(false); // no toggle → default off
  });

  test('isMasterEnabled reads the liveDataEnabled toggle', () => {
    expect(registry.isMasterEnabled([{ service: 'liveDataEnabled', enabled: true }])).toBe(true);
    expect(registry.isMasterEnabled([{ service: 'liveDataEnabled', enabled: false }])).toBe(false);
    expect(registry.isMasterEnabled([])).toBe(false);
  });
});

describe('registry.mergeOverrides', () => {
  test('overrides definition fields on a seeded feed by id', () => {
    const merged = registry.mergeOverrides(registry.getSeedFeeds(), [
      { id: 'iss', sourceUrl: 'https://example/iss', intervalMs: 120000 }
    ]);
    const iss = merged.find(f => f.id === 'iss');
    expect(iss.sourceUrl).toBe('https://example/iss');
    expect(iss.intervalMs).toBe(120000);
    expect(iss.parser).toBe('iss'); // non-overridable fields preserved
  });

  test('adds a fully-custom feed defined only in livedatafeeds', () => {
    const merged = registry.mergeOverrides(registry.getSeedFeeds(), [
      { id: 'tides', parser: 'genericJson', store: { collection: 'livedata_points', mode: 'points' } }
    ]);
    expect(merged.find(f => f.id === 'tides')).toBeTruthy();
    // an override without parser+store is ignored, not added as a broken feed
    const merged2 = registry.mergeOverrides(registry.getSeedFeeds(), [{ id: 'bogus' }]);
    expect(merged2.find(f => f.id === 'bogus')).toBeFalsy();
  });
});

// ── parsers ──────────────────────────────────────────────────────
describe('parsers.iss', () => {
  const asRes = (obj) => ({ json: async () => obj });

  test('parses wheretheiss.at top-level numeric shape', async () => {
    const out = await parsers.iss(asRes({ latitude: 1.5, longitude: -2.5, timestamp: 1700000000 }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ latitude: 1.5, longitude: -2.5 });
    expect(out[0].timeStamp).toBeInstanceOf(Date);
  });

  test('parses legacy open-notify nested shape', async () => {
    const out = await parsers.iss(asRes({ message: 'success', iss_position: { latitude: '3', longitude: '4' }, timestamp: 1700000000 }));
    expect(out[0]).toMatchObject({ latitude: 3, longitude: 4 });
  });

  test('rejects error message and non-finite coords', async () => {
    expect(await parsers.iss(asRes({ message: 'failure' }))).toEqual([]);
    expect(await parsers.iss(asRes({ latitude: 'nope', longitude: 1 }))).toEqual([]);
  });
});

describe('parsers.openWeather', () => {
  test('builds a pressure doc for the location', async () => {
    const res = { json: async () => ({ main: { pressure: 1013 } }) };
    const out = await parsers.openWeather(res, { location: { lat: 46.8, lon: -71.2 } });
    expect(out[0]).toMatchObject({ pressure: 1013, lat: 46.8, lon: -71.2 });
    expect(out[0].timeStamp).toBeInstanceOf(Date);
  });
});

// ── store ────────────────────────────────────────────────────────
describe('store.appendDocs + retention', () => {
  test('inserts then prunes the oldest beyond maxDocs', async () => {
    const feed = { id: 'iss', store: { collection: 'isses', mode: 'append', tsField: 'timeStamp', retention: { maxDocs: 2 } } };
    const db = makeDb({ isses: [
      { _id: 'a', timeStamp: new Date(1) },
      { _id: 'b', timeStamp: new Date(2) }
    ] });
    await store.write(db, feed, [{ _id: 'c', timeStamp: new Date(3) }]); // now 3, cap 2
    const remaining = db._cols.isses._docs().map(d => d._id).sort();
    expect(remaining).toEqual(['b', 'c']); // oldest 'a' pruned
  });

  test('prunes by maxAgeMs', async () => {
    const feed = { id: 'pts', store: { collection: 'c', mode: 'append', tsField: 'ts', retention: { maxAgeMs: 1000 } } };
    const old = new Date(Date.now() - 5000);
    const fresh = new Date();
    const db = makeDb({ c: [{ _id: 'old', ts: old }] });
    await store.write(db, feed, [{ _id: 'new', ts: fresh }]);
    const ids = db._cols.c._docs().map(d => d._id);
    expect(ids).toEqual(['new']); // stale row aged out
  });
});

describe('store.replaceDocs', () => {
  test('writes to a temp collection and renames over the target', async () => {
    const feed = { id: 'quakes', store: { collection: 'quakes', mode: 'replace' } };
    const db = makeDb();
    const n = await store.write(db, feed, [{ mag: 5.2 }, { mag: 1.1 }]);
    expect(n).toBe(2);
    const tempName = Object.keys(db._cols).find(k => k.startsWith('quakes_temp_'));
    expect(tempName).toBeTruthy();
    expect(db._cols[tempName].renamedTo).toBe('quakes');
  });

  test('handles an empty replacement as a valid empty refresh', async () => {
    const feed = { id: 'quakes', store: { collection: 'quakes', mode: 'replace' } };
    const db = makeDb({ quakes: [{ _id: 'old', mag: 4.4 }] });
    const n = await store.write(db, feed, []);
    expect(n).toBe(0);
    const tempName = Object.keys(db._cols).find(k => k.startsWith('quakes_temp_'));
    expect(tempName).toBeTruthy();
    expect(db._cols[tempName].renamedTo).toBe('quakes');
  });
});

describe('store.writePoints (generic livedata_points)', () => {
  test('stamps feedId/ts/payload/geo and prunes per feedId', async () => {
    const feed = { id: 'air_quality', store: { collection: 'livedata_points', mode: 'points', retention: { maxDocs: 2 } } };
    const db = makeDb();
    await store.write(db, feed, [
      { ts: new Date(1), lat: 1, lon: 2, payload: { pm2_5: 10 } },
      { ts: new Date(2), payload: { pm2_5: 11 } },
      { ts: new Date(3), payload: { pm2_5: 12 } }
    ]);
    const pts = db._cols.livedata_points._docs();
    expect(pts).toHaveLength(2); // pruned to maxDocs
    expect(pts.every(p => p.feedId === 'air_quality')).toBe(true);
    const geoPoint = db._cols.livedata_points._docs().find(p => p.geo);
    // oldest (ts=1, the geo one) was pruned, so remaining are ts 2 & 3
    expect(pts.map(p => p.payload.pm2_5).sort()).toEqual([11, 12]);
    expect(geoPoint).toBeFalsy();
  });

  test('does not let one feed prune another feed\'s points', async () => {
    const db = makeDb({ livedata_points: [
      { _id: 'x1', feedId: 'other', ts: new Date(1), payload: {} }
    ] });
    const feed = { id: 'air_quality', store: { collection: 'livedata_points', mode: 'points', retention: { maxDocs: 1 } } };
    await store.write(db, feed, [{ ts: new Date(2), payload: { v: 1 } }]);
    const ids = db._cols.livedata_points._docs().map(d => d.feedId).sort();
    expect(ids).toEqual(['air_quality', 'other']); // other feed's point untouched
  });
});
