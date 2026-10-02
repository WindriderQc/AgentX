'use strict';

const crypto = require('crypto');
const personaCatalog = require('./persona-catalog');
const { createNestorClient } = require('./personal-continuity');
const { createAgentClient, agentIdFor } = require('./conversation-agent');
const { configuredOpenClaw, conversationBackend, createConversationExecutor } = require('./conversation-executor');
const llmx = require('./llmx-conversation');
const { visual: normalizeVisual, selections: voiceSelections } = require('./public/persona-presentation');
const path = require('path');
const { dadBriefing, dadDesk, morningReminderPreview, publicTask, sortedPersonalTasks } = require('./briefing');
const {
  calendarDayKey,
  cleanProfileId,
  familyChore,
  familyProfile,
  familyRoom,
  familyTimeZone,
  nextRoutineDue
} = require('../../src/domains/household/family');
const { registerFamilyRoutes } = require('./family-routes');
const replyChannels = require('./reply-channels'), { plainReply } = replyChannels, { createVisuals } = require('./visuals'), { createBrain } = require('./brain');
const { registerSecretaryMcp } = require('./secretary-mcp');
const { registerSecretaryMailRoutes, secretaryMailControl } = require('./secretary-mail-routes');
const { ACTION_CATEGORIES, checkEmailActionReadiness } = require('./email-action');
const { householdActivation } = require('./readiness');
const { voiceContract } = require('./voice-contract');
const { avatarModuleUrl, createScriptRelay } = require('./asset-relay');
const {
  detectSpeechLanguage,
  normalizeSpeechLanguage,
  speechProfile
} = require('./public/speech-language');
const deviceAcceptance = require('./device-acceptance');
const nestorKnowledge = require('./nestor-knowledge');
const soundLibrary = require('./sound-library');
const { openClawCrew, openClawPanelStatus, panelCrewReady } = require('./panel-status');
const {
  fetchWithTimeout, upstreamJson, publicVoixConfig, publicVoixConversation, publicVoixEvent, publicVoixMediaClip, publicVoixMediaVault, publicVoixMetrics, publicVoixSession
} = require('./voix-client');
const { registerVoixRoutes } = require('./voix-routes');
const { registerNativeConsumers } = require('./native-consumers');
const { createPersonaTurnHandler } = require('./persona-turn');
const {
  createOpenLaneHold: createHostHold,
  HOUSEHOLD_OPEN_HOLD_IDLE_MS, HOUSEHOLD_OPEN_HOLD_OWNER, HOUSEHOLD_OPEN_HOLD_WAIT_TIMEOUT_MS
} = require('./open-lane-hold');
const {
  HOUSEHOLD_PERMISSIVE_PRIMARY_DEFAULT_MODEL, HOUSEHOLD_PERMISSIVE_PRIMARY_DEFAULT_DIGEST, HOUSEHOLD_PERMISSIVE_CONTEXT, PERSONAL_OPERATOR_SURFACE_CONTRACT, PACKS,
  SAFETY_SUPPORT, packIdsSharingMemory, packById, packSummary, modeSummary,
  inferenceTargetForMode
} = require('./packs');
const {
  MEMORY_RECALL_LIMIT, MEMORY_BLOCK_MAX_CHARS, MEMORY_CONTRACT, detectMemoryRequest, memoryBlock,
  replyLanguageDirective, spokenReplyLanguage, systemPromptFor, assessSafety, escalationReply,
  childBoundaryReply
} = require('./persona-prompt');
const {
  VOIX_MEMORY_SCHEMA_VERSION, VOIX_MEMORY_SCOPE_ID, explicitMemoryStatement, forgetMemoryStatement, normalizeVoixMemoryTurn,
  inferredMemoryCandidate, voiceMemoryCandidateId, normalizeVoixTranscriptionMultipart
} = require('./voice-memory-turns');

const CORE_SELF_URL = () => String(process.env.CORE_INTERNAL_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '');
const VOIX_FAMILY_PACK_ID = 'kidx_nestor';
const VOIX_FAMILY_MODE_ID = 'family';
const VOIX_FAMILY_SCOPE_ID = 'family';
const HOUSEHOLD_CONSUMER_CONTRACT = 'household-runtime-v1';
const EXTENSION_CAPABILITIES = Object.freeze([
  'household-panel',
  'reader',
  'secretary',
  'voice-personas',
  'llmx-conversation',
  'voice-transport',
  'voice-contract',
  'voice-memory',
  'voice-improvement-media-vault',
  'ecosystem-crew',
  'kids-room',
  'kids-sound-library',
  'family-launch',
  'dad-desk',
  'dad-nestor',
  'kids-learning-companion',
  'nestor-secretary-tools',
  'gmail-action-intake',
  'curated-knowledge',
  'physical-device-acceptance'
]);
const FLEET_LABELS = Object.freeze({
  primary: 'Primary inference',
  secondary: 'Secondary inference',
  tertiary: 'Service host'
});

function envelope(res, data, status = 200) {
  return res.status(status).json({ ok: true, status: 'success', data });
}

function fail(res, status, message, code = 'HOUSEHOLD_ERROR', details) {
  const body = { ok: false, status: 'error', message, code };
  if (details) body.details = details;
  return res.status(status).json(body);
}

function cleanText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function secureTokenEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function bearerToken(req) {
  const header = String(req.get?.('authorization') || req.headers?.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireVoixMemoryConsumer(req, res, next) {
  const expected = String(process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN || '').trim();
  if (!expected) return fail(res, 503, 'Voice memory consumer authentication is not configured', 'VOIX_MEMORY_AUTH_UNCONFIGURED');
  if (!secureTokenEqual(bearerToken(req), expected)) {
    return fail(res, 401, 'Voice memory consumer token is invalid', 'VOIX_MEMORY_AUTH_INVALID');
  }
  return next();
}

function cleanScope(value, fallback = 'default') {
  return cleanText(value || fallback, 64).toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

// The open-lane hold targets the personal operator's Open mode.
function createOpenLaneHold(options = {}) {
  const pack = PACKS.find((entry) => entry.id === 'personal_operator');
  const mode = pack?.modes.find((entry) => entry.id === 'open');
  return createHostHold({ ...options, resolveTarget: (env) => inferenceTargetForMode(pack, mode, env) });
}

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

async function serviceHealth(name, url) {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(url, {}, 5000);
    return { id: name.toLowerCase(), name, status: response.ok ? 'ok' : 'down', latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { id: name.toLowerCase(), name, status: 'down', latencyMs: Date.now() - startedAt, error: error.message };
  }
}

async function projectedJson(url, projector, fallback, timeoutMs = 8000) {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, timeoutMs);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.message || body?.error || `HTTP ${response.status}`);
    return { ...projector(body), latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ...fallback, latencyMs: Date.now() - startedAt, error: error.message };
  }
}

const projectionCache = new Map();
const projectionInFlight = new Map();

async function cachedProjectedJson(url, projector, fallback, timeoutMs = 8000, ttlMs = 60_000) {
  const cached = projectionCache.get(url);
  if (cached && Date.now() < cached.expiresAt) {
    return { ...projector(cached.body), latencyMs: 0, cache: 'fresh' };
  }
  let pending = projectionInFlight.get(url);
  if (!pending) pending = (async () => {
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, timeoutMs);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || body?.error || `HTTP ${response.status}`);
      projectionCache.set(url, { body, expiresAt: Date.now() + ttlMs });
      return { body, latencyMs: Date.now() - startedAt, cache: 'refreshed' };
    } catch (error) {
      if (cached) return { body: cached.body, latencyMs: Date.now() - startedAt, cache: 'stale', error: error.message };
      return { body: null, latencyMs: Date.now() - startedAt, cache: 'unavailable', error: error.message };
    } finally {
      projectionInFlight.delete(url);
    }
  })();
  if (!projectionInFlight.has(url)) projectionInFlight.set(url, pending);
  const result = await pending;
  const metadata = {
    latencyMs: result.latencyMs,
    cache: result.cache,
    ...(result.error ? { error: result.error } : {})
  };
  return result.body === null
    ? { ...fallback, ...metadata }
    : { ...projector(result.body), ...metadata };
}

