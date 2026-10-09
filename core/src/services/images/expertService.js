'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { forSurface } = require('../surfaceConversationService');
const gateway = require('./expertGateway');
const presentation = require('./workshopPresentation');
const images = require('./imageService');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const identity = sessionId => {
  if (!ID.test(sessionId || '')) throw failure('Conversation imageX invalide.');
  return { sessionId, packId: 'atelier', scopeId: 'workspace' };
};
const evidence = turn => turn.toolEvidence?.imagex || {};
const publicTurn = turn => ({ id: turn.traceId, sessionId: turn.sessionId, mode: turn.modeId,
  input: turn.inputText, text: turn.replyText, state: turn.outcome, createdAt: turn.createdAt,
  updatedAt: turn.updatedAt, ...evidence(turn) });

function createService({ conversations = forSurface('image-workshop'), bridge = gateway,
  workshop = presentation, imageService = images } = {}) {
  const running = new Map(), admissions = new Map();
  async function status() {
    if (!bridge.configured()) return { configured: false, available: false };
    try { return { configured: true, available: true, ...await bridge.invoke({ action: 'describe' }, { timeoutMs: 12000 }) }; }
    catch { return { configured: true, available: false, message: 'Le relais Hermes ne répond pas. La création manuelle reste disponible.' }; }
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
      || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 8000) throw failure('Demande imageX invalide.');
    const context = input.context || {};
    if (typeof context.prompt !== 'string' || context.prompt.length > 8000
      || !Number.isInteger(context.referenceCount) || context.referenceCount < 0 || context.referenceCount > 2) throw failure('Contexte image invalide.');
    const recipe = imageService.status().profiles.find(row => row.id === context.profile);
    if (!recipe || ![context.width, context.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2752 && n % 32 === 0)
      || context.width * context.height > recipe.maxPixels) throw failure('Choisis une recette et un format disponibles.');
    const clean = { prompt: context.prompt, profile: context.profile, width: context.width, height: context.height, referenceCount: context.referenceCount };
    if (input.mode === 'plan' && !clean.prompt.trim()) throw failure('Écris ton brief avant de demander une proposition.');
    return { clientTurnId: input.clientTurnId, mode: input.mode, message: input.message.trim(), context: clean };
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
      const proposal = result.proposal || null;
      // Plan validation is repeated against the current Core contract at the trust boundary.
      if (proposal && (proposal.profile !== envelope.request.profile || proposal.width !== envelope.request.width
        || proposal.height !== envelope.request.height || typeof proposal.prompt !== 'string' || !proposal.prompt.trim()
        || proposal.prompt.length > 8000 || typeof proposal.reason !== 'string' || proposal.reason.length > 2000)) throw new Error('Proposition Hermes invalide.');
      if (envelope.action === 'plan' && !proposal) throw new Error('Hermes n’a pas fourni de proposition applicable.');
      await save({ proposal, reportedModel: result.model || null, nativeSessionId: result.sessionId || null,
        tokens: result.tokens || null, durationMs: result.durationMs || null });
      await conversations.updateTurn({ ...scope, traceId: turn.traceId }, { $set: { outcome: 'completed',
        replyText: proposal ? proposal.reason : result.text, model: result.model || '', sourceCompletedAt: new Date() } });
    } catch (error) {
      await save({ error: controller.signal.aborted ? 'Consultation arrêtée.' : String(error.message).slice(0, 240) });
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
          return [{ role: 'user', content: (plan ? `Brief à affiner : ${previous.context.prompt}\nDemande : ${row.inputText}` : row.inputText).slice(0, 2000) },
            { role: 'assistant', content: (plan ? `Prompt proposé : ${plan.prompt}\nExplication : ${row.replyText}` : row.replyText).slice(0, 2000) }];
        });
      const envelope = { action: input.mode, history, status,
        ...(input.mode === 'plan' ? { request: { ...input.context, instruction: input.message } }
          : { prompt: input.message, context: input.context }) };
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
