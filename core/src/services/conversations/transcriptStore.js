'use strict';

const mongoose = require('mongoose');
const { serialize, deserialize, calculateObjectSize } = require('bson');
const { createHash } = require('node:crypto');
const { withOwnerWrite, eraseOwner } = require('./writeFence');
const PAGE_BYTES = 1024 * 1024;
const collections = () => ({
  pages: mongoose.connection.collection('conversation_transcript_pages'),
  chunks: mongoose.connection.collection('conversation_payload_chunks'),
  identities: mongoose.connection.collection('conversation_turn_identities')
});
const digest = (owner, bytes) => createHash('sha256').update(String(owner)).update(bytes).digest('hex');
const failure = message => Object.assign(new Error(message), {
  code: 'CONVERSATION_TRANSCRIPT_UNAVAILABLE', statusCode: 503
});
const plain = value => typeof value?.toObject === 'function' ? value.toObject() : value;

// Search windows end between whitespace-delimited groups, never inside a
// word. Phrase matching reads the complete payload, so overlap is unnecessary.
// An exceptionally long group is kept whole while it fits a safe BSON row;
// otherwise searching that payload refuses explicitly instead of indexing
// artificial word fragments. Reading and exporting it remain complete.
function searchWindows(content) {
  const texts = [], separators = /\s+/gu;
  let start = 0, end = 0, overflow = false;
  while (start < content.length) {
    const limit = start + PAGE_BYTES;
    separators.lastIndex = end;
    let separator;
    while ((separator = separators.exec(content))) {
      if (separator.index >= limit) break;
      end = separator.index + separator[0].length;
    }
    if (content.length <= limit) end = content.length;
    else if (end <= start) end = separator ? separator.index + separator[0].length : content.length;
    const text = content.slice(start, end);
    if (Buffer.byteLength(text) < 8 * PAGE_BYTES) texts.push(text);
    else overflow = true;
    start = end;
  }
  return { texts, overflow };
}

// Immutable content is written before the Conversation's atomic reference update.
// A failed reference update leaves unreferenced pages, never a partial transcript.
async function putPayloadRaw(owner, value, fence) {
  const object = { value };
  const bytes = serialize(object, { minInternalBufferSize: calculateObjectSize(object) + 1024 });
  const ids = [];
  for (let offset = 0; offset < bytes.length; offset += PAGE_BYTES) {
    const data = bytes.subarray(offset, offset + PAGE_BYTES);
    const id = digest(owner, data);
    await fence.mutate(() => collections().chunks.updateOne({ _id: id, owner: String(owner) },
      { $setOnInsert: { data, createdAt: new Date() } }, { upsert: true, writeConcern: { w: 'majority', j: true } }));
    ids.push(id);
  }
  const searchIds = [];
  const search = typeof value?.content === 'string' ? searchWindows(value.content) : { texts: [] };
  for (const searchText of search.texts) {
    const id = digest(owner, Buffer.from(`search:${searchText}`));
    await fence.mutate(() => collections().chunks.updateOne({ _id: id, owner: String(owner) },
      { $setOnInsert: { searchText, createdAt: new Date() } }, { upsert: true, writeConcern: { w: 'majority', j: true } }));
    searchIds.push(id);
  }
  return { ids, bytes: bytes.length, sha256: digest(owner, bytes), ...(searchIds.length ? { searchIds } : {}),
    ...(search.overflow ? { searchUnavailable: true } : {}) };
}

const putPayload = (owner, value, options) => withOwnerWrite(owner,
  fence => putPayloadRaw(owner, value, fence), options);

async function readPayload(owner, ref) {
  if (!ref?.ids?.length) throw failure('The complete conversation payload reference is missing.');
  const rows = await collections().chunks.find({ _id: { $in: ref.ids }, owner: String(owner) }).toArray();
  const byId = new Map(rows.map(row => [row._id, row]));
  const bytes = Buffer.concat(ref.ids.map(id => {
    const row = byId.get(id);
    if (!row) throw failure('A conversation payload chunk is missing; partial content was not returned.');
    return Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data.buffer);
  }));
  if (bytes.length !== ref.bytes || digest(owner, bytes) !== ref.sha256) {
    throw failure('Conversation payload integrity check failed.');
  }
  return deserialize(bytes).value;
}

