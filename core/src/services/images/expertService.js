'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { forSurface } = require('../surfaceConversationService');
const gateway = require('./expertGateway');
const presentation = require('./workshopPresentation');
const images = require('./imageService');
const constraints = require('../../../public/js/image-brief-constraints');
const { officialDashboardUrl } = require('./expertDashboard');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_ENVELOPE_UNITS = 60000, MAX_ENVELOPE_BYTES = 65536;
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const boundedText = value => typeof value === 'string' && value.length <= constraints.MAX_BRIEF && value.isWellFormed();
const identity = sessionId => {
  if (!ID.test(sessionId || '')) throw failure('Conversation imageX invalide.');
  return { sessionId, packId: 'atelier', scopeId: 'workspace' };
};
const evidence = turn => turn.toolEvidence?.imagex || {};
function expertError(error, context) {
  const field = /Image expert changed the requested (width|height|profile)/.exec(error.message || '')?.[1];
  if (!field) return { error: String(error.message).slice(0, 240) };
  const name = { width: 'la largeur', height: 'la hauteur', profile: 'la recette' }[field];
  return { errorCode: 'IMAGE_EXPERT_SETTINGS_CHANGED',
    error: `Hermes a proposé de modifier ${name} choisie. La proposition a été refusée pour préserver ${context.width} × ${context.height} et la recette ${context.profile}. Ton brief reste conservé.` };
}
const publicTurn = turn => ({ id: turn.traceId, sessionId: turn.sessionId, mode: turn.modeId,
  input: turn.inputText, text: turn.replyText, state: turn.outcome, createdAt: turn.createdAt,
  updatedAt: turn.updatedAt, ...evidence(turn) });

function boundEnvelope(envelope) {
  // Match the installed studio transport's exact JSON bounds before accepting a turn.
  for (;;) {
    const json = JSON.stringify(envelope);
    if (json.length <= MAX_ENVELOPE_UNITS && Buffer.byteLength(json, 'utf8') <= MAX_ENVELOPE_BYTES) return envelope;
    if (!envelope.history.length) throw failure('Brief et demande dépassent la capacité du relais Hermes (60 000 caractères UTF-16 / 65 536 octets JSON). Réduis le texte avant de continuer.');
    envelope.history.splice(0, 2); // Only discard complete oldest user/assistant pairs.
  }
}

