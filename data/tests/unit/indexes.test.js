// Verifies the `network_devices.mac_unique` partial-index migration in
// utils/indexes.js. The bug: a non-sparse unique index on `mac` rejected a 2nd
// MAC-less device (`mac: ''`) with E11000, dropping the whole agent-ingest batch.
// The fix makes the index partial (uniqueness only on non-empty MACs) and migrates
// any legacy non-partial index by dropping + rebuilding it.
jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const { ensureIndexes } = require('../../utils/indexes');

const PARTIAL_FILTER = { mac: { $type: 'string', $gt: '' } };

// A fake db whose network_devices.indexes() reflects the given legacy state, and
// which records every createIndex / dropIndex call across all collections.
function fakeDb({ macIndexState = 'none', indexesThrows = false } = {}) {
  const createIndexCalls = [];
  const dropIndexCalls = [];
  const collections = {};

  const networkDevicesIndexes = () => {
    if (indexesThrows) {
      const err = new Error('ns does not exist: agentx.network_devices');
      err.codeName = 'NamespaceNotFound';
      throw err;
    }
    const base = [{ name: '_id_', key: { _id: 1 } }];
    if (macIndexState === 'legacy') {
      base.push({ name: 'mac_unique', key: { mac: 1 }, unique: true });
    } else if (macIndexState === 'partial') {
      base.push({ name: 'mac_unique', key: { mac: 1 }, unique: true, partialFilterExpression: PARTIAL_FILTER });
    }
    // 'none' → collection exists but has no mac_unique yet (fresh build).
    return base;
  };

  const makeColl = (name) => ({
    createIndex: jest.fn(async (key, options) => { createIndexCalls.push({ collection: name, key, options }); return options?.name; }),
    dropIndex: jest.fn(async (idxName) => { dropIndexCalls.push({ collection: name, idxName }); }),
    indexes: jest.fn(async () => (name === 'network_devices' ? networkDevicesIndexes() : [{ name: '_id_', key: { _id: 1 } }]))
  });

  return {
    collection: jest.fn((name) => { if (!collections[name]) collections[name] = makeColl(name); return collections[name]; }),
    _createIndexCalls: createIndexCalls,
    _dropIndexCalls: dropIndexCalls,
    _coll: (name) => collections[name]
  };
}

function macUniqueCreate(db) {
  return db._createIndexCalls.find((c) => c.collection === 'network_devices' && c.options?.name === 'mac_unique');
}

describe('ensureIndexes — mac_unique partial migration', () => {
  test('rebuilds mac_unique as a partial unique index for all states', async () => {
    const db = fakeDb({ macIndexState: 'none' });
    await ensureIndexes(db);

    const created = macUniqueCreate(db);
    expect(created).toBeDefined();
    expect(created.key).toEqual({ mac: 1 });
    expect(created.options.unique).toBe(true);
    expect(created.options.partialFilterExpression).toEqual(PARTIAL_FILTER);
  });

  test('drops a legacy NON-partial mac_unique before recreating it', async () => {
    const db = fakeDb({ macIndexState: 'legacy' });
    await ensureIndexes(db);

    // Legacy index dropped...
    expect(db._dropIndexCalls).toContainEqual({ collection: 'network_devices', idxName: 'mac_unique' });
    // ...then rebuilt as partial.
    expect(macUniqueCreate(db).options.partialFilterExpression).toEqual(PARTIAL_FILTER);
  });

  test('does NOT drop when mac_unique is already partial (idempotent)', async () => {
    const db = fakeDb({ macIndexState: 'partial' });
    await ensureIndexes(db);

    expect(db._dropIndexCalls).toHaveLength(0);
    // createIndex is still issued (Mongo treats an identical spec as a no-op).
    expect(macUniqueCreate(db).options.partialFilterExpression).toEqual(PARTIAL_FILTER);
  });

  test('does NOT drop when the collection does not exist yet (indexes() throws)', async () => {
    const db = fakeDb({ indexesThrows: true });
    await expect(ensureIndexes(db)).resolves.toBeUndefined();

    expect(db._dropIndexCalls).toHaveLength(0);
    // Still creates the partial index fresh.
    expect(macUniqueCreate(db).options.partialFilterExpression).toEqual(PARTIAL_FILTER);
  });

  test('does not recreate the retired pending-deletion queue', async () => {
    const db = fakeDb({ macIndexState: 'partial' });
    await ensureIndexes(db);

    expect(db._createIndexCalls.some(call => call.collection === 'nas_pending_deletions')).toBe(false);
  });

  test('indexes chunked Janitor report details by report and order', async () => {
    const db = fakeDb({ macIndexState: 'partial' });
    await ensureIndexes(db);

    expect(db._createIndexCalls).toContainEqual({
      collection: 'janitor_strategy_report_details',
      key: { reportId: 1, ordinal: 1 },
      options: { name: 'report_ordinal' }
    });
  });
});
