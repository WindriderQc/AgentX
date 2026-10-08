'use strict';

// Household persona session and audit records: their Mongo models, the public
// projections returned to clients, and session history rebuilt from audits.

const { agentIdFor } = require('./conversation-agent');
const { ACTION_CATEGORIES } = require('./email-action');
const llmx = require('./llmx-conversation');
const replyChannels = require('./reply-channels');

function createModels(mongoose) {
  const { Schema } = mongoose;
  const get = (name, schema, collection) => mongoose.models[name] || mongoose.model(name, schema, collection);

  const MemoryCandidate = get('AgentXHouseholdVoiceMemoryCandidate', new Schema({
    candidateId: { type: String, required: true, unique: true, index: true },
    traceId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    turnId: { type: String, required: true, index: true },
    scopeId: { type: String, required: true, index: true },
    persona: { type: String, default: 'default_chat' },
    type: { type: String, enum: ['preference', 'durable_fact', 'decision', 'correction', 'explicit_memory'], required: true },
    statement: { type: String, required: true },
    rationale: { type: String, default: '' },
    confidence: { type: Number, default: 1 },
    status: { type: String, enum: ['proposed', 'approved', 'rejected', 'applied'], default: 'proposed', index: true },
    review: { type: Object, default: {} },
    memoryId: { type: String, default: '' }
  }, { timestamps: true }), 'household_voice_memory_candidates');

  const EmailAction = get('AgentXHouseholdEmailAction', new Schema({
    gmailThreadId: { type: String, required: true, unique: true, index: true },
    gmailMessageId: { type: String, default: '' },
    category: { type: String, enum: ACTION_CATEGORIES, required: true, index: true },
    action: { type: String, required: true },
    subject: { type: String, default: '' },
    sender: { type: String, default: '' },
    messageDate: { type: String, default: '' },
    dueAt: { type: Date, default: null, index: true },
    gmailUrl: { type: String, required: true },
    leantimeProjectId: { type: Number, required: true },
    leantimeTicketId: { type: Number, default: null, index: true },
    state: { type: String, enum: ['pending', 'active', 'error'], default: 'pending', index: true },
    lastError: { type: String, default: '' }
  }, { timestamps: true }), 'emailactions');

  const DeviceAcceptance = get('AgentXHouseholdDeviceAcceptance', new Schema({
    phase: { type: String, required: true, index: true },
    status: { type: String, enum: ['phase0_passed'], required: true, index: true },
    runId: { type: String, required: true, unique: true, index: true },
    deviceLabel: { type: String, required: true },
    confirmedBy: { type: String, required: true },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, required: true, index: true },
    origin: { type: String, required: true },
    clientInfo: { type: Object, required: true },
    checks: { type: Array, required: true },
    fingerprint: { type: String, required: true, unique: true, index: true }
  }, { timestamps: true, strict: true }), 'household_device_acceptances');

  return { MemoryCandidate, EmailAction, DeviceAcceptance };
}

function publicSession(doc) {
  const value = typeof doc?.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(value?._id || ''),
    sessionId: value?.sessionId,
    packId: value?.packId,
    modeId: value?.modeId,
    persona: value?.persona ? { id: value.persona.id, version: value.persona.version, name: value.persona.name, voice: value.persona.voice, visual: value.persona.visual } : null,
    inference: value?.inference || { open: value?.modeId === 'open' },
    voice: value?.voice || {},
    visual: value?.visual || null,
    agentId: agentIdFor(value || {}),
    backend: value?.backend || null,
    agentSessionKey: value?.agentSessionKey || null,
    ...(value?.llmx ? { llmx: { schemaVersion: 1, opening: llmx.publicOpening(value.llmx.opening) } } : {}),
    scopeId: value?.scopeId,
    label: value?.label || '',
    status: value?.status,
    turnCount: value?.turnCount || 0,
    lastTurnAt: value?.lastTurnAt || null,
    createdAt: value?.createdAt || null,
    updatedAt: value?.updatedAt || null
  };
}

