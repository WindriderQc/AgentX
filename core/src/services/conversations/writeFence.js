'use strict';

const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');

const acknowledged = { writeConcern: { w: 'majority', j: true } };
const contexts = new WeakSet();
const collection = () => mongoose.connection.collection('conversation_write_fences');
const error = (code, message, statusCode = 503) => Object.assign(new Error(message), { code, statusCode });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function uncertainMutation(cause) {
  // A server rejection acknowledges the end of that command. A transport or
  // write-concern failure does not prove that the command stopped in MongoDB.
  return !(cause?.name === 'MongoServerError' && cause.code !== 64
    && !cause.writeConcernError && !cause.errInfo?.writeConcern);
}

async function ensure(owner) {
  try {
    await collection().updateOne({ _id: owner }, { $setOnInsert: {
      token: null, state: 'OPEN', eraseRequested: false
    } }, { ...acknowledged, upsert: true });
  } catch (cause) {
    if (cause.code !== 11000) throw cause;
  }
}

function owns(fence, owner) {
  return contexts.has(fence) && fence.owner === String(owner);
}

async function run(owner, erase, action, { fence, waitMs = 2_000 } = {}) {
  owner = String(owner);
  if (owns(fence, owner)) {
    if (erase && !fence.erasing) throw error('CONVERSATION_FENCE_INVALID', 'Erasure requires its own barrier.');
    return action(fence);
  }
  await ensure(owner);
  if (erase) await collection().updateOne({ _id: owner }, { $set: { eraseRequested: true } }, acknowledged);
  const token = randomUUID();
  const until = Date.now() + waitMs;
  let acquired;
  do {
    acquired = await collection().findOneAndUpdate({ _id: owner, token: null, state: { $ne: 'UNKNOWN' },
      eraseRequested: erase }, { $set: { token, acquiredAt: new Date() } },
    { ...acknowledged, returnDocument: 'after', includeResultMetadata: false });
    if (acquired) break;
    const current = await collection().findOne({ _id: owner });
    if (!erase && current?.eraseRequested) {
      throw error('CONVERSATION_CONTENT_ERASED', 'The content is being erased or has been erased.', 410);
    }
    if (current?.state === 'UNKNOWN') {
      throw error('CONVERSATION_WRITE_RECOVERY_REQUIRED', 'A previous content mutation has an unknown outcome.');
    }
    if (Date.now() >= until) {
      throw error(erase ? 'CONVERSATION_ERASURE_PENDING' : 'CONVERSATION_WRITE_BUSY',
        erase ? 'Erasure is pending an already admitted writer; it has not completed.'
          : 'Another admitted content writer has not settled.');
    }
    await sleep(Math.min(25, Math.max(1, until - Date.now())));
  } while (true);

  let unknown = false, acceptingMutations = true, mutationFailure;
  const pending = new Set();
  const context = Object.freeze({ owner, erasing: erase,
    mutate(operation) {
      if (!acceptingMutations || !contexts.has(context)) {
        return Promise.reject(error('CONVERSATION_FENCE_INVALID', 'This content writer has already settled.'));
      }
      const mutation = Promise.resolve().then(operation).catch(cause => {
        unknown ||= uncertainMutation(cause);
        mutationFailure ||= cause;
        throw cause;
      });
      pending.add(mutation);
      // Retain ownership even if a caller neglects to await its admitted write.
      mutation.then(() => pending.delete(mutation), () => pending.delete(mutation));
      return mutation;
    }
  });
  contexts.add(context);
  let outcome, failure;
  try { outcome = await action(context); }
  catch (cause) { failure = cause; }
  acceptingMutations = false;
  await Promise.allSettled([...pending]);
  failure ||= mutationFailure;
  try {
    const settled = await collection().updateOne({ _id: owner, token }, { $set: unknown
      ? { state: 'UNKNOWN', unknownAt: new Date() }
      : { token: null, state: erase && !failure ? 'ERASED' : 'OPEN', settledAt: new Date() } }, acknowledged);
    if (settled.matchedCount !== 1) {
      throw error('CONVERSATION_WRITE_RECOVERY_REQUIRED', 'The exact content writer fence no longer matches.');
    }
  } catch (cause) {
    failure ||= cause;
  } finally { contexts.delete(context); }
  if (failure) throw failure;
  return outcome;
}

// There is deliberately no TTL or automatic lock takeover. A dead writer or
// unknown Mongo command cannot authorize successful erasure or late writes.
const withOwnerWrite = (owner, action, options) => run(owner, false, action, options);
const eraseOwner = (owner, action, options) => run(owner, true, action, options);

module.exports = { withOwnerWrite, eraseOwner, owns, acknowledged };
