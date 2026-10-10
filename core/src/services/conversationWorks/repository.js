'use strict';

const Model = require('../../../models/ConversationWorkState');
const Counter = require('../../../models/Counter');
const { acknowledged, withOwnerWrite } = require('../conversations/writeFence');
const { putPayload, readPayload } = require('../conversations/transcriptStore');
const { OWNER, LIMITS, fail, notFound } = require('./contract');

function createRepository({ model = Model, counter = Counter } = {}) {
  const collection = () => model.collection;
  const get = id => collection().findOne({ _id: id, owner: OWNER, erased: { $ne: true } });
  const payload = (row, value, fence) => putPayload(row.conversationId, value, { fence });
  const read = (row, ref) => readPayload(row.conversationId, ref);
  async function mutate(id, operation) {
    for (let i = 0; i < 12; i++) {
      const row = await get(id);
      if (!row) throw notFound();
      // Erasure and immutable payload publication share the canonical owner.
      const outcome = await withOwnerWrite(row.conversationId, async fence => {
        const current = await get(id);
        if (!current) throw notFound();
        const change = await operation(current, fence);
        if (!change) return { retry: false, row: current };
        const sequence = (await counter.findByIdAndUpdate('conversationWorkEvents', { $inc: { seq: 1 } },
          { new: true, upsert: true, writeConcern: acknowledged.writeConcern })).seq;
        const event = { sequence, type: change.event, at: new Date(), ...(change.eventData || {}) };
        const next = { ...current, ...change.fields, revision: current.revision + 1, updatedAt: event.at, sequence,
          events: [...current.events, event].slice(-LIMITS.events) };
        const result = await fence.mutate(() => collection().replaceOne({ _id: id, owner: OWNER,
          revision: current.revision, erased: { $ne: true } }, next, acknowledged));
        return result.matchedCount === 1 ? { row: next } : { retry: true };
      });
      if (!outcome.retry) return outcome.row;
    }
    throw fail('CONVERSATION_WORK_CONFLICT', 'Work changed concurrently. Read its current state.', 409);
  }
  async function insert(row) {
    return withOwnerWrite(row.conversationId, async fence => {
      const previous = await get(row._id);
      if (previous) return previous;
      const sequence = (await counter.findByIdAndUpdate('conversationWorkEvents', { $inc: { seq: 1 } },
        { new: true, upsert: true, writeConcern: acknowledged.writeConcern })).seq;
      row = { ...row, sequence, events: [{ sequence, type: 'request_received', at: row.receivedAt }] };
      await fence.mutate(() => collection().updateOne({ _id: row._id, owner: OWNER },
        { $setOnInsert: row }, { ...acknowledged, upsert: true }));
      return get(row._id);
    });
  }
  const find = (query, limit = 100, sort = { receivedAt: 1, _id: 1 }) => collection().find({ owner: OWNER, erased: { $ne: true }, ...query })
    .sort(sort).limit(limit).toArray();
  return { get, mutate, insert, find, payload, read, collection, getIncludingErased: id => collection().findOne({ _id: id, owner: OWNER }) };
}
module.exports = { createRepository };
