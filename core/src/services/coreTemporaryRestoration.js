'use strict';

const { createHash, randomBytes } = require('crypto');
const { BSON } = require('mongoose').mongo;

const GROUPS = ['history', 'souvenirs'];
const PREFIX = '__agentx_core_restore_';
const READ = { promoteValues: false, promoteLongs: false, bsonRegExp: true };
const WRITE = { writeConcern: { w: 1 } };
const HASH = /^[a-f0-9]{64}$/;
const INDEX_FIELDS = new Set([
  'v', 'ns', 'name', 'key', 'unique', 'sparse', 'partialFilterExpression',
  'collation', 'background', 'hidden'
]);

class RestorationError extends Error {}

function fail(code = 'INVALID', statusCode = 409) {
  const error = new RestorationError('Core temporary restoration refused.');
  error.code = `CORE_RESTORATION_${code}`;
  error.statusCode = statusCode;
  return error;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function hash(buffers) {
  const digest = createHash('sha256');
  for (const buffer of buffers) digest.update(buffer);
  return digest.digest('hex');
}

function number(value) {
  return value?._bsontype === 'Int32' ? value.valueOf() : value;
}

function decode(bytes) {
  const document = BSON.deserialize(bytes, READ);
  if (!BSON.serialize(document).equals(bytes)) throw fail('BSON');
  return document;
}

function clone(value) {
  return decode(BSON.serialize(value, { checkKeys: false }));
}

function normalizeIndex(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(key => !INDEX_FIELDS.has(key))) throw fail('INDEX');
  const spec = clone(raw);
  if (typeof spec.name !== 'string' || !spec.name || spec.name.length > 127
      || spec.name.includes('\0') || !spec.key || typeof spec.key !== 'object'
      || Array.isArray(spec.key)) throw fail('INDEX');
  if (Object.hasOwn(spec, 'v') && ![1, 2].includes(number(spec.v))) throw fail('INDEX');
  if (Object.hasOwn(spec, 'ns') && typeof spec.ns !== 'string') throw fail('INDEX');
  const key = Object.entries(spec.key).map(([field, direction]) => [field, number(direction)]);
  if (!key.length || key.some(([field, direction]) => !field || field.includes('\0')
      || field.includes('$') || ![1, -1].includes(direction))) throw fail('INDEX');
  const normalized = { name: spec.name, key };
  for (const option of ['unique', 'sparse', 'background', 'hidden']) {
    if (Object.hasOwn(spec, option)) {
      if (typeof spec[option] !== 'boolean') throw fail('INDEX');
      normalized[option] = spec[option];
    }
  }
  for (const option of ['partialFilterExpression', 'collation']) {
    if (Object.hasOwn(spec, option)) {
      if (!spec[option] || typeof spec[option] !== 'object'
          || Array.isArray(spec[option])) throw fail('INDEX');
      normalized[option] = spec[option];
    }
  }
  if (spec.name === '_id_' && (key.length !== 1 || key[0][0] !== '_id'
      || key[0][1] !== 1 || Object.keys(normalized).some(option =>
        !['name', 'key', 'collation'].includes(option)))) throw fail('INDEX');
  return normalized;
}

function indexState(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 64) throw fail('INDEX');
  const specs = raw.map(normalizeIndex).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (new Set(specs.map(spec => spec.name)).size !== specs.length
      || !specs.some(spec => spec.name === '_id_')) throw fail('INDEX');
  return { specs, sha256: hash(specs.map(spec => BSON.serialize(spec))) };
}

function documentState(raw, maximum = 100) {
  if (!Array.isArray(raw)) throw fail('INVALID', 400);
  const byId = new Map();
  for (const document of raw) {
    if (!document || document._id?._bsontype !== 'ObjectId') throw fail('BSON');
    const buffer = BSON.serialize(document, { checkKeys: false });
    if (buffer.length > 512 * 1024) throw fail('LIMIT', 413);
    const decoded = BSON.deserialize(buffer, READ);
    if (!BSON.serialize(decoded).equals(buffer)) throw fail('BSON');
    const id = decoded._id.toHexString();
    if (byId.has(id) && !byId.get(id).equals(buffer)) throw fail('DUPLICATE');
    byId.set(id, buffer);
    if (byId.size > maximum) throw fail('LIMIT', 413);
  }
  const buffers = [...byId.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([, buffer]) => buffer);
  return { buffers, byId, bytes: buffers.reduce((sum, buffer) => sum + buffer.length, 0),
    sha256: hash(buffers) };
}

