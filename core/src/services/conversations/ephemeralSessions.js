'use strict';

const { randomUUID, randomBytes } = require('node:crypto');
const { serialize } = require('node:v8');
const { Types } = require('mongoose');

const PREFIX = 'ephemeral-';
const IDLE_MS = 30 * 60 * 1000;
const MAX_BYTES = 16 * 1024 * 1024;
const failure = (message, statusCode = 409, code = 'CONVERSATION_EPHEMERAL_INVALID') =>
  Object.assign(new Error(message), { statusCode, code });
const ephemeralId = id => typeof id === 'string' && id.startsWith(PREFIX);
const get = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    const actual = get(row, key);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.entries(value).every(([op, expected]) => {
        if (op === '$ne') return actual !== expected;
        if (op === '$exists') return (actual !== undefined) === expected;
        if (op === '$gt') return actual > expected;
        if (op === '$lt') return actual < expected;
        throw failure('Unsupported transient condition.');
      });
    }
    return actual === value;
  });
}
function patch(row, update) {
  for (const [operator, fields] of Object.entries(update)) {
    for (const [key, value] of Object.entries(fields)) {
      const parts = key.split('.'), last = parts.pop();
      let parent = row;
      for (const part of parts) parent = parent[part] ||= {};
      if (operator === '$set') parent[last] = structuredClone(value);
      else if (operator === '$unset') delete parent[last];
      else if (operator === '$inc') parent[last] = (parent[last] || 0) + value;
      else throw failure('Unsupported transient update.');
    }
  }
}

