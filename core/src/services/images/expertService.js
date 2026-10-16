'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { forSurface } = require('../surfaceConversationService');
const gateway = require('./expertGateway');
const presentation = require('./workshopPresentation');
const images = require('./imageService');
const constraints = require('../../../public/js/image-brief-constraints');
const textPolicy = require('../../../public/js/image-text-policy');
const referenceSelection = require('./expertReferences');
const inspectionStage = require('./expertInspection');
const { officialDashboardUrl } = require('./expertDashboard');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_ENVELOPE_UNITS = 60000, MAX_ENVELOPE_BYTES = 65536;
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const boundedText = value => typeof value === 'string' && value.length <= constraints.MAX_BRIEF && value.isWellFormed();
const identity = sessionId => {
  if (!ID.test(sessionId || '')) throw failure('Invalid imageX conversation.');
  return { sessionId, packId: 'atelier', scopeId: 'workspace' };
};
const evidence = turn => turn.toolEvidence?.imagex || {};
function expertError(error, context) {
  const field = /Image expert changed the requested (width|height|profile)/.exec(error.message || '')?.[1];
  if (!field) return { error: String(error.message).slice(0, 240) };
  const name = { width: 'width', height: 'height', profile: 'recipe' }[field];
  return { errorCode: 'IMAGE_EXPERT_SETTINGS_CHANGED',
    error: `Hermes proposed changing the chosen ${name}. The proposal was refused to preserve ${context.width} × ${context.height} and the recipe ${context.profile}. Your brief is kept.` };
}
const publicTurn = turn => ({ id: turn.traceId, sessionId: turn.sessionId, mode: turn.modeId,
  input: turn.inputText, text: turn.replyText, state: turn.outcome, createdAt: turn.createdAt,
  updatedAt: turn.updatedAt, ...evidence(turn),
  ...(evidence(turn).inspection && { inspection: inspectionStage.safeInspection(evidence(turn).inspection) }) });

function boundEnvelope(envelope) {
  // Match the installed studio transport's exact JSON bounds before accepting a turn.
  for (;;) {
    const json = JSON.stringify(envelope);
    if (json.length <= MAX_ENVELOPE_UNITS && Buffer.byteLength(json, 'utf8') <= MAX_ENVELOPE_BYTES) return envelope;
    if (!envelope.history.length) throw failure('Brief and request exceed the Hermes relay capacity (60,000 UTF-16 characters / 65,536 JSON bytes). Shorten the text before continuing.');
    envelope.history.splice(0, 2); // Only discard complete oldest user/assistant pairs.
  }
}

