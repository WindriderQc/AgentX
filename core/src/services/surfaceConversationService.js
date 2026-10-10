'use strict';

const { Types } = require('mongoose');
const Conversation = require('../../models/Conversation');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const Attachment = require('../../models/ConversationAttachment');
const TURN_TEXT_LIMIT = 16000;
const SURFACE_INPUT_LIMITS = Object.freeze({ 'image-workshop': 32000 });

// The deployed topology has one Core writer. Serialize file writes, exports and
// erasure in that process; the durable tombstone also rejects later native replay.
const pendingWrites = new Map();
async function withSessionWrite(surface, sessionId, operation) {
  const key = JSON.stringify([surface, sessionId]);
  const previous = pendingWrites.get(key) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  pendingWrites.set(key, next);
  await previous;
  try { return await operation(); }
  finally { release(); if (pendingWrites.get(key) === next) pendingWrites.delete(key); }
}

async function resumeDeletedSessionCleanup() {
  const cursor = Conversation.find({ 'surfaceSession.deletedAt': { $type: 'date' }, 'surfaceSession.deleteCleanupPending': true })
    .select('_id surface surfaceSession.sessionId').lean().cursor();
  let removed = 0;
  try {
    for await (const row of cursor) {
      await withSessionWrite(row.surface, row.surfaceSession.sessionId, async () => {
        removed += (await Attachment.deleteMany({ conversationId: row._id })).deletedCount;
        await Conversation.updateOne({ _id: row._id, 'surfaceSession.deletedAt': { $type: 'date' } },
          { $set: { 'surfaceSession.deleteCleanupPending': false } });
      });
    }
  } finally { await cursor.close(); }
  return { removed };
}

const failure = (message, statusCode = 400, code = 'CONVERSATION_INVALID') =>
  Object.assign(new Error(message), { statusCode, code });
const objectId = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value) ? new Types.ObjectId(value) : value;
const limitOf = (value, fallback = 50) => Math.max(1, Math.min(500, Math.trunc(Number(value)) || fallback));

// Conditions come only from a trusted surface. Map field paths while keeping
// Mongo's comparison values intact (including Dates and ObjectIds).
function mapFields(value, field) {
  return Object.fromEntries(Object.entries(value).map(([key, operand]) => {
    if (['$or', '$and', '$nor'].includes(key)) return [key, operand.map(entry => mapFields(entry, field))];
    if (key.startsWith('$')) throw failure('Unsupported conversation condition');
    return [field(key), key === '_id' ? objectId(operand) : operand];
  }));
}
const sessionField = key => ['_id', 'createdAt', 'updatedAt'].includes(key) ? key : `surfaceSession.${key}`;
const turnField = key => key === '_id' ? '_id' : key === 'replyText' ? 'content' : `turn.${key}`;
const sessionView = row => row ? { ...row.surfaceSession, _id: row._id,
  conversationId: String(row._id), createdAt: row.createdAt, updatedAt: row.updatedAt } : null;
function turnView(conversation, message) {
  if (!message?.turn) return null;
  const user = conversation.messages.find(entry => entry.role === 'user' && entry.turnId === message.turnId);
  return { ...message.turn, _id: message._id, conversationId: String(conversation._id),
    inputText: user?.content || '', replyText: message.content || '', ...(user?.attachments?.length ? { attachments: user.attachments } : {}) };
}