// Process-local context, never a second durable conversation store. The reserved
// identity namespace also refuses late writes after expiry/restart, without ever
// falling through to Mongo. Each surface instantiates its own store.
function withEphemeralSessions(durable, { idleMs = IDLE_MS, maximum = 64 } = {}) {
  const sessions = new Map();
  const guarded = Object.fromEntries(Object.entries(durable).map(([key, method]) => [key, typeof method !== 'function' ? method : async (query, ...args) => {
    if (ephemeralId(query?.sessionId)) throw failure('This operation requires retained history.');
    return method(query, ...args);
  }]));
  function remove(id) { clearTimeout(sessions.get(id)?.timer); return sessions.delete(id); }
  function entry(id) {
    const value = sessions.get(id);
    if (!value) throw failure('This ephemeral context expired. Start a new conversation.', 410, 'CONVERSATION_EPHEMERAL_EXPIRED');
    clearTimeout(value.timer);
    value.timer = setTimeout(() => remove(id), idleMs); value.timer.unref?.();
    return value;
  }
  function scoped(query) {
    const value = entry(query.sessionId);
    return matches(value.session, query) ? value : null;
  }
  function reserve(value, addition) {
    const bytes = serialize(addition).byteLength;
    if (value.bytes + bytes > MAX_BYTES) throw failure('This ephemeral context is full. Start a new conversation.', 413);
    value.bytes += bytes;
  }
  async function createSession(input) {
    if (input.ephemeral !== true) {
      if (ephemeralId(input.sessionId)) throw failure('A transient identity cannot be retained.');
      return durable.createSession(input);
    }
    if (input.backend !== 'agentx' || input.packId !== 'personal_operator' || input.scopeId !== 'personal' || input.llmx) {
      throw failure('This engine does not provide an ephemeral memory/history contract. Choose AgentX / Ollama or explicitly turn ephemeral off.', 409, 'CONVERSATION_EPHEMERAL_UNSUPPORTED');
    }
    if (sessions.size >= maximum) throw failure('Transient conversation capacity is full.', 503);
    const id = PREFIX + randomUUID(), now = new Date();
    const session = { ...structuredClone(input), sessionId: id, _id: id, status: 'active', turnCount: 0,
      createdAt: now, updatedAt: now, lastTurnAt: null, ephemeral: true };
    sessions.set(id, { session, turns: [], files: new Map(), bytes: 0 });
    reserve(entry(id), session);
    return structuredClone(session);
  }
  async function getSession(query) {
    if (!ephemeralId(query.sessionId)) return durable.getSession(query);
    const value = scoped(query); return value ? structuredClone(value.session) : null;
  }
  async function updateSession(query, update) {
    if (!ephemeralId(query.sessionId)) return durable.updateSession(query, update);
    const value = scoped(query); if (!value) return null;
    if (Object.values(update).some(fields => Object.keys(fields).some(key =>
      ['sessionId', 'packId', 'scopeId', 'ephemeral', 'backend'].includes(key)))) throw failure('Cannot change transient identity or policy.');
    reserve(value, update); patch(value.session, update); value.session.updatedAt = new Date();
    return structuredClone(value.session);
  }
  async function recordTurn(input, options) {
    if (!ephemeralId(input.sessionId)) return durable.recordTurn(input, options);
    const value = scoped({ sessionId: input.sessionId, packId: input.packId, scopeId: input.scopeId, status: 'active' });
    if (!value) throw failure('Conversation not found in this space.', 404);
    if (value.turns.some(row => row.traceId === input.traceId || input.clientTurnId && row.clientTurnId === input.clientTurnId)) {
      throw failure('This transient turn was already submitted.', 409, 'CONVERSATION_TURN_REPLAY');
    }
    const row = { ...structuredClone(input), _id: new Types.ObjectId().toHexString(), createdAt: new Date(),
      memoryState: 'not_applicable', textRetention: 'transient' };
    reserve(value, row); value.turns.push(row);
    value.session.turnCount++; value.session.lastTurnAt = row.createdAt;
    return structuredClone(row);
  }
  async function listTurns(query, { sort = { createdAt: -1 }, limit = 50 } = {}) {
    if (!ephemeralId(query.sessionId)) return durable.listTurns(query, { sort, limit });
    const value = entry(query.sessionId);
    return structuredClone(value.turns.filter(row => matches(row, query))
      .sort((a, b) => Object.entries(sort).reduce((order, [key, direction]) => order ||
        (get(a, key) > get(b, key) ? direction : get(a, key) < get(b, key) ? -direction : 0), 0)).slice(0, limit));
  }
  async function getTurn(query) {
    if (!ephemeralId(query.sessionId)) return durable.getTurn(query);
    return (await listTurns(query, { limit: 1 }))[0] || null;
  }
  async function updateTurn(query, update) {
    if (!ephemeralId(query.sessionId)) return durable.updateTurn(query, update);
    const value = entry(query.sessionId), row = value.turns.find(row => matches(row, query));
    if (!row) return null;
    reserve(value, update); patch(row, update); return structuredClone(row);
  }
  async function deleteSession(query) {
    if (!ephemeralId(query.sessionId)) return durable.deleteSession(query);
    const value = scoped(query); if (!value) throw failure('Conversation not found in this space.', 404);
    remove(query.sessionId); return { deleted: true, ephemeral: true };
  }
  function attachments(sessionId) {
    const files = () => entry(sessionId).files;
    const attachment = require('../conversationAttachmentService');
    const reference = row => ({ id: row._id, name: row.name, mimeType: row.mimeType, kind: row.kind, size: row.size });
    async function load(ids) {
      const rows = attachment.ids(ids, 24).map(id => files().get(id));
      if (rows.some(row => !row)) throw failure('Attachment not found in this conversation.', 404);
      return rows;
    }
    return {
      async upload(input) {
        const value = entry(sessionId), row = { ...await attachment.decode(input), _id: randomBytes(12).toString('hex') };
        // Expiry during decoding must never resurrect the context.
        if (entry(sessionId) !== value) throw failure('Context expired.', 410);
        reserve(value, row); files().set(row._id, row); return reference(row);
      },
      async references(ids) { return (await load(ids)).map(reference); },
      async download(id) { const [row] = await load([id]); return { ...reference(row), data: row.data }; },
      async downloadVerified(id) { const [row] = await load([id]); return { ...reference(row), sha256: row.sha256, data: row.data }; },
      async attachOriginal(id) { const [row] = await load([id]); return { ...reference(row), originalRetention: 'not-retained' }; },
      prepare: (messages, backend) => attachment.prepareWithLoader(messages, backend, load)
    };
  }
  return Object.freeze({ ...guarded, createSession, getSession, updateSession, recordTurn, listTurns, getTurn, updateTurn, deleteSession,
    // Lists and exports use the durable owner only. Transient rows are never
    // advertised to history, recap, ingestion workers or restoration consumers.
    async exportSession(query, ...args) {
      if (ephemeralId(query.sessionId)) throw failure('Ephemeral conversations cannot be exported from history.', 404);
      return durable.exportSession(query, ...args);
    },
    ephemeralAttachments: attachments,
    disposeEphemeral() { for (const id of sessions.keys()) remove(id); }
  });
}

module.exports = { withEphemeralSessions, ephemeralId, IDLE_MS, failure };
