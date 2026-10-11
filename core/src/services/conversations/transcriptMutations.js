'use strict';

const mongoose = require('mongoose');
const store = require('./transcriptStore');
const exchanges = require('./exchangeReceipts');
const { withOwnerWrite, eraseOwner, currentFence, acknowledged } = require('./writeFence');
const { applyMessageUpdate } = require('./transcriptUpdates');
const { internal, hasMessages, messageField, matchingRoots, exactRootFilter, configureProjection } = require('./transcriptQueries');
const saving = new WeakSet();
const nativeSave = mongoose.Model.prototype.save;
const refusal = message => Object.assign(new Error(message), { code: 'CONVERSATION_TRANSCRIPT_UNSUPPORTED_WRITE', statusCode: 503 });
const conflict = row => Object.assign(new mongoose.Error.VersionError({ _doc: row }, row.__v, ['messages']),
  { code: 'CONVERSATION_WRITE_CONFLICT', statusCode: 409 });

function restoreMessages(doc, messages, failed) {
  if (!messages) return;
  doc.$__setValue('messages', messages);
  if (failed) doc.markModified('messages');
  else {
    for (const child of doc.$getAllSubdocs()) {
      child.$isNew = false;
      for (const path of child.modifiedPaths()) child.unmarkModified(path);
    }
    doc.unmarkModified('messages');
  }
}

async function save(options = {}) {
  if (saving.has(this)) throw new mongoose.Error.ParallelSaveError(this);
  if (this.$locals.transcriptPartial && this.isModified('messages')) {
    throw refusal('A partially selected transcript cannot replace the full conversation.');
  }
  saving.add(this);
  const originalWhere = this.$where;
  let messages, failed = true;
  try {
    const result = await withOwnerWrite(this._id, async fence => {
      if (fence.erasing) throw refusal('An erasure barrier cannot save conversation content.');
      if (options.validateBeforeSave !== false) await this.validate(options);
      if (!this.isNew) {
        const row = await this.constructor.collection.findOne({ _id: this._id });
        if (!row) throw new mongoose.Error.DocumentNotFoundError({ _id: this._id });
        if (row.__v !== this.__v) throw conflict(row);
        const owner = this.$locals.transcriptLoadedOwner ?? this.userId;
        if (owner != null && row.userId !== owner) throw new mongoose.Error.DocumentNotFoundError({ _id: this._id, userId: owner });
        const where = { ...(originalWhere || {}), ...(owner != null ? { userId: owner } : {}) };
        if (hasMessages(where)) {
          const found = await matchingRoots(this.constructor, { $and: [{ _id: this._id }, where] });
          if (!found.length) throw new mongoose.Error.DocumentNotFoundError(where);
        }
        this.$where = await exactRootFilter(this.constructor, row, where);
      }
      if (this.isNew || this.isModified('messages')) {
        messages = this.messages;
        if (this.surfaceSession) await store.reserveTurnIdentities(this._id, this.surface, messages, { fence });
        this.transcript = await store.writeTranscript(this._id, messages, { fence });
        this.set('messages', []);
        this.markModified('messages');
      }
      return fence.mutate(() => nativeSave.call(this, { ...options, validateBeforeSave: false, writeConcern: acknowledged.writeConcern }));
    });
    failed = false;
    return result;
  } catch (error) {
    if (error.name === 'VersionError') { error.code = 'CONVERSATION_WRITE_CONFLICT'; error.statusCode = 409; }
    throw error;
  } finally {
    this.$where = originalWhere;
    restoreMessages(this, messages, failed);
    saving.delete(this);
  }
}

function mappedUpdate(update) {
  const mapped = {};
  for (const [operator, fields] of Object.entries(update)) {
    if (!operator.startsWith('$') || !fields || typeof fields !== 'object') throw refusal('Use explicit conversation update operators.');
    mapped[operator] = Object.fromEntries(Object.entries(fields).filter(([key]) => !messageField(key)));
    if (!Object.keys(mapped[operator]).length) delete mapped[operator];
  }
  mapped.$inc = { ...mapped.$inc, __v: 1 };
  return mapped;
}

// Embedded session timestamps are inserted by Mongoose before this hook.
// Cleanup can settle an erased tombstone, but cannot introduce any content.
const cleanupOnly = update => update.$set?.['surfaceSession.deleteCleanupPending'] === false
  && Object.keys(update).every(key => ['$set', '$setOnInsert'].includes(key))
  && Object.keys(update.$set).every(key => ['surfaceSession.deleteCleanupPending', 'surfaceSession.updatedAt'].includes(key))
  && Object.keys(update.$setOnInsert || {}).every(key => key === 'surfaceSession.createdAt');