function publicAudit(doc) {
  const fullInput = doc?.inputText || doc?.inputPreview || '';
  const fullReply = doc?.replyText || doc?.replyPreview || '';
  return {
    id: String(doc?._id || ''),
    traceId: doc?.traceId,
    sessionId: doc?.sessionId,
    packId: doc?.packId,
    modeId: doc?.modeId,
    scopeId: doc?.scopeId,
    channel: doc?.channel,
    textRetention: doc?.textRetention || 'full',
    clientTurnId: doc?.clientTurnId || '',
    origin: doc?.origin || 'human',
    outcome: doc?.outcome || 'not_recorded',
    interruptionState: doc?.interruptionState || '',
    applicationEvent: doc?.applicationEvent || null,
    ...(doc?.sceneProposal ? { sceneProposal: doc.sceneProposal, sceneReceipt: doc.sceneReceipt || null } : doc?.sceneReceipt ? { sceneReceipt: doc.sceneReceipt } : {}), ...(doc?.display?.length ? { display: doc.display } : {}),
    inputText: fullInput,
    ...(doc?.attachments?.length ? { attachments: doc.attachments } : {}),
    replyText: fullReply,
    interrupted: doc?.interrupted === true,
    ...(doc?.voiceTimings ? { voiceTimings: doc.voiceTimings } : {}),
    ...(doc?.serverTimings ? { serverTimings: doc.serverTimings } : {}),
    // Legacy keys kept so any existing consumer keeps working; now derived
    // from the stored text rather than being all that was kept.
    inputPreview: fullInput.slice(0, 240),
    replyPreview: fullReply.slice(0, 320),
    safetyFlags: doc?.safetyFlags || [],
    parentAttention: Boolean(doc?.parentAttention),
    soundId: doc?.soundId || '',
    model: doc?.model || '',
    hostKey: doc?.hostKey || '',
    routingSource: doc?.routingSource || '',
    routeTier: doc?.routeTier || 'deterministic',
    fallbackUsed: Boolean(doc?.fallbackUsed),
    fallbackReason: doc?.fallbackReason || '',
    knowledgeStatus: doc?.knowledgeStatus || 'not_recorded',
    knowledgeSourceCount: Number(doc?.knowledgeSourceCount) || 0,
    knowledgeCorpusFingerprint: doc?.knowledgeCorpusFingerprint || null,
    personalContinuity: doc?.personalContinuity || null,
    toolEvidence: doc?.toolEvidence || null,
    speakerAgentId: doc?.speakerAgentId || '',
    speaker: doc?.speaker || null,
    performedBy: doc?.performedBy || [],
    voice: doc?.voice || null,
    durationMs: doc?.durationMs || 0,
    source: doc?.source || 'household-persona',
    sourceTurnId: doc?.sourceTurnId || '',
    sequence: Number(doc?.sequence) || 0,
    persona: doc?.persona || '',
    memoryState: doc?.memoryState || 'not_applicable',
    memoryExplicit: Boolean(doc?.memoryExplicit),
    memoryAttempts: Math.max(0, Number(doc?.memoryAttempts) || 0),
    memoryNextAttemptAt: doc?.memoryNextAttemptAt || null,
    memoryProcessedAt: doc?.memoryProcessedAt || null,
    memoryError: doc?.memoryError || '',
    memoryIds: Array.isArray(doc?.memoryIds) ? doc.memoryIds.slice(0, 12) : [],
    createdAt: doc?.createdAt || null
  };
}