function sessionHistoryMessages(rows = [], pack = {}) {
  const maximumMessages = Math.max(0, Number(pack.historyTurns) || 0);
  const maximumCharacters = Math.max(1, Number(pack.historyMessageCharacters) || 1000);
  if (maximumMessages === 0) return [];
  return rows.slice(0, Math.ceil(maximumMessages / 2)).reverse().flatMap((row) => {
    const audit = publicAudit(row);
    const input = cleanText(audit.inputText, maximumCharacters);
    const reply = cleanText(replyChannels.historyText(audit.replyText, audit.display), maximumCharacters)
      + (audit.interrupted ? '\n[The user interrupted this reply during playback and may not have heard all of it.]' : '')
      + (audit.origin === 'application_opening' && ['cancelled', 'failed'].includes(audit.outcome)
        ? `\n[This application opening ${audit.outcome}; delivery to the visitor was not confirmed.]` : '');
    return [
      ...(input ? [{ role: 'user', content: input, ...(audit.attachments?.length ? { attachments: audit.attachments } : {}) }] : []),
      ...(reply ? [{ role: 'assistant', content: reply }] : [])
    ];
  }).slice(-maximumMessages);
}

async function loadSessionAuditRows(conversations, session, pack) {
  const rowLimit = Math.max(1, Math.ceil((Number(pack?.historyTurns) || 0) / 2));
  return conversations.listTurns({
    sessionId: session.sessionId,
    packId: session.packId,
    scopeId: session.scopeId
  }, { sort: { createdAt: -1, _id: -1 }, limit: rowLimit });
}

function hermesCrew(body = {}) {
  const telegram = body.gateway?.platforms?.telegram || {};
  const running = body.ok === true && body.gateway?.running === true;
  const connected = telegram.state === 'connected';
  const freshness = body.gateway?.freshness;
  const stale = freshness?.fresh === false;
  const degraded = running && (stale || (telegram.state && !connected));
  return {
    id: 'hermes',
    name: 'Hermès',
    role: 'External runtime · local memory source',
    status: running ? (degraded ? 'degraded' : 'ok') : 'down',
    detail: !running
      ? 'supervision gateway unavailable'
      : stale
        ? 'supervision online · Telegram evidence stale'
        : `supervision online${connected ? ' · Telegram connected' : ''}`,
    updatedAt: telegram.updated_at || body.gateway?.updatedAt || null,
    href: '/agent-ops'
  };
}

function fleetSummary(body = {}) {
  const data = body.data || body;
  const health = data.health || {};
  const hosts = Array.isArray(data.cluster) ? data.cluster.map((host) => {
    const models = Array.isArray(host?.models) ? host.models : [];
    return {
      id: cleanText(host?.hostKey || 'unknown', 32),
      name: FLEET_LABELS[host?.hostKey] || cleanText(host?.hostKey || 'Unknown host', 64),
      status: host?.status === 'online' ? 'ok' : 'down',
      models: models.length,
      primaryModel: cleanText(models[0] || '', 160),
      latencyMs: Number(host?.latency || 0)
    };
  }) : [];
  const configuredHosts = Math.max(0, Number(health.configuredHosts || hosts.length));
  const onlineHosts = Math.max(0, Number(health.onlineHosts || hosts.filter((host) => host.status === 'ok').length));
  const attention = (data.operationalAttention?.issues || [])
    .filter((issue) => issue.code !== 'active_alerts')
    .map((issue) => cleanText(issue.message, 240));
  for (const alert of (data.alerts || []).filter((entry) => entry.status === 'active').slice(0, 5)) {
    attention.push(cleanText(alert.title || alert.ruleName || 'Alerte active', 240));
  }
  if (data.health?.status !== 'ok' && !attention.length) attention.push('État opérationnel à vérifier');
  return {
    status: configuredHosts > 0 && hosts.length === configuredHosts && hosts.every((host) => host.status === 'ok') ? 'ok' : 'degraded',
    attention: attention.filter(Boolean).slice(0, 5),
    configuredHosts,
    onlineHosts,
    observedModels: Math.max(0, Number(health.observedModels || 0)),
    hosts
  };
}

