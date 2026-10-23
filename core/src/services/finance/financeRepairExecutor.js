'use strict';

// Operator-only, one reviewed book reassignment. No inference or re-ingestion.
const fs = require('node:fs/promises');
const path = require('node:path');
const mongoose = require('mongoose');
const access = require('./financeAccess');
const storage = require('./financeRepairStorage');
const contract = require('./financeRepairManifest');
const check = require('./financeRepairChecks');
const coreProof = require('./financeRepairCoreProof');
const { WRITE, error } = access;

function createExecutor({ checkpoint = async () => {} } = {}) {
  async function execute({ bytes, confirmedDigest, mode = 'resume', receiptRoot, archiveRoot, coreOrigin, actor }) {
    if (!['apply','resume','rollback'].includes(mode) || !String(actor || '').trim()) {
      throw error('Finance repair requires an operator and a bounded action', 'FINANCE_REPAIR_ACTOR_REQUIRED', 400);
    }
    const { manifest: m, digest } = contract.read(bytes, confirmedDigest);
    if (mongoose.connection.readyState !== 1) throw error('Native Finance database is unavailable','FINANCE_COORDINATION_UNAVAILABLE');
    const root = await storage.privateRoot(receiptRoot);
    const processLock = await storage.lock(root);
    const rootIdentity = processLock.identity;
    const db = mongoose.connection.db;
    const journals = db.collection('finance_repairs');
    const key = m.requestKey;
    const directory = path.join(root.directory, storage.hash(key));
    let record;
    const load = () => journals.findOne({ _id: key });
    async function save(fields) {
      const result = await journals.updateOne({ _id: key, digest, executorRoot: rootIdentity }, { $set: fields }, WRITE);
      if (result.matchedCount !== 1) throw error('Finance repair journal ownership differs', 'FINANCE_REPAIR_JOURNAL_CONFLICT', 409);
      record = await load();
    }
    async function finish(phase, proof) {
      const field = phase === 'applied' ? 'applyReceipt' : phase === 'rolled_back' ? 'rollbackReceipt' : 'refusalReceipt';
      if (!record[field]) {
        await save({ phase, [field]: { schema: 'agentx.finance-repair/v1', requestKey: key, digest,
          phase, actor: String(actor).trim(), completedAt: new Date(), ...proof } });
      }
      await checkpoint('terminal_saved', { phase });
      await storage.immutable(path.join(directory, phase + '.json'), record[field]);
      processLock.assert();
      await access.release(key,digest);
      await checkpoint('released', { phase });
      return storage.plain(record[field]);
    }
    async function terminal() {
      const gate = await access.state();
      const field = record.phase === 'applied' ? 'applyReceipt' : record.phase === 'rolled_back' ? 'rollbackReceipt' : 'refusalReceipt';
      if (gate.repair?.requestKey === key && gate.repair?.digest === digest) {
        // Finish publication/release after a lost terminal reply. Admission has
        // stayed closed, so no later supported Finance operation can intervene.
        if (record.phase === 'applied') check.assertSignatures(await check.snapshot(db), record.expectedApplied);
        if (record.phase === 'rolled_back' && record.expectedRollback) check.assertSignatures(await check.snapshot(db), record.expectedRollback);
        await storage.immutable(path.join(directory, record.phase + '.json'), record[field]);
        await access.release(key,digest);
      }
      return storage.plain(record[field]);
    }
    async function prepare() {
      await storage.verifyOriginal(m, archiveRoot);
      const state = await check.snapshot(db);
      const before = check.images(state,m);
      check.assertImages(before,[m.updates.map(u => u.before)]);
      const appliedAt = new Date();
      const after = check.typedAfter(before,m,appliedAt);
      check.validateScope(state,m,after);
      const balances = await check.nativeViews();
      await storage.immutable(path.join(directory,'before.json'),state);
      await checkpoint('backup_saved');
      await save({ phase: 'applying', appliedAt, before, after, balances,
        baseline: check.signatures(state), expectedApplied: check.signatures(check.derive(state,m,after)),
        backupSha256: storage.hash(state) });
      await checkpoint('intent_saved');
    }
    function uncertain() {
      return error('A dispatched Finance write has no observed effect; reconcile its native outcome', 'FINANCE_REPAIR_WRITE_UNCERTAIN');
    }
    async function observeDispatches(state, direction) {
      const steps = record[direction === 'apply' ? 'steps' : 'rollbackSteps'] || {};
      const destination = direction === 'apply' ? record.after : record.before;
      const source = direction === 'apply' ? record.before : record.after;
      check.images(state,m).forEach((current,i) => {
        if (steps[i] && storage.hash(current) !== storage.hash(destination[i])) throw uncertain();
        if (!steps[i] && storage.hash(current) !== storage.hash(source[i])) throw check.conflict('Finance changed before its recorded dispatch');
      });
    }
    async function dispatch(i, direction) {
      const field = direction === 'apply' ? 'steps' : 'rollbackSteps';
      const source = direction === 'apply' ? record.before : record.after;
      const destination = direction === 'apply' ? record.after : record.before;
      processLock.assert();
      const current = check.images(await check.snapshot(db),m)[i];
      if (record[field]?.[i]) {
        // There was at most one command for this step. Its exact destination
        // proves that effect was received. A source image does NOT prove that
        // a dispatched, unanswered command cannot still arrive at Mongo.
        if (storage.hash(current) !== storage.hash(destination[i])) throw uncertain();
      } else {
        await save({ [`${field}.${i}`]: 'dispatching' });
        await checkpoint('dispatch_saved', { direction, index: i });
        await access.owned(key,digest,() => check.replace(db,m.updates[i],source[i],destination[i]));
      }
      await checkpoint(direction === 'apply' ? 'applied_step' : 'rollback_step', { index: i });
      await save({ [`${field}.${i}`]: 'received' });
    }
    async function apply() {
      await storage.verifyOriginal(m, archiveRoot);
      let state = await check.snapshot(db);
      check.assertImages(check.images(state,m),[record.before, record.after]);
      check.validateScope(state,m,record.after);
      await observeDispatches(state,'apply');
      check.assertSignatures(check.derive(state,m,record.after),record.expectedApplied);
      for (let i=0;i<3;i++) await dispatch(i,'apply');
      state = await check.snapshot(db);
      check.assertSignatures(state,record.expectedApplied);
      check.assertBalances(m,record.balances,await check.nativeViews());
      await storage.immutable(path.join(directory,'after.json'),state);
      await checkpoint('verified');
      return finish('applied',{ documents: 3, inserted: 0, deleted: 0,
        sourcePdfSha256: m.verifiedIdentity.pdfSha256, backupSha256: record.backupSha256,
        stateSignatures: record.expectedApplied, arithmeticResidualCents: 0, latestBalancesUnchanged: true });
    }
    async function rollback() {
      if (record.applyReceipt) await storage.immutable(path.join(directory,'applied.json'),record.applyReceipt);
      if (record.phase === 'draining') {
        // No accounting write was dispatched. Cancel intent without restoring
        // anything a previously admitted operation may have changed.
        return finish('rolled_back',{ documents: 0, inserted: 0, deleted: 0, reason: 'cancelled_before_accounting_dispatch' });
      }
      if (record.phase !== 'rolling_back') {
        const state = await check.snapshot(db);
        const current = check.images(state,m);
        check.assertImages(current, record.phase === 'applied' ? [record.after] : [record.before,record.after]);
        await observeDispatches(state,'apply');
        if (record.phase !== 'applied') check.assertSignatures(check.derive(state,m,record.after),record.expectedApplied);
        check.validateScope(state,m,record.before);
        const balances = await check.nativeViews();
        await storage.immutable(path.join(directory,'rollback-before.json'),state);
        await save({ phase: 'rolling_back', rollbackBalances: balances,
          expectedRollback: check.signatures(check.derive(state,m,record.before)), rollbackRequestedBy: String(actor).trim() });
        await checkpoint('rollback_intent_saved');
      }
      const state = await check.snapshot(db);
      check.assertImages(check.images(state,m),[record.before,record.after]);
      check.assertSignatures(check.derive(state,m,record.before),record.expectedRollback);
      for (const i of [2,1,0]) await dispatch(i,'rollback');
      const restored = await check.snapshot(db);
      check.assertSignatures(restored,record.expectedRollback);
      check.assertBalances(m,record.rollbackBalances,await check.nativeViews());
      await storage.immutable(path.join(directory,'restored.json'),restored);
      return finish('rolled_back',{ documents: 3, inserted: 0, deleted: 0,
        stateSignatures: record.expectedRollback, exactBeforeImagesRestored: true });
    }
    try {
      await access.bindExecutor(rootIdentity);
      await fs.mkdir(directory,{ mode: 0o700 });
    } catch (e) {
      if (e.code !== 'EEXIST') { await processLock.release(); throw e; }
    }
    try {
      record = await load();
      if (!record) {
        if (mode !== 'apply') throw error('Finance repair has no saved intent', 'FINANCE_REPAIR_NOT_FOUND', 404);
        await journals.insertOne({ _id: key, digest, executorRoot: rootIdentity, manifest: m, phase: 'draining',
          createdAt: new Date(), requestedBy: String(actor).trim() },WRITE);
        record = await load();
        await checkpoint('journal_created');
      }
      if (record.digest !== digest || record.executorRoot !== rootIdentity) throw error('Finance repair identity has different intent', 'FINANCE_REPAIR_INTENT_CONFLICT', 409);
      if (['rolled_back','rejected'].includes(record.phase) || (record.phase === 'applied' && mode !== 'rollback')) return await terminal();
      await coreProof.protocol(coreOrigin);
      await access.hold(key,digest,rootIdentity);
      await checkpoint('fenced');
      await coreProof.fenced(coreOrigin);
      return await access.owned(key,digest,async () => {
        if (mode === 'rollback' || record.phase === 'rolling_back') return rollback();
        if (record.phase === 'draining') await prepare();
        return apply();
      });
    } catch (e) {
      record = await load().catch(() => null);
      // Invalid preconditions before the first dispatch can be refused safely.
      // All ambiguous/partial effects retain their durable Finance exclusion.
      if (record?.digest === digest) {
        const gate = await access.state().catch(() => null);
        const ours = gate?.repair?.requestKey === key && gate.repair.digest === digest && gate.readers.length === 0;
        if (ours && record.phase === 'draining' && ['FINANCE_REPAIR_STATE_CONFLICT','FINANCE_REPAIR_ORIGINAL_CHANGED',
          'FINANCE_REPAIR_ORIGINAL_INVALID','FINANCE_REPAIR_ARCHIVE_REQUIRED','FINANCE_REPAIR_CORE_UNQUALIFIED'].includes(e.code)) {
          await finish('rejected',{ reason: e.code, documents: 0, inserted: 0, deleted: 0 });
        } else if (ours && record.phase === 'applied' && mode === 'rollback' && e.code === 'FINANCE_REPAIR_STATE_CONFLICT') {
          await save({ rollbackRefused: { code: e.code, at: new Date() } });
          await access.release(key,digest);
        } else await save({ lastError: { code: e.code || 'FINANCE_REPAIR_INTERRUPTED', at: new Date() } }).catch(() => {});
      }
      throw e;
    } finally { await processLock.release(); }
  }
  return { execute };
}

module.exports = { createExecutor };