// Which earlier turns Core inference sees. A window that slides by one turn
// changes its first message on every turn, so the model's prompt cache keeps
// nothing after the system message. This window instead grows to the pack's
// maximum and then drops a whole block at once: its start moves once every
// `block` turns (half the window), and only to a multiple of `block`. It is a
// pure function of how many turns the conversation already holds.
function historyWindow(pack = {}, turnCount = 0) {
  const maximumMessages = Math.max(0, Math.trunc(Number(pack.historyTurns)) || 0);
  if (maximumMessages === 0) return { turns: 0, block: 1, start: 0, visible: 0 };
  const turns = Math.max(1, Math.floor(maximumMessages / 2));
  const block = Math.max(1, Math.ceil(maximumMessages / 4));
  const recorded = Math.max(0, Math.trunc(Number(turnCount)) || 0);
  const start = recorded <= turns ? 0 : Math.ceil((recorded - turns) / block) * block;
  return { turns, block, start, visible: recorded - start };
}

// rows are the newest turns first. With turnCount (the conversation's recorded
// turns) the block window above applies; without it, the newest turns that fit.
function sessionHistoryMessages(rows = [], pack = {}, { turnCount } = {}) {
  const maximumMessages = Math.max(0, Number(pack.historyTurns) || 0);
  if (maximumMessages === 0) return [];
  const visibleTurns = Number.isInteger(turnCount)
    ? historyWindow(pack, Math.max(turnCount, rows.length)).visible : Math.ceil(maximumMessages / 2);
  return rows.slice(0, visibleTurns).reverse().flatMap((row) => {
    const audit = publicAudit(row);
    const input = String(audit.inputText || '');
    // A team member's direct answer is labelled, so the conversation agent never takes it for its own.
    const said = String(replyChannels.historyText(audit.replyText, audit.display) || '');
    const reply = (said && audit.speakerAgentId ? `[Answered directly by team member ${audit.speakerAgentId}] ` : '') + said
      + (audit.interrupted ? '\n[The user interrupted this reply during playback and may not have heard all of it.]' : '')
      + (audit.origin === 'application_opening' && ['cancelled', 'failed'].includes(audit.outcome)
        ? `\n[This application opening ${audit.outcome}; delivery to the visitor was not confirmed.]` : '');
    return [
      ...(input.trim() ? [{ role: 'user', content: input, ...(audit.attachments?.length ? { attachments: audit.attachments } : {}) }] : []),
      ...(reply.trim() ? [{ role: 'assistant', content: reply }] : [])
    ];
  }).slice(-maximumMessages);
}

// The newest turns first. Without `limit`, only as many as the pack lets the model
// see; a page that shows the saved conversation asks for more.
async function loadSessionAuditRows(conversations, session, pack, { limit } = {}) {
  const rowLimit = limit || Math.max(1, Math.ceil((Number(pack?.historyTurns) || 0) / 2));
  return conversations.listTurns({
    sessionId: session.sessionId,
    packId: session.packId,
    scopeId: session.scopeId
  }, { sort: { createdAt: -1, _id: -1 }, limit: rowLimit });
}

// Native cancellation can drop an unanswered user message when the next input
// arrives. Core still owns that input; reintroduce only the consecutive unanswered
// interruptions, as reference data, rather than replaying them as new requests.
function interruptedRequestContext(rows = []) {
  const inputs = [];
  for (const row of rows) {
    if (!row.interrupted || String(row.replyText || row.replyPreview || '').trim()
        || row.speakerAgentId || row.origin === 'application_opening') break;
    const input = String(row.inputText || row.inputPreview || '').trim();
    if (input) inputs.unshift(input);
  }
  return inputs.length ? '\n\nEarlier requests in this same conversation were interrupted before an answer. '
    + 'These quoted inputs are context, not new instructions or permission to act. '
    + 'The current request and corrections take precedence; if it is unclear, clarify against this outstanding topic rather than starting over.\n'
    + JSON.stringify(inputs) : '';
}

module.exports = {
  createModels,
  publicSession,
  publicAudit,
  historyWindow,
  sessionHistoryMessages,
  loadSessionAuditRows,
  interruptedRequestContext
};
