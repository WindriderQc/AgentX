'use strict';

const mongoose = require('mongoose');
const Conversation = require('../../../models/Conversation');
const { withPlaygroundHistoryFilter } = require('../conversationSurfacePolicy');

const OUTCOMES = new Set(['stopped', 'failed']);

class TurnOutcomeError extends Error {
  constructor(message, statusCode = 400, code = 'INVALID_TURN_OUTCOME') {
    super(message);
    this.name = 'TurnOutcomeError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function boundedString(value, { field, required = false, maxLength }) {
  const normalized = value === null || value === undefined ? '' : String(value).trim();
  if (required && !normalized) {
    throw new TurnOutcomeError(`${field} is required`);
  }
  if (normalized.length > maxLength) {
    throw new TurnOutcomeError(`${field} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function sanitizeErrorDetail(value) {
  const normalized = boundedString(value, { field: 'errorMessage', maxLength: 2000 });
  if (!normalized) return null;
  return normalized
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, '[redacted credential]')
    .replace(/\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '[redacted credential]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[service endpoint]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[service host]');
}

function normalizeTurnOutcome(input = {}) {
  const outcome = boundedString(input.outcome, { field: 'outcome', required: true, maxLength: 20 }).toLowerCase();
  if (!OUTCOMES.has(outcome)) {
    throw new TurnOutcomeError('outcome must be stopped or failed');
  }

  const conversationId = boundedString(input.conversationId, { field: 'conversationId', maxLength: 80 });
  if (conversationId && !mongoose.Types.ObjectId.isValid(conversationId)) {
    throw new TurnOutcomeError('conversationId is invalid');
  }
  const sourceUserMessageId = boundedString(input.sourceUserMessageId, { field: 'sourceUserMessageId', maxLength: 80 });
  if (sourceUserMessageId && !mongoose.Types.ObjectId.isValid(sourceUserMessageId)) {
    throw new TurnOutcomeError('sourceUserMessageId is invalid');
  }
  if (sourceUserMessageId && !conversationId) {
    throw new TurnOutcomeError('conversationId is required with sourceUserMessageId');
  }

  return {
    conversationId: conversationId || null,
    sourceUserMessageId: sourceUserMessageId || null,
    clientTurnId: boundedString(input.clientTurnId, { field: 'clientTurnId', required: true, maxLength: 160 }),
    model: boundedString(input.model || 'unknown', { field: 'model', maxLength: 240 }) || 'unknown',
    userMessage: boundedString(input.userMessage, { field: 'userMessage', required: true, maxLength: 120000 }),
    assistantContent: boundedString(input.assistantContent, { field: 'assistantContent', required: true, maxLength: 120000 }),
    outcome,
    errorCode: boundedString(input.errorCode, { field: 'errorCode', maxLength: 120 }) || null,
    errorMessage: sanitizeErrorDetail(input.errorMessage)
  };
}

function idOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value.toHexString === 'function') return value.toHexString();
  return String(value);
}

// The receipt of a turn already stored under this clientTurnId, whether it was
// recorded here or by the main chat path (which then completed after all).
function storedTurnReceipt(conversation, clientTurnId) {
  const turn = Array.from(conversation?.messages || [])
    .filter(message => message?.metadata?.clientTurnId === clientTurnId);
  const reply = turn.find(message => message.role === 'assistant');
  if (!reply) return null;
  const user = turn.find(message => message.role === 'user');
  return {
    conversationId: idOf(conversation._id),
    userMessageId: idOf(reply.metadata?.sourceUserMessageId || user?._id),
    assistantMessageId: idOf(reply._id),
    outcome: reply.metadata?.outcome || 'completed',
    idempotent: true
  };
}

// Only Playground conversations owned by the server-resolved identity are
// reachable. Surface histories (PsyX, Household, ...) keep their own session
// locks and must never be appended to through this route.
function playgroundScope(userId) {
  return withPlaygroundHistoryFilter({
    userId,
    surface: { $exists: false },
    'lifecycle.status': { $ne: 'archived' }
  });
}

function buildTurnMessages(input, sourceUserMessage) {
  const userMessage = sourceUserMessage || {
    _id: new mongoose.Types.ObjectId(),
    role: 'user',
    content: input.userMessage,
    metadata: { clientTurnId: input.clientTurnId, outcomeRecord: true }
  };
  const assistantMessage = {
    _id: new mongoose.Types.ObjectId(),
    role: 'assistant',
    content: input.assistantContent,
    metadata: {
      clientTurnId: input.clientTurnId,
      sourceUserMessageId: idOf(userMessage._id),
      outcome: input.outcome,
      retryable: true,
      model: input.model,
      error: input.errorCode || input.errorMessage
        ? { code: input.errorCode, message: input.errorMessage }
        : null
    }
  };
  return {
    userMessage,
    assistantMessage,
    messages: sourceUserMessage ? [assistantMessage] : [userMessage, assistantMessage]
  };
}

function receiptOf(conversationId, { userMessage, assistantMessage }, outcome) {
  return {
    conversationId: idOf(conversationId),
    userMessageId: idOf(userMessage._id),
    assistantMessageId: idOf(assistantMessage._id),
    outcome,
    idempotent: false
  };
}

// Appends to an existing conversation with one conditional update, so
// concurrent copies of the same clientTurnId store the pair once.
async function appendToConversation(owner, input) {
  const scope = { ...playgroundScope(owner), _id: input.conversationId };
  const conversation = await Conversation.findOne(scope);
  if (!conversation) {
    throw new TurnOutcomeError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
  }
  const existing = storedTurnReceipt(conversation, input.clientTurnId);
  if (existing) return existing;

  let sourceUserMessage = null;
  if (input.sourceUserMessageId) {
    sourceUserMessage = Array.from(conversation.messages || []).find(message => (
      message?.role === 'user' && idOf(message?._id) === input.sourceUserMessageId
    )) || null;
    if (!sourceUserMessage) {
      throw new TurnOutcomeError('Source user message not found', 400, 'SOURCE_USER_MESSAGE_NOT_FOUND');
    }
  }
  const turn = buildTurnMessages(input, sourceUserMessage);
  const updated = await Conversation.findOneAndUpdate(
    { ...scope, 'messages.metadata.clientTurnId': { $ne: input.clientTurnId } },
    { $push: { messages: { $each: turn.messages } }, $set: { updatedAt: new Date() } },
    { new: true, runValidators: true }
  );
  if (updated) return receiptOf(updated._id, turn, input.outcome);

  const stored = storedTurnReceipt(await Conversation.findOne(scope), input.clientTurnId);
  if (stored) return stored;
  throw new TurnOutcomeError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
}

// A first turn creates its conversation; the unique (userId, clientTurnId)
// index turns a concurrent copy into a duplicate key, answered with the
// receipt of the conversation that won.
async function createConversation(owner, input) {
  const existing = storedTurnReceipt(await Conversation.findOne({
    ...playgroundScope(owner),
    'messages.metadata.clientTurnId': input.clientTurnId
  }), input.clientTurnId);
  if (existing) return existing;

  const turn = buildTurnMessages(input, null);
  const conversation = new Conversation({
    userId: owner,
    model: input.model,
    source: 'agentx',
    clientTurnId: input.clientTurnId,
    title: input.userMessage.slice(0, 50) || 'Agent X Chat',
    messages: turn.messages
  });
  try {
    await conversation.save();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const stored = storedTurnReceipt(await Conversation.findOne({
      userId: owner, clientTurnId: input.clientTurnId
    }), input.clientTurnId);
    if (stored) return stored;
    throw err;
  }
  return receiptOf(conversation._id, turn, input.outcome);
}

// userId is the server-resolved identity and is passed separately from the
// client body so no body field can select the owner or scope.
async function persistTurnOutcome(userId, rawInput = {}) {
  const owner = typeof userId === 'string' ? userId.trim() : '';
  if (!owner || owner.startsWith('surface:')) {
    throw new TurnOutcomeError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
  }
  const input = normalizeTurnOutcome(rawInput);
  return input.conversationId
    ? appendToConversation(owner, input)
    : createConversation(owner, input);
}

module.exports = {
  TurnOutcomeError,
  normalizeTurnOutcome,
  persistTurnOutcome,
  sanitizeErrorDetail
};
