'use strict';

const { createHash } = require('node:crypto');
const MemoryNote = require('../../models/MemoryNote');
const { memoryFactInput } = require('../../../shared/memoryFactMetadata');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => Object.assign(new Error(message), { statusCode: 409, code: 'MEMORY_REPLACEMENT_CONFLICT' });
const ID = /^[a-f0-9]{24}$/;
const busy = row => ['preparing', 'linked', 'undoing'].includes(row?.replacement?.phase);
// The index is derived and can change without changing the reviewed fact.
const FIELDS = ['packId', 'scopeId', 'scope', 'sensitivity', 'text', 'kind', 'type', 'topic', 'source',
  'sourceTraceId', 'sourceRefs', 'validFrom', 'expiresAt', 'invalidatedAt', 'supersededBy', 'status', 'updatedAt'];
const snapshot = row => Object.fromEntries(FIELDS.map(key => [key, row[key] ?? null]));
const fingerprint = row => hash(snapshot(row));
const current = row => row?.status === 'active' && !row.invalidatedAt && !row.supersededBy
  && (!row.expiresAt || new Date(row.expiresAt) > new Date());
const receipt = (old, replay = false) => ({ ok: true, authority: 'agentx.core', id: old.replacement.successorId,
  predecessorId: String(old._id), key: old.replacement.key, alreadyApplied: replay });