function createService({ conversations = forSurface('image-workshop'), bridge = gateway,
  workshop = presentation, imageService = images, references = referenceSelection.createResolver(), analyze } = {}) {
  const inspection = inspectionStage.createLifecycle({ conversations, analyze });
  const running = new Map(), admissions = new Map();
  async function status() {
    const dashboardUrl = officialDashboardUrl();
    if (!bridge.configured()) return { configured: false, available: false, dashboardUrl };
    try {
      const native = await bridge.invoke({ action: 'describe' }, { timeoutMs: 12000 });
      return { configured: true, available: true, ...native, referenceInspection: { supported: true,
        available: native.capabilities?.referenceInspectionEvidence === 1, source: 'openclaw-main',
        maxReferences: 2, maxImageBytes: 3 * 1024 * 1024 }, dashboardUrl };
    }
    catch { return { configured: true, available: false, dashboardUrl, message: 'The Hermes relay does not answer. Manual creation remains available.' }; }
  }
  async function resource(id) {
    if (!['identity', 'agentx-images', 'comfyui', 'learning', 'memory'].includes(id)) throw failure('Unknown imageX file.', 404);
    return (await bridge.invoke({ action: 'resource', id }, { timeoutMs: 12000 })).resource;
  }
  async function sessions() {
    return conversations.listSessions({ packId: 'atelier', scopeId: 'workspace' }, { limit: 30 });
  }
  async function createSession() {
    return conversations.createSession({ ...identity(randomUUID()), modeId: 'imagex', label: 'imageX conversation',
      agentId: 'imagex', backend: 'openclaw' });
  }
  async function turns(sessionId) {
    const scope = identity(sessionId);
    if (!await conversations.getSession(scope)) throw failure('imageX conversation not found.', 404);
    const rows = await conversations.listTurns(scope, { limit: 50 });
    for (const row of rows) {
      if (['accepted', 'running'].includes(row.outcome) && !running.has(row.traceId)) {
        const previousOutcome = row.outcome, previousInspection = evidence(row).inspection?.state;
        let details = evidence(row);
        const unknown = await inspection.interrupted(scope, row.traceId, details.inspection, async patch => { details = { ...details, ...patch }; });
        row.outcome = unknown ? 'unknown' : 'interrupted';
        row.toolEvidence = { imagex: { ...details, error: unknown
          ? 'The native inspection outcome is unknown. Reconcile its saved identity; no replacement was launched.'
          : 'The consultation was interrupted by a restart. You can send a new request.' } };
        const updated = await conversations.updateTurn({ ...scope, traceId: row.traceId, outcome: previousOutcome,
          ...(previousInspection && { 'toolEvidence.imagex.inspection.state': previousInspection }) },
        { $set: { outcome: row.outcome, toolEvidence: row.toolEvidence } });
        Object.assign(row, updated || await conversations.getTurn({ ...scope, traceId: row.traceId }));
      }
    }
    return rows.reverse().map(publicTurn);
  }
  async function inspectionFence(sessionId) {
    const session = await conversations.getSession(identity(sessionId));
    if (!session) throw failure('imageX conversation not found.', 404);
    const fence = session.imageInspection;
    if (!fence) return null;
    // Read-only disclosure, independent of the recent-turn window. Native
    // session keys, references and execution internals remain private.
    return { state: ['prepared', 'unknown'].includes(fence.state) ? fence.state : 'unknown',
      ...(ID.test(fence.requestId || '') && { requestId: fence.requestId }),
      ...(ID.test(fence.turnId || '') && { turnId: fence.turnId }) };
  }
  function validate(input) {
    if (!input || !ID.test(input.clientTurnId || '') || !['consult', 'plan'].includes(input.mode)
      || !boundedText(input.message) || !input.message.trim()) throw failure('The imageX request requires valid Unicode text of at most 32,000 UTF-16 characters.');
    const context = input.context || {};
    if (!boundedText(context.prompt)
      || !Number.isInteger(context.referenceCount) || context.referenceCount < 0 || context.referenceCount > 2) throw failure('Invalid image context.');
    const recipe = imageService.status().profiles.find(row => row.id === context.profile);
    if (!recipe || ![context.width, context.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2752 && n % 32 === 0)
      || context.width * context.height > recipe.maxPixels) throw failure('Choose an available recipe and format.');
    const protectedItems = constraints.validate(context.constraints);
    const policy = textPolicy.validate(context.textPolicy);
    textPolicy.known(policy, protectedItems);
    constraints.composeBrief(context.prompt, protectedItems);
    if (context.inspectReferences !== undefined && typeof context.inspectReferences !== 'boolean') throw failure('Invalid inspection choice.');
    const selected = context.references === undefined ? undefined : referenceSelection.selectors(context.references);
    if (selected && selected.length !== context.referenceCount) throw failure('The ordered reference selection does not match its count.');
    if (context.inspectReferences && !selected?.length) throw failure('Select references before requesting inspection.');
    const clean = { ...(selected && { references: selected }), ...(context.inspectReferences !== undefined && { inspectReferences: context.inspectReferences }), prompt: context.prompt, profile: context.profile, width: context.width, height: context.height, referenceCount: context.referenceCount,
      ...(protectedItems && { constraints: protectedItems }), ...(policy && { textPolicy: policy }) };
    if (input.mode === 'plan' && !clean.prompt.trim()) throw failure('Write your brief before asking for a proposal.');
    return { clientTurnId: input.clientTurnId, mode: input.mode, message: input.message, context: clean };
  }
  async function execute(scope, turn, envelope, controller, prepared) {
    let details = evidence(turn);
    const save = async patch => {
      details = { ...details, ...patch };
      const updated = await conversations.updateTurn({ ...scope, traceId: turn.traceId }, { $set: { toolEvidence: { imagex: details } } });
      if (updated === null) throw failure('The canonical consultation is no longer writable.', 409);
    };
    try {
      await conversations.updateTurn({ ...scope, traceId: turn.traceId }, { $set: { outcome: 'running' } });
      if (prepared.inspection.state === 'prepared') {
        const referenceInspection = await inspection.run({ scope, turnId: turn.traceId, inspection: prepared.inspection,
          messages: prepared.messages, signal: controller.signal, save });
        envelope = boundEnvelope({ ...envelope, referenceInspection });
        await save({ envelope });
      }
      controller.signal.throwIfAborted();
      const result = await bridge.invoke(envelope, { signal: controller.signal, onEvent: async event => {
        const safe = { type: event.type, at: Number(event.at) || Date.now(),
          ...(event.name && { name: String(event.name).slice(0, 120) }),
          ...(event.reportedModel && { reportedModel: String(event.reportedModel).slice(0, 200) }),
          ...(Number.isFinite(event.durationMs) && { durationMs: event.durationMs }),
          ...(typeof event.failed === 'boolean' && { failed: event.failed }) };
        if ((details.events || []).length < 80) await save({ events: [...(details.events || []), safe] });
      } });
      controller.signal.throwIfAborted();
      let proposal = result.proposal || null;
      // Plan validation is repeated against the current Core contract at the trust boundary.
      if (proposal) for (const field of ['profile', 'width', 'height']) {
        if (proposal[field] !== envelope.request[field]) throw new Error(`Image expert changed the requested ${field}`);
      }
      if (proposal && (typeof proposal.prompt !== 'string' || !proposal.prompt.trim()
        || proposal.prompt.length > 8000 || typeof proposal.reason !== 'string' || proposal.reason.length > 2000)) throw new Error('Invalid Hermes proposal.');
      if (envelope.action === 'plan' && !proposal) throw new Error('Hermes did not provide an applicable proposal.');
      if (proposal && (details.context.constraints || details.context.textPolicy || proposal.textPlan)) {
        const protectedItems = constraints.validate(details.context.constraints);
        const plan = textPolicy.validatePlan(proposal.textPlan, details.context.textPolicy, protectedItems);
        const policy = textPolicy.applyPlan(plan, details.context.textPolicy, protectedItems);
        const visualPrompt = textPolicy.visual(proposal.prompt, protectedItems, policy);
        if (!visualPrompt.trim()) throw new Error('Hermes did not provide a visual description.');
        proposal = { profile: proposal.profile, width: proposal.width, height: proposal.height, reason: proposal.reason,
          visualPrompt, prompt: textPolicy.compose(visualPrompt, protectedItems, policy),
          ...(protectedItems && { constraints: protectedItems }), ...(policy && { textPolicy: policy }), ...(plan && { textPlan: plan }) };
      }
      await save({ proposal, reportedModel: result.model || null, nativeSessionId: result.sessionId || null,
        tokens: result.tokens || null, durationMs: result.durationMs || null });
      await conversations.updateTurn({ ...scope, traceId: turn.traceId }, { $set: { outcome: 'completed',
        replyText: proposal ? proposal.reason : result.text, model: result.model || '', sourceCompletedAt: new Date() } });
    } catch (error) {
      if (details.inspection?.state === 'prepared') {
        await save({ inspection: { ...details.inspection, state: 'cancelled', executionState: 'not-dispatched' } });
        await inspection.clear(scope, turn.traceId, details.inspection.requestId, 'prepared');
      }
      if (details.inspection?.state === 'running') await save({ inspection: { ...details.inspection, state: 'unknown', executionState: 'unknown' } });
      await save(controller.signal.aborted ? { error: 'Consultation stopped.' } : expertError(error, details.context));
      await conversations.updateTurn({ ...scope, traceId: turn.traceId }, { $set: { outcome: details.inspection?.state === 'unknown' ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'failed' } });
    } finally { running.delete(turn.traceId); }
  }
  async function accept(sessionId, raw) {
    const scope = identity(sessionId), input = validate(raw);
    if (admissions.has(sessionId)) throw failure('A request is already being recorded.', 409);
    admissions.set(sessionId, true);
    try {
      if (!await conversations.getSession(scope)) throw failure('imageX conversation not found.', 404);
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const previous = await conversations.getTurn({ ...scope, traceId: input.clientTurnId });
      if (previous) {
        if (evidence(previous).requestSha256 !== hash) throw failure('This request belongs to another message.', 409);
        return publicTurn(previous);
      }
      if (input.context.inspectReferences) await inspection.checkFence(scope);
      const rows = await conversations.listTurns(scope, { limit: 50 });
      if (rows.some(row => ['accepted', 'running'].includes(row.outcome) && running.has(row.traceId))) throw failure('Hermes is already working in this conversation.', 409);
      if (!bridge.configured()) throw failure('The link to Hermes is not configured.', 503);
      if (input.context.inspectReferences && bridge.supportsReferenceInspection
        && !await bridge.supportsReferenceInspection()) throw failure('The native imageX worker must be updated before reference inspection. Your brief is kept.', 503);
      const resolved = input.context.references ? await references.resolve(sessionId, input.context.references,
        { forInspection: input.context.inspectReferences === true }) : { references: [], inputs: [] };
      const acceptedContext = { ...input.context, ...(input.context.references && { references: resolved.references }) };
      const prepared = inspectionStage.prepare({ ...input, context: acceptedContext }, resolved, sessionId);
      const available = await workshop.overview();
      const status = { configured: imageService.status().configured, profiles: available.profiles,
        maxReferences: 2, dimensions: available.dimensions };
      const history = rows.filter(row => row.outcome === 'completed').slice(0, 6).reverse()
        .flatMap(row => {
          const previous = evidence(row), plan = previous.proposal;
          return [{ role: 'user', content: plan ? `Brief à affiner : ${previous.context.prompt}\nDemande : ${row.inputText}` : row.inputText },
            { role: 'assistant', content: plan ? `Prompt proposé : ${plan.prompt}\nExplication : ${row.replyText}${plan.textPlan ? '\nTextes proposés : ' + JSON.stringify(plan.textPlan) : ''}` : row.replyText }];
        });
      const envelope = boundEnvelope({ action: input.mode, history, status,
        ...(input.mode === 'plan' ? { request: { ...acceptedContext, prompt: constraints.composeBrief(input.context.prompt, input.context.constraints), instruction: input.message,
          ...(input.context.textPolicy && { renderBudget: textPolicy.planningBudget(input.context.constraints, input.context.textPolicy) }) } }
          : { prompt: input.message, context: acceptedContext }) });
      let turn;
      try { turn = await conversations.recordTurn({ ...scope, traceId: input.clientTurnId, clientTurnId: input.clientTurnId,
        modeId: input.mode, source: 'imagex-hermes', speakerAgentId: 'imagex', routeTier: 'agent', outcome: 'accepted',
        inputText: input.message, replyText: '',
        attachments: resolved.references.filter(row => row.attachmentId).map(row => ({ id: row.attachmentId })), toolEvidence: { imagex: { requestSha256: hash, context: acceptedContext,
          inspection: prepared.inspection, envelope, events: [{ type: 'accepted', at: Date.now() }] } } },
      prepared.inspection.state === 'prepared' ? { sessionConditions: { imageInspection: { $exists: false } },
        sessionPatch: { imageInspection: { ...prepared.inspection, turnId: input.clientTurnId } } } : {});
      } catch (error) {
        if (error.code !== 11000) throw error;
        const previous = await conversations.getTurn({ ...scope, traceId: input.clientTurnId });
        if (!previous || evidence(previous).requestSha256 !== hash) throw failure('This request belongs to another message.', 409);
        return publicTurn(previous);
      }
      const controller = new AbortController(); running.set(turn.traceId, { controller, sessionId });
      void execute(scope, turn, envelope, controller, prepared).catch(() => running.delete(turn.traceId));
      return publicTurn(turn);
    } finally { admissions.delete(sessionId); }
  }
  async function cancel(sessionId, turnId) {
    const scope = identity(sessionId), job = running.get(turnId);
    if (!ID.test(turnId || '') || !await conversations.getTurn({ ...scope, traceId: turnId })) throw failure('Consultation not found.', 404);
    if (job?.sessionId === sessionId) job.controller.abort();
    return { requested: !!job };
  }
  async function selected(sessionId) {
    const scope = identity(sessionId);
    if (!await conversations.getSession(scope)) throw failure('imageX conversation not found.', 404);
  }
  return { status, resource, sessions, createSession, turns, inspectionFence, accept, cancel,
    uploadReference: async (id, input) => { await selected(id); return references.upload(id, input); },
    downloadReference: async (id, attachmentId) => { await selected(id); return references.download(id, attachmentId); },
    originalReference: async (id, attachmentId, bytes, name) => { await selected(id); return references.original(id, attachmentId, bytes, name); },
    resolveReferences: async (id, values) => { await selected(id); const { inputs, ...result } = await references.resolve(id, values); return result; } };

}
module.exports = { createService };
