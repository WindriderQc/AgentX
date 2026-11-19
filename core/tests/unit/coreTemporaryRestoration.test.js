'use strict';

const mongoose = require('mongoose');
const { BSON } = mongoose.mongo;
const { createHash } = require('crypto');
const { describe: describePayload, restore } = require('../../src/services/coreTemporaryRestoration');

const SHA = 'b'.repeat(64);
const READ = { promoteValues: false, promoteLongs: false, bsonRegExp: true };
const ID_INDEX = { v: 2, key: { _id: 1 }, name: '_id_' };
const oid = n => new BSON.ObjectId(n.toString(16).padStart(24, '0'));
const doc = n => ({ _id: oid(n), owner: 'owner', ordinal: new BSON.Int32(n) });
const payload = () => ({
  history: { documents: [doc(1), doc(2)], indexes: [ID_INDEX] },
  souvenirs: { documents: [doc(3)], indexes: [ID_INDEX] }
});
const options = verify => ({ verify: verify || (async () => SHA), expectedVerificationSha256: SHA });
const native = () => mongoose.connection.db;
const temporaryNames = async () => (await native().listCollections().toArray())
  .map(row => row.name).filter(name => name.startsWith('__agentx_core_restore_'));

// Test-only fault cleanup is still UUID-conditional, including intentionally retained tainted copies.
async function clearTemporary() {
  for (const row of await native().listCollections().toArray()) {
    if (row.name.startsWith('__agentx_core_restore_')) {
      await native().command({ drop: row.name, collectionUUID: row.info.uuid });
    }
  }
}

