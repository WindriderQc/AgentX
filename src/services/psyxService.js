'use strict';

const fetch = require('node-fetch');
const Conversation = require('../../models/Conversation');
const PsyXState = require('../../models/PsyXState');
const { getOrCreateProfile } = require('../helpers/userHelpers');
const { buildSystemPrompt } = require('./chat/chatPromptHelpers');
const { persistConversation, findConversationForUpdate } = require('./chat/conversationPersistence');
const { buildOllamaPayload, extractResponse } = require('../helpers/ollamaResponseHandler');
const { sanitizeOptions, resolveModelNumCtx, resolveTarget } = require('../utils');
const { getTargetForModel, recordInference } = require('./modelRouter');
const logger = require('../../config/logger');
const {
  PSYX_PROMPT_VERSION,
  PSYX_DEFAULT_MODEL,
  PSYX_SYSTEM_PROMPT
} = require('../../config/psyx');

function buildStateQuery(userId, workspaceId = null) {
  const query = { userId };
  if (workspaceId) {
    query.workspaceId = workspaceId;
  } else {
    query.$or = [
      { workspaceId: { $exists: false } },
      { workspaceId: null }
    ];
  }
  return query;
}

async function getOrCreateState(userId, workspaceId = null) {
  const query = buildStateQuery(userId, workspaceId);
  let state = await PsyXState.findOne(query);
  if (state) return state;

  try {
    state = await PsyXState.create({ userId, workspaceId });
    return state;
  } catch (err) {
    if (err.code === 11000) {
      return PsyXState.findOne(query);
    }
    throw err;
  }
}

function toPlainState(state) {
  if (!state) return {};
  const raw = typeof state.toObject === 'function' ? state.toObject() : state;
  return {
    activeThreads: raw.activeThreads || [],
    patterns: raw.patterns || [],
    hypotheses: raw.hypotheses || [],
    relationships: raw.relationships || {},
    openLoops: raw.openLoops || [],
    experiments: raw.experiments || [],
    recentEmotionalState: raw.recentEmotionalState || {},
    importantEvents: raw.importantEvents || [],
    contradictions: raw.contradictions || [],
    riskSignals: raw.riskSignals || [],
    notes: raw.notes || [],
    interactionCount: raw.interactionCount || 0,
    lastInteractionAt: raw.lastInteractionAt || null
  };
}

function renderStateForPrompt(state) {
  return `\n\n=== PSYX LONGITUDINAL STATE ===\n${JSON.stringify(toPlainState(state), null, 2)}\n=== END PSYX LONGITUDINAL STATE ===`;
}

async function getConversationMessages({ conversationId, userId, workspaceId }) {
  if (!conversationId) return [];
  const conversation = await findConversationForUpdate({ conversationId, userId, workspaceId });
  if (!conversation) return [];

  return conversation.messages
    .filter(message => ['user', 'assistant'].includes(message.role))
    .map(message => ({ role: message.role, content: message.content }));
}

async function remember({ userId, workspaceId = null, text }) {
  if (!text || !String(text).trim()) {
    throw new Error('Memory text is required');
  }
  const state = await getOrCreateState(userId, workspaceId);
  state.notes.push({ text: String(text).trim(), source: 'user' });
  await state.save();
  return state;
}

async function clearState({ userId, workspaceId = null }) {
  const state = await getOrCreateState(userId, workspaceId);
  state.activeThreads = [];
  state.patterns = [];
  state.hypotheses = [];
  state.relationships = {};
  state.openLoops = [];
  state.experiments = [];
  state.recentEmotionalState = {};
  state.importantEvents = [];
  state.contradictions = [];
  state.riskSignals = [];
  state.notes = [];
  await state.save();
  return state;
}

async function chat({
  userId,
  workspaceId = null,
  message,
  conversationId = null,
  model = PSYX_DEFAULT_MODEL,
  target = null,
  options = {}
}) {
  if (!userId) throw new Error('userId is required');
  if (!message || !String(message).trim()) throw new Error('message is required');

  const state = await getOrCreateState(userId, workspaceId);
  const effectiveConversationId = conversationId || state.lastConversationId || null;
  const history = await getConversationMessages({
    conversationId: effectiveConversationId,
    userId,
    workspaceId
  });

  const userProfile = await getOrCreateProfile(userId);
  const baseSystemPrompt = buildSystemPrompt(PSYX_SYSTEM_PROMPT, userProfile, null);
  const effectiveSystemPrompt = baseSystemPrompt + renderStateForPrompt(state);

  const effectiveTarget = target || getTargetForModel(model);
  if (!effectiveTarget) throw new Error(`No Ollama target available for model ${model}`);

  const sanitized = sanitizeOptions(options) || {};
  if (!sanitized.num_ctx) {
    sanitized.num_ctx = await resolveModelNumCtx(model, {
      targetHost: resolveTarget(effectiveTarget)
    });
  }

  const messages = [
    { role: 'system', content: effectiveSystemPrompt },
    ...history,
    { role: 'user', content: String(message).trim() }
  ];

  const payload = buildOllamaPayload({
    model,
    messages,
    options: sanitized,
    streamEnabled: false
  });

  const url = `${resolveTarget(effectiveTarget)}/api/chat`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      let detail = response.statusText;
      try {
        const body = await response.json();
        detail = body.error || JSON.stringify(body) || detail;
      } catch (_) {}
      throw new Error(`Ollama request failed: ${detail}`);
    }

    const data = await response.json();
    const extracted = extractResponse(data, model);
    const assistantContent = extracted.content;
    if (!assistantContent || !assistantContent.trim()) {
      throw new Error('PsyX received an empty model response');
    }

    const activePrompt = {
      _id: null,
      name: 'psyx',
      version: PSYX_PROMPT_VERSION
    };

    const { conversation, assistantMessageId } = await persistConversation({
      userId,
      workspaceId,
      conversationId: effectiveConversationId,
      model,
      effectiveSystemPrompt,
      message: String(message).trim(),
      assistantContent,
      activePrompt,
      metadata: {
        thinking: extracted.thinking,
        options: sanitized
      },
      stats: extracted.stats,
      ragUsed: false,
      useRag: false,
      ragSources: []
    });

    if (!conversation) {
      throw new Error('PsyX response completed but conversation persistence failed');
    }

    state.lastConversationId = conversation._id;
    state.interactionCount = (state.interactionCount || 0) + 1;
    state.lastInteractionAt = new Date();
    await state.save();

    recordInference({
      host: resolveTarget(effectiveTarget),
      model,
      caller: 'psyx',
      callerDetail: userId,
      tokensIn: extracted.stats?.usage?.promptTokens || 0,
      tokensOut: extracted.stats?.usage?.completionTokens || 0,
      durationMs: Date.now() - startedAt,
      status: 'success'
    });

    return {
      response: assistantContent,
      conversationId: conversation._id,
      messageId: assistantMessageId,
      model,
      target: effectiveTarget,
      interactionCount: state.interactionCount
    };
  } catch (err) {
    recordInference({
      host: resolveTarget(effectiveTarget),
      model,
      caller: 'psyx',
      callerDetail: userId,
      durationMs: Date.now() - startedAt,
      status: err.name === 'AbortError' ? 'timeout' : 'error',
      error: err.message
    });

    logger.error('PsyX chat failed', {
      userId,
      model,
      target: effectiveTarget,
      error: err.message
    });

    if (err.name === 'AbortError') {
      throw new Error('PsyX model request timed out (2m limit)');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  chat,
  getOrCreateState,
  renderStateForPrompt,
  toPlainState,
  remember,
  clearState
};