async function readSearchTexts(owner, ids) {
  const expected = [...new Set(ids)];
  if (!expected.length) return [];
  const rows = await collections().chunks.find({ _id: { $in: expected }, owner: String(owner) },
    { projection: { _id: 1, searchText: 1 } }).toArray();
  if (rows.length !== expected.length || rows.some(row => typeof row.searchText !== 'string'
    || digest(owner, Buffer.from(`search:${row.searchText}`)) !== row._id)) {
    throw failure('Conversation search content is missing or corrupt.');
  }
  return rows;
}

function searchableStub(message, payload) {
  const projectedFields = ['messages.content'];
  const turn = message.turn ? { ...message.turn } : undefined;
  if (turn) for (const field of ['display', 'sceneProposedReplyText', 'sceneProposal', 'sceneReceipt',
    'toolEvidence', 'applicationEvent', 'personalContinuity', 'backgroundReview']) {
    if (calculateObjectSize({ value: turn[field] }) > 16384) {
      delete turn[field]; projectedFields.push(`messages.turn.${field}`);
    }
  }
  const metadata = message.metadata ? { ...message.metadata } : undefined;
  if (metadata) for (const [key, value] of Object.entries(metadata)) {
    if (calculateObjectSize({ value }) > 16384) {
      delete metadata[key]; projectedFields.push(`messages.metadata.${key}`);
    }
  }
  return { _id: message._id, role: message.role, timestamp: message.timestamp,
    turnId: message.turnId, feedback: message.feedback, stats: message.stats, cost: message.cost,
    content: typeof message.content === 'string' ? message.content.slice(0, 4096) : '',
    metadata, ...(turn ? { turn } : {}), _payload: payload, _projectedFields: projectedFields };
}

async function writeTranscriptRaw(owner, messages, fence) {
  const ids = [];
  let items = [], bytes = 0;
  const flush = async () => {
    if (!items.length) return;
    items = deserialize(serialize({ items })).items;
    const encoded = serialize({ items });
    const id = digest(owner, encoded);
    const searchContent = items.filter(item => !item._payload).map(item => item.content || '');
    await fence.mutate(() => collections().pages.updateOne({ _id: id, owner: String(owner) },
      { $setOnInsert: { items, sha256: id, createdAt: new Date() }, $set: { searchContent } },
      { upsert: true, writeConcern: { w: 'majority', j: true } }));
    ids.push(id); items = []; bytes = 0;
  };
  for (const entry of messages) {
    let message = plain(entry);
    let size = calculateObjectSize({ message });
    if (size > PAGE_BYTES / 2) {
      message = searchableStub(message, await putPayloadRaw(owner, message, fence));
      size = serialize({ message }).length;
      if (size > PAGE_BYTES / 2) throw failure('Conversation evidence requires an unsupported oversized query projection.');
    }
    if (bytes + size > PAGE_BYTES) await flush();
    items.push(message); bytes += size;
  }
  await flush();
  return { version: 1, pages: ids, count: messages.length };
}

const writeTranscript = (owner, messages, options) => withOwnerWrite(owner,
  fence => writeTranscriptRaw(owner, messages, fence), options);

// Keep the admitted writer until both immutable content and its canonical
// reference have settled. A caller already publishing under an owner fence
// must pass that exact context, rather than acquiring a second writer.
async function publishTranscript(owner, messages, publish, options) {
  if (typeof publish !== 'function') throw new TypeError('A canonical transcript publisher is required.');
  return withOwnerWrite(owner, async fence => {
    if (fence.erasing) throw failure('An erasure barrier cannot publish conversation content.');
    const reference = await writeTranscriptRaw(owner, messages, fence);
    return fence.mutate(() => publish(reference, fence));
  }, options);
}