function register(api) {
  if (!api || api.contractVersion !== 2) {
    throw new Error('agentx-household requires AgentX trusted-extension contract v2');
  }
  const { app, express, mongoose, standardJsonParser, runtimeServices, extensionRoot, logger } = api;
  const models = createModels(mongoose);
  const conversations = runtimeServices.conversations.forSurface('household');
  const personalTasks = runtimeServices.tasks.personal;
  const familyTasks = runtimeServices.tasks.family;
  const ownerMemory = runtimeServices.memory.forAudience('owner');
  const familyMemory = runtimeServices.memory.forAudience('household');
  const personalNotes = runtimeServices.memory.notes.personal();
  const notesFor = (pack, scopeId) => runtimeServices.memory.notes.forSpace({
    audience: pack.childSafe ? 'household' : 'owner', scopeId,
    packIds: packIdsSharingMemory(pack)
  });
  const nestorClient = app.locals?.agentxNestorContinuity || createNestorClient();
  const conversationEnv = app.locals?.agentxConversationEnv || process.env;
  const agentClient = app.locals?.agentxNestorAgent || createAgentClient({ env: conversationEnv, continuity: nestorClient });
  const executeConversation = createConversationExecutor({ agentClient, inference: runtimeServices.inference, consumerContract: HOUSEHOLD_CONSUMER_CONTRACT });
  const requireNativeAgent = async id => {
    if (id === 'main') return;
    const { agents } = await nestorClient({ operation: 'agents' });
    if (!agents?.some(agent => agent.id === id)) throw Object.assign(new Error('Choose an existing OpenClaw agent.'), { statusCode: 400 });
  };
  const bridgeProjection = async (method, projector, fallback, options = {}) => {
    const evidence = app.locals?.aioOpsRuntimeEvidence; // bridges register after this surface
    if (evidence?.contractVersion !== 1 || typeof evidence?.[method] !== 'function') {
      return { ...fallback, error: 'AIOps in-process runtime evidence is unavailable' };
    }
    const startedAt = Date.now();
    try { return { ...projector(await evidence[method](options)), latencyMs: Date.now() - startedAt }; }
    catch (error) { return { ...fallback, latencyMs: Date.now() - startedAt, error: error.message }; }
  };
  // Resolved per request: the runtime-bridges extension publishes it at registration.
  const secretaryMail = () => secretaryMailControl(app);
  const knowledgeState = nestorKnowledge.loadFailClosed(undefined, logger);
  const openHold = createOpenLaneHold({ runtimeServices, logger });
  // The existing OpenClaw Ollama proxy consumes this same private model policy.
  // Household owns the Open choice/hold; the proxy still owns model transport.
  app.locals.aioOpsConversationTarget = async model => {
    if (model !== (process.env.HOUSEHOLD_PERMISSIVE_PRIMARY_MODEL || HOUSEHOLD_PERMISSIVE_PRIMARY_DEFAULT_MODEL)) return null;
    const pack = packById('personal_operator');
    const target = inferenceTargetForMode(pack, pack.modes.find(mode => mode.id === 'open'));
    if (model !== target?.model) return null;
    const state = await openHold.status();
    if (!state.active) return null;
    return { ...target, contextSize: target.numCtx,
      inferenceContract: { capabilities: { tools: { supported: true }, thinking: { supported: true } } } };
  };
  let catalogReady;
  const ensureCatalog = () => {
    if (!runtimeServices.personas) throw Object.assign(new Error('The shared persona catalog needs the Product release.'), { statusCode: 503 });
    if (!catalogReady) catalogReady = runtimeServices.personas.publish('agentx-household', personaCatalog.generatedPersonas())
      .catch(error => { catalogReady = null; throw error; });
    return catalogReady;
  };
  const publicRoot = path.join(extensionRoot, 'public');
  // Resolved once at registration: the pack is read-only in the container, and
  // a clip that is not on disk is never advertised nor selected.
  const sounds = soundLibrary.createSoundLibrary({ soundsDir: path.join(publicRoot, 'sounds'), logger }), visuals = createVisuals({ logger }), brain = createBrain({ inference: runtimeServices.inference, conversations, consumerContract: HOUSEHOLD_CONSUMER_CONTRACT, logger,
    loadTurns: session => loadSessionAuditRows(conversations, session, { historyTurns: 12 }).then(rows => rows.slice().reverse().map(publicAudit)) });


  const processVoixMemoryAudit = async (traceId) => {
    const now = new Date();
    const claimed = await conversations.updateTurn(
      {
        traceId,
        source: 'voix-native',
        memoryState: 'captured',
        $or: [{ memoryNextAttemptAt: null }, { memoryNextAttemptAt: { $lte: now } }]
      },
      { $set: { memoryState: 'processing', memoryClaimedAt: new Date(), memoryError: '' } });
    if (!claimed) return null;
    const audit = typeof claimed.toObject === 'function' ? claimed.toObject() : claimed;
    const safety = assessSafety(audit.inputText);
    const blocked = safety.flagIds.some((id) => [
      'private_information', 'self_harm', 'immediate_danger', 'abuse_or_threat'
    ].includes(id));
    const forget = blocked ? '' : forgetMemoryStatement(audit.inputText);
    const explicit = blocked || forget ? '' : explicitMemoryStatement(audit.inputText);
    const memoryIds = [];
    try {
      if (forget) {
        const matches = await personalNotes.list({ query: forget, limit: 20 });
        const ids = matches.notes.map(row => row.id);
        if (ids.length) {
          for (const id of ids) await personalNotes.forget(id);
          memoryIds.push(...ids.map((id) => `forgotten:${String(id)}`));
        } else {
          memoryIds.push('forgotten:no-match');
        }
      } else if (explicit) {
        const memory = await personalNotes.record({ text: explicit, type: 'fact',
          source: 'voix-explicit', sourceTraceId: traceId });
        const memoryId = memory.id;
        if (memoryId) memoryIds.push(memoryId);
        const candidateId = voiceMemoryCandidateId(traceId, 'explicit_memory', explicit);
        await models.MemoryCandidate.findOneAndUpdate(
          { candidateId },
          {
            $setOnInsert: {
              candidateId,
              traceId,
              sessionId: audit.sessionId,
              turnId: audit.sourceTurnId,
              scopeId: audit.scopeId,
              persona: audit.persona,
              type: 'explicit_memory',
              statement: explicit,
              rationale: 'Explicit voice memory request from a completed Dad turn.',
              confidence: 1,
              status: 'applied',
              review: { by: 'explicit-owner-request', at: new Date() },
              memoryId
            }
          },
          { new: true, upsert: true }
        );
      } else if (!blocked) {
        const inferred = inferredMemoryCandidate(audit.inputText);
        if (inferred) {
          const candidateId = voiceMemoryCandidateId(traceId, inferred.type, inferred.statement);
          await models.MemoryCandidate.findOneAndUpdate(
            { candidateId },
            {
              $setOnInsert: {
                candidateId,
                traceId,
                sessionId: audit.sessionId,
                turnId: audit.sourceTurnId,
                scopeId: audit.scopeId,
                persona: audit.persona,
                ...inferred,
                status: 'proposed'
              }
            },
            { new: true, upsert: true }
          );
          memoryIds.push(`candidate:${candidateId}`);
        }
      }
      await conversations.updateTurn(
        { traceId },
        {
          $set: {
            memoryState: 'processed',
            memoryProcessedAt: new Date(),
            memoryNextAttemptAt: null,
            memoryError: blocked ? `skipped:${safety.flagIds.join(',')}` : '',
            memoryIds
          }
        }
      );
      return { traceId, memoryIds, explicit: Boolean(explicit), forget: Boolean(forget), blocked };
    } catch (error) {
      const attempts = Math.max(0, Number(audit.memoryAttempts) || 0) + 1;
      const terminal = attempts >= 5;
      const retryDelaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
      await conversations.updateTurn(
        { traceId },
        {
          $set: {
            memoryState: terminal ? 'failed' : 'captured',
            memoryAttempts: attempts,
            memoryNextAttemptAt: terminal ? null : new Date(Date.now() + retryDelaySeconds * 1000),
            memoryError: cleanText(error.message, 500)
          }
        }
      ).catch(() => {});
      throw error;
    }
  };

  const drainVoixMemoryAudits = async (limit = 10) => {
    const staleClaimBefore = new Date(Date.now() - 5 * 60 * 1000);
    await conversations.updateTurns(
      {
        source: 'voix-native',
        memoryState: 'processing',
        memoryClaimedAt: { $lt: staleClaimBefore }
      },
      { $set: { memoryState: 'captured', memoryError: 'recovered_stale_processing_claim' } }
    );
    const rows = await conversations.listTurns({
      source: 'voix-native',
      memoryState: 'captured',
      $or: [{ memoryNextAttemptAt: null }, { memoryNextAttemptAt: { $lte: new Date() } }]
    }, { sort: { sourceCompletedAt: 1, sequence: 1 }, limit: Math.max(1, Math.min(Number(limit) || 10, 50)) });
    const results = [];
    for (const row of rows) {
      try { results.push(await processVoixMemoryAudit(row.traceId)); }
      catch (error) { logger?.error?.('VoiX memory processing failed', { traceId: row.traceId, error: error.message }); }
    }
    return results.filter(Boolean);
  };

  app.use('/assets/household', express.static(publicRoot, { fallthrough: false, maxAge: '5m' }));
  app.get('/dad/nestor', (_req, res) => res.redirect(302, '/voice'));
  app.get([
    '/', '/ecosystem', '/panel', '/dad', '/dad/day', '/dad/memories', '/dad/family', '/voice-personas/debug', '/kids', '/kids/sounds', '/lecture', '/lecture/parents', '/lecture/parents.html',
    '/voice', '/voice/native', '/voice.html', '/voix', '/voice-personas', '/voice-personas.html', '/device-check'
  ], (_req, res) => res.sendFile(path.join(publicRoot, 'index.html')));
  app.get('/api/household/avatar/llmx-face.js', createScriptRelay({ resolveUrl: avatarModuleUrl, fetchWithTimeout,
    unavailable: (res, error) => fail(res, error.status || 503, error.message, error.code || 'AVATAR_UNAVAILABLE') }));

  registerVoixRoutes(app, {
    express, logger, models, conversations, personalNotes, runtimeServices, sounds, standardJsonParser, ensureCatalog, drainVoixMemoryAudits,
    envelope, fail, cleanText, assessSafety, detectMemoryRequest, normalizeVoixMemoryTurn, normalizeVoixTranscriptionMultipart, requireVoixMemoryConsumer,
    MEMORY_BLOCK_MAX_CHARS, MEMORY_RECALL_LIMIT, VOIX_MEMORY_SCHEMA_VERSION, VOIX_MEMORY_SCOPE_ID
  });

  const personas = express.Router();
  personas.use(standardJsonParser);
  personas.get('/private/agents', async (_req, res) => {
    try { return envelope(res, configuredOpenClaw(conversationEnv) ? await nestorClient({ operation: 'agents' }) : { agents: [] }); }
    catch { return fail(res, 503, 'OpenClaw agents are unavailable.', 'CONVERSATION_AGENTS_UNAVAILABLE'); }
  });
  personas.get('/catalog', async (_req, res) => {
    try { await ensureCatalog(); return envelope(res, { personas: (await runtimeServices.personas.list()).map(personaCatalog.snapshot), runtime: { defaultBackend: conversationBackend(null, conversationEnv), openclawConfigured: configuredOpenClaw(conversationEnv) } }); }
    catch (error) { return fail(res, error.statusCode || 503, error.message); }
  });
  personas.get('/catalog/:name', async (req, res) => {
    try { await ensureCatalog(); return envelope(res, { persona: personaCatalog.snapshot(await runtimeServices.personas.resolve(req.params.name, req.query.version)) }); }
    catch (error) { return fail(res, error.statusCode || 503, error.message); }
  });
  personas.get('/packs', (_req, res) => envelope(res, {
    defaultPackId: 'personal_operator',
    packs: PACKS.map(packSummary)
  }));
  personas.get('/knowledge/status', (_req, res) => envelope(res, {
    knowledge: knowledgeState.status
  }));
  // Dad's Open session hold: selecting Open acquires it (and starts loading
  // the model on inference-host), the page polls it to show loading/resident, and
  // leaving Open releases it. Core enforces the hold; this is only the door.
  const openHoldRoute = (operation) => async (req, res) => {
    try {
      return envelope(res, { hold: await openHold.browser(operation, req.query) });
    } catch (error) {
      return fail(
        res,
        error.statusCode || 503,
        error.message || 'Open session hold is unavailable',
        error.code || 'VOICE_PERSONA_OPEN_HOLD_UNAVAILABLE'
      );
    }
  };
  personas.get('/private/open/hold', openHoldRoute('status'));
  personas.post('/private/open/hold', openHoldRoute('acquire'));
  personas.delete('/private/open/hold', openHoldRoute('release'));
  // Open to the child surfaces on purpose: the clips are already served as
  // static assets, and the Kids Room shows what it can play.
  personas.get('/sounds', (_req, res) => envelope(res, {
    sounds: sounds.sounds,
    status: sounds.status
  }));
  personas.get('/packs/:packId', (req, res) => {
    const pack = packById(req.params.packId);
    if (!pack) return fail(res, 404, 'Unknown voice persona pack', 'VOICE_PERSONA_PACK_NOT_FOUND');
    return envelope(res, { pack: packSummary(pack), mode: modeSummary(pack.modes[0]) });
  });
  const createPersonaSession = (access, consumer = null) => async (req, res) => {
    try {
      const pack = packById(req.body?.packId || 'personal_operator');
      if (!pack) return fail(res, 404, 'Unknown voice persona pack', 'VOICE_PERSONA_PACK_NOT_FOUND');
      if (access === 'child' && !pack.childSafe) {
        return fail(res, 403, 'Private persona sessions require the guarded private route', 'VOICE_PERSONA_PRIVATE_ROUTE_REQUIRED');
      }
      if (access === 'private' && pack.childSafe) {
        return fail(res, 400, 'Child-safe persona sessions use the public child route', 'VOICE_PERSONA_CHILD_ROUTE_REQUIRED');
      }
      const requestedMode = pack.modes.find((entry) => entry.id === req.body?.modeId) || pack.modes[0];
      const backend = conversationBackend(req.body?.backend, conversationEnv);
      const agentId = pack.childSafe ? 'family' : backend === 'openclaw' ? req.body?.agentId || 'main' : 'main';
      if (backend === 'openclaw') await requireNativeAgent(agentId);
      const open = access === 'private' && (req.body?.inference?.open === true || requestedMode.id === 'open');
      const mode = requestedMode;
      let persona = null;
      if (runtimeServices.personas && (access === 'private' || req.body?.personaId)) {
        await ensureCatalog();
        if (pack.childSafe && req.body?.personaId !== 'nestor') throw Object.assign(new Error('Family uses the Nestor personality'), { statusCode: 400 });
        persona = personaCatalog.snapshot(await runtimeServices.personas.resolve(pack.childSafe ? 'nestor' : req.body?.personaId || 'nestor', req.body?.personaVersion));
      } else if (req.body?.personaId) throw Object.assign(new Error('Shared persona catalog unavailable'), { statusCode: 503 });
      const presentation = req.body?.voice?.presentation;
      if (presentation && !['masculine', 'feminine'].includes(presentation)) throw Object.assign(new Error('Invalid voice presentation'), { statusCode: 400 });
      const language = req.body?.language || 'auto';
      if (!['auto', 'en', 'fr'].includes(language)) throw Object.assign(new Error('Invalid voice language'), { statusCode: 400 });
      const session = await conversations.createSession({
        sessionId: crypto.randomUUID(),
        packId: pack.id,
        modeId: mode.id,
        ...(persona ? { persona, inference: { open }, voice: { language, ...(Object.keys(voiceSelections(req.body?.voice?.selections)).length ? { selections: voiceSelections(req.body.voice.selections) } : {}), ...(presentation ? { presentation } : {}) }, visual: normalizeVisual(req.body?.visual) } : {}),
        scopeId: access === 'private' ? 'personal' : cleanScope(req.body?.scopeId, pack.defaultScopeId),
        agentId, backend,
        ...(consumer === 'llmx' ? { llmx: { schemaVersion: 1, humanStarted: false, opening: null } } : {}),
        label: cleanText(req.body?.label, 120)
      });
      return envelope(res, { session: publicSession(session), pack: packSummary(pack), mode: modeSummary(mode) }, 201);
    } catch (error) {
      logger?.error?.('Household session creation failed', { error: error.message });
      return fail(res, error.statusCode || 500, error.message || 'Unable to create voice session', 'VOICE_PERSONA_SESSION_CREATE_FAILED');
    }
  };
  const createNativeFamilySession = async (req, res) => {
    if (
      cleanText(req.body?.packId, 64) !== VOIX_FAMILY_PACK_ID
      || cleanText(req.body?.modeId, 64) !== VOIX_FAMILY_MODE_ID
      || cleanText(req.body?.scopeId, 120) !== VOIX_FAMILY_SCOPE_ID
    ) {
      return fail(
        res,
        400,
        'Native Family voice requires the exact kidx_nestor/family/family contract',
        'VOIX_FAMILY_CONTRACT_REQUIRED'
      );
    }
    return createPersonaSession('child')(req, res);
  };
  personas.post('/sessions', createPersonaSession('child'));
  personas.post('/private/sessions', createPersonaSession('private'));
  personas.post('/family/sessions', createNativeFamilySession);
  // The existing adult surface edits Core notes regardless of the harness.
  personas.post('/private/notes', async (req, res) => {
    const { operation, id, text, kind } = req.body || {};
    if (!['list', 'remember', 'forget'].includes(operation)) return fail(res, 400, 'Invalid note operation', 'NESTOR_NOTE_INVALID');
    if ((id !== undefined || operation === 'forget') && !/^[a-f0-9]{24}$/.test(id || '')) return fail(res, 400, 'Choose an existing note', 'NESTOR_NOTE_INVALID');
    if (operation === 'remember' && (typeof text !== 'string' || !text.trim() || text.length > 2000)) return fail(res, 400, 'A note must contain 1-2000 characters', 'NESTOR_NOTE_INVALID');
    try { return envelope(res, await runtimeServices.memory.notes.operatePersonal({ operation, id, text, kind })); }
    catch (error) { return fail(res, error.statusCode || 503,
      error.statusCode ? error.message : 'Personal notes are unavailable. Refresh before retrying a change.',
      error.code || 'NESTOR_CONTINUITY_UNAVAILABLE'); }
  });
  const activePersonaTurns = new Map();
  const openingPayload = (session, active = false) => {
    const opening = llmx.publicOpening(session?.llmx?.opening, active);
    const language = spokenReplyLanguage(opening?.replyText || '', session?.voice?.language === 'en' ? 'Hello' : 'Bonjour');
    return { opening, replayed: false, ...(opening?.status === 'completed' && opening.replyText ? {
      reply: { text: opening.replyText, language, speech: personaCatalog.speechFor(session.persona, language, session.voice) }
    } : {}) };
  };
  const validClientTurnId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(value);
  function registerBrowserSessionControls(prefix, packId, scopeId, router = personas, consumer = null) {
    const sessionScope = consumer === 'llmx' ? llmx.sessionScope(scopeId === 'family' ? 'family' : 'personal')
      : { packId, ...(scopeId ? { scopeId } : {}) };
    router.get(`${prefix}/sessions/recent`, async (req, res) => {
      try {
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 3, 5));
        const pack = packById(packId);
        const personaOnly = req.query.personaOnly === 'true';
        const sessions = await conversations.listSessions({
          ...sessionScope,
          status: 'active',
          turnCount: { $gt: 0 }, ...(Date.parse(req.query.before) ? { lastTurnAt: { $lt: new Date(req.query.before) } } : {}), // older page
          ...(personaOnly ? { 'persona.id': { $exists: true, $ne: '' } } : {})
        }, { sort: { lastTurnAt: -1, createdAt: -1 }, limit: limit * 3 });
        const resumable = sessions.filter((session) => pack.modes.some((mode) => mode.id === session.modeId)
          && (!personaOnly || session.persona?.id)).slice(0, limit);
        return envelope(res, {
          sessions: await Promise.all(resumable.map(async session => {
            const result = publicSession(session);
            if (!personaOnly && req.query.preview !== 'true') return result; // previews without narrowing
            // At most five indexed, session-scoped reads of the latest audit row.
            const [last] = await loadSessionAuditRows(conversations, session, { historyTurns: 2 });
            return { ...result, lastTurn: last ? {
              inputPreview: cleanText(last.inputText || last.inputPreview, 240),
              replyPreview: cleanText(last.replyText || last.replyPreview, 240)
            } : null };
          })),
          policy: {
            historyAuthority: 'agentx.core.conversations',
            automaticResume: consumer === 'llmx' ? 'exact-client-stored-session-only' : false,
            childResume: packId === 'kidx_nestor',
            maximumSessions: 5
          }
        });
      } catch (error) {
        return fail(res, 500, error.message, 'VOICE_PERSONA_PRIVATE_SESSIONS_FAILED');
      }
    });
    router.get(`${prefix}/sessions/:sessionId/history`, async (req, res) => {
      try {
        const session = await conversations.getSession({
          sessionId: cleanText(req.params.sessionId, 64),
          ...sessionScope,
          status: 'active'
        });
        if (!session) return fail(res, 404, 'Conversation not found in this space', 'VOICE_PERSONA_SESSION_NOT_FOUND');
        const pack = packById(packId);
        if (!pack.modes.some((mode) => mode.id === session.modeId)) {
          return fail(res, 409, 'This session uses a retired mode and cannot be resumed.', 'VOICE_PERSONA_SESSION_MODE_UNAVAILABLE');
        }
        const rows = await loadSessionAuditRows(conversations, session, pack);
        let lastReply = null;
        if (consumer === 'llmx') {
          const [completed] = await conversations.listTurns({ sessionId: session.sessionId, packId, scopeId: session.scopeId,
            source: 'graphysx-llmx', outcome: 'completed' }, { sort: { createdAt: -1 }, limit: 1 });
          if (completed?.replyText?.trim()) {
            const language = spokenReplyLanguage(completed.replyText, completed.inputText || '');
            lastReply = { turnId: completed.clientTurnId, reply: { text: completed.replyText, language,
              speech: personaCatalog.speechFor(session.persona, language, session.voice) } };
          }
        }
        return envelope(res, {
          session: { ...publicSession(session), ...(consumer === 'llmx' ? { llmx: { schemaVersion: 1, opening: llmx.publicOpening(session.llmx.opening, activePersonaTurns.has(session.sessionId)) } } : {}) },
          turns: rows.slice().reverse().map(publicAudit),
          history: sessionHistoryMessages(rows, pack),
          ...(consumer === 'llmx' ? { lastReply } : {}),
          policy: {
            historyAuthority: 'agentx.core.conversations',
            automaticResume: consumer === 'llmx' ? 'exact-client-stored-session-only' : false,
            childResume: packId === 'kidx_nestor',
            maximumMessages: pack.historyTurns
          }
        });
      } catch (error) {
        return fail(res, 500, error.message, 'VOICE_PERSONA_PRIVATE_HISTORY_FAILED');
      }
    });

    router.post(`${prefix}/sessions/:sessionId/interrupt`, async (req, res) => {
      const clientTurnId = req.body?.turnId;
      if (!validClientTurnId(clientTurnId)) return fail(res, 400, 'A valid turnId is required', 'VOICE_INTERRUPTION_INVALID');
      const entry = activePersonaTurns.get(req.params.sessionId);
      let timer;
      try {
        if (entry) {
          if (entry.clientTurnId !== clientTurnId) {
            return fail(res, 409, 'This is not the current browser turn', 'VOICE_INTERRUPTION_MISMATCH');
          }
          let wrongScope = false;
          const settlement = (async () => {
            // Admission owns the turn synchronously, before Mongo resolves its
            // session. A correlated interruption waits for that validation;
            // an absent snapshot is not evidence of an absent conversation.
            const snapshot = entry.snapshot || await entry.ready;
            if (!snapshot || snapshot.packId !== packId || (scopeId && snapshot.scopeId !== scopeId)
                || (consumer === 'llmx' && (!entry.llmx || snapshot.modeId !== sessionScope.modeId))) {
              wrongScope = true; return true;
            }
            entry.interrupted = true;
            entry.abort.abort();
            await entry.finished;
            return true;
          })();
          const settled = await Promise.race([settlement, new Promise(resolve => {
            timer = setTimeout(() => resolve(false), 10000);
          })]);
          if (!settled) return envelope(res, { interrupted: false, pending: true, turnId: clientTurnId }, 202);
          if (wrongScope) return fail(res, 404, 'Conversation not found in this space', 'VOICE_PERSONA_SESSION_NOT_FOUND');
          if (entry.error && !entry.executionSettled) throw entry.error;
        }
        if (consumer === 'llmx' && !await conversations.getSession({ sessionId: cleanText(req.params.sessionId, 64),
          ...sessionScope, status: 'active' })) return fail(res, 404, 'Conversation not found in this space', 'VOICE_PERSONA_SESSION_NOT_FOUND');
        // Short replies may have finished generating before playback is interrupted.
        // Mark the same existing audit so history never implies it was fully heard.
        const audit = await conversations.updateTurn({
          sessionId: cleanText(req.params.sessionId, 64), clientTurnId,
          packId, ...(scopeId ? { scopeId } : {}), ...(consumer === 'llmx' ? { source: 'graphysx-llmx' } : { channel: 'voice' })
        }, { $set: { interrupted: true } });
        if (!audit) return fail(res, 409, 'The voice turn is no longer available', 'VOICE_INTERRUPTION_UNAVAILABLE');
        if (audit.interruptionState === 'failed') {
          const native = audit.toolEvidence;
          if (native?.sessionKey?.endsWith(`:household:direct:${audit.sessionId}`) && /^resp_[a-f0-9-]{36}$/.test(native.runId || '')) {
            // A hook can arrive after the original stop deadline. Observe only
            // this recorded run; never retry inference or adopt another session.
            const evidence = await nestorClient({ operation: 'turn', sessionKey: native.sessionKey, runId: native.runId });
            if (evidence?.run?.runId === native.runId && evidence.run.sessionKey === native.sessionKey
                && ['completed', 'failed'].includes(evidence.run.status)) {
              await conversations.updateTurn({ _id: audit._id, interruptionState: 'failed' },
                { $set: { interruptionState: 'confirmed', 'toolEvidence.run': evidence.run } });
              return envelope(res, { interrupted: true, turnId: clientTurnId });
            }
          }
          return fail(res, 503, 'La fin du tour précédent reste non confirmée. Son historique est conservé. Utilise Nouvelle conversation pour reprendre.'
            + (consumer === 'llmx' ? ' Le monde 3D sera conservé.' : ''), 'VOICE_INTERRUPTION_FAILED');
        }
        return envelope(res, { interrupted: true, turnId: clientTurnId });
      } catch (error) {
        return fail(res, 503, error.message || 'Unable to stop the previous turn', 'VOICE_INTERRUPTION_FAILED');
      } finally { clearTimeout(timer); }
    });
  }
  registerBrowserSessionControls('/private', 'personal_operator'); visuals.register(personas); brain.register(personas);
  registerBrowserSessionControls('/family', 'kidx_nestor', 'family');
  const personalAttachments = sessionId => runtimeServices.attachments.forConversation({
    surface: 'household', sessionId, packId: 'personal_operator', scopeId: 'personal'
  });
  const personalSessionScope = sessionId => ({ sessionId, packId: 'personal_operator', scopeId: 'personal' }), familySessionScope = sessionId => ({ sessionId, packId: 'kidx_nestor', scopeId: 'family' });
  personas.get('/private/sessions/:sessionId/export', async (req, res) => {
    try {
      res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="agentx-conversation.json"` });
      await conversations.exportSession(personalSessionScope(req.params.sessionId), res);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      return fail(res, error.statusCode || 500, error.statusCode ? error.message : 'Export indisponible.', error.code);
    }
  });
  personas.delete('/:space(private|family)/sessions/:sessionId', async (req, res) => { // family: adult session at the gateway
    if (req.body?.confirmation !== 'DELETE CONVERSATION') return fail(res, 400, 'Confirme l’effacement de cette conversation.', 'CONVERSATION_DELETE_CONFIRMATION_REQUIRED');
    if (activePersonaTurns.has(req.params.sessionId)) return fail(res, 409, 'Arrête la réponse en cours avant d’effacer la conversation.', 'VOICE_TURN_IN_PROGRESS');
    try { return envelope(res, await conversations.deleteSession((req.params.space === 'family' ? familySessionScope : personalSessionScope)(req.params.sessionId))); }
    catch (error) { return fail(res, error.statusCode || 500, error.statusCode ? error.message : 'Effacement incomplet. Réessaie pour terminer.', error.code); }
  });
  personas.post('/private/sessions/:sessionId/attachments', async (req, res) => {
    try { return envelope(res, { attachment: await personalAttachments(req.params.sessionId).upload(req.body) }, 201); }
    catch (error) { return fail(res, error.statusCode || 500, error.statusCode ? error.message : 'Pièce jointe indisponible.', error.code); }
  });
  personas.get('/private/sessions/:sessionId/attachments/:attachmentId', async (req, res) => {
    try {
      const attachment = await personalAttachments(req.params.sessionId).download(req.params.attachmentId);
      res.set({ 'Content-Type': attachment.mimeType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${attachment.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}` });
      return res.send(attachment.data);
    } catch (error) { return fail(res, error.statusCode || 500, error.statusCode ? error.message : 'Pièce jointe indisponible.', error.code); }
  });
  const handlePersonaTurn = createPersonaTurnHandler({
    logger, runtimeServices, conversations, conversationEnv, executeConversation, requireNativeAgent,
    familyTasks, ownerMemory, familyMemory, notesFor, personalAttachments, knowledgeState, openHold, openingPayload,
    sounds, visuals, brain, activePersonaTurns, validClientTurnId,
    envelope, fail, cleanText, assessSafety, childBoundaryReply, escalationReply, detectMemoryRequest,
    packById, packSummary, modeSummary, publicSession, systemPromptFor, spokenReplyLanguage,
    sessionHistoryMessages, loadSessionAuditRows,
    MEMORY_RECALL_LIMIT, PERSONAL_OPERATOR_SURFACE_CONTRACT, VOIX_FAMILY_PACK_ID
  });
  personas.post('/sessions/:sessionId/turns/text', (req, res) => handlePersonaTurn(req, res, 'child'));
  personas.post('/private/sessions/:sessionId/turns/text', (req, res) => handlePersonaTurn(req, res, 'private'));
  personas.post('/family/sessions/:sessionId/turns/text', (req, res) => handlePersonaTurn(req, res, 'child', { packId: VOIX_FAMILY_PACK_ID, modeId: VOIX_FAMILY_MODE_ID, scopeId: VOIX_FAMILY_SCOPE_ID, browser: true }));
  registerNativeConsumers(app, {
    express, standardJsonParser, conversations, conversationEnv, activePersonaTurns,
    createPersonaSession, createNativeFamilySession, handlePersonaTurn, registerBrowserSessionControls, openingPayload,
    envelope, fail, cleanText, requireVoixMemoryConsumer,
    VOIX_FAMILY_PACK_ID, VOIX_FAMILY_MODE_ID, VOIX_FAMILY_SCOPE_ID
  });

  personas.get('/audit/recent', async (req, res) => {
    try {
      const query = {};
      if (req.query.packId) query.packId = cleanText(req.query.packId, 64);
      if (req.query.scopeId) query.scopeId = cleanScope(req.query.scopeId);
      if (req.query.sessionId) query.sessionId = cleanText(req.query.sessionId, 64);
      // A parent journal wants every child-facing lane, not one hard-coded pack.
      // Deriving it from childSafe means a new kid pack is covered on the day it
      // ships instead of silently staying invisible to the parent.
      if (String(req.query.childSafe) === 'true') {
        const childPacks = PACKS.filter((entry) => entry.childSafe).map((entry) => entry.id);
        const requested = typeof query.packId === 'string' ? [query.packId] : null;
        query.packId = { $in: requested ? requested.filter((id) => childPacks.includes(id)) : childPacks };
      }
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 40, 200));
      const rows = await conversations.listTurns(query, { sort: { createdAt: -1 }, limit: limit });
      return envelope(res, { audit: rows.map(publicAudit) });
    } catch (error) {
      return fail(res, 500, error.message, 'VOICE_PERSONA_AUDIT_FAILED');
    }
  });
  personas.get('/alerts', async (req, res) => {
    try {
      const query = { parentAttention: true };
      if (req.query.packId) query.packId = cleanText(req.query.packId, 64);
      if (req.query.scopeId) query.scopeId = cleanScope(req.query.scopeId);
      const rows = await conversations.listTurns(query, { sort: { createdAt: -1 }, limit: 50 });
      return envelope(res, {
        alerts: {
          count: rows.length,
          requiresAttention: rows.length > 0,
          items: rows.map(publicAudit)
        }
      });
    } catch (error) {
      return fail(res, 500, error.message, 'VOICE_PERSONA_ALERTS_FAILED');
    }
  });
  personas.post('/memory', async (req, res) => {
    const text = cleanText(req.body?.text || req.body?.summary, 4000);
    const pack = packById(req.body?.packId);
    if (!pack || !text) return fail(res, 400, 'packId and text are required', 'VOICE_PERSONA_MEMORY_INVALID');
    try {
      const memory = await notesFor(pack, cleanScope(req.body?.scopeId, pack.defaultScopeId)).record({
        topic: cleanText(req.body?.topic || 'general', 80),
        text,
        type: req.body?.type === 'summary' ? 'summary' : 'fact'
      });
      return envelope(res, { memory }, 201);
    } catch (error) {
      return fail(res, 500, error.message, 'VOICE_PERSONA_MEMORY_SAVE_FAILED');
    }
  });
  personas.post('/memory/summary', async (req, res) => {
    const text = cleanText(req.body?.summary || req.body?.text, 4000);
    const pack = packById(req.body?.packId);
    if (!pack || !text) return fail(res, 400, 'packId and summary are required', 'VOICE_PERSONA_MEMORY_INVALID');
    try {
      const memory = await notesFor(pack, cleanScope(req.body?.scopeId, pack.defaultScopeId)).record({
        topic: cleanText(req.body?.topic || 'general', 80),
        text,
        type: 'summary'
      });
      return envelope(res, { memory }, 201);
    } catch (error) {
      return fail(res, 500, error.message, 'VOICE_PERSONA_MEMORY_SAVE_FAILED');
    }
  });
  personas.post('/memory/search', async (req, res) => {
    const pack = packById(req.body?.packId);
    if (!pack) return fail(res, 400, 'packId is required', 'VOICE_PERSONA_MEMORY_INVALID');
    try {
      const needle = cleanText(req.body?.query, 200);
      const { notes: rows } = await notesFor(pack, cleanScope(req.body?.scopeId, pack.defaultScopeId)).list({ query: needle, limit: 20 });
      return envelope(res, { memory: { count: rows.length, results: rows } });
    } catch (error) {
      return fail(res, 500, error.message, 'VOICE_PERSONA_MEMORY_SEARCH_FAILED');
    }
  });
  app.use('/api/voice-personas', personas);

  const secretary = express.Router();
  secretary.use(standardJsonParser);
  secretary.get('/tasks', async (req, res) => {
    try {
      return envelope(res, await personalTasks.list(req.query));
    } catch (error) {
      return fail(res, error.status || 500, error.message, error.code || 'SECRETARY_LIST_FAILED', error.details);
    }
  });
  secretary.get('/briefing', async (_req, res) => {
    try {
      const [report, tasks] = await Promise.all([
        cachedProjectedJson(
          `${CORE_SELF_URL()}/api/reports/morning-brief`,
          (body) => body,
          { unavailable: true },
          8000
        ),
        personalTasks.list({ limit: 100 }).then(result => result.tasks)
      ]);
      return envelope(res, dadBriefing(report, tasks));
    } catch (error) {
      return fail(res, 500, error.message, 'SECRETARY_BRIEFING_FAILED');
    }
  });
  secretary.get('/desk', async (_req, res) => {
    try {
      const [report, tasks, cron, mailBacklog, family, latestDevice, budget] = await Promise.all([
        cachedProjectedJson(
          `${CORE_SELF_URL()}/api/reports/morning-brief`,
          (body) => body,
          { unavailable: true },
          8000
        ),
        personalTasks.list({ limit: 100 }).then(result => result.tasks),
        bridgeProjection(
          'getOpenClawCronProjection',
          (body) => body,
          { unavailable: true },
          { includeDisabled: true }
        ),
        // The count is cached by its owner. Neither a Gmail failure nor a slow
        // host delays the desk: a late count simply shows on the next refresh.
        Promise.race([
          secretaryMail().backlog(),
          new Promise((resolve) => { setTimeout(resolve, 6000, { error: 'The unlabelled count is still being read.' }).unref?.(); })
        ]).catch((error) => ({ error: error.message })),
        Promise.all([
          familyTasks.listProfiles().then(result => result.profiles),
          familyTasks.list().then(result => result.chores)
        ]).then(([profiles, chores]) => ({ profiles, chores })),
        models.DeviceAcceptance.findOne({ phase: deviceAcceptance.PHASE }).sort({ completedAt: -1 }).lean(),
        cachedProjectedJson(
          `${CORE_SELF_URL()}/api/budget/status`,
          (body) => body?.data || body,
          { unavailable: true },
          8000
        )
      ]);
      const activation = householdActivation({
        family,
        cron,
        knowledge: knowledgeState.status,
        device: deviceAcceptance.contract(latestDevice)
      });
      return envelope(res, {
        ...dadDesk(report, tasks, cron, new Date(), family, activation, budget, mailBacklog),
        activation
      });
    } catch (error) {
      return fail(res, 500, error.message, 'SECRETARY_DESK_FAILED');
    }
  });
  // Dad's two actionable Gmail labels and the owner's sender triage rules.
  registerSecretaryMailRoutes({ app, router: secretary, mongoose, envelope, fail });
  secretary.get('/email-action/readiness', async (_req, res) => {
    const readiness = await checkEmailActionReadiness();
    if (readiness.code === 'EMAIL_ACTION_READY') return envelope(res, { readiness });
    return fail(res, 503, 'Email-action readiness is unavailable', readiness.code, { readiness });
  });
  secretary.post('/tasks', async (req, res) => {
    try {
      const task = await personalTasks.create(req.body || {});
      return envelope(res, { task }, 201);
    } catch (error) {
      return fail(res, error.status || 500, error.message, error.code || 'SECRETARY_CREATE_FAILED', error.details);
    }
  });
  secretary.post('/tasks/update', async (req, res) => {
    try {
      const task = await personalTasks.update(req.body || {});
      return envelope(res, { task });
    } catch (error) {
      return fail(res, error.status || 500, error.message, error.code || 'SECRETARY_UPDATE_FAILED', error.details);
    }
  });
  secretary.post('/tasks/complete', async (req, res) => {
    try {
      return envelope(res, await personalTasks.complete(req.body || {}));
    } catch (error) {
      return fail(res, error.status || 500, error.message, error.code || 'SECRETARY_COMPLETE_FAILED', error.details);
    }
  });
  app.use('/api/secretary', secretary);
  registerSecretaryMcp({ app, standardJsonParser, models, personalTasks, sounds });

  registerFamilyRoutes({ app, express, familyTasks, standardJsonParser, conversations });
  const device = express.Router();
  device.use(standardJsonParser);
  device.get('/contract', async (_req, res) => {
    try {
      const latest = await models.DeviceAcceptance.findOne({ phase: deviceAcceptance.PHASE })
        .sort({ completedAt: -1 })
        .lean();
      return envelope(res, deviceAcceptance.contract(latest));
    } catch (error) {
      return fail(res, 500, error.message, 'DEVICE_ACCEPTANCE_READ_FAILED');
    }
  });
  device.get('/latest', async (_req, res) => {
    try {
      const latest = await models.DeviceAcceptance.findOne({ phase: deviceAcceptance.PHASE })
        .sort({ completedAt: -1 })
        .lean();
      return envelope(res, { phase: deviceAcceptance.PHASE, latest: deviceAcceptance.publicReceipt(latest) });
    } catch (error) {
      return fail(res, 500, error.message, 'DEVICE_ACCEPTANCE_READ_FAILED');
    }
  });
  device.post('/receipts', async (req, res) => {
    try {
      const receipt = deviceAcceptance.buildReceipt(req.body || {});
      const saved = await models.DeviceAcceptance.create(receipt);
      return envelope(res, { receipt: deviceAcceptance.publicReceipt(saved) }, 201);
    } catch (error) {
      if (error?.code === 11000) {
        const existing = await models.DeviceAcceptance.findOne({ runId: cleanText(req.body?.runId, 80) }).lean().catch(() => null);
        if (existing) {
          return envelope(res, { receipt: deviceAcceptance.publicReceipt(existing), alreadyRecorded: true });
        }
        return fail(res, 409, 'This physical acceptance run was already recorded', 'DEVICE_ACCEPTANCE_DUPLICATE');
      }
      return fail(res, error.status || 500, error.message, error.code || 'DEVICE_ACCEPTANCE_WRITE_FAILED', error.details);
    }
  });
  app.use('/api/household/device-acceptance', device);

  const panel = express.Router();
  panel.use(standardJsonParser);
  panel.get('/status', async (_req, res) => {
    const [services, voixStatus, openclaw, fleet] = await Promise.all([
      Promise.all([
        serviceHealth('Core', `${CORE_SELF_URL()}/health`),
        serviceHealth('Benchmark', String(process.env.BENCHMARK_SERVICE_URL || 'http://benchmark:3081').replace(/\/+$/, '') + '/health'),
        serviceHealth('RAG', String(process.env.RAG_SERVICE_URL || 'http://rag:3082').replace(/\/+$/, '') + '/health'),
        ...(process.env.DATAAPI_BASE_URL ? [serviceHealth('Data', String(process.env.DATAAPI_BASE_URL).replace(/\/+$/, '') + '/health')] : [])
      ]),
      upstreamJson('/health')
        .then((health) => ({ status: health?.status === 'ok' ? 'ok' : 'down', health }))
        .catch((error) => ({ status: 'down', error: error.message })),
      openClawPanelStatus(app.locals?.aioOpsRuntimeEvidence),
      projectedJson(
        `${CORE_SELF_URL()}/api/nerve-center/ecosystem`,
        fleetSummary,
        fleetSummary({})
      )
    ]);
    const serviceCount = services.filter((service) => service.status === 'ok').length;
    const agentx = {
      id: 'agentx',
      name: 'AgentX',
      role: 'Router · RAG · shared memory authority',
      status: serviceCount === services.length ? 'ok' : 'down',
      detail: `${serviceCount}/${services.length} platform services ready`,
      href: '/agent-ops'
    };
    const nestor = {
      id: 'nestor',
      name: 'Nestor',
      role: 'Family front door',
      status: agentx.status === 'ok' && fleet.status === 'ok' ? 'ok' : 'down',
      detail: knowledgeState.status.enabled
        ? `${knowledgeState.status.documentCount} approved knowledge document(s)`
        : 'child-safe lane · approved knowledge waiting',
      href: '#family-nestor'
    };
    const voix = {
      id: 'voix',
      name: 'VoiX',
      role: 'Private ears & voice',
      status: voixStatus.status,
      detail: voixStatus.status === 'ok'
        ? cleanText(voixStatus.health?.version || voixStatus.health?.serviceVersion || 'local speech ready', 120)
        : 'local speech unavailable',
      href: '/voice'
    };
    const crew = [nestor, openclaw, agentx, voix];
    const ready = panelCrewReady(crew, fleet);
    return envelope(res, {
      generatedAt: new Date().toISOString(),
      status: ready && !fleet.attention.length ? 'ok' : 'degraded',
      services,
      voix: voixStatus,
      crew,
      fleet,
      memory: {
        sharedAuthority: 'AgentX Memory Review',
        sharedHref: '/memory-review',
        familyNotebook: 'scoped household notebook',
        retiredHermesCorpus: 'Retained read-only for explicit Memory Review compatibility; no live Hermès service.'
      },
      knowledge: knowledgeState.status,
      reader: { status: 'ok', packId: 'kidx_reader' },
      secretary: { status: 'ok', store: 'pipelinetasks' },
      home: { status: 'not_configured', entities: [] }
    });
  });
  panel.post('/heartbeat', (req, res) => envelope(res, {
    accepted: true,
    deviceId: cleanText(req.body?.deviceId || 'house-panel', 120),
    at: new Date().toISOString()
  }, 202));
  app.use('/api/panel', panel);

  app.get('/api/household/status', (_req, res) => envelope(res, {
    extension: 'agentx-household',
    version: '1.58.12',
    audioRetention: 'ephemeral-memory-only',
    rawAudioPersisted: false,
    capabilities: EXTENSION_CAPABILITIES,
    knowledge: knowledgeState.status
  }));
}

