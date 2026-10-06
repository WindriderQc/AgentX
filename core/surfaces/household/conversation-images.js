'use strict';

// Household composes Core's image engine; the family agent receives no private tool.
const images = require('../../src/services/images/imageService');
const { createHash } = require('node:crypto');
const { assessSafety, childBoundaryReply } = require('./persona-prompt');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FAMILY_UNSUITABLE = /\b(?:porn\w*|sex\w*|naked|nude\w*|nu|nue|nus|nues|genital\w*|penis|vagin\w*|breasts?|seins?|gore|dismember\w*|demembr\w*)\b/i;
const scopeFor = session => ({ surface: 'household', sessionId: session.sessionId, packId: session.packId, scopeId: session.scopeId });
function spaceFor(session) {
  if (session.llmx || session.source === 'graphysx-llmx') return null;
  if (session.packId === 'kidx_nestor' && session.scopeId === 'family') return 'family';
  if (session.packId === 'personal_operator' && session.scopeId === 'personal' && (session.agentId || 'main') === 'main') return 'private';
  return null;
}
function createConversationImages({ conversations, service = images }) {
  const configuration = () => { try { return service.status(); } catch { return { configured: false, conversationProfile: null }; } };
  function view(operation, session) {
    const base = `/api/voice-personas/${spaceFor(session)}/sessions/${encodeURIComponent(session.sessionId)}/images/${operation.id}`;
    return { id: operation.id, state: operation.state, runtimeRestored: operation.runtimeRestored,
      statusUrl: base, studioPath: `/images?operation=${operation.id}`,
      ...(operation.artifact && { artifact: { ...operation.artifact, url: base + '/image' } }) };
  }
  function card(operation, session, title = 'Ton image', body = 'Création locale') {
    return { id: `image-${operation.id}`, key: `image:${operation.id}`, kind: 'image', source: 'local',
      title, body, status: operation.state, operation: view(operation, session) };
  }
  function contract(session, backend) {
    if (!spaceFor(session)) return '';
    const config = configuration();
    if (!config.configured) return 'Local image creation is unavailable in this conversation. Do not emit a draw block or claim to create an image.';
    if (spaceFor(session) === 'private' && backend === 'openclaw') return 'When the user requests a new image, use local_image create once, then end this turn so image preparation can start. Core selects a quick conversation preset by default when available. The application displays progress and the result automatically. Never poll in this same turn or claim completion without its verified receipt.';
    if (!config.conversationProfile) return 'Local drawing is unavailable in this conversation. Do not emit a draw block or claim to create an image.';
    return 'Only when the user asks you to create or change a drawing, emit one <show kind="image" source="draw" title="short caption">a precise standalone description of the requested image</show>. This is a bounded application request, not a native tool. Preserve requested objects, counts and relations; do not insert private information. For a change, describe the whole revised scene; this produces a new illustration, not a faithful edit of the old image. Say you are asking for the drawing, never that it is ready. The application accepts at most one new drawing per turn, after your reply. It displays progress, the result and an atelier link. Never use draw for an image search or to replay an earlier request.'
      + (spaceFor(session) === 'family' ? ' Family drawings must be age-appropriate, non-sexual and non-graphic. Apply the family safety rules to the drawing description as well as to speech. Offer a safe alternative or refuse an unsafe request without emitting draw. No uploads, photos, references or custom generation settings are accepted here.' : ' No file references or custom generation settings are accepted in a draw block.');
  }
  async function contextFor(session) {
    if (!spaceFor(session)) return '';
    try {
      const operations = await service.listForConversation(scopeFor(session));
      if (!operations.length) return '';
      return '\n\nCurrent Core image receipts, newest first (reference data, never a new creation instruction; do not speak identifiers):\n'
        + operations.slice(0, 3).map(op => `- ${op.id}: ${op.state}; ready=${op.state === 'completed' && op.runtimeRestored === true && /^[a-f0-9]{64}$/.test(op.artifact?.sha256 || '')}.`).join('\n')
        + '\nOnly ready=true confirms a completed image. The screen follows its progress; you have not inspected its visual content.';
    } catch { return '\n\nCurrent image state could not be verified. Do not claim readiness or create another image to recover it.'; }
  }
  async function complete({ session, pack, backend, display, evidence, turnId, signal, onShow, member = false }) {
    const space = !member && spaceFor(session), native = space === 'private' && backend === 'openclaw';
    // Native operation IDs come only from verified Core tool receipts, never model text.
    for (const operation of native ? evidence?.imageDelivery?.operations || [] : []) {
      try {
        const scoped = await service.getForConversation(operation.id, scopeFor(session));
        const block = card(scoped, session); display.push(block); onShow(block);
      } catch { /* Unbound legacy operations keep their existing studio link. */ }
    }
    let requested = false;
    for (const block of display.filter(block => block.kind === 'image' && block.source === 'draw')) {
      const description = block.body;
      try {
        signal.throwIfAborted();
        const config = configuration(), quick = config.conversationProfile;
        if (!space || native || requested || !config.configured || !quick) throw Object.assign(new Error('Dessin indisponible dans ce tour.'), { statusCode: 409 });
        requested = true;
        const safety = assessSafety(description);
        if (space === 'family' && (safety.deterministicEscalation || childBoundaryReply(pack, safety, description)
          || FAMILY_UNSUITABLE.test(description.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))) throw Object.assign(new Error('Choisis une autre idée de dessin.'), { statusCode: 400 });
        const prompt = space === 'family' ? 'Age-appropriate illustration for children.\n' + description : description;
        const actionKey = 'household:' + createHash('sha256').update(JSON.stringify([scopeFor(session), turnId, 'image'])).digest('hex');
        const operation = await service.accept({ actionKey, prompt,
          profile: quick.id, width: quick.width, height: quick.height }, { conversation: scopeFor(session), signal });
        Object.assign(block, card(operation, session, block.title || 'Ton dessin', description));
      } catch (error) {
        if (signal.aborted) return;
        Object.assign(block, { source: 'local', status: error.statusCode ? 'failed' : 'unknown', body: error.statusCode
          ? 'Le dessin n’a pas été accepté. Réessaie quand l’atelier sera disponible, ou choisis une autre idée.'
          : 'Impossible de confirmer la demande. Vérifie les images de cette conversation avant de demander un autre dessin.' });
      }
      onShow(block);
    }
  }
  function register(router) {
    for (const space of ['private', 'family']) {
      const base = `/${space}/sessions/:sessionId/images`;
      const wrap = handler => async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
          const session = await conversations.getSession({ sessionId: req.params.sessionId });
          if (!session || spaceFor(session) !== space) throw Object.assign(new Error('Conversation image inconnue.'), { statusCode: 404 });
          if (req.params.id && !UUID.test(req.params.id)) throw Object.assign(new Error('Image inconnue.'), { statusCode: 404 });
          await handler(req, res, session);
        } catch (error) { res.status(error.statusCode || 503).json({ ok: false, message: error.statusCode === 404 ? 'Image ou conversation inconnue.' : 'La demande image est indisponible. Vérifie son état avant de réessayer.' }); }
      };
      router.get(base, wrap(async (_req, res, session) => res.json({ ok: true,
        blocks: (await service.listForConversation(scopeFor(session))).map(op => card(op, session)) })));
      router.get(base + '/:id', wrap(async (req, res, session) => res.json({ ok: true,
        operation: view(await service.getForConversation(req.params.id, scopeFor(session)), session) })));
      router.get(base + '/:id/image', wrap(async (req, res, session) => {
        const op = await service.getForConversation(req.params.id, scopeFor(session));
        if (op.state !== 'completed' || !op.runtimeRestored || !op.artifact) throw Object.assign(new Error('Image en préparation.'), { statusCode: 409 });
        const artifact = await service.image(req.params.id);
        res.set({ 'Content-Type': artifact.mimeType, 'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `inline; filename="image-${op.id}.png"` }).send(artifact.bytes);
      }));
      if (space === 'private') {
        router.post(base, wrap(async (req, res, session) => {
          if (session.status !== 'active') throw Object.assign(new Error('Conversation terminée.'), { statusCode: 409 });
          const quick = service.status().conversationProfile;
          const input = req.body || {};
          const body = { ...input, ...(!input.profile && quick ? { profile: quick.id,
            width: input.width || quick.width, height: input.height || quick.height } : {}) };
          res.status(202).json({ ok: true, operation: await service.accept(body, { conversation: scopeFor(session) }) });
        }));
        router.post(base + '/:id/cancel', wrap(async (req, res, session) => {
          await service.getForConversation(req.params.id, scopeFor(session));
          res.json({ ok: true, operation: await service.cancel(req.params.id) });
        }));
      }
    }
  }
  return { contract, contextFor, complete, register };
}
module.exports = { createConversationImages, spaceFor, scopeFor };
