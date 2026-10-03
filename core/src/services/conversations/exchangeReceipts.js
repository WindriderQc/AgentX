'use strict';

const mongoose = require('mongoose');
const { randomUUID, createHash } = require('node:crypto');
const { serialize, calculateObjectSize } = require('bson');
const { putPayload, readPayload, eraseTranscript } = require('./transcriptStore');
const { withOwnerWrite, eraseOwner, acknowledged } = require('./writeFence');

const receipts = () => mongoose.connection.collection('conversation_exchange_receipts');
const packets = () => mongoose.connection.collection('conversation_exchange_packets');
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (code, message, statusCode = 503) => Object.assign(new Error(message), { code, statusCode });
const ownerOf = id => 'exchange:' + id;
const closed = receipt => !receipt || ['erasing', 'erased'].includes(receipt.state);
const scoped = (scope, action) => withOwnerWrite('exchange-scope:' + digest(scope), action);
const conversationWriter = (id, action) => id ? withOwnerWrite(String(id), action) : action();
const erasedTurn = (scope, clientTurnId) => receipts().findOne({ scope,
  state: { $in: ['erasing', 'erased'] },
  $or: [{ _id: digest(scope + '\n' + clientTurnId) }, { clientTurnId }] }, { projection: { _id: 1 } });

async function accept(scope, request, key, conversationId) {
  if (!scope) throw failure('EXCHANGE_SCOPE_REQUIRED', 'A trusted conversation scope is required.');
  if (key != null && (typeof key !== 'string' || !key.length || key.length > 260)) {
    throw failure('EXCHANGE_KEY_INVALID', 'A request identity must be a string of 1 to 260 characters.', 400);
  }
  const fingerprint = digest(serialize(request, { minInternalBufferSize: calculateObjectSize(request) + 1024 }));
  const id = key ? digest(scope + '\n' + key) : randomUUID();
  try {
    return await scoped(scope, async () => {
      if (typeof request.body?.clientTurnId === 'string' && /^[\x21-\x7e]{1,160}$/.test(request.body.clientTurnId)
        && await erasedTurn(scope, request.body.clientTurnId)) {
        throw failure('EXCHANGE_ERASED', 'This turn was explicitly erased and cannot be accepted again.', 410);
      }
      return conversationWriter(conversationId, () => withOwnerWrite(ownerOf(id), async fence => {
      let receipt = await receipts().findOne({ _id: id, scope });
      if (!receipt) {
        receipt = { _id: id, scope, fingerprint, state: 'preparing',
          ...(typeof request.body?.clientTurnId === 'string' && /^[\x21-\x7e]{1,160}$/.test(request.body.clientTurnId)
            ? { clientTurnId: request.body.clientTurnId } : {}),
          ...(conversationId ? { conversationId: String(conversationId) } : {}), createdAt: new Date() };
        await fence.mutate(() => receipts().insertOne(receipt, acknowledged));
      }
      if (closed(receipt)) throw failure('EXCHANGE_ERASED', 'This exchange was explicitly erased and cannot be replayed.', 410);
      if (receipt.fingerprint !== fingerprint) throw failure('EXCHANGE_KEY_CONFLICT', 'This request identity already belongs to different content.', 409);
      if (receipt.state !== 'preparing') return { receipt, duplicate: true };
      const requestRef = await putPayload(ownerOf(id), request, { fence });
      const result = await fence.mutate(() => receipts().updateOne({ _id: id, scope, state: 'preparing' },
        { $set: { requestRef, state: 'accepted' } }, acknowledged));
      if (!result.matchedCount) throw failure('EXCHANGE_CLOSED', 'The exchange was closed while accepting its request.');
      return { receipt: { ...receipt, requestRef, state: 'accepted' }, duplicate: false };
      }));
    });
  } catch (cause) {
    if (cause.code === 'CONVERSATION_CONTENT_ERASED') {
      throw failure('EXCHANGE_ERASED', 'This exchange or conversation was explicitly erased and cannot be replayed.', 410);
    }
    throw cause;
  }
}

async function append(receipt, sequence, bytes) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw failure('EXCHANGE_SEQUENCE_INVALID', 'Response packet sequence is invalid.', 400);
  const data = Buffer.from(bytes);
  try {
    return await withOwnerWrite(ownerOf(receipt._id), async fence => {
      if (!await receipts().findOne({ _id: receipt._id, scope: receipt.scope, state: 'accepted' })) {
        throw failure('EXCHANGE_CLOSED', 'The exchange was closed or erased; delivery stopped.');
      }
      await fence.mutate(() => packets().insertOne({ _id: receipt._id + ':' + sequence, receiptId: receipt._id,
        scope: receipt.scope, sequence, data, sha256: digest(data), createdAt: new Date() }, acknowledged));
    });
  } catch (cause) {
    if (cause.code === 'CONVERSATION_CONTENT_ERASED') throw failure('EXCHANGE_CLOSED', 'The exchange was erased; delivery stopped.');
    throw cause;
  }
}

