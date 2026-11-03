'use strict';

// One persisted Finance admission document. No TTL: an uncertain operation or
// interrupted repair keeps admission closed until its native owner reconciles it.
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const context = new AsyncLocalStorage();
const WRITE = { writeConcern: { w: 'majority', j: true } };
const ID = 'finance';

function error(message, code = 'FINANCE_MAINTENANCE', status = 503) {
  return Object.assign(new Error(message), { code, status });
}
function collection() {
  if (mongoose.connection.readyState !== 1) throw error('Finance coordination is unavailable', 'FINANCE_COORDINATION_UNAVAILABLE');
  return mongoose.connection.db.collection('finance_coordination');
}
async function state() {
  const store = collection();
  try { await store.updateOne({ _id: ID }, { $setOnInsert: { identity: randomUUID(), repair: null, ingestion: null, readers: [], executorRoot: null } }, { upsert: true, ...WRITE }); }
  catch (e) { if (e.code !== 11000) throw e; }
  return store.findOne({ _id: ID });
}
async function open() {
  await state();
  const id = randomUUID();
  const result = await collection().updateOne({ _id: ID, repair: null, ingestion: null, 'readers.255': { $exists: false } },
    { $push: { readers: { id, pid: process.pid, at: new Date() } } }, WRITE);
  if (!result.matchedCount) throw error('Finance is held by maintenance or has reached its admission limit');
  return { id, active: true, jobs: new Set() };
}
async function close(scope) {
  scope.active = false;
  // A rejected Promise.all must not release admission while sibling database
  // operations are still settling. Nested model operations register here.
  while (scope.jobs.size) await Promise.allSettled([...scope.jobs]);
  const result = await collection().updateOne({ _id: ID, 'readers.id': scope.id }, { $pull: { readers: { id: scope.id } } }, WRITE);
  if (!result.matchedCount) throw error('Finance admission release could not be verified', 'FINANCE_ADMISSION_UNCERTAIN');
}
function nested(scope, fn) {
  const task = Promise.resolve().then(fn);
  scope.jobs.add(task);
  // Use both handlers: cleanup itself must not create an unhandled rejection.
  task.then(() => scope.jobs.delete(task), () => scope.jobs.delete(task));
  return task;
}
async function withAccess(fn) {
  const current = context.getStore();
  if (current?.exclusive) return fn();
  if (current?.active) return nested(current, fn);
  const scope = await open();
  try { return await context.run(scope, fn); }
  finally { await close(scope); }
}
function guard(exports, names) {
  for (const name of names) {
    const fn = exports[name];
    exports[name] = function (...args) { return withAccess(() => fn.apply(this, args)); };
  }
  return exports;
}
async function* iterator(source) {
  const scope = await open();
  try {
    for (;;) {
      const item = await context.run(scope, () => source.next());
      if (item.done) return;
      yield item.value;
    }
  } finally {
    try { if (source.return) await context.run(scope, () => source.return()); }
    finally { await close(scope); }
  }
}
function requireCursorScope() {
  const current = context.getStore();
  if (!current?.active && !current?.exclusive) throw error('Finance cursors require a guarded service or iterator', 'FINANCE_CURSOR_SCOPE_REQUIRED');
}
async function bindExecutor(rootId) {
  await state();
  const result = await collection().updateOne({ _id: ID, $or: [{ executorRoot: null }, { executorRoot: rootId }] },
    { $set: { executorRoot: rootId } }, WRITE);
  if (!result.matchedCount) throw error('Finance executor storage differs from its registered owner', 'FINANCE_EXECUTOR_ROOT_CONFLICT', 409);
}
async function hold(requestKey, digest, rootId) {
  await bindExecutor(rootId);
  const result = await collection().updateOne({ _id: ID, executorRoot: rootId, ingestion: null,
    $or: [{ repair: null }, { 'repair.requestKey': requestKey, 'repair.digest': digest }] },
  { $set: { repair: { requestKey, digest } } }, WRITE);
  if (!result.matchedCount) throw error('Another Finance repair owns admission', 'FINANCE_REPAIR_HELD', 409);
  const held = await state();
  if (held.readers.length) throw error('Finance repair is draining admitted operations', 'FINANCE_REPAIR_DRAINING', 409);
}
async function release(requestKey, digest) {
  const result = await collection().updateOne({ _id: ID, 'repair.requestKey': requestKey, 'repair.digest': digest, readers: { $size: 0 } },
    { $set: { repair: null } }, WRITE);
  if (!result.matchedCount) throw error('Finance repair release is uncertain', 'FINANCE_REPAIR_RELEASE_UNCERTAIN');
}
async function owned(requestKey, digest, fn) {
  const current = await state();
  if (current.ingestion || current.repair?.requestKey !== requestKey || current.repair?.digest !== digest || current.readers.length) {
    throw error('Finance repair no longer owns exclusive admission', 'FINANCE_REPAIR_OWNERSHIP_LOST');
  }
  return context.run({ exclusive: true }, fn);
}