async function expandMessages(owner, messages) {
  return Promise.all(messages.map(message => message?._payload
    ? readPayload(owner, message._payload) : message));
}

async function reserveTurnIdentitiesRaw(owner, surface, messages, fence) {
  const turnIds = [...new Set(messages.map(message => message.turnId).filter(Boolean))];
  if (!turnIds.length) return;
  // Legacy embedded turns keep their identity before their first paged write.
  const legacy = await mongoose.connection.collection('conversations').findOne({
    _id: { $ne: owner }, surface, 'messages.turnId': { $in: turnIds }
  }, { projection: { _id: 1 } });
  if (legacy) throw Object.assign(new Error('This turn identity already belongs to another conversation.'), { code: 11000, statusCode: 409 });
  await fence.mutate(() => collections().identities.bulkWrite(turnIds.map(turnId => ({ updateOne: {
    filter: { _id: digest(surface, Buffer.from(turnId)), owner: String(owner) },
    update: { $setOnInsert: { surface } }, upsert: true
  } })), { writeConcern: { w: 'majority', j: true } }));
}

const reserveTurnIdentities = (owner, surface, messages, options) => withOwnerWrite(owner,
  fence => reserveTurnIdentitiesRaw(owner, surface, messages, fence), options);

async function readPageItems(owner, reference) {
  if (!reference || reference.version !== 1 || !Array.isArray(reference.pages)) {
    throw failure('Unsupported conversation transcript reference.');
  }
  const rows = await collections().pages.find({ _id: { $in: reference.pages }, owner: String(owner) }).toArray();
  const byId = new Map(rows.map(row => [row._id, row]));
  const messages = [];
  for (const id of reference.pages) {
    const row = byId.get(id);
    if (!row || digest(owner, serialize({ items: row.items })) !== id) {
      throw failure('A conversation page is missing or corrupt; partial history was not returned.');
    }
    messages.push(...row.items);
  }
  if (messages.length !== reference.count) throw failure('Conversation message count does not match its durable reference.');
  return messages;
}

async function readTranscript(owner, reference) {
  return expandMessages(owner, await readPageItems(owner, reference));
}

function transcriptStages() {
  return [
    { $lookup: { from: 'conversation_transcript_pages', let: { ids: { $ifNull: ['$transcript.pages', []] }, owner: { $toString: '$_id' } },
      pipeline: [{ $match: { $expr: { $and: [{ $in: ['$_id', '$$ids'] }, { $eq: ['$owner', '$$owner'] }] } } },
        { $set: { _order: { $indexOfArray: ['$$ids', '$_id'] } } }, { $sort: { _order: 1 } }], as: '_transcriptPages' } },
    { $set: { messages: { $cond: [{ $eq: ['$transcript.version', 1] },
      { $reduce: { input: { $map: { input: '$transcript.pages', as: 'pageId', in: { $arrayElemAt: [{ $filter: { input: '$_transcriptPages', as: 'page', cond: { $eq: ['$$page._id', '$$pageId'] } } }, 0] } } }, initialValue: [], in: { $concatArrays: ['$$value', '$$this.items'] } } },
      { $ifNull: ['$messages', []] }] } } },
    { $unset: '_transcriptPages' }
  ];
}

const eraseTranscript = (owner, options) => eraseOwner(owner, async fence => {
  await fence.mutate(() => collections().pages.deleteMany({ owner: String(owner) }, { writeConcern: { w: 'majority', j: true } }));
  await fence.mutate(() => collections().chunks.deleteMany({ owner: String(owner) }, { writeConcern: { w: 'majority', j: true } }));
  await fence.mutate(() => collections().identities.deleteMany({ owner: String(owner) }, { writeConcern: { w: 'majority', j: true } }));
}, options);

module.exports = { putPayload, readPayload, writeTranscript, publishTranscript, readTranscript, expandMessages,
  transcriptStages, readPageItems, readSearchTexts, eraseTranscript, reserveTurnIdentities, PAGE_BYTES };