async function eraseRows(filter, scope, scopeFence) {
  const cursor = receipts().find({ ...filter, scope }, { projection: { _id: 1, scope: 1, conversationId: 1 } });
  let erased = 0;
  for await (const row of cursor) {
    // The scope gate stops new accepts. Existing packet writers may finish,
    // but successful erasure waits for their exact durable owner fence.
    await scopeFence.mutate(() => receipts().updateOne({ _id: row._id, scope },
      { $set: { state: 'erasing' } }, acknowledged));
    await eraseOwner(ownerOf(row._id), async fence => {
      await fence.mutate(() => receipts().updateOne({ _id: row._id, scope }, {
        $set: { state: 'erased', ...(row.conversationId ? { erasureConversationId: row.conversationId } : {}) },
        $unset: { requestRef: '', response: '', conversationId: '', createdAt: '', updatedAt: '' }
      }, acknowledged));
      await fence.mutate(() => packets().deleteMany({ receiptId: row._id, scope }, acknowledged));
      await eraseTranscript(ownerOf(row._id), { fence });
    });
    erased++;
  }
  return erased;
}

async function finish(receipt, state, response) {
  if (!['completed', 'interrupted'].includes(state)) throw failure('EXCHANGE_STATE_INVALID', 'Exchange terminal state is invalid.', 400);
  return scoped(receipt.scope, async scopeFence => {
    try {
      return await conversationWriter(response.conversationId || receipt.conversationId, () =>
        withOwnerWrite(ownerOf(receipt._id), async fence => {
          const result = await fence.mutate(() => receipts().updateOne({ _id: receipt._id, scope: receipt.scope, state: 'accepted' },
            { $set: { state, response, ...(response.conversationId ? { conversationId: String(response.conversationId) } : {}),
              updatedAt: new Date() } }, acknowledged));
          if (!result.matchedCount) throw failure('EXCHANGE_CLOSED', 'The exchange is already closed or erased.');
        }));
    } catch (cause) {
      if (cause.code === 'CONVERSATION_CONTENT_ERASED') {
        await eraseRows({ _id: receipt._id }, receipt.scope, scopeFence);
        throw failure('EXCHANGE_CLOSED', 'The exchange or its conversation was erased.');
      }
      throw cause;
    }
  });
}

// Canonical publication is short and shares the eraser's scope gate; inference
// itself never holds this gate. Bind the generated conversation before saving
// so a crash cannot leave an accepted exchange outside that conversation's
// deletion boundary.
async function publish(receipt, conversationId, action) {
  return scoped(receipt.scope, async scopeFence => {
    try {
      return await conversationWriter(conversationId, async rootFence => {
        await withOwnerWrite(ownerOf(receipt._id), async fence => {
          const result = await fence.mutate(() => receipts().updateOne({ _id: receipt._id,
            scope: receipt.scope, state: 'accepted' }, { $set: { conversationId: String(conversationId) } }, acknowledged));
          if (!result.matchedCount) throw failure('EXCHANGE_CLOSED', 'The exchange was erased before its conversation could be saved.', 410);
        });
        return rootFence.mutate(action);
      });
    } catch (cause) {
      if (cause.code === 'CONVERSATION_CONTENT_ERASED') {
        await eraseRows({ _id: receipt._id }, receipt.scope, scopeFence);
        throw failure('EXCHANGE_CLOSED', 'The conversation was erased before its reply could be saved.', 410);
      }
      throw cause;
    }
  });
}

async function eraseCanonical(scope, conversationId, action, { clientTurnIds = [] } = {}) {
  return scoped(scope, async scopeFence => {
    // Older conversations may have no exchange receipt. Keep only their stable
    // turn identities so a late browser outcome cannot recreate erased content.
    for (const clientTurnId of clientTurnIds) {
      await scopeFence.mutate(() => receipts().updateOne({ _id: digest(scope + '\n' + clientTurnId), scope },
        { $set: { state: 'erasing', clientTurnId }, $setOnInsert: { scope } }, { ...acknowledged, upsert: true }));
    }
    const filter = { $or: [{ conversationId: String(conversationId) },
      { erasureConversationId: String(conversationId) },
      ...(clientTurnIds.length ? [{ clientTurnId: { $in: clientTurnIds } }] : [])] };
    await scopeFence.mutate(() => receipts().updateMany({ ...filter, scope },
      { $set: { state: 'erasing' } }, acknowledged));
    const result = await eraseOwner(String(conversationId), async fence => {
      const deleted = await fence.mutate(action);
      await eraseTranscript(String(conversationId), { fence });
      return deleted;
    });
    await eraseRows(filter, scope, scopeFence);
    return result;
  });
}