// Ordinary ingestion upgrades its admitted scope before its first accounting
// write. A failed/uncertain writer leaves this persisted fence in place.
async function withIngestion(requestKey, digest, fn) {
  let scope = context.getStore();
  let recovery = false;
  if (scope?.exclusive) throw error('An exclusive Finance operation cannot start an ingestion', 'FINANCE_INGESTION_OWNER_CONFLICT', 409);
  if (scope?.ingestionOwner || (scope?.active && scope.jobs.size > 1)) {
    throw error('Ingestion requires one settled operation in its admitted scope', 'FINANCE_INGESTION_OWNER_CONFLICT', 409);
  }
  if (!scope?.active) {
    await state();
    scope = { id: randomUUID(), active: true, jobs: new Set() };
    const result = await collection().updateOne({ _id: ID, repair: null,
      'ingestion.requestKey': requestKey, 'ingestion.digest': digest, readers: { $size: 0 } },
    { $push: { readers: { id: scope.id, pid: process.pid, at: new Date() } },
      $set: { 'ingestion.readerId': scope.id } }, WRITE);
    if (!result.matchedCount) throw error('The exact ingestion is not available for native recovery', 'FINANCE_INGESTION_HELD', 409);
    recovery = true;
  }
  const run = async () => {
    const result = await collection().updateOne({ _id: ID, repair: null, 'readers.id': scope.id,
      $or: [{ ingestion: null }, { 'ingestion.requestKey': requestKey, 'ingestion.digest': digest, 'ingestion.readerId': scope.id }] },
    { $set: { ingestion: { requestKey, digest, readerId: scope.id } } }, WRITE);
    if (!result.matchedCount) throw error('Another operation owns Finance admission', 'FINANCE_INGESTION_HELD', 409);
    // New readers are fenced; already-admitted readers may finish normally.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const gate = await state();
      if (gate.readers.every(reader => reader.id === scope.id)) {
        scope.ingestionOwner = { requestKey, digest };
        try { return await context.run(scope, fn); }
        finally { delete scope.ingestionOwner; }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw error('Finance ingestion is draining previously admitted readers', 'FINANCE_INGESTION_DRAINING');
  };
  try { return await context.run(scope, run); }
  finally { if (recovery) await close(scope); }
}

async function assertIngestion(requestKey, digest) {
  const scope = context.getStore();
  const gate = await state();
  if (!scope?.active || scope.ingestionOwner?.requestKey !== requestKey || scope.ingestionOwner?.digest !== digest
    || gate.repair || gate.ingestion?.requestKey !== requestKey || gate.ingestion?.digest !== digest || gate.ingestion?.readerId !== scope.id
    || gate.readers.length !== 1 || gate.readers[0].id !== scope.id) {
    throw error('The ingestion no longer owns exclusive Finance admission', 'FINANCE_INGESTION_OWNERSHIP_LOST');
  }
}

async function releaseIngestion(requestKey, digest) {
  await assertIngestion(requestKey, digest);
  const scope = context.getStore();
  const result = await collection().updateOne({ _id: ID, repair: null, 'ingestion.requestKey': requestKey,
    'ingestion.digest': digest, 'ingestion.readerId': scope.id, readers: { $size: 1 }, 'readers.0.id': scope.id }, { $set: { ingestion: null } }, WRITE);
  if (!result.matchedCount) throw error('Finance ingestion release is uncertain', 'FINANCE_INGESTION_RELEASE_UNCERTAIN');
}

module.exports = { withAccess, guard, iterator, requireCursorScope, state, bindExecutor, hold, release, owned, WRITE, error,
  withIngestion, assertIngestion, releaseIngestion,
  detached: fn => context.exit(fn) };