function wrapDb(overrides = {}) {
  const db = native();
  return new Proxy(db, { get(target, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key];
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

function error(codeName) { return Object.assign(new Error('private synthetic details'), { codeName }); }

beforeEach(clearTemporary);
afterEach(clearTemporary);

describe('bounded BSON snapshot', () => {
  test('exact metadata, stable ordering and deduplication without exposing content', () => {
    const input = payload();
    const first = describePayload(input);
    input.history.documents.reverse();
    input.history.documents.push(doc(1));
    expect(describePayload(input)).toEqual(first);
    expect(Object.keys(first)).toEqual(['history', 'souvenirs']);
    expect(first.history).toEqual({ documents: 2, bytes: expect.any(Number),
      documentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/), indexes: 1,
      indexesSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(first)).not.toContain('owner');
    const expected = createHash('sha256').update(BSON.serialize(doc(1)))
      .update(BSON.serialize(doc(2))).digest('hex');
    expect(first.history.documentsSha256).toBe(expected);
    input.history.documents = Array.from({ length: 101 }, () => doc(1));
    expect(describePayload(input).history.documents).toBe(1);
  });

  test('compound index key order is significant', () => {
    const input = payload();
    input.history.indexes.push({ name: 'ordered', key: { owner: 1, ordinal: -1 } });
    const first = describePayload(input);
    input.history.indexes[1].key = { ordinal: -1, owner: 1 };
    expect(describePayload(input).history.indexesSha256).not.toBe(first.history.indexesSha256);
  });

  test('normalizes namespace/version bookkeeping and index-list ordering only', () => {
    const input = payload();
    input.history.indexes.push({ name: 'owner_1', key: { owner: 1 }, v: 2, ns: 'source.history' });
    const first = describePayload(input);
    input.history.indexes.reverse();
    delete input.history.indexes[0].v;
    delete input.history.indexes[0].ns;
    expect(describePayload(input)).toEqual(first);
  });

  test.each([
    ['unknown payload field', p => { p.target = 'canonical'; }],
    ['unknown group field', p => { p.history.target = 'canonical'; }],
    ['non ObjectId id', p => { p.history.documents[0]._id = 'x'; }],
    ['conflicting duplicate', p => { p.history.documents.push({ ...doc(1), owner: 'other' }); }],
    ['unknown index field', p => { p.history.indexes[0] = { ...ID_INDEX, futureOption: true }; }],
    ['unfinished index', p => { p.history.indexes[0] = { ...ID_INDEX, buildUUID: new BSON.UUID() }; }],
    ['TTL index', p => { p.history.indexes.push({ name: 'ttl', key: { when: 1 }, expireAfterSeconds: 10 }); }],
    ['text index', p => { p.history.indexes.push({ name: 'text', key: { owner: 'text' } }); }],
    ['wildcard index', p => { p.history.indexes.push({ name: 'wild', key: { '$**': 1 } }); }],
    ['missing id index', p => { p.history.indexes = []; }],
    ['duplicate indexes', p => { p.history.indexes.push(ID_INDEX); }],
    ['too many indexes', p => { p.history.indexes = Array.from({ length: 65 }, () => ID_INDEX); }],
    ['too many unique documents', p => { p.history.documents = Array.from({ length: 101 }, (_, i) => doc(i)); }],
    ['document too large', p => { p.history.documents[0].body = 'x'.repeat(512 * 1024); }],
    ['total BSON too large', p => { for (const group of Object.values(p)) {
      group.documents = Array.from({ length: 20 }, (_, i) => ({ ...doc(i), body: 'x'.repeat(450 * 1024) }));
    } }]
  ])('refuses %s synchronously with constant errors', (_label, mutate) => {
    const input = payload();
    mutate(input);
    expect(() => describePayload(input)).toThrow('Core temporary restoration refused.');
    try { describePayload(input); } catch (err) {
      expect(err.code).toMatch(/^CORE_RESTORATION_/);
      expect([400, 409, 413]).toContain(err.statusCode);
      expect(err.message).not.toContain('canonical');
    }
  });
});

describe('native private restoration and custody', () => {
  test('preserves complete typed BSON, embeddings and source collections', async () => {
    const input = payload();
    input.history.documents[0] = {
      ...doc(1), body: 'synthetic private source', embedding: [new BSON.Double(0.25), new BSON.Double(1)],
      date: new Date('2026-01-02T03:04:05.678Z'), long: BSON.Long.fromString('9007199254740993'),
      int: new BSON.Int32(4), double: new BSON.Double(4), decimal: BSON.Decimal128.fromString('1.2300'),
      binary: new BSON.Binary(Buffer.from([0, 1, 255]), 128), uuid: new BSON.UUID(),
      timestamp: new BSON.Timestamp({ t: 123, i: 4 }), regex: new BSON.BSONRegExp('a+', 'im'),
      min: new BSON.MinKey(), max: new BSON.MaxKey(), context: { sourceBody: 'full synthetic content' }
    };
    const source = native().collection('canonical_history');
    await source.deleteMany({});
    await source.insertMany(input.history.documents);
    const before = (await source.find({}, READ).sort({ _id: 1 }).toArray()).map(value => BSON.serialize(value));
    let verificationError;
    const verify = jest.fn(async ({ history, souvenirs }) => {
      try {
      const rows = await history.find({}, READ).sort({ _id: 1 }).toArray();
      expect(rows.map(value => BSON.serialize(value))).toEqual(before);
      expect(rows[0].embedding[1]._bsontype).toBe('Double');
      expect(rows[0].int._bsontype).toBe('Int32');
      expect(rows[0].long._bsontype).toBe('Long');
      expect(rows[0].binary.sub_type).toBe(128);
      expect(await souvenirs.countDocuments({ owner: 'owner' })).toBe(1);
      return SHA;
      } catch (err) { verificationError = err; throw err; }
    });
    const result = await restore(native(), input, options(verify)).catch(err => { throw verificationError || err; });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.contract).toBe('agentx.core-temporary-restoration/v1');
    expect(result.verificationSha256).toBe(SHA);
    expect(result.temporaryCopyRemoved).toBe(true);
    expect(result.collections.history.sourceDocumentsSha256).toBe(result.collections.history.restoredDocumentsSha256);
    expect((await source.find({}, READ).sort({ _id: 1 }).toArray()).map(value => BSON.serialize(value))).toEqual(before);
    expect(await temporaryNames()).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/__agentx|synthetic|owner|uuid/i);
  });

  test('native index options, key order and constraints survive reread', async () => {
    const source = native().collection('canonical_indexes');
    await source.deleteMany({});
    await source.insertMany(payload().history.documents);
    await source.createIndex({ owner: 1, ordinal: -1 }, {
      name: 'ordered_unique', unique: true, sparse: true, background: true, hidden: true
    });
    await source.createIndex({ ordinal: 1 }, { name: 'partial', partialFilterExpression: { ordinal: { $gte: 1 } } });
    await source.createIndex({ owner: 1 }, { name: 'collated', collation: { locale: 'en', strength: 2 } });
    const input = payload();
    input.history.indexes = await source.listIndexes().toArray();
    const sourceIndexes = await source.listIndexes().toArray();
    let verificationError;
    const result = await restore(native(), input, options(async ({ history }) => {
      try {
      const indexes = await history.listIndexes().toArray();
      expect([...indexes].sort((a, b) => a.name.localeCompare(b.name)))
        .toEqual([...sourceIndexes].sort((a, b) => a.name.localeCompare(b.name)));
      expect(Object.entries(indexes.find(index => index.name === 'ordered_unique').key))
        .toEqual([['owner', 1], ['ordinal', -1]]);
      await expect(history.insertOne({ ...doc(20), ordinal: new BSON.Int32(1) }))
        .rejects.toMatchObject({ code: 11000 });
      return SHA;
      } catch (err) { verificationError = err; throw err; }
    })).catch(err => { throw verificationError || err; });
    expect(result.collections.history.sourceIndexesSha256).toBe(result.collections.history.restoredIndexesSha256);
    expect(await source.listIndexes().toArray()).toEqual(sourceIndexes);
  });

  test('supports native collection-default collation through the id index', async () => {
    const name = 'canonical_collated';
    if (!(await native().listCollections({ name }).toArray()).length) {
      await native().createCollection(name, { collation: { locale: 'en', strength: 2 } });
    }
    const input = payload();
    input.history.indexes = await native().collection(name).listIndexes().toArray();
    await restore(native(), input, options());
    expect(await temporaryNames()).toEqual([]);
  });

  test('snapshots all input before the first await', async () => {
    const input = payload();
    const before = describePayload(input);
    const promise = restore(native(), input, options());
    input.history.documents[0].owner = 'changed';
    input.souvenirs.documents.length = 0;
    input.history.indexes[0] = { name: 'broken', key: { x: 'text' } };
    const result = await promise;
    expect(result.collections.history.sourceDocumentsSha256).toBe(before.history.documentsSha256);
    expect(result.collections.souvenirs.documents).toBe(1);
  });

  test.each(['Unauthorized', 'IDLUnknownField', 'CommandNotFound'])('guard %s refuses before any create or insert', async codeName => {
    const createCollection = jest.fn();
    const command = jest.fn(async () => { throw error(codeName); });
    await expect(restore(wrapDb({ createCollection, command }), payload(), options()))
      .rejects.toMatchObject({ code: 'CORE_RESTORATION_GUARD' });
    expect(createCollection).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledTimes(1);
  });

  test('wrong native UUID preserves an empty replacement and probe permission is exercised', async () => {
    const db = native();
    const commands = [];
    const command = async value => { commands.push(value); return db.command(value); };
    await restore(wrapDb({ command }), payload(), options());
    expect(commands.every(value => value.drop?.startsWith('__agentx_core_restore_')
      && value.collectionUUID?._bsontype === 'Binary')).toBe(true);
    expect(commands).toHaveLength(5); // absent guard, wrong probe, probe cleanup, two data copies
  });

  test.each(['mismatch', 'throw'])('business verification %s cleans safe peers', async kind => {
    const verify = jest.fn(async () => {
      if (kind === 'throw') throw new Error('synthetic source body must stay private');
      return 'c'.repeat(64);
    });
    await expect(restore(native(), payload(), options(verify))).rejects.toMatchObject({
      code: kind === 'throw' ? 'CORE_RESTORATION_NATIVE' : 'CORE_RESTORATION_VERIFICATION',
      message: 'Core temporary restoration refused.'
    });
    expect(await temporaryNames()).toEqual([]);
  });

  test('tainted documents are retained while the untouched peer is removed', async () => {
    let tainted;
    await expect(restore(native(), payload(), options(async ({ history }) => {
      tainted = history.collectionName;
      await history.updateOne({}, { $set: { owner: 'unexpected' } });
      return SHA;
    }))).rejects.toMatchObject({ code: 'CORE_RESTORATION_CUSTODY' });
    expect(await temporaryNames()).toEqual([tainted]);
    expect(await native().collection(tainted).findOne({ owner: 'unexpected' })).not.toBeNull();
  });

  test('tainted indexes are retained while the untouched peer is removed', async () => {
    let tainted;
    await expect(restore(native(), payload(), options(async ({ souvenirs }) => {
      tainted = souvenirs.collectionName;
      await souvenirs.createIndex({ owner: 1 }, { name: 'foreign_index' });
      return SHA;
    }))).rejects.toMatchObject({ code: 'CORE_RESTORATION_CUSTODY' });
    expect(await temporaryNames()).toEqual([tainted]);
  });

  test.each(['document', 'index'])('missing verified %s retains the tainted copy', async kind => {
    const input = payload();
    input.history.indexes.push({ name: 'owner_1', key: { owner: 1 } });
    let tainted;
    await expect(restore(native(), input, options(async ({ history }) => {
      tainted = history.collectionName;
      if (kind === 'document') await history.deleteOne({ _id: oid(1) });
      else await history.dropIndex('owner_1');
      return SHA;
    }))).rejects.toMatchObject({ code: 'CORE_RESTORATION_CUSTODY' });
    expect(await temporaryNames()).toEqual([tainted]);
  });

  test('unsupported native index mechanics refuse before all private document inserts', async () => {
    const db = native();
    const input = payload();
    input.souvenirs.indexes.push({ name: 'invalid_collation', key: { owner: 1 },
      collation: { locale: 'en', strength: 99 } });
    const inserts = jest.fn();
    const collection = (name, opts) => new Proxy(db.collection(name, opts), {
      get(target, key) {
        if (key === 'insertMany') return inserts;
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    await expect(restore(wrapDb({ collection }), input, options())).rejects.toMatchObject({
      code: 'CORE_RESTORATION_NATIVE'
    });
    expect(inserts).not.toHaveBeenCalled();
    expect(await temporaryNames()).toEqual([]);
  });

  test('business callback cannot leak a forged typed error message', async () => {
    await expect(restore(native(), payload(), options(async () => {
      throw Object.assign(new Error('synthetic private body'), { code: 'CORE_RESTORATION_PRIVATE' });
    }))).rejects.toMatchObject({ code: 'CORE_RESTORATION_NATIVE',
      message: 'Core temporary restoration refused.' });
    expect(await temporaryNames()).toEqual([]);
  });

  test('altered private creation nonce refuses removal of the affected copy', async () => {
    let tainted;
    await expect(restore(native(), payload(), options(async ({ history }) => {
      tainted = history.collectionName;
      await native().command({ collMod: tainted, validator: {} });
      return SHA;
    }))).rejects.toMatchObject({ code: 'CORE_RESTORATION_CUSTODY' });
    expect(await temporaryNames()).toEqual([tainted]);
    expect(await native().collection(tainted).countDocuments()).toBe(2);
  });

  test('replacement between final precheck and native drop survives the UUID guard', async () => {
    const db = native();
    let target;
    const drops = [];
    const command = async value => {
      if (value.drop) drops.push(value.drop);
      if (value.drop === target) {
        const original = await db.listCollections({ name: target }).next();
        await db.command({ drop: target, collectionUUID: original.info.uuid });
        await db.createCollection(target);
        await db.collection(target).insertOne({ _id: oid(42), marker: 'replacement' });
        target = null;
      }
      return db.command(value);
    };
    let replacement;
    await expect(restore(wrapDb({ command }), payload(), options(async ({ history }) => {
      target = replacement = history.collectionName;
      return SHA;
    }))).rejects.toMatchObject({ code: 'CORE_RESTORATION_CUSTODY' });
    expect(await native().collection(replacement).findOne({ marker: 'replacement' })).not.toBeNull();
    expect(drops.filter(name => name === replacement)).toHaveLength(1);
    expect(await temporaryNames()).toEqual([replacement]);
  });

  test('renamed original is unknown custody even when its old namespace is absent', async () => {
    let renamed;
    await expect(restore(native(), payload(), options(async ({ history }) => {
      renamed = `${history.collectionName}_renamed`;
      await history.rename(renamed);
      return SHA;
    }))).rejects.toMatchObject({ code: 'CORE_RESTORATION_CUSTODY' });
    expect(await temporaryNames()).toEqual([renamed]);
    expect(await native().collection(renamed).countDocuments()).toBe(2);
  });

  test('lost successful drop response reconciles UUID without relaunch', async () => {
    const db = native();
    const counts = new Map();
    const command = async value => {
      const result = await db.command(value);
      if (value.drop) {
        counts.set(value.drop, (counts.get(value.drop) || 0) + 1);
        throw new Error('lost successful reply');
      }
      return result;
    };
    const result = await restore(wrapDb({ command }), payload(), options());
    expect(result.temporaryCopyRemoved).toBe(true);
    expect([...counts.values()]).toEqual([1, 1, 1]);
    expect(await temporaryNames()).toEqual([]);
  });

  test('lost unapplied drop refuses and never relaunches that command', async () => {
    const db = native();
    let target;
    let count = 0;
    const command = async value => {
      if (value.drop === target) { count++; throw new Error('unknown drop outcome'); }
      return db.command(value);
    };
    await expect(restore(wrapDb({ command }), payload(), options(async ({ history }) => {
      target = history.collectionName;
      return SHA;
    }))).rejects.toMatchObject({ code: 'CORE_RESTORATION_CUSTODY' });
    expect(count).toBe(1);
    expect(await temporaryNames()).toEqual([target]);
  });

  test('native creation collision refuses without adopting or deleting the preexisting collection', async () => {
    const db = native();
    let collision;
    let nativeCollision;
    const command = jest.fn(value => db.command(value));
    const createCollection = async (name, opts) => {
      collision = name;
      await db.createCollection(name);
      await db.collection(name).insertOne({ _id: oid(42), marker: 'preexisting' });
      try { return await db.createCollection(name, opts); }
      catch (err) { nativeCollision = err; throw err; }
    };
    await expect(restore(wrapDb({ createCollection, command }), payload(), options()))
      .rejects.toMatchObject({ code: 'CORE_RESTORATION_CUSTODY' });
    expect(nativeCollision).toMatchObject({ code: 48 });
    expect(command.mock.calls.filter(([value]) => value.drop === collision)).toEqual([]);
    expect(await db.collection(collision).countDocuments()).toBe(1);
    expect(await db.collection(collision).findOne({ marker: 'preexisting' })).not.toBeNull();
    expect(await temporaryNames()).toEqual([collision]);
  });

  test('lost create response leaves unknown custody without a second create or a drop', async () => {
    const db = native();
    let created;
    const createCollection = jest.fn(async (name, opts) => {
      created = name;
      await db.createCollection(name, opts);
      throw new Error('lost create response');
    });
    const command = jest.fn(value => db.command(value));
    await expect(restore(wrapDb({ createCollection, command }), payload(), options()))
      .rejects.toMatchObject({ code: 'CORE_RESTORATION_CUSTODY' });
    expect(createCollection).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledTimes(1);
    expect(await db.collection(created).countDocuments()).toBe(0);
  });

  test('unreadable UUID after create leaves unknown custody without drop or document copies', async () => {
    const db = native();
    let created;
    const createCollection = async (...args) => { created = args[0]; return db.createCollection(...args); };
    const listCollections = (filter, opts) => {
      if (filter?.name === created && !opts?.nameOnly) return { toArray: async () => { throw error('Unauthorized'); } };
      return db.listCollections(filter, opts);
    };
    const command = jest.fn(value => db.command(value));
    await expect(restore(wrapDb({ createCollection, listCollections, command }), payload(), options()))
      .rejects.toMatchObject({ code: 'CORE_RESTORATION_CUSTODY' });
    expect(command).toHaveBeenCalledTimes(1);
    expect(await db.collection(created).countDocuments()).toBe(0);
  });

  test('partial native insert failure removes only verified source subsets', async () => {
    const input = payload();
    input.history.indexes.push({ name: 'owner_unique', key: { owner: 1 }, unique: true });
    await expect(restore(native(), input, options())).rejects.toMatchObject({ code: 'CORE_RESTORATION_NATIVE' });
    expect(await temporaryNames()).toEqual([]);
  });

  test('invalid verifier fails before any native command', async () => {
    const command = jest.fn();
    await expect(restore(wrapDb({ command }), payload(), { verify: async () => SHA,
      expectedVerificationSha256: 'invalid' })).rejects.toMatchObject({ code: 'CORE_RESTORATION_VERIFICATION' });
    expect(command).not.toHaveBeenCalled();
  });
});

describe('native isolated MongoDB authorization', () => {
  test('ordinary readWrite qualifies the UUID guard; read-only refuses before copies', async () => {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const { MongoClient } = mongoose.mongo;
    const server = await MongoMemoryServer.create({ auth: {
      enable: true, customRootName: 'synthetic_root', customRootPwd: 'synthetic_root_password'
    } });
    const clients = [];
    try {
      const root = new MongoClient(server.getUri('admin'), {
        auth: { username: 'synthetic_root', password: 'synthetic_root_password' }, authSource: 'admin'
      });
      clients.push(root);
      await root.connect();
      const dbName = 'isolated_restoration';
      for (const role of ['readWrite', 'read']) {
        await root.db(dbName).command({ createUser: `synthetic_${role}`, pwd: 'synthetic_password',
          roles: [{ role, db: dbName }] });
        const client = new MongoClient(server.getUri(dbName), { authSource: dbName,
          auth: { username: `synthetic_${role}`, password: 'synthetic_password' } });
        clients.push(client);
        await client.connect();
        if (role === 'readWrite') {
          const result = await restore(client.db(dbName), payload(), options());
          expect(result.temporaryCopyRemoved).toBe(true);
        } else {
          await expect(restore(client.db(dbName), payload(), options()))
            .rejects.toMatchObject({ code: 'CORE_RESTORATION_GUARD' });
        }
        expect(await root.db(dbName).listCollections().toArray()).toEqual([]);
      }
    } finally {
      await Promise.all(clients.map(client => client.close()));
      await server.stop();
    }
  });
});