// A browser may post a stopped/failed outcome after the original HTTP request
// closes. Its stable turn identity must not restore content explicitly erased
// through either the conversation or receipt route.
async function guardTurn(scope, clientTurnId, action) {
  return scoped(scope, async fence => {
    const erased = await erasedTurn(scope, clientTurnId);
    if (erased) throw failure('EXCHANGE_ERASED', 'This turn was explicitly erased and cannot be saved again.', 410);
    return action(fence);
  });
}

async function read(scope, id) {
  if (closed(await receipts().findOne({ _id: id, scope }))) return null;
  try {
    return await withOwnerWrite(ownerOf(id), async () => {
      const receipt = await receipts().findOne({ _id: id, scope });
      if (closed(receipt)) return null;
      const output = await packets().find({ receiptId: id, scope }).sort({ sequence: 1 }).toArray();
      let sequence = 0;
      const data = output.map(row => {
        const bytes = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data.buffer);
        if (row.sequence !== sequence++ || digest(bytes) !== row.sha256) {
          throw failure('EXCHANGE_INTEGRITY_FAILED', 'Stored response integrity failed; incomplete data was not returned.');
        }
        return bytes;
      });
      if (receipt.state === 'completed' && receipt.response?.packets !== output.length) {
        throw failure('EXCHANGE_INTEGRITY_FAILED', 'The response packet count does not match its completion receipt.');
      }
      return { id, state: receipt.state, createdAt: receipt.createdAt,
        request: await readPayload(ownerOf(id), receipt.requestRef),
        response: { ...receipt.response, body: Buffer.concat(data).toString('utf8') },
        // An accepted receipt after a crash never authorizes replay.
        complete: receipt.state === 'completed' };
    });
  } catch (cause) {
    if (cause.code === 'CONVERSATION_CONTENT_ERASED') return null;
    throw cause;
  }
}

async function listRecoverable(scope, { cursor } = {}) {
  const filter = { scope, state: { $in: ['accepted', 'interrupted', 'completed'] },
    $or: [{ state: { $ne: 'completed' } }, { conversationId: { $exists: false } },
      { 'response.statusCode': { $gte: 400 } }] };
  if (cursor) {
    try {
      if (typeof cursor !== 'string' || !/^[\w-]{1,200}$/.test(cursor)) throw new Error();
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      const at = new Date(value.createdAt);
      if (typeof value.createdAt !== 'string' || !Number.isFinite(at.getTime())
        || typeof value.id !== 'string' || !/^[\w-]{1,64}$/.test(value.id)) throw new Error();
      filter.$and = [{ $or: [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: value.id } }] }];
    } catch { throw failure('EXCHANGE_CURSOR_INVALID', 'Saved exchange cursor is invalid.', 400); }
  }
  const rows = await receipts().find(filter,
  { projection: { _id: 1, state: 1, createdAt: 1, 'response.statusCode': 1 } })
    .sort({ createdAt: -1, _id: -1 }).limit(51).toArray();
  const last = rows[49];
  const nextCursor = rows.length > 50 ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last._id }))
    .toString('base64url') : null;
  return { items: rows.slice(0, 50).map(row => ({ id: row._id, state: row.state, createdAt: row.createdAt,
    statusCode: row.response?.statusCode || null })), nextCursor };
}

async function eraseMatching(filter) {
  const scopes = await receipts().distinct('scope', filter);
  for (const scope of scopes) await scoped(scope, fence => eraseRows(filter, scope, fence));
}
const eraseScope = scope => scoped(scope, fence => eraseRows({}, scope, fence));
const eraseOne = (scope, id) => scoped(scope, fence => eraseRows({ _id: id }, scope, fence));
async function eraseConversation(conversationId) {
  await eraseTranscript(String(conversationId));
  await eraseMatching({ $or: [{ conversationId: String(conversationId) }, { erasureConversationId: String(conversationId) }] });
}
const resumeErasure = () => eraseMatching({ state: { $in: ['erasing', 'erased'] } });

module.exports = { resumeErasure, accept, append, finish, read, eraseScope, eraseConversation, eraseOne,
  publish, eraseCanonical, guardTurn, listRecoverable };