async function update() {
  if (this[internal]) return;
  configureProjection.call(this);
  const changes = this.getUpdate(), options = this.getOptions();
  if (Array.isArray(changes) || options.upsert) throw refusal('Conversation query upserts and pipeline updates require an explicit implementation.');
  this.cast(this.model);
  const filter = this.getFilter(), candidates = await matchingRoots(this.model, filter);
  let matchedCount = 0, result = null;
  for (const candidate of candidates) {
    const action = async fence => {
      const rows = await matchingRoots(this.model, { $and: [filter, { _id: candidate._id }] });
      const raw = rows[0];
      if (!raw) return;
      const finalFilter = await exactRootFilter(this.model, raw, filter);
      const mapped = mappedUpdate(changes);
      if (hasMessages(changes)) {
        raw.messages = raw.transcript ? await store.readTranscript(raw._id, raw.transcript) : raw.messages || [];
        const edited = applyMessageUpdate(raw.messages, changes, options.arrayFilters);
        const validated = this.model.hydrate({ ...raw, messages: edited });
        await validated.validate();
        if (raw.surfaceSession) await store.reserveTurnIdentities(raw._id, raw.surface, validated.messages, { fence });
        mapped.$set = { ...mapped.$set, messages: [], transcript: await store.writeTranscript(raw._id, validated.messages, { fence }) };
      }
      const query = this.model.findOneAndUpdate(finalFilter, mapped,
        { ...options, ...(this.op === 'findOneAndUpdate' ? {} : { new: true, returnDocument: 'after' }),
          arrayFilters: undefined, writeConcern: acknowledged.writeConcern });
      if (this.projection()) query.select(this.projection());
      // The outer query hydrates its selected before/after snapshot once.
      query._hydrateTranscript = false;
      query[internal] = true;
      // Native Mongoose casts/validates the non-message operators; message
      // arrays have been validated above and share this same root command.
      const saved = await fence.mutate(() => query.exec());
      if (!saved) throw conflict(raw);
      matchedCount++;
      result = saved;
      if (this._mongooseOptions.lean && result?.toObject) result = result.toObject();
    };
    if (candidate.surfaceSession?.deletedAt && cleanupOnly(changes)) await eraseOwner(candidate._id, action);
    else await withOwnerWrite(candidate._id, action);
    if (this.op !== 'updateMany' && matchedCount) break;
  }
  throw mongoose.skipMiddlewareFunction(this.op === 'findOneAndUpdate' ? result
    : { acknowledged: true, matchedCount, modifiedCount: matchedCount });
}

async function erase() {
  if (this[internal]) return;
  this.cast(this.model);
  const filter = this.getFilter(), candidates = await matchingRoots(this.model, filter);
  let deletedCount = 0, returned = null;
  const replacement = ['replaceOne', 'findOneAndReplace'].includes(this.op);
  if (replacement && (!this.getUpdate()?.surfaceSession?.deletedAt || this.getUpdate()?.messages?.length)) {
    throw refusal('Use save() to replace conversation content; query replacement is reserved for session erasure.');
  }
  for (const candidate of candidates) {
    const inherited = currentFence(candidate._id)?.erasing;
    await eraseOwner(candidate._id, async fence => {
      const rows = await matchingRoots(this.model, { $and: [filter, { _id: candidate._id }] });
      const raw = rows[0];
      if (!raw) throw new mongoose.Error.DocumentNotFoundError(filter);
      const finalFilter = await exactRootFilter(this.model, raw, filter);
      let query;
      if (replacement) {
        query = this.model.findOneAndReplace(finalFilter, { ...this.getUpdate(), __v: (raw.__v || 0) + 1 },
          { ...this.getOptions(), new: true, returnDocument: 'after', writeConcern: acknowledged.writeConcern });
      } else query = this.model.findOneAndDelete(finalFilter, { ...this.getOptions(), writeConcern: acknowledged.writeConcern });
      query[internal] = true;
      query._hydrateTranscript = false;
      const saved = await fence.mutate(() => query.exec());
      if (!saved) throw new mongoose.Error.DocumentNotFoundError(finalFilter);
      await fence.mutate(() => mongoose.connection.collection('conversation_work_states').updateMany(
        { conversationId: String(candidate._id) }, { $set: { erased: true, state: 'cancelled' },
          $unset: Object.fromEntries(['conversationId', 'sessionId', 'turnId', 'exchangeId', 'requestSha256',
            'contextRef', 'guardian', 'result', 'tools', 'nativeAdmissions', 'events', 'delivery', 'reason', 'classification'].map(key => [key, ''])) }, acknowledged));
      await store.eraseTranscript(candidate._id, { fence });
      returned = saved;
      deletedCount++;
    });
    // Canonical exchange erasure owns its scope-before-root ordering and will
    // purge receipts after this inherited root barrier settles.
    if (!inherited) await exchanges.eraseConversation(candidate._id);
    if (!['deleteMany'].includes(this.op)) break;
  }
  if (this._mongooseOptions.lean && returned?.toObject) returned = returned.toObject();
  throw mongoose.skipMiddlewareFunction(['findOneAndDelete', 'findOneAndReplace'].includes(this.op) ? returned
    : replacement ? { acknowledged: true, matchedCount: deletedCount, modifiedCount: deletedCount }
      : { acknowledged: true, deletedCount });
}

function install(schema) {
  // Mongoose create() uses $save; direct consumers use save(). Both delegate
  // to the real native save under the same durable owner context.
  schema.method('save', save, { suppressWarning: true });
  schema.method('$save', save, { suppressWarning: true });
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], update);
  schema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne', 'findOneAndReplace'], erase);
  schema.statics.insertMany = async function(docs, options = {}) {
    if (options.rawResult || options.lean || options.ordered === false) throw refusal('Raw or unordered bulk conversation inserts require an explicit implementation.');
    const inputs = (Array.isArray(docs) ? docs : [docs]).map(input => new this(input));
    // Ordered native inserts validate the entire batch before sending it.
    for (const row of inputs) await row.validate();
    const rows = [];
    for (const row of inputs) {
      row.$locals.transcriptBulkInsert = true;
      try { rows.push(await row.$save(options)); }
      finally { delete row.$locals.transcriptBulkInsert; }
    }
    return rows;
  };
  schema.pre('bulkWrite', function() { throw refusal('Bulk conversation writes require an explicit transcript implementation.'); });
}

module.exports = { install };