// This synchronous snapshot precedes every await: no caller-owned BSON object is retained.
function snapshot(payload) {
  if (!exact(payload, GROUPS)) throw fail('INVALID', 400);
  const result = {};
  for (const group of GROUPS) {
    if (!exact(payload[group], ['documents', 'indexes'])) throw fail('INVALID', 400);
    result[group] = {
      data: documentState(payload[group].documents),
      index: indexState(payload[group].indexes)
    };
  }
  if (GROUPS.reduce((sum, group) => sum + result[group].data.bytes, 0) > 16 * 1024 * 1024) {
    throw fail('LIMIT', 413);
  }
  return result;
}

function describe(payload) {
  try {
    const captured = snapshot(payload);
    return Object.fromEntries(GROUPS.map(group => {
      const { data, index } = captured[group];
      return [group, { documents: data.buffers.length, bytes: data.bytes,
        documentsSha256: data.sha256, indexes: index.specs.length, indexesSha256: index.sha256 }];
    }));
  } catch (error) {
    throw sanitize(error);
  }
}

function sanitize(error) {
  return error instanceof RestorationError ? error : fail('NATIVE');
}

function privateName() {
  return PREFIX + randomBytes(24).toString('hex');
}

function uuidBytes(value) {
  if (value?._bsontype !== 'Binary' || value.sub_type !== 4 || value.length() !== 16) {
    throw fail('CUSTODY');
  }
  return Buffer.from(value.value());
}

function sameUuid(left, right) {
  return uuidBytes(left).equals(uuidBytes(right));
}

async function namedInfo(db, name) {
  const rows = await db.listCollections({ name }, { nameOnly: false, ...READ }).toArray();
  if (rows.length !== 1 || rows[0].type !== 'collection') throw fail('CUSTODY');
  uuidBytes(rows[0].info?.uuid);
  return rows[0];
}

async function assertOwned(db, entry) {
  const info = await namedInfo(db, entry.name);
  if (!sameUuid(info.info.uuid, entry.uuid)
      || !BSON.serialize(info.options?.validator || {}).equals(BSON.serialize(entry.validator))) {
    throw fail('CUSTODY');
  }
}

async function currentIdentity(db, entry) {
  // A missing name alone does not prove removal: the original may have been renamed.
  const rows = await db.listCollections({ $or: [
    { name: entry.name }, { 'info.uuid': entry.uuid }
  ] }, { nameOnly: false, ...READ }).toArray();
  if (!rows.length) return 'gone';
  if (rows.length === 1 && rows[0].name === entry.name && rows[0].type === 'collection'
      && sameUuid(rows[0].info?.uuid, entry.uuid)) return 'owned';
  throw fail('CUSTODY');
}

async function guardedDrop(db, entry) {
  if (await currentIdentity(db, entry) === 'gone') {
    entry.removed = true;
    return;
  }
  if (entry.dropAttempted) throw fail('REMOVAL');
  entry.dropAttempted = true;
  try {
    // MongoDB enforces identity atomically. Never replace this with collection.drop().
    await db.command({ drop: entry.name, collectionUUID: entry.uuid, ...WRITE });
  } catch {
    // A lost acknowledgement is reconciled by the original UUID, without a second drop.
  }
  if (await currentIdentity(db, entry) !== 'gone') throw fail('REMOVAL');
  entry.removed = true;
}

async function createOwned(db, entries, collation) {
  const entry = { name: privateName(), uuid: null, removed: false };
  const existing = await db.listCollections({ name: entry.name }, { nameOnly: true }).toArray();
  if (existing.length) throw fail('CUSTODY');
  entries.push(entry);
  // Mongo create is idempotent for identical options. An unpredictable tautological
  // validator makes an ordinary collision a native NamespaceExists failure, including
  // an empty collection created after our precheck. It imposes no document restriction.
  // The trusted DB account is the boundary, not an adversary copying these private options.
  const nonce = randomBytes(24).toString('hex');
  entry.validator = { $expr: { $eq: [{ $literal: nonce }, { $literal: nonce }] } };
  await db.createCollection(entry.name, { ...WRITE, validator: entry.validator,
    ...(collation ? { collation } : {}) });
  const info = await namedInfo(db, entry.name);
  if (!BSON.serialize(info.options?.validator || {}).equals(BSON.serialize(entry.validator))) {
    throw fail('CUSTODY');
  }
  entry.uuid = clone({ uuid: info.info.uuid }).uuid;
  entry.collection = db.collection(entry.name);
  return entry;
}

async function readState(db, entry) {
  await assertOwned(db, entry);
  const documents = (await entry.collection.find({}, { ...READ, raw: true }).limit(101).toArray()).map(decode);
  const indexes = (await entry.collection.listIndexes({ ...READ, raw: true }).toArray()).map(decode);
  const result = { data: documentState(documents), index: indexState(indexes) };
  await assertOwned(db, entry);
  return result;
}

function matches(actual, expected) {
  return actual.data.sha256 === expected.data.sha256
    && actual.index.sha256 === expected.index.sha256;
}