module.exports = {
  id: 'agentx-household',
  version: '1.58.12',
  capabilities: EXTENSION_CAPABILITIES,
  register,
  assessSafety,
  cachedProjectedJson,
  calendarDayKey,
  childBoundaryReply,
  escalationReply,
  cleanScope,
  cleanProfileId,
  dadBriefing,
  dadDesk,
  morningReminderPreview,
  familyChore,
  familyProfile,
  familyRoom,
  familyTimeZone,
  fleetSummary,
  hermesCrew,
  householdActivation,
  openClawCrew,
  packById,
  packSummary,
  inferenceTargetForMode,
  createOpenLaneHold,
  HOUSEHOLD_OPEN_HOLD_WAIT_TIMEOUT_MS,
  HOUSEHOLD_OPEN_HOLD_IDLE_MS,
  HOUSEHOLD_OPEN_HOLD_OWNER,
  plainReply,
  replyLanguageDirective,
  spokenReplyLanguage,
  detectSpeechLanguage,
  normalizeSpeechLanguage,
  speechProfile,
  systemPromptFor,
  voiceContract,
  detectMemoryRequest,
  explicitMemoryStatement,
  forgetMemoryStatement,
  inferredMemoryCandidate,
  normalizeVoixMemoryTurn,
  packIdsSharingMemory,
  memoryBlock,
  HOUSEHOLD_CONSUMER_CONTRACT,
  HOUSEHOLD_PERMISSIVE_PRIMARY_DEFAULT_MODEL,
  HOUSEHOLD_PERMISSIVE_PRIMARY_DEFAULT_DIGEST,
  HOUSEHOLD_PERMISSIVE_CONTEXT,
  MEMORY_CONTRACT,
  SAFETY_SUPPORT,
  nextRoutineDue,
  nestorKnowledge,
  normalizeVoixTranscriptionMultipart,
  deviceAcceptance,
  publicAudit,
  publicSession,
  publicVoixEvent,
  publicVoixConfig,
  publicVoixConversation,
  publicVoixMediaClip,
  publicVoixMediaVault,
  publicVoixMetrics,
  publicVoixSession,
  publicTask,
  sessionHistoryMessages,
  sortedPersonalTasks
};