function createService({ conversations = forSurface('image-workshop'), bridge = gateway,
  workshop = presentation, imageService = images } = {}) {
  const running = new Map(), admissions = new Map();
  async function status() {
    const dashboardUrl = officialDashboardUrl();
    if (!bridge.configured()) return { configured: false, available: false, dashboardUrl };
    try { return { configured: true, available: true, ...await bridge.invoke({ action: 'describe' }, { timeoutMs: 12000 }), dashboardUrl }; }
    catch { return { configured: true, available: false, dashboardUrl, message: 'Le relais Hermes ne répond pas. La création manuelle reste disponible.' }; }
  }
  async function resource(id) {
    if (!['identity', 'agentx-images', 'comfyui', 'learning', 'memory'].includes(id)) throw failure('Fichier imageX inconnu.', 404);
    return (await bridge.invoke({ action: 'resource', id }, { timeoutMs: 12000 })).resource;
  }
  async function sessions() {
    return conversations.listSessions({ packId: 'atelier', scopeId: 'workspace' }, { limit: 30 });
  }
  async function createSession() {
    return conversations.createSession({ ...identity(randomUUID()), modeId: 'imagex', label: 'Conversation imageX',
      agentId: 'imagex', backend: 'openclaw' });
  }
  async function turns(sessionId) {
    const scope = identity(sessionId);
    if (!await conversations.getSession(scope)) throw failure('Conversation imageX introuvable.', 404);
    const rows = await conversations.listTurns(scope, { limit: 50 });
    for (const row of rows) {
      if (['accepted', 'running'].includes(row.outcome) && !running.has(row.traceId)) {
        row.outcome = 'interrupted';
        row.toolEvidence = { imagex: { ...evidence(row), error: 'La consultation a été interrompue par un redémarrage. Tu peux envoyer une nouvelle demande.' } };
        await conversations.updateTurn({ ...scope, traceId: row.traceId }, { $set: { outcome: row.outcome, toolEvidence: row.toolEvidence } });
      }
    }
    return rows.reverse().map(publicTurn);
  }
  function validate(input) {
    if (!input || !ID.test(input.clientTurnId || '') || !['consult', 'plan'].includes(input.mode)
      || !boundedText(input.message) || !input.message.trim()) throw failure('La demande imageX exige un texte Unicode valide de 32 000 caractères UTF-16 au maximum.');
    const context = input.context || {};
    if (!boundedText(context.prompt)
      || !Number.isInteger(context.referenceCount) || context.referenceCount < 0 || context.referenceCount > 2) throw failure('Contexte image invalide.');
    const recipe = imageService.status().profiles.find(row => row.id === context.profile);
    if (!recipe || ![context.width, context.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2752 && n % 32 === 0)
      || context.width * context.height > recipe.maxPixels) throw failure('Choisis une recette et un format disponibles.');
    const protectedItems = constraints.validate(context.constraints);
    constraints.composeBrief(context.prompt, protectedItems);
    const clean = { prompt: context.prompt, profile: context.profile, width: context.width, height: context.height, referenceCount: context.referenceCount,
      ...(protectedItems && { constraints: protectedItems }) };
    if (input.mode === 'plan' && !clean.prompt.trim()) throw failure('Écris ton brief avant de demander une proposition.');
    return { clientTurnId: input.clientTurnId, mode: input.mode, message: input.message, context: clean };
  }
  async function execute(scope, turn, envelope, controller) {
    let details = evidence(turn);
    const save = async patch => {
      details = { ...details, ...patch };
      await conversations.updateTurn({ ...scope, traceId: turn.traceId }, { $set: { toolEvidence: { imagex: details } } });
    };
    try {
      await conversations.updateTurn({ ...scope, traceId: turn.traceId }, { $set: { outcome: 'running' } });
      const result = await bridge.invoke(envelope, { signal: controller.signal, onEvent: async event => {
        const safe = { type: event.type, at: Number(event.at) || Date.now(),
          ...(event.name && { name: String(event.name).slice(0, 120) }),
          ...(event.reportedModel && { reportedModel: String(event.reportedModel).slice(0, 200) }),
          ...(Number.isFinite(event.durationMs) && { durationMs: event.durationMs }),
          ...(typeof event.failed === 'boolean' && { failed: event.failed }) };
        if ((details.events || []).length < 80) await save({ events: [...(details.events || []), safe] });
      } });
      let proposal = result.proposal || null;
      // Plan validation is repeated against the current Core contract at the trust boundary.
      if (proposal) for (const field of ['profile', 'width', 'height']) {
        if (proposal[field] !== envelope.request[field]) throw new Error(`Image expert changed the requested ${field}`);
      }
      if (proposal && (typeof proposal.prompt !== 'string' || !proposal.prompt.trim()
        || proposal.prompt.length > 8000 || typeof proposal.reason !== 'string' || proposal.reason.length > 2000)) throw new Error('Proposition Hermes invalide.');
      if (envelope.action === 'plan' && !proposal) throw new Error('Hermes n’a pas fourni de proposition applicable.');
      if (proposal && details.context.constraints) {
        const protectedItems = constraints.validate(details.context.constraints);
        const visualPrompt = constraints.visual(proposal.prompt, protectedItems);
        if (!visualPrompt.trim()) throw new Error('Hermes n’a pas fourni de description visuelle.');
        proposal = { profile: proposal.profile, width: proposal.width, height: proposal.height, reason: proposal.reason,
          visualPrompt, prompt: constraints.compose(visualPrompt, protectedItems), constraints: protectedItems };
      }
      await save({ proposal, reportedModel: result.model || null, nativeSessionId: result.sessionId || null,
        tokens: result.tokens || null, durationMs: result.durationMs || null });
      await conversations.updateTurn({ ...scope, traceId: turn.traceId }, { $set: { outcome: 'completed',
        replyText: proposal ? proposal.reason : result.text, model: result.model || '', sourceCompletedAt: new Date() } });
    } catch (error) {
      await save(controller.signal.aborted ? { error: 'Consultation arrêtée.' } : expertError(error, details.context));
      await conversations.updateTurn({ ...scope, traceId: turn.traceId }, { $set: { outcome: controller.signal.aborted ? 'cancelled' : 'failed' } });
    } finally { running.delete(turn.traceId); }
  }
  async function accept(sessionId, raw) {
    const scope = identity(sessionId), input = validate(raw);
    if (admissions.has(sessionId)) throw failure('Une demande est déjà en cours d’enregistrement.', 409);
    admissions.set(sessionId, true);
    try {
      if (!await conversations.getSession(scope)) throw failure('Conversation imageX introuvable.', 404);
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const previous = await conversations.getTurn({ ...scope, traceId: input.clientTurnId });
      if (previous) {
        if (evidence(previous).requestSha256 !== hash) throw failure('Cette demande appartient à un autre message.', 409);
        return publicTurn(previous);
      }
      const rows = await conversations.listTurns(scope, { limit: 50 });
      if (rows.some(row => ['accepted', 'running'].includes(row.outcome) && running.has(row.traceId))) throw failure('Hermes travaille déjà dans cette conversation.', 409);
      if (!bridge.configured()) throw failure('Le lien vers Hermes n’est pas configuré.', 503);
      const available = await workshop.overview();
      const status = { configured: imageService.status().configured, profiles: available.profiles,
        maxReferences: 2, dimensions: available.dimensions };
      const history = rows.filter(row => row.outcome === 'completed').slice(0, 6).reverse()
        .flatMap(row => {
          const previous = evidence(row), plan = previous.proposal;
          return [{ role: 'user', content: plan ? `Brief à affiner : ${previous.context.prompt}\nDemande : ${row.inputText}` : row.inputText },
            { role: 'assistant', content: plan ? `Prompt proposé : ${plan.prompt}\nExplication : ${row.replyText}` : row.replyText }];
        });
      const envelope = boundEnvelope({ action: input.mode, history, status,
        ...(input.mode === 'plan' ? { request: { ...input.context, prompt: constraints.composeBrief(input.context.prompt, input.context.constraints), instruction: input.message } }
          : { prompt: input.message, context: input.context }) });
      const turn = await conversations.recordTurn({ ...scope, traceId: input.clientTurnId, clientTurnId: input.clientTurnId,
        modeId: input.mode, source: 'imagex-hermes', speakerAgentId: 'imagex', routeTier: 'agent', outcome: 'accepted',
        inputText: input.message, replyText: '', toolEvidence: { imagex: { requestSha256: hash, context: input.context,
          envelope, events: [{ type: 'accepted', at: Date.now() }] } } });
      const controller = new AbortController(); running.set(turn.traceId, { controller, sessionId });
      void execute(scope, turn, envelope, controller).catch(() => running.delete(turn.traceId));
      return publicTurn(turn);
    } finally { admissions.delete(sessionId); }
  }
  async function cancel(sessionId, turnId) {
    const scope = identity(sessionId), job = running.get(turnId);
    if (!ID.test(turnId || '') || !await conversations.getTurn({ ...scope, traceId: turnId })) throw failure('Consultation introuvable.', 404);
    if (job?.sessionId === sessionId) job.controller.abort();
    return { requested: !!job };
  }
  return { status, resource, sessions, createSession, turns, accept, cancel };
}
module.exports = { createService };
