'use strict';

// Household composes Core's image engine; the family agent receives no private tool.
const images = require('../../src/services/images/imageService');
const { createHash } = require('node:crypto');
const { assessSafety, childBoundaryReply } = require('./persona-prompt');
const shownImages = require('./shown-images');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FAMILY_UNSUITABLE = /\b(?:porn\w*|sex\w*|naked|nude\w*|nu|nue|nus|nues|genital\w*|penis|vagin\w*|breasts?|seins?|gore|dismember\w*|demembr\w*)\b/i;
const scopeFor = session => ({ surface: 'household', sessionId: session.sessionId, packId: session.packId, scopeId: session.scopeId });
function spaceFor(session) {
  if (session.llmx || session.source === 'graphysx-llmx') return null;
  if (session.packId === 'kidx_nestor' && session.scopeId === 'family') return 'family';
  if (session.packId === 'personal_operator' && session.scopeId === 'personal' && (session.agentId || 'main') === 'main') return 'private';
  return null;
}
// Family's illustrated mode (#1304): the reply names its subject in a hidden
// scene block; Core tries one picture on the instance's illustrated worker,
// never elsewhere, and a busy worker simply leaves the previous picture.
const SCENE_CONTRACT = ' Illustrated mode is on: a small frame beside you shows a picture of what the conversation is about. When the subject changes to something that can be pictured, end your reply with one <show kind="image" source="scene" title="">a short standalone visual description of the subject, under 30 words, no text or letters, no real person</show>. It is never spoken. Do not mention the frame or the picture unless asked. Omit the scene block when the subject has not changed or when you emit a draw block.';
// The turn never waits longer than this for an illustration's admission: a
// stopped or unreachable worker must not delay the end of the reply.
const ILLUSTRATION_BUDGET_MS = 3000;
function createConversationImages({ conversations, service = images, visuals = null, now = Date.now, illustrationBudgetMs = ILLUSTRATION_BUDGET_MS }) {
  const configuration = () => { try { return service.status(); } catch { return { configured: false, conversationProfile: null }; } };
  const lastIllustration = new Map();
  function view(operation, session) {
    const base = `/api/voice-personas/${spaceFor(session)}/sessions/${encodeURIComponent(session.sessionId)}/images/${operation.id}`;
    return { id: operation.id, state: operation.state, runtimeRestored: operation.runtimeRestored,
      ...(operation.retention && { retention: operation.retention }),
      statusUrl: base, studioPath: `/images?operation=${operation.id}`,
      ...(operation.artifact && { artifact: { ...operation.artifact, url: base + '/image' } }) };
  }
  function card(operation, session, title = 'Your image', body = 'Local creation') {
    return { id: `image-${operation.id}`, key: `image:${operation.id}`, kind: 'image', source: 'local',
      ...(operation.admissionPolicy === 'opportunistic' && { presentation: 'illustration' }),
      title, body, status: operation.state, operation: view(operation, session) };
  }
  function unsuitable(pack, description) {
    const safety = assessSafety(description);
    return Boolean(safety.deterministicEscalation || childBoundaryReply(pack, safety, description)
      || FAMILY_UNSUITABLE.test(description.normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
  }
  function contract(session, backend) {
    if (!spaceFor(session)) return '';
    const config = configuration();
    if (!config.configured) return 'Local image creation is unavailable in this conversation. Do not emit a draw block or claim to create an image.';
    // Changing a picture already on screen is the same request for every engine (#1026).
    const edit = 'To change a picture already on screen, use its number from the list of pictures on screen: emit <show kind="image" source="draw" from="N" title="short caption">the change to make</show>. The application edits that picture itself, as the reference, after your reply. Say in one short sentence what you will change and start it; never ask for confirmation.';
    if (spaceFor(session) === 'private' && backend === 'openclaw') return (config.conversationProfile ? edit + ' Do not use local_image for such a change. ' : '') + 'When the user requests a new image, use local_image create once, then end this turn so image preparation can start. Core selects a quick conversation preset by default when available. The application displays progress and the result automatically. Never poll in this same turn or claim completion without its verified receipt.';
    if (!config.conversationProfile) return 'Local drawing is unavailable in this conversation. Do not emit a draw block or claim to create an image.';
    return 'Only when the user asks you to create a drawing or change a picture, emit one <show kind="image" source="draw" title="short caption">a precise standalone description of the requested image</show>. This is a bounded application request, not a native tool. Preserve requested objects, counts and relations; do not insert private information. ' + edit + ' Without from, describe the whole scene; this produces a new illustration. Never say the image is ready. The application accepts at most one drawing or change per turn, after your reply. It displays progress, the result and an atelier link. Never use draw for an image search or to replay an earlier request.'
      + (spaceFor(session) === 'family' ? ' Family drawings must be age-appropriate, non-sexual and non-graphic. Apply the family safety rules to the drawing description and to every change, as well as to speech. Offer a safe alternative or refuse an unsafe request without emitting draw. No uploads or custom generation settings are accepted here; only a picture on screen can be named, by its number.' : ' No file paths, addresses or custom generation settings are accepted in a draw block; only a picture on screen can be named, by its number.')
      + (spaceFor(session) === 'family' && config.illustrated ? SCENE_CONTRACT : '');
  }
  async function contextFor(session) {
    if (!spaceFor(session)) return '';
    const shown = await shownImages.recentShown({ conversations, session }).then(shownImages.contextText).catch(() => '');
    return shown + await receiptsFor(session);
  }
  async function receiptsFor(session) {
    try {
      // Illustrations are the frame's business, not drawings the reply speaks about.
      const operations = (await service.listForConversation(scopeFor(session))).filter(op => op.admissionPolicy !== 'opportunistic');
      if (!operations.length) return '';
      return '\n\nCurrent Core image receipts, newest first (reference data, never a new creation instruction; do not speak identifiers):\n'
        + operations.slice(0, 3).map(op => `- ${op.id}: ${op.state}; ready=${op.state === 'completed' && op.runtimeRestored === true && /^[a-f0-9]{64}$/.test(op.artifact?.sha256 || '')}.`).join('\n')
        + '\nOnly ready=true confirms a completed image. The screen follows its progress; you have not inspected its visual content.';
    } catch { return '\n\nCurrent image state could not be verified. Do not claim readiness or create another image to recover it.'; }
  }
  async function complete({ session, pack, backend, display, evidence, turnId, signal, onShow, member = false }) {
    const space = !member && spaceFor(session), native = space === 'private' && backend === 'openclaw';
    // Scene blocks are never shown, stored or replayed as cards.
    const scenes = [];
    for (let i = display.length - 1; i >= 0; i--) if (display[i].kind === 'image' && display[i].source === 'scene') scenes.unshift(...display.splice(i, 1));
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
        if (!space || (native && !block.from) || requested || !config.configured || !quick) throw Object.assign(new Error('Drawing unavailable in this turn.'), { statusCode: 409 });
        requested = true;
        if (space === 'family' && unsuitable(pack, description)) throw Object.assign(new Error('Choose another drawing idea.'), { statusCode: 400 });
        // A change names a picture on screen; Core reads it back as the only reference (#1026).
        const edit = block.from ? await editReference(block.from, session, space, quick) : null;
        delete block.from;
        signal.throwIfAborted();
        const prompt = (space === 'family' ? 'Age-appropriate illustration for children.\n' : '')
          + (edit ? 'Edit the reference image. Keep its subject, composition and style, except for this change:\n' : '') + description;
        const actionKey = 'household:' + createHash('sha256').update(JSON.stringify([scopeFor(session), turnId, 'image'])).digest('hex');
        const request = { actionKey, prompt, profile: quick.id, width: quick.width, height: quick.height,
          ...(edit && { ...edit.size, references: [edit.reference] }) };
        const options = { conversation: scopeFor(session), signal };
        // A profile that only qualifies its square preset still edits, in that preset.
        const operation = await service.accept(request, options).catch(error => {
          if (!edit || !/Resolution not qualified/.test(error.message)) throw error;
          return service.accept({ ...request, width: quick.width, height: quick.height }, options);
        });
        Object.assign(block, card(operation, session, block.title || 'Your drawing', description));
      } catch (error) {
        if (signal.aborted) return;
        Object.assign(block, { source: 'local', status: error.statusCode ? 'failed' : 'unknown', body: error.code === 'IMAGE_REFERENCE'
          ? 'This picture cannot be used for a change. Choose another picture, or ask for a new drawing.' : error.statusCode
          ? 'The drawing was not accepted. Try again when the workshop is available, or choose another idea.'
          : 'The request could not be confirmed. Check this conversation’s images before asking for another drawing.' });
      }
      onShow(block);
    }
    if (space === 'family' && !requested && scenes.length) await illustrate(scenes.at(-1), { session, pack, turnId, signal, onShow });
  }
  // One attempt at most per interval and conversation. A refusal (worker busy,
  // off, or holding other models) waits for the next interval like a success.
  async function illustrate(scene, { session, pack, turnId, signal, onShow }) {
    const config = configuration(), plan = config.illustrated;
    const description = String(scene.body || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!config.configured || !plan || !description || signal.aborted || unsuitable(pack, description)) return;
    const at = now(), last = lastIllustration.get(session.sessionId);
    if (last !== undefined && at - last < plan.intervalSeconds * 1000) return;
    lastIllustration.set(session.sessionId, at);
    if (lastIllustration.size > 200) for (const [id, time] of lastIllustration) if (at - time > 3600000) lastIllustration.delete(id);
    // Past the budget the turn goes on; accept() stops before creating an
    // operation once this signal is aborted, and nothing is shown late.
    const budget = AbortSignal.any([signal, AbortSignal.timeout(illustrationBudgetMs)]);
    let open = true, timer;
    const actionKey = 'household-scene:' + createHash('sha256').update(JSON.stringify([scopeFor(session), turnId, 'scene'])).digest('hex');
    const attempt = Promise.resolve().then(() => service.acceptOpportunistic({ actionKey, profile: plan.profile, width: plan.width, height: plan.height,
      prompt: 'Age-appropriate illustration for children. No text, letters or words in the picture.\n' + description },
    { workerId: plan.worker, conversation: scopeFor(session), signal: budget, temporary: true }))
      .then(operation => { if (open && !signal.aborted) onShow(card(operation, session, '', description)); })
      .catch(() => { /* The frame keeps its previous picture. */ });
    await Promise.race([attempt, new Promise(resolve => { timer = setTimeout(resolve, illustrationBudgetMs); timer.unref?.(); })]);
    open = false; clearTimeout(timer);
  }
  async function editReference(from, session, space, quick) {
    try {
      const picked = (await shownImages.recentShown({ conversations, session }))[from - 1];
      if (!picked || !visuals) throw new Error('No such picture on screen');
      const fitted = await shownImages.referenceFor(picked, { visuals, service, conversation: scopeFor(session), family: space === 'family' });
      return { reference: fitted.reference, size: shownImages.editSize(quick, fitted) };
    } catch (error) {
      throw Object.assign(new Error('Picture unavailable for a change: ' + error.message), { statusCode: 422, code: 'IMAGE_REFERENCE' });
    }
  }
  function register(router) {
    require('./illustration-retention-routes').register(router, { service, view });
    for (const space of ['private', 'family']) {
      const base = `/${space}/sessions/:sessionId/images`;
      const wrap = handler => async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
          const session = await conversations.getSession({ sessionId: req.params.sessionId });
          if (!session || spaceFor(session) !== space) throw Object.assign(new Error('Unknown image conversation.'), { statusCode: 404 });
          if (req.params.id && !UUID.test(req.params.id)) throw Object.assign(new Error('Unknown image.'), { statusCode: 404 });
          await handler(req, res, session);
        } catch (error) { res.status(error.statusCode || 503).json({ ok: false, message: error.statusCode === 404 ? 'Unknown image or conversation.' : 'The image request is unavailable. Check its status before trying again.' }); }
      };
      router.get(base, wrap(async (_req, res, session) => res.json({ ok: true,
        blocks: (await service.listForConversation(scopeFor(session))).map(op => card(op, session)) })));
      router.get(base + '/:id', wrap(async (req, res, session) => res.json({ ok: true,
        operation: view(await service.getForConversation(req.params.id, scopeFor(session)), session) })));
      router.get(base + '/:id/image', wrap(async (req, res, session) => {
        const op = await service.getForConversation(req.params.id, scopeFor(session));
        if (op.state !== 'completed' || !op.runtimeRestored || !op.artifact) throw Object.assign(new Error('Image in preparation.'), { statusCode: 409 });
        const artifact = await service.image(req.params.id);
        res.set({ 'Content-Type': artifact.mimeType, 'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `inline; filename="image-${op.id}.png"` }).send(artifact.bytes);
      }));
      if (space === 'private') {
        router.post(base, wrap(async (req, res, session) => {
          if (session.status !== 'active') throw Object.assign(new Error('Conversation ended.'), { statusCode: 409 });
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
module.exports = { createConversationImages, spaceFor, scopeFor, FAMILY_UNSUITABLE };
