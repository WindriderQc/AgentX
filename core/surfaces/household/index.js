'use strict';

const crypto = require('crypto');
const personaCatalog = require('./persona-catalog');
const { agentForPersona } = require('./persona-selection');
const { createNestorClient } = require('./personal-continuity');
const { createAgentClient } = require('./conversation-agent');
const { browserSpeechFallback, configuredOpenClaw, conversationBackend, createConversationExecutor } = require('./conversation-executor');
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
const { plainReply } = require('./reply-channels'), { createVisuals } = require('./visuals'), { createBrain } = require('./brain');
const { registerSecretaryMcp } = require('./secretary-mcp');
const { secretaryMailControl } = require('./secretary-mail-routes');
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
const { openClawCrew } = require('./panel-status');
const {
  fetchWithTimeout, publicVoixConfig, publicVoixConversation, publicVoixEvent, publicVoixMediaClip,
  publicVoixMediaVault, publicVoixMetrics, publicVoixSession
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
  inferredMemoryCandidate, normalizeVoixTranscriptionMultipart
} = require('./voice-memory-turns');
const {
  createModels, publicSession, publicAudit, sessionHistoryMessages, loadSessionAuditRows
} = require('./persona-records');
const {
  cachedProjectedJson, hermesCrew, fleetSummary
} = require('./panel-sources');
const { registerPanelRoutes } = require('./panel-routes');
const { registerSecretaryRoutes } = require('./secretary-routes');
const { registerDeviceAcceptanceRoutes } = require('./device-routes');
const { createVoixMemoryAuditWorker } = require('./voice-memory-audit');
const { createBrowserSessionControls } = require('./browser-session-controls');

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

function register(api) {
  if (!api || api.contractVersion !== 2) {
    throw new Error('agentx-household requires AgentX trusted-extension contract v2');
  }
  const { app, express, mongoose, standardJsonParser, runtimeServices, extensionRoot, logger } = api;
  const models = createModels(mongoose);
  const conversations = require('./turn-attribution').attributedConversations(runtimeServices.conversations.forSurface('household'));
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


  const { drainVoixMemoryAudits } = createVoixMemoryAuditWorker({
    conversations, personalNotes, models, cleanText, logger
  });

  for (const name of ['browser-conversation', 'speech-language', 'playback-hold', 'voice-capture-worklet']) {
    app.get(`/assets/household/${name}.js`, (_req, res) => res.sendFile(path.join(__dirname, '../../public/js/voice', `${name}.js`)));
  }
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
    try { await ensureCatalog(); return envelope(res, { personas: (await runtimeServices.personas.list()).map(personaCatalog.snapshot), runtime: { defaultBackend: conversationBackend(null, conversationEnv), openclawConfigured: configuredOpenClaw(conversationEnv),
      browserSpeechFallback: browserSpeechFallback(conversationEnv) } }); }
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

      const open = access === 'private' && (req.body?.inference?.open === true || requestedMode.id === 'open');
      const mode = requestedMode;
      let persona = null;
      if (runtimeServices.personas && (access === 'private' || req.body?.personaId)) {
        await ensureCatalog();
        if (pack.childSafe) agentForPersona({ id: req.body?.personaId }, { family: true });
        persona = personaCatalog.snapshot(await runtimeServices.personas.resolve(pack.childSafe ? 'nestor' : req.body?.personaId || 'nestor', req.body?.personaVersion));
      } else if (req.body?.personaId) throw Object.assign(new Error('Shared persona catalog unavailable'), { statusCode: 503 });
      const agentId = agentForPersona(persona, { agentId: req.body?.agentId, family: pack.childSafe });
      if (backend === 'openclaw') await requireNativeAgent(agentId);
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
      return fail(res, error.statusCode || 500, error.message || 'Unable to create voice session', error.code || 'VOICE_PERSONA_SESSION_CREATE_FAILED');
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
  require('./session-persona').registerSessionPersonaRoutes(personas, { conversations, personas: runtimeServices.personas,
    ensureCatalog, activePersonaTurns, envelope, fail });
  const openingPayload = (session, active = false) => {
    const opening = llmx.publicOpening(session?.llmx?.opening, active);
    const language = spokenReplyLanguage(opening?.replyText || '', session?.voice?.language === 'en' ? 'Hello' : 'Bonjour');
    return { opening, replayed: false, ...(opening?.status === 'completed' && opening.replyText ? {
      reply: { text: opening.replyText, language, speech: personaCatalog.speechFor(session.persona, language, session.voice) }
    } : {}) };
  };
  const validClientTurnId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(value);
  const registerBrowserSessionControls = createBrowserSessionControls({
    personas, conversations, envelope, cleanText, fail, activePersonaTurns,
    validClientTurnId, nestorClient
  });
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
  require('./attachment-routes').registerAttachmentRoutes(personas, { express, personalAttachments, envelope, fail });
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

  registerSecretaryRoutes(app, {
    express, standardJsonParser, envelope, personalTasks, fail, CORE_SELF_URL,
    bridgeProjection, secretaryMail, familyTasks, models, knowledgeState, mongoose
  });
  registerSecretaryMcp({ app, standardJsonParser, models, personalTasks, sounds });

  registerFamilyRoutes({ app, express, familyTasks, standardJsonParser, conversations });
  registerDeviceAcceptanceRoutes(app, {
    express, standardJsonParser, models, envelope, fail, cleanText
  });

  registerPanelRoutes(app, {
    express, standardJsonParser, CORE_SELF_URL, knowledgeState, cleanText, envelope
  });

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