// A surface binds its namespace in server code. HTTP bodies cannot select it or
// receive Mongo models. Both session state and text use canonical conversations.
function forSurface(surface) {
  if (typeof surface !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(surface)) throw failure('A server-selected surface is required');
  const inputTextLimit = Object.hasOwn(SURFACE_INPUT_LIMITS, surface) ? SURFACE_INPUT_LIMITS[surface] : TURN_TEXT_LIMIT;
  const sessionQuery = query => ({ surface, ...mapFields(query, sessionField), 'surfaceSession.deletedAt': { $exists: false } });
  const rootForTurn = query => ({ surface,
    'surfaceSession.deletedAt': { $exists: false },
    ...Object.fromEntries(['sessionId', 'packId', 'scopeId'].filter(key => typeof query[key] === 'string')
      .map(key => [`surfaceSession.${key}`, query[key]])) });

  async function createSession(input) {
    const session = { ...input, sessionId: String(input.sessionId || '') };
    if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(session.sessionId)) throw failure('A bounded session ID is required');
    return withSessionWrite(surface, session.sessionId, async () => {
      if (await Conversation.exists({ surface, 'surfaceSession.sessionId': session.sessionId })) {
        throw failure('This conversation identity already exists', 409, 11000);
      }
      const row = await Conversation.create({ surface, surfaceSession: session,
        // Surface histories are not implicitly offered to the default Playground.
        userId: `surface:${surface}:${session.packId}:${session.scopeId}`,
        title: session.label || 'New Conversation', clientRef: session.sessionId, messages: [] });
      return sessionView(row.toObject());
    });
  }

  async function getSession(query) {
    return sessionView(await Conversation.findOne(sessionQuery(query)).select('-messages').lean());
  }

  async function ensureSession(input) {
    let session = await getSession({ sessionId: input.sessionId });
    if (!session) {
      try { session = await createSession(input); }
      catch (error) {
        if (error.code !== 11000) throw error;
        session = await getSession({ sessionId: input.sessionId });
      }
    }
    if (!session || session.packId !== input.packId || session.scopeId !== input.scopeId) {
      throw failure('The session belongs to another conversation space', 409, 'CONVERSATION_SCOPE_CONFLICT');
    }
    return session;
  }

  async function listSessions(query, { sort = { lastTurnAt: -1 }, limit = 50 } = {}) {
    return (await Conversation.find(sessionQuery(query)).select('-messages')
      .sort(mapFields(sort, sessionField)).limit(limitOf(limit)).lean()).map(sessionView);
  }

  async function updateSession(query, update) {
    const mapped = {};
    for (const [operator, fields] of Object.entries(update)) {
      if (!['$set', '$inc', '$unset'].includes(operator)) throw failure('Unsupported session update');
      if (Object.keys(fields).some(key => ['sessionId', 'packId', 'scopeId', '_id'].includes(key))) {
        throw failure('A conversation cannot change its identity or space');
      }
      mapped[operator] = mapFields(fields, sessionField);
    }
    mapped.$set = { ...mapped.$set, updatedAt: new Date() };
    return sessionView(await Conversation.findOneAndUpdate(sessionQuery(query), mapped,
      { new: true, runValidators: true }).select('-messages').lean());
  }

  async function recordTurn(input, { sessionPatch = {} } = {}) {
    const { inputText = '', replyText = '', attachments = [], ...event } = input;
    if (typeof event.traceId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,260}$/.test(event.traceId)
      || typeof inputText !== 'string' || typeof replyText !== 'string'
      || inputText.length > inputTextLimit || replyText.length > TURN_TEXT_LIMIT) throw failure('Invalid bounded conversation turn');
    const now = new Date();
    const refs = attachments.length ? await require('./conversationAttachmentService').forConversation({ surface,
      sessionId: event.sessionId, packId: event.packId, scopeId: event.scopeId }).references(attachments.map(item => item.id)) : [];
    if (refs.length && !inputText) throw failure('Attachments require a user message');
    if (Object.keys(sessionPatch).some(key => ['sessionId', 'packId', 'scopeId', 'turnCount', 'lastTurnAt', '_id'].includes(key))) {
      throw failure('A turn cannot change the conversation identity or counters');
    }
    const messageId = new Types.ObjectId();
    const messages = [
      ...(inputText ? [{ _id: new Types.ObjectId(), role: 'user', content: inputText, turnId: event.traceId, timestamp: now,
        ...(refs.length ? { attachments: refs } : {}) }] : []),
      { _id: messageId, role: 'assistant', content: replyText, turnId: event.traceId, timestamp: now,
        turn: { ...event, createdAt: event.createdAt || now, updatedAt: event.updatedAt || now } }
    ];
    // One document update is the durability boundary for transcript, evidence
    // and turn count. The same native event cannot append or increment twice.
    const row = await Conversation.findOneAndUpdate({
      ...sessionQuery({ sessionId: event.sessionId, packId: event.packId, scopeId: event.scopeId }),
      'surfaceSession.status': 'active', 'messages.turn.traceId': { $ne: event.traceId }
    }, { $push: { messages: { $each: messages } }, $inc: { 'surfaceSession.turnCount': 1 },
      $set: { 'surfaceSession.lastTurnAt': event.sourceCompletedAt || now, updatedAt: now,
        ...mapFields(sessionPatch, sessionField),
        ...(event.model ? { model: event.model } : {}) } }, { new: true, runValidators: true }).lean();
    if (!row) {
      if (await getTurn({ traceId: event.traceId })) throw failure('This turn is already recorded', 409, 11000);
      throw failure('Active conversation not found in this space', 404, 'CONVERSATION_NOT_FOUND');
    }
    return turnView(row, row.messages.find(message => String(message._id) === String(messageId)));
  }

  function turnPipeline(query) {
    const match = { ...mapFields(query, key => `messages.${turnField(key)}`), 'messages.turn': { $exists: true } };
    return [
      { $match: { ...rootForTurn(query), messages: { $elemMatch: { turn: { $exists: true }, ...mapFields(query, turnField) } } } },
      { $set: { _allMessages: '$messages' } },
      { $unwind: '$messages' },
      { $match: match }
    ];
  }

  async function listTurns(query = {}, { sort = { createdAt: -1, _id: -1 }, limit = 50 } = {}) {
    const stableSort = Object.hasOwn(sort, '_id') ? sort : { ...sort, _id: Object.values(sort)[0] < 0 ? -1 : 1 };
    const rows = await Conversation.aggregate([
      ...turnPipeline(query), { $sort: mapFields(stableSort, key => `messages.${turnField(key)}`) }, { $limit: limitOf(limit) },
      { $project: { _id: 1, messages: { $filter: { input: '$_allMessages', as: 'message',
        cond: { $eq: ['$$message.turnId', '$messages.turnId'] } } } } }
    ]);
    return rows.map(row => turnView(row, row.messages.find(message => message.turn))).filter(Boolean);
  }

  async function getTurn(query, options = {}) {
    return (await listTurns(query, { ...options, limit: 1 }))[0] || null;
  }

  async function countTurns(query = {}) {
    const [count] = await Conversation.aggregate([...turnPipeline(query), { $count: 'value' }]);
    return count?.value || 0;
  }

  function turnUpdate(update) {
    const mapped = {};
    for (const [operator, fields] of Object.entries(update)) {
      if (!['$set', '$inc', '$unset'].includes(operator)) throw failure('Unsupported turn update');
      if (Object.keys(fields).some(key => ['traceId', 'sessionId', 'packId', 'scopeId', '_id', 'inputText'].includes(key))) {
        throw failure('Recorded input and turn identity are immutable');
      }
      mapped[operator] = mapFields(fields, key => `messages.$[entry].${turnField(key)}`);
    }
    mapped.$set = { ...mapped.$set, 'messages.$[entry].turn.updatedAt': new Date() };
    return mapped;
  }

  async function updateTurn(query, update) {
    const previous = await getTurn(query);
    if (!previous) return null;
    const exact = { ...query, _id: previous._id };
    const row = await Conversation.findOneAndUpdate({ _id: previous.conversationId, surface,
      messages: { $elemMatch: mapFields(exact, turnField) } }, turnUpdate(update),
    // The exact row and all preconditions are checked together by $elemMatch.
    // The array filter only selects that row; it must not re-cast logical query
    // branches as message subdocuments (Mongoose otherwise injects defaults).
    { new: true, runValidators: true, arrayFilters: [{ 'entry._id': previous._id }] }).lean();
    return row ? turnView(row, row.messages.find(message => String(message._id) === String(previous._id))) : null;
  }

  async function updateTurns(query, update) {
    return Conversation.updateMany({ ...rootForTurn(query), messages: { $elemMatch: mapFields(query, turnField) } },
      turnUpdate(update), { runValidators: true, arrayFilters: [mapFields(query, key => `entry.${turnField(key)}`)] });
  }

  function exactSession(query = {}) {
    for (const key of ['sessionId', 'packId', 'scopeId']) {
      if (typeof query[key] !== 'string' || !query[key]) throw failure('An exact conversation space is required');
    }
    return { surface, ...mapFields(Object.fromEntries(['sessionId', 'packId', 'scopeId'].map(key => [key, query[key]])), sessionField) };
  }

  async function deleteSession(query) {
    const filter = exactSession(query);
    return withSessionWrite(surface, query.sessionId, async () => {
      const row = await Conversation.findOne(filter).lean();
      if (!row) throw failure('Conversation introuvable.', 404);
      if (!row.surfaceSession.deletedAt) {
        // Replace rather than enumerate content fields: no transcript, native
        // session key, persona, preview, model, metadata or tool receipt survives.
        const at = new Date();
        await Conversation.replaceOne({ _id: row._id, ...filter }, {
          _id: row._id, surface, userId: `surface:${surface}:${query.packId}:${query.scopeId}`,
          title: 'Deleted conversation', messages: [], lifecycle: { status: 'archived', archivedAt: at },
          surfaceSession: { sessionId: query.sessionId, packId: query.packId, scopeId: query.scopeId,
            modeId: row.surfaceSession.modeId, status: 'closed', deletedAt: at, deleteCleanupPending: true },
          createdAt: row.createdAt, updatedAt: at
        }, { runValidators: true });
      }
      // A failure leaves only the tombstone and is retryable with the same scope.
      await Attachment.deleteMany({ conversationId: row._id });
      await Conversation.updateOne({ _id: row._id }, { $set: { 'surfaceSession.deleteCleanupPending': false } });
      return { deleted: true, sessionId: query.sessionId };
    });
  }

  async function exportSession(query, destination) {
    const filter = exactSession(query);
    return withSessionWrite(surface, query.sessionId, async () => {
      const row = await Conversation.findOne({ ...filter, 'surfaceSession.deletedAt': { $exists: false } }).lean();
      if (!row) throw failure('Conversation introuvable.', 404);
      const attachmentIds = [...new Set((row.messages || []).flatMap(message => (message.attachments || []).map(item => String(item.id))))];
      const attachmentFilter = { conversationId: row._id, _id: { $in: attachmentIds } };
      if (await Attachment.countDocuments(attachmentFilter) !== attachmentIds.length) throw failure('Une pièce jointe de cette conversation est indisponible.', 409);
      const cursor = Attachment.find(attachmentFilter).sort({ _id: 1 }).lean().cursor({ batchSize: 1 });
      async function* chunks() {
        // Original bytes are streamed one attachment at a time, never accumulated
        // into an unbounded JSON object. Only referenced files belong in an export.
        try {
          yield JSON.stringify({ schema: 'agentx.conversation-export/v1', exportedAt: new Date(),
            conversation: { id: String(row._id), surface, session: row.surfaceSession, title: row.title,
              createdAt: row.createdAt, updatedAt: row.updatedAt, messages: row.messages,
              ...(row.sessionRecap ? { sessionRecap: row.sessionRecap } : {}) } }).slice(0, -1) + ',"attachments":[';
          let separator = '';
          for await (const attachment of cursor) {
            const data = Buffer.isBuffer(attachment.data) ? attachment.data : Buffer.from(attachment.data.buffer || attachment.data);
            yield separator + JSON.stringify({ id: String(attachment._id), name: attachment.name,
              mimeType: attachment.mimeType, kind: attachment.kind, size: attachment.size, sha256: attachment.sha256,
              dataUrl: `data:${attachment.mimeType};base64,${data.toString('base64')}` });
            separator = ',';
          }
          yield ']}';
        } finally { await cursor.close(); }
      }
      await pipeline(Readable.from(chunks()), destination);
    });
  }

  const intake = require('./conversations/surfaceTurnIntake').turnIntake({ recordTurn, getTurn, updateTurn,
    withWrite: (sessionId, action) => withSessionWrite(surface, sessionId, action) });
  return Object.freeze({ ...intake, createSession, ensureSession, getSession, listSessions, updateSession,
    recordTurn, getTurn, listTurns, countTurns, updateTurn, updateTurns, deleteSession, exportSession });
}

module.exports = { forSurface, withSessionWrite, resumeDeletedSessionCleanup };