function safeSubset(actual, expected) {
  return [...actual.data.byId].every(([id, buffer]) => expected.data.byId.get(id)?.equals(buffer))
    && actual.index.specs.every(spec => expected.index.specs.some(candidate =>
      BSON.serialize(candidate).equals(BSON.serialize(spec))));
}

async function cleanup(db, entries) {
  let unsafe = false;
  for (const entry of entries) {
    if (entry.removed) continue;
    if (!entry.uuid || !entry.expected) { unsafe = true; continue; }
    try {
      if (await currentIdentity(db, entry) === 'gone') { entry.removed = true; continue; }
      const actual = await readState(db, entry);
      if (!(entry.complete ? matches(actual, entry.expected) : safeSubset(actual, entry.expected))) {
        throw fail('TAINTED');
      }
      await guardedDrop(db, entry);
    } catch { unsafe = true; }
  }
  if (unsafe) throw fail('CUSTODY');
}

async function qualifyGuard(db, entries) {
  const name = privateName();
  const wrong = new BSON.UUID();
  let rejected = false;
  try {
    await db.command({ drop: name, collectionUUID: wrong, ...WRITE });
  } catch (error) {
    rejected = ['CollectionUUIDMismatch', 'NamespaceNotFound'].includes(error.codeName);
  }
  if (!rejected) throw fail('GUARD');
  const probe = await createOwned(db, entries);
  probe.expected = { data: documentState([]), index: indexState([{ name: '_id_', key: { _id: 1 } }]) };
  rejected = false;
  try {
    await db.command({ drop: probe.name, collectionUUID: wrong, ...WRITE });
  } catch (error) { rejected = error.codeName === 'CollectionUUIDMismatch'; }
  if (!rejected) throw fail('GUARD');
  if (!matches(await readState(db, probe), probe.expected)) throw fail('GUARD');
  await guardedDrop(db, probe);
}

async function restore(db, payload, { verify, expectedVerificationSha256 } = {}) {
  let captured;
  try {
    captured = snapshot(payload);
    if (typeof verify !== 'function' || typeof expectedVerificationSha256 !== 'string'
        || !HASH.test(expectedVerificationSha256)) {
      throw fail('VERIFICATION', 400);
    }
  } catch (error) { throw sanitize(error); }
  const entries = [];
  try {
    await qualifyGuard(db, entries);
    const selected = {};
    for (const group of GROUPS) {
      const expected = captured[group];
      const idIndex = expected.index.specs.find(spec => spec.name === '_id_');
      const entry = await createOwned(db, entries, idIndex.collation);
      entry.expected = expected;
      selected[group] = entry;
      await assertOwned(db, entry);
      for (const spec of expected.index.specs) {
        if (spec.name === '_id_') continue;
        const { key, ...options } = spec;
        await assertOwned(db, entry);
        await entry.collection.createIndex(new Map(key), { ...options, ...WRITE });
      }
      const empty = await readState(db, entry);
      if (empty.data.buffers.length || empty.index.sha256 !== expected.index.sha256) throw fail('ROUNDTRIP');
    }
    // Qualify both native index roundtrips before the first private document copy.
    for (const group of GROUPS) {
      const entry = selected[group];
      const expected = entry.expected;
      await assertOwned(db, entry);
      if (expected.data.buffers.length) {
        await entry.collection.insertMany(expected.data.buffers.map(buffer =>
          BSON.deserialize(buffer, READ)), { ordered: true, ...WRITE });
      }
      if (!matches(await readState(db, entry), expected)) throw fail('ROUNDTRIP');
      entry.complete = true;
    }
    const verificationSha256 = await verify(Object.fromEntries(GROUPS.map(group =>
      [group, selected[group].collection])));
    if (typeof verificationSha256 !== 'string' || !HASH.test(verificationSha256)
        || verificationSha256 !== expectedVerificationSha256) throw fail('VERIFICATION');
    const collections = {};
    // Fence both groups before the first removal. A callback cannot quietly taint a copy.
    for (const group of GROUPS) {
      const entry = selected[group];
      const actual = await readState(db, entry);
      if (!matches(actual, entry.expected)) throw fail('TAINTED');
      const { data, index } = entry.expected;
      collections[group] = { documents: data.buffers.length, bytes: data.bytes,
        sourceDocumentsSha256: data.sha256, restoredDocumentsSha256: actual.data.sha256,
        indexes: index.specs.length, sourceIndexesSha256: index.sha256,
        restoredIndexesSha256: actual.index.sha256 };
    }
    for (const group of GROUPS) await guardedDrop(db, selected[group]);
    return { contract: 'agentx.core-temporary-restoration/v1', collections,
      verificationSha256, temporaryCopyRemoved: true };
  } catch (error) {
    try { await cleanup(db, entries); } catch { throw fail('CUSTODY'); }
    throw sanitize(error);
  }
}

module.exports = { describe, restore };