function forNotes({ audience, boundary, seal, indexLater, forget }) {
  function owner() {
    if (audience !== 'owner') throw Object.assign(fail('Replacement belongs to the owner'), { statusCode: 403 });
  }
  function validate(id, key) {
    owner();
    if (!ID.test(id || '') || typeof key !== 'string' || !/^[a-zA-Z0-9:._-]{1,200}$/.test(key)) throw fail('Choose an exact source and operation key');
  }
  const get = id => MemoryNote.findOne({ ...boundary, _id: id }).lean();
  async function abortPrelink(id, op) {
    const staged = await MemoryNote.findOne({ ...boundary, _id: op.successorId, replacementKey: op.key, status: 'pending' }).lean();
    if (staged) await forget(String(staged._id));
    await MemoryNote.updateOne({ ...boundary, _id: id, 'replacement.key': op.key, 'replacement.phase': 'preparing' },
      { $set: { 'replacement.phase': 'failed' } }, { timestamps: false });
  }
  async function replacementSource(id) {
    owner();
    if (!ID.test(id || '')) throw fail('Choose an existing owner fact');
    const row = await get(id);
    if (!current(row) || busy(row) || row.scope !== 'owner' || row.kind === 'souvenir') throw fail('The source is not an available owner fact');
    return { authority: 'local_memory', ref: id, fingerprint: fingerprint(row) };
  }

  async function supersede(input) {
    const { id, key, expectedFingerprint, scope, sensitivity } = input;
    validate(id, key);
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000 || input.text.includes('\0')) throw fail('A replacement needs bounded text');
    const fact = memoryFactInput(input);
    const { text } = await seal(input.text.trim());
    const inputHash = hash({ id, expectedFingerprint, text, scope, sensitivity, ...fact });
    let old = await get(id);
    if (!old) throw fail('The source no longer exists in this space');
    let op = old.replacement;
    if (op?.key === key) {
      if (op.inputHash !== inputHash) throw fail('The operation key already names different content');
      if (op.phase === 'applied') return receipt(old, true);
      if (!['preparing', 'linked'].includes(op.phase)) throw fail('This operation cannot be applied again');
    } else {
      if (!current(old) || busy(old) || old.scope !== scope || old.sensitivity !== sensitivity
          || scope !== 'owner' || old.kind === 'souvenir' || fingerprint(old) !== expectedFingerprint) throw fail('The reviewed source changed or its labels do not match');
      const effectiveAt = fact.validFrom ? new Date(fact.validFrom) : new Date();
      if (effectiveAt > new Date() || old.validFrom && effectiveAt < old.validFrom) throw fail('Replacement validity must be known now and follow the previous fact');
      const successorId = createHash('sha256').update([old.scopeId, old.packId, text].join('\n')).digest('hex').slice(0, 24);
      if (successorId === id || await MemoryNote.exists({ _id: successorId })) throw fail('The replacement sentence already has a note');
      op = { key, inputHash, sourceHash: expectedFingerprint, successorId, effectiveAt, phase: 'preparing' };
      old = await MemoryNote.findOneAndUpdate({ ...boundary, _id: id, ...snapshot(old), replacement: old.replacement || null },
        { $set: { replacement: op } }, { new: true, timestamps: false }).lean();
      if (!old) {
        old = await get(id);
        if (old?.replacement?.key !== key || old.replacement.inputHash !== inputHash) throw fail('The reviewed source changed before it could be reserved');
        op = old.replacement;
        if (op.phase === 'applied') return receipt(old, true);
        if (!['preparing', 'linked'].includes(op.phase)) throw fail('The original replacement is no longer available');
      }
    }
    if (old.status !== 'active' || op.phase === 'preparing' && !current(old)) {
      if (op.phase === 'preparing') await abortPrelink(id, op);
      throw fail('The source is no longer current; the replacement cannot activate');
    }
    const values = { _id: op.successorId, packId: old.packId, scopeId: old.scopeId, scope, sensitivity,
      text, kind: old.kind || 'fact', type: old.type || 'fact', topic: old.topic || 'general',
      source: 'memory-review', sourceTraceId: `replacement:${key}`, sourceRefs: fact.sourceRefs || [],
      validFrom: op.effectiveAt, contentHash: createHash('sha256').update(text.toLowerCase()).digest('hex'),
      status: 'pending', replacementKey: key, replaces: id, createdAt: new Date(), updatedAt: new Date() };
    let next = await MemoryNote.findOne({ _id: op.successorId }).lean();
    if (!next) {
      try {
        next = await MemoryNote.findOneAndUpdate({ _id: op.successorId }, { $setOnInsert: values },
          { new: true, upsert: true, runValidators: true, timestamps: false }).lean();
      } catch (error) {
        if (error.code !== 11000) throw error;
        next = await MemoryNote.findOne({ _id: op.successorId }).lean();
      }
    }
    if (!next || next.replacementKey !== key || next.replaces !== id || next.text !== text || next.packId !== old.packId
        || next.scopeId !== old.scopeId || next.scope !== scope || next.sensitivity !== sensitivity) {
      await MemoryNote.updateOne({ ...boundary, _id: id, 'replacement.key': key, 'replacement.phase': 'preparing' },
        { $set: { 'replacement.phase': 'failed' } }, { timestamps: false });
      throw fail('The successor identity belongs to another operation');
    }
    if (!['pending', 'active'].includes(next.status) || busy(next) || next.invalidatedAt || next.supersededBy) throw fail('The successor changed; reconcile the original operation');
    const successorHash = fingerprint({ ...next, status: 'active' });
    if (op.phase === 'preparing') {
      const linked = await MemoryNote.findOneAndUpdate({ ...boundary, _id: id, status: 'active', invalidatedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
        supersededBy: null, 'replacement.key': key, 'replacement.phase': 'preparing' },
      { $set: { invalidatedAt: op.effectiveAt, supersededBy: op.successorId,
        'replacement.phase': 'linked', 'replacement.successorHash': successorHash } }, { new: true, timestamps: false }).lean();
      if (!linked) {
        old = await get(id);
        if (old?.replacement?.key !== key || !['linked', 'applied'].includes(old.replacement.phase)) {
          if (old?.replacement?.key === key && old.replacement.phase === 'preparing') await abortPrelink(id, op);
          throw fail('The source changed before linking');
        }
      } else old = linked;
    } else if (old.supersededBy !== op.successorId || Number(old.invalidatedAt) !== Number(op.effectiveAt)
        || op.successorHash !== successorHash) throw fail('The committed replacement no longer matches');
    if (next.status === 'pending') {
      next = await MemoryNote.findOneAndUpdate({ _id: next._id, ...snapshot(next), replacementKey: key, rollbackKey: null },
        { $set: { status: 'active' } }, { new: true, timestamps: false }).lean();
      if (!next) {
        next = await get(op.successorId);
        if (!next || next.replacementKey !== key || fingerprint(next) !== successorHash) throw fail('The staged successor changed before activation');
      }
    }
    const applied = await MemoryNote.findOneAndUpdate({ ...boundary, _id: id, 'replacement.key': key,
      'replacement.phase': 'linked', supersededBy: op.successorId },
    { $set: { 'replacement.phase': 'applied' } }, { new: true, timestamps: false }).lean();
    if (!applied) {
      const completed = await get(id);
      if (completed?.replacement?.key === key && completed.replacement.phase === 'applied') return receipt(completed, true);
      throw fail('The replacement receipt needs reconciliation');
    }
    indexLater(next);
    return receipt(applied);
  }

  async function rollbackSupersession({ id, key }) {
    validate(id, key);
    let old = await get(id);
    const op = old?.replacement;
    if (!op || op.key !== key) throw fail('The original replacement is unavailable');
    if (op.phase === 'rolled_back') return { ok: true, id, key, alreadyRolledBack: true };
    if (!['applied', 'undoing'].includes(op.phase) || old.status !== 'active'
        || old.expiresAt && old.expiresAt <= new Date()) throw fail('The predecessor cannot be restored');
    let next = await get(op.successorId);
    if (!next || next.replacementKey !== key || next.replaces !== id || next.supersededBy || busy(next)) throw fail('The successor has changed or has its own replacement');
    const resuming = next.rollbackKey === key && ['pending', 'forgotten'].includes(next.status);
    if (!resuming) {
      if (!current(next) || fingerprint(next) !== op.successorHash) throw fail('The successor changed after application');
      next = await MemoryNote.findOneAndUpdate({ ...boundary, _id: next._id, ...snapshot(next), replacement: next.replacement || null },
        { $set: { status: 'pending', rollbackKey: key } }, { new: true, timestamps: false }).lean();
      if (!next) throw fail('The successor changed before rollback');
    }
    const restored = old.supersededBy === null && old.invalidatedAt === null && op.phase === 'undoing';
    if (!restored) {
      old = await MemoryNote.findOneAndUpdate({ ...boundary, _id: id, status: 'active', supersededBy: op.successorId,
        invalidatedAt: op.effectiveAt, 'replacement.key': key, 'replacement.phase': 'applied' },
      { $set: { invalidatedAt: null, supersededBy: null, 'replacement.phase': 'undoing' } }, { new: true, timestamps: false }).lean();
      if (!old) {
        await MemoryNote.updateOne({ ...boundary, _id: next._id, status: 'pending', rollbackKey: key },
          { $set: { status: 'active', rollbackKey: null } }, { timestamps: false });
        throw fail('The predecessor changed; rollback refused');
      }
    }
    await forget(String(next._id));
    const done = await MemoryNote.updateOne({ ...boundary, _id: id, status: 'active', invalidatedAt: null,
      supersededBy: null, 'replacement.key': key, 'replacement.phase': 'undoing' },
    { $set: { 'replacement.phase': 'rolled_back' } }, { timestamps: false });
    if (!done.matchedCount) throw fail('The rollback receipt needs reconciliation');
    return { ok: true, authority: 'agentx.core', id, key, forgottenSuccessorId: String(next._id) };
  }
  return { replacementSource, supersede, rollbackSupersession };
}

module.exports = { forNotes, fingerprint };
