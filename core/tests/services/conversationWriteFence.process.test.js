'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');
const mongoose = require('mongoose');
const Conversation = require('../../models/Conversation');
const exchanges = require('../../src/services/conversations/exchangeReceipts');
const transcripts = require('../../src/services/conversations/transcriptStore');
const { withOwnerWrite, eraseOwner } = require('../../src/services/conversations/writeFence');
const { MongoNetworkError, MongoServerError } = require('mongodb');
const children = new Set();
const collection = name => mongoose.connection.collection(name);
const fences = () => collection('conversation_write_fences');

function writer(input) {
  const child = fork(path.join(__dirname, '../fixtures/conversationStorageFence.child.js'), [], {
    env: { ...process.env, CONVERSATION_FENCE_INPUT: JSON.stringify(input) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  children.add(child);
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  const messages = [], waiting = [];
  child.on('message', value => {
    const request = waiting.shift();
    if (request) { clearTimeout(request.timer); request.resolve(value); }
    else messages.push(value);
  });
  const exited = new Promise(resolve => child.once('exit', code => {
    children.delete(child);
    for (const request of waiting.splice(0)) {
      clearTimeout(request.timer); request.reject(new Error(`Child exited ${code}: ${stderr}`));
    }
    resolve(code);
  }));
  return {
    child, exited,
    next() {
      if (messages.length) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const request = { resolve, reject };
        request.timer = setTimeout(() => reject(new Error('Writer fixture did not reach its boundary')), 10000);
        waiting.push(request);
      });
    },
    resume: () => child.send({ event: 'resume' })
  };
}

beforeEach(async () => {
  for (const name of ['conversation_write_fences', 'conversation_exchange_receipts',
    'conversation_exchange_packets', 'conversation_payload_chunks', 'conversation_transcript_pages',
    'conversation_turn_identities', 'conversations']) {
    await collection(name).deleteMany({});
  }
});

test('model root publication and erasure remain fenced across independent Core workers', async () => {
  const row = await Conversation.create({ userId: 'model-erasure', messages: [{ role: 'user', content: 'Original' }] });
  const peer = writer({ action: 'modelAppend', owner: String(row._id), userId: row.userId, trace: 'late-turn',
    pauseCollection: 'conversations', pauseMethod: 'findOneAndUpdate' });
  expect((await peer.next()).event).toBe('paused');
  let completed = false;
  const erasure = Conversation.deleteOne({ _id: row._id, userId: row.userId }).then(() => { completed = true; });
  for (let i = 0; i < 100 && !await fences().findOne({ _id: String(row._id), eraseRequested: true }); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(await fences().findOne({ _id: String(row._id), eraseRequested: true })).toBeTruthy();
  expect(completed).toBe(false);
  peer.resume();
  expect((await peer.next()).event).toBe('result');
  expect(await peer.exited).toBe(0);
  await erasure;
  expect(await Conversation.collection.countDocuments({ _id: row._id })).toBe(0);
  for (const name of ['conversation_transcript_pages', 'conversation_payload_chunks']) {
    expect(await collection(name).countDocuments({ owner: String(row._id) })).toBe(0);
  }
  await expect(new Conversation({ _id: row._id, messages: [{ role: 'user', content: 'Resurrection' }] }).save())
    .rejects.toMatchObject({ code: 'CONVERSATION_CONTENT_ERASED' });
});

test.each([true, false])('separate model workers preserve exact-once counters and distinct turns (same identity: %s)', async same => {
  const row = await Conversation.create({ userId: 'model-race', messages: [{ role: 'user', content: 'Original' }] });
  const first = writer({ action: 'modelAppend', owner: String(row._id), userId: row.userId, trace: 'first',
    pauseCollection: 'conversations', pauseMethod: 'findOneAndUpdate' });
  expect((await first.next()).event).toBe('paused');
  const second = writer({ action: 'modelAppend', owner: String(row._id), userId: row.userId, trace: same ? 'first' : 'second' });
  first.resume();
  expect((await first.next()).event).toBe('result');
  expect((await second.next()).event).toBe('result');
  expect(await first.exited).toBe(0);
  expect(await second.exited).toBe(0);
  const saved = await Conversation.findById(row._id).lean();
  expect(saved.messages).toHaveLength(same ? 2 : 3);
  expect(saved.usage.totalTokens).toBe(same ? 1 : 2);
});

test('final model publication retains owner predicates even if a raw writer changes scope without incrementing version', async () => {
  const row = await Conversation.create({ userId: 'original-owner', messages: [{ role: 'user', content: 'Original' }] });
  const peer = writer({ action: 'modelAppend', owner: String(row._id), userId: row.userId, trace: 'scope-race',
    pauseCollection: 'conversations', pauseMethod: 'findOneAndUpdate' });
  expect((await peer.next()).event).toBe('paused');
  await Conversation.collection.updateOne({ _id: row._id }, { $set: { userId: 'new-owner' } });
  peer.resume();
  expect(await peer.next()).toMatchObject({ event: 'failure', code: 'CONVERSATION_WRITE_CONFLICT' });
  expect(await peer.exited).toBe(1);
  const raw = await Conversation.collection.findOne({ _id: row._id });
  expect(raw.transcript).toEqual(row.transcript);
  expect(raw.usage.totalTokens).toBe(0);
  expect(await fences().findOne({ _id: String(row._id), token: null, state: 'OPEN' })).toBeTruthy();
});

test('a killed model publisher keeps its writer and erasure pending rather than guessing whether publication settled', async () => {
  const row = await Conversation.create({ userId: 'model-crash', messages: [{ role: 'user', content: 'Original' }] });
  const peer = writer({ action: 'modelAppend', owner: String(row._id), userId: row.userId, trace: 'crashed',
    pauseCollection: 'conversations', pauseMethod: 'findOneAndUpdate' });
  expect((await peer.next()).event).toBe('paused');
  peer.child.kill('SIGKILL'); await peer.exited;
  await expect(Conversation.deleteOne({ _id: row._id })).rejects.toMatchObject({ code: 'CONVERSATION_ERASURE_PENDING' });
  expect(await fences().findOne({ _id: String(row._id), token: { $ne: null }, eraseRequested: true })).toBeTruthy();
  const raw = await Conversation.collection.findOne({ _id: row._id });
  expect(raw.transcript).toEqual(row.transcript);
  expect((await transcripts.readTranscript(row._id, raw.transcript)).map(message => message.content)).toEqual(['Original']);
});
afterEach(async () => {
  await Promise.all([...children].map(child => new Promise(resolve => {
    child.once('exit', resolve); child.kill('SIGKILL');
  })));
});

test('erasure waits for a separate worker already admitted to insert a response packet', async () => {
  const { receipt } = await exchanges.accept('synthetic:owner', { body: { message: 'Original' } }, 'racing-packet');
  const peer = writer({ action: 'append', receipt, pauseCollection: 'conversation_exchange_packets', pauseMethod: 'insertOne' });
  expect(await peer.next()).toEqual({ event: 'paused' });
  let completed = false;
  const erasure = exchanges.eraseOne(receipt.scope, receipt._id).then(() => { completed = true; });
  // Wait for the durable barrier, rather than assuming a scheduler delay.
  for (let i = 0; i < 100 && !await fences().findOne({ _id: `exchange:${receipt._id}`, eraseRequested: true }); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(await fences().findOne({ _id: `exchange:${receipt._id}`, eraseRequested: true })).toBeTruthy();
  expect(completed).toBe(false);
  peer.resume();
  expect((await peer.next()).event).toBe('result');
  expect(await peer.exited).toBe(0);
  await erasure;
  expect(await collection('conversation_exchange_packets').countDocuments({ receiptId: receipt._id })).toBe(0);
  expect(await collection('conversation_payload_chunks').countDocuments({ owner: `exchange:${receipt._id}` })).toBe(0);
  await expect(exchanges.append(receipt, 1, Buffer.from('Another late byte'))).rejects.toMatchObject({ code: 'EXCHANGE_CLOSED' });
});

test('scope erasure includes a separate worker still saving an accepted request', async () => {
  const peer = writer({ action: 'accept', scope: 'synthetic:scope', key: 'accept-race',
    pauseCollection: 'conversation_payload_chunks', pauseMethod: 'updateOne' });
  expect((await peer.next()).event).toBe('paused');
  let completed = false;
  const erasure = exchanges.eraseScope('synthetic:scope').then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(completed).toBe(false);
  peer.resume();
  expect((await peer.next()).event).toBe('result');
  expect(await peer.exited).toBe(0);
  await erasure;
  expect(await collection('conversation_payload_chunks').countDocuments({})).toBe(0);
  expect(await collection('conversation_exchange_receipts').countDocuments({ state: 'accepted' })).toBe(0);
});

test('a long admitted writer leaves erasure pending and a retry purges its eventual late packet', async () => {
  const { receipt } = await exchanges.accept('synthetic:pending', { body: {} }, 'pending-writer');
  const peer = writer({ action: 'append', receipt, pauseCollection: 'conversation_exchange_packets', pauseMethod: 'insertOne' });
  expect((await peer.next()).event).toBe('paused');
  await expect(exchanges.eraseOne(receipt.scope, receipt._id)).rejects.toMatchObject({ code: 'CONVERSATION_ERASURE_PENDING' });
  expect(await collection('conversation_exchange_receipts').findOne({ _id: receipt._id, state: 'erasing' })).toBeTruthy();
  await expect(exchanges.append(receipt, 1, Buffer.from('Unadmitted late packet'))).rejects.toMatchObject({ code: 'EXCHANGE_CLOSED' });
  // A timeout does not authorize stealing the writer: let that exact worker
  // finish its real insert, then resume only the already requested erasure.
  peer.resume();
  expect((await peer.next()).event).toBe('result');
  expect(await peer.exited).toBe(0);
  expect(await collection('conversation_exchange_packets').countDocuments({ receiptId: receipt._id })).toBe(1);
  await exchanges.resumeErasure();
  expect(await collection('conversation_exchange_packets').countDocuments({ receiptId: receipt._id })).toBe(0);
  expect(await collection('conversation_payload_chunks').countDocuments({ owner: `exchange:${receipt._id}` })).toBe(0);
  expect(await exchanges.read(receipt.scope, receipt._id)).toBeNull();
  // Repeated cleanup must not allow the erased identity to accept content.
  await exchanges.resumeErasure();
  await expect(exchanges.accept(receipt.scope, { body: {} }, 'pending-writer')).rejects.toMatchObject({ code: 'EXCHANGE_ERASED' });
});

test('transcript erasure fences a page writer in a separate process', async () => {
  const owner = 'synthetic-conversation';
  const peer = writer({ action: 'transcript', owner, pauseCollection: 'conversation_transcript_pages', pauseMethod: 'updateOne' });
  expect((await peer.next()).event).toBe('paused');
  const erasure = transcripts.eraseTranscript(owner);
  peer.resume();
  expect((await peer.next()).event).toBe('result');
  expect(await peer.exited).toBe(0);
  await erasure;
  expect(await collection('conversation_transcript_pages').countDocuments({ owner })).toBe(0);
  await expect(transcripts.writeTranscript(owner, [{ role: 'user', content: 'Late' }])).rejects.toMatchObject({ code: 'CONVERSATION_CONTENT_ERASED' });
});

test('transcript publication stays fenced between durable pages and the canonical root write', async () => {
  const owner = 'synthetic-publication-race';
  await collection('conversations').insertOne({ _id: owner, messages: [] });
  const peer = writer({ action: 'publishTranscript', owner,
    largeContent: true, pauseCollection: 'conversations', pauseMethod: 'updateOne' });
  expect(await peer.next()).toEqual({ event: 'paused' });
  expect(await collection('conversation_transcript_pages').countDocuments({ owner })).toBeGreaterThan(0);
  expect((await collection('conversations').findOne({ _id: owner })).transcript).toBeUndefined();
  let completed = false;
  const erasure = eraseOwner(owner, async fence => {
    await fence.mutate(() => collection('conversations').deleteOne({ _id: owner }));
    await transcripts.eraseTranscript(owner, { fence });
  }).then(() => { completed = true; });
  for (let i = 0; i < 100 && !await fences().findOne({ _id: owner, eraseRequested: true }); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(await fences().findOne({ _id: owner, eraseRequested: true })).toBeTruthy();
  expect(completed).toBe(false);
  const latePublish = jest.fn();
  await expect(transcripts.publishTranscript(owner, [], latePublish))
    .rejects.toMatchObject({ code: 'CONVERSATION_CONTENT_ERASED' });
  expect(latePublish).not.toHaveBeenCalled();
  peer.resume();
  expect((await peer.next()).event).toBe('result');
  expect(await peer.exited).toBe(0);
  await erasure;
  expect(await collection('conversations').findOne({ _id: owner })).toBeNull();
  for (const name of ['conversation_transcript_pages', 'conversation_payload_chunks']) {
    expect(await collection(name).countDocuments({ owner })).toBe(0);
  }
});

test('a process killed before canonical publication retains its exact writer and leaves erasure pending', async () => {
  const owner = 'synthetic-dead-publication';
  await collection('conversations').insertOne({ _id: owner, messages: [] });
  const peer = writer({ action: 'publishTranscript', owner,
    pauseCollection: 'conversations', pauseMethod: 'updateOne' });
  expect((await peer.next()).event).toBe('paused');
  const admitted = await fences().findOne({ _id: owner });
  peer.child.kill('SIGKILL');
  await peer.exited;
  const purge = jest.fn();
  await expect(eraseOwner(owner, purge, { waitMs: 25 }))
    .rejects.toMatchObject({ code: 'CONVERSATION_ERASURE_PENDING' });
  expect(purge).not.toHaveBeenCalled();
  expect((await fences().findOne({ _id: owner })).token).toBe(admitted.token);
  expect((await collection('conversations').findOne({ _id: owner })).transcript).toBeUndefined();
  expect(await collection('conversation_transcript_pages').countDocuments({ owner })).toBe(1);
});

test('an ambiguous canonical publication cannot authorize erasure even when its root write reached Mongo', async () => {
  const owner = 'synthetic-ambiguous-publication';
  await collection('conversations').insertOne({ _id: owner, messages: [] });
  const messages = [{ role: 'assistant', content: 'Full synthetic transcript' }];
  await expect(transcripts.publishTranscript(owner, messages, async reference => {
    await collection('conversations').updateOne({ _id: owner }, { $set: { transcript: reference } });
    throw new MongoNetworkError('Synthetic acknowledgement lost after canonical dispatch');
  })).rejects.toBeInstanceOf(MongoNetworkError);
  const root = await collection('conversations').findOne({ _id: owner });
  expect(await transcripts.readTranscript(owner, root.transcript)).toEqual(messages);
  const prior = await fences().findOne({ _id: owner });
  expect(prior.state).toBe('UNKNOWN');
  const purge = jest.fn();
  await expect(eraseOwner(owner, purge)).rejects.toMatchObject({ code: 'CONVERSATION_WRITE_RECOVERY_REQUIRED' });
  expect(purge).not.toHaveBeenCalled();
  expect((await fences().findOne({ _id: owner })).token).toBe(prior.token);
});

test('a dead writer is never replaced by a TTL or mistaken for completed erasure', async () => {
  const peer = writer({ action: 'hold', owner: 'dead-writer' });
  expect((await peer.next()).event).toBe('paused');
  peer.child.kill('SIGKILL');
  await peer.exited;
  await fences().updateOne({ _id: 'dead-writer' }, { $set: { acquiredAt: new Date(0) } });
  await expect(eraseOwner('dead-writer', jest.fn(), { waitMs: 25 })).rejects.toMatchObject({ code: 'CONVERSATION_ERASURE_PENDING' });
  expect(await fences().findOne({ _id: 'dead-writer', token: { $ne: null }, eraseRequested: true })).toBeTruthy();
});

test('unknown Mongo mutation outcomes retain the exact writer and refuse erasure', async () => {
  await expect(withOwnerWrite('unknown-write', fence => fence.mutate(async () => {
    throw new MongoNetworkError('Synthetic connection lost after dispatch');
  }))).rejects.toBeInstanceOf(MongoNetworkError);
  const prior = await fences().findOne({ _id: 'unknown-write' });
  expect(prior.state).toBe('UNKNOWN');
  expect(prior.token).toEqual(expect.any(String));
  const purge = jest.fn();
  await expect(eraseOwner('unknown-write', purge)).rejects.toMatchObject({ code: 'CONVERSATION_WRITE_RECOVERY_REQUIRED' });
  expect(purge).not.toHaveBeenCalled();
  expect((await fences().findOne({ _id: 'unknown-write' })).token).toBe(prior.token);
});

test('an acknowledged server rejection settles the writer without an unknown quarantine', async () => {
  await expect(withOwnerWrite('rejected-write', fence => fence.mutate(async () => {
    throw new MongoServerError({ message: 'Synthetic duplicate', code: 11000 });
  }))).rejects.toMatchObject({ code: 11000 });
  const purge = jest.fn();
  await eraseOwner('rejected-write', purge);
  expect(purge).toHaveBeenCalledTimes(1);
  expect(await fences().findOne({ _id: 'rejected-write', token: null, state: 'ERASED' })).toBeTruthy();
});

test('late conversation association erases the exchange instead of restoring deleted content', async () => {
  const { receipt } = await exchanges.accept('synthetic:owner', { body: { message: 'New conversation' } }, 'late-association');
  await exchanges.append(receipt, 0, Buffer.from('Synthetic output'));
  await exchanges.eraseConversation('deleted-conversation');
  await expect(exchanges.finish(receipt, 'completed', { conversationId: 'deleted-conversation', packets: 1 }))
    .rejects.toMatchObject({ code: 'EXCHANGE_CLOSED' });
  expect(await exchanges.read(receipt.scope, receipt._id)).toBeNull();
  expect(await collection('conversation_exchange_packets').countDocuments({ receiptId: receipt._id })).toBe(0);
  expect(await collection('conversation_payload_chunks').countDocuments({ owner: `exchange:${receipt._id}` })).toBe(0);
});

test('a retained callback cannot mutate content after its exact fence settled', async () => {
  let captured;
  await withOwnerWrite('settled-writer', async fence => { captured = fence; });
  const write = jest.fn();
  await expect(captured.mutate(write)).rejects.toMatchObject({ code: 'CONVERSATION_FENCE_INVALID' });
  expect(write).not.toHaveBeenCalled();
});

test('an admitted mutation remains fenced even when its caller forgets to await it', async () => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const boundary = new Promise(resolve => { entered = resolve; });
  const writerDone = withOwnerWrite('unawaited-writer', fence => {
    fence.mutate(async () => {
      entered();
      await blocked;
      await collection('conversation_exchange_packets').insertOne({ _id: 'unawaited-packet', owner: 'unawaited-writer' });
    });
  });
  await boundary;
  await expect(eraseOwner('unawaited-writer', jest.fn(), { waitMs: 25 })).rejects.toMatchObject({ code: 'CONVERSATION_ERASURE_PENDING' });
  release();
  await writerDone;
  await eraseOwner('unawaited-writer', fence => fence.mutate(() =>
    collection('conversation_exchange_packets').deleteMany({ owner: 'unawaited-writer' })));
  expect(await collection('conversation_exchange_packets').countDocuments({ _id: 'unawaited-packet' })).toBe(0);
});

test('a handled acknowledged rejection can return a verified existing write without retaining the fence', async () => {
  const result = await withOwnerWrite('verified-duplicate', async fence => {
    try { await fence.mutate(async () => { throw new MongoServerError({ message: 'Synthetic duplicate', code: 11000 }); }); }
    catch (error) { expect(error.code).toBe(11000); return 'verified-existing-row'; }
  });
  expect(result).toBe('verified-existing-row');
  expect(await fences().findOne({ _id: 'verified-duplicate', token: null, state: 'OPEN' })).toBeTruthy();
});

test('a caught or unawaited unknown mutation still invalidates successful settlement', async () => {
  await expect(withOwnerWrite('ignored-unknown', fence => {
    fence.mutate(async () => { throw new MongoNetworkError('Synthetic ambiguous write'); });
    return 'not-proof';
  })).rejects.toBeInstanceOf(MongoNetworkError);
  expect(await fences().findOne({ _id: 'ignored-unknown', state: 'UNKNOWN', token: { $ne: null } })).toBeTruthy();
});
