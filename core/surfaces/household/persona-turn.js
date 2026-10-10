'use strict';

// The Household persona turn engine: safety, memory, the family and math
// scenes, inference through the conversation executor, reply channels and
// visuals. Household's register() creates it once with its runtime services
// and shares it between the browser persona routes and the native consumers.

const crypto = require('crypto');
const personaCatalog = require('./persona-catalog');
const { agentInstructions, agentIdFor, personalVoice } = require('./conversation-agent');
const { conversationBackend } = require('./conversation-executor');
const { workshopContext, workshopPrompt } = require('./kidx-workshop');
const llmx = require('./llmx-conversation');
const { FAMILY_TONE, familyTurn, householdMembers } = require('./family-context');
const { mathTurnFor } = require('./math-scene');
const replyChannels = require('./reply-channels');
const { plainReply } = replyChannels;
const { scoreSpeechLanguage, speechText } = require('../../public/js/voice/speech-language');
const nestorKnowledge = require('./nestor-knowledge');
const { voiceRecallOptions } = require('./voice-note-recall');
const teamAddress = require('./team-address');
const { serverTimingsOf } = require('./turn-phases');
const { turnDirective } = require('./persona-prompt');
const { interruptedRequestContext } = require('./persona-records');

// A team member's own personality: the active catalog persona naming that agent, so an
// edit made on the Team page applies; the shared definition when the catalog is unreadable.
async function teamPersona(agentId, personas) {
  try {
    const active = (await personas?.list?.() || []).find((entry) => entry.uiConfig?.layoutConfig?.agentId === agentId);
    if (active) return personaCatalog.snapshot(active);
  } catch { /* the shared definition below */ }
  const row = personaCatalog.generatedPersonas().find((entry) => entry.uiConfig.layoutConfig.agentId === agentId);
  return row ? personaCatalog.snapshot({ ...row, version: 0, _id: 'catalog' }) : null;
}

const FAMILY_SURFACE_CONTRACT = 'This is a family learning conversation. Use the child’s latest language, defaulting to Canadian French only when unclear. Keep private adult data separate. Household handles speech and supplies the current approved context; native permissions define your tools. ' + FAMILY_TONE;

function createPersonaTurnHandler({
  logger, runtimeServices, conversations, conversationEnv, executeConversation, requireNativeAgent, preferencesFor = null, conversationWorks = null,
  familyTasks, ownerMemory, familyMemory, notesFor, personalAttachments, knowledgeState, openHold, openingPayload,
  sounds, visuals, brain, memberWork, conversationImages, warmup = null, activePersonaTurns, validClientTurnId,
  envelope, fail, cleanText, assessSafety, childBoundaryReply, escalationReply, detectMemoryRequest,
  packById, packSummary, modeSummary, publicSession, systemPromptFor, spokenReplyLanguage,
  sessionHistoryMessages, loadSessionAuditRows,
  MEMORY_RECALL_LIMIT, PERSONAL_OPERATOR_SURFACE_CONTRACT, VOIX_FAMILY_PACK_ID
}) {
  // The instructions of a native turn. They hold only what stays the same for the
  // whole conversation, so the model's prompt cache keeps them; the opening
  // warm-up (voice-warmup.js) builds its own through this same function.
  const nativeInstructionsFor = ({ turnSession, pack, selectedMode, channel, soundPlayback, addressed = '', workshop = null, scene = '', llmxTurn = false, imageSession = turnSession, imageBackend = conversationBackend(turnSession.backend, conversationEnv), imagesEnabled = true }) =>
    agentInstructions(turnSession, turnSession.persona,
      pack.childSafe ? FAMILY_SURFACE_CONTRACT : PERSONAL_OPERATOR_SURFACE_CONTRACT, selectedMode, { soundPlayback, channel })
    + addressed + workshopPrompt(workshop) + scene
    + (llmxTurn ? '' : '\n\n' + replyChannels.contract({ family: pack.childSafe, imageSources: visuals.sources({ family: pack.childSafe }) })
      + (imagesEnabled && conversationImages ? '\n' + conversationImages.contract(imageSession, imageBackend) : ''));
  // What an ordinary spoken turn of the conversation's own agent sends, in a personal session nobody has spoken in yet.
  const openingInstructions = (session, pack, selectedMode) => nativeInstructionsFor({ turnSession: session, pack, selectedMode,
    channel: 'voice', soundPlayback: true,
    addressed: memberWork ? teamAddress.consultContract(teamAddress.teamMembers(conversationEnv), agentIdFor(session)) : '',
    workshop: workshopContext(undefined, session) });
  const handle = async (req, res, access, requiredSession = null) => {
    // Set only by this handler when the conversation's agent consults a member (#41): never a request field.
    const consult = req.consult || null;
    const isLlmX = Boolean(req.llmx), isOpening = req.llmx?.opening === true;
    const sceneEnabled = isLlmX && !isOpening && llmx.sceneCapable(req.llmx.sceneContext);
    const userText = consult ? consult.question : isOpening ? '' : String(req.body?.text || '').trim();
    if (userText.length > 4000) {
      return fail(res, 413, 'Le texte dépasse la limite de 4 000 caractères. Rien n’a été raccourci ni envoyé au modèle.', 'VOICE_PERSONA_TEXT_TOO_LARGE');
    }
    if (!userText && !isOpening) return fail(res, 400, 'text is required', 'VOICE_PERSONA_TEXT_REQUIRED');
    if (!consult && activePersonaTurns.has(req.params.sessionId)) return fail(res, 409, 'Wait for this conversation to finish its reply.', 'VOICE_TURN_IN_PROGRESS');
    let clientTurnId = consult ? consult.turnId : (isLlmX || ((access === 'private' || requiredSession?.browser === true) && req.body?.channel === 'voice'
      && (req.body?.stream === true || ['read', 'observe'].includes(conversationEnv.PERSONAL_CONVERSATION_WORK_MODE))))
      && validClientTurnId(req.body?.turnId) ? req.body.turnId : '';
    const startedAt = Date.now();
    const abort = new AbortController();
    // A consulted member works like a detached member turn: nothing is streamed, its reply goes to member-work.
    const entry = { abort, clientTurnId, imageTurnId: crypto.randomUUID(), generated: '', interrupted: false, auditWritten: false, detached: Boolean(consult),
      llmx: isLlmX, profile: req.llmx?.profile || 'personal', opening: isOpening, dispatched: false };
    entry.ready = new Promise(resolve => { entry.markReady = resolve; });
    entry.finished = new Promise(resolve => { entry.finish = resolve; });
    if (consult) consult.cancel = () => { entry.interrupted = true; abort.abort(); };
    else { activePersonaTurns.set(req.params.sessionId, entry); brain.cancel(req.params.sessionId); }
    // A detached member turn (member-work.js) keeps running without its request.
    const disconnected = () => { if (!res.writableEnded && !entry.detached) abort.abort(); };
    res.on?.('close', disconnected);
    const streaming = req.body?.stream === true;
    const event = (type, data) => {
      if (!streaming || abort.signal.aborted || entry.detached) return;
      if (!res.headersSent) res.status(200).set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.write(JSON.stringify({ type, ...data }) + '\n');
    };
    try {
      const session = await conversations.getSession({ sessionId: req.params.sessionId });
      if (!session || session.status !== 'active') {
        return fail(res, 404, 'Voice persona session not found', 'VOICE_PERSONA_SESSION_NOT_FOUND');
      }
      if (isLlmX && !llmx.matchesSession(session, entry.profile)) {
        return fail(res, 404, 'LLMx conversation not found', 'LLMX_SESSION_NOT_FOUND');
      }
      const pack = packById(session.packId);
      if (!pack) return fail(res, 409, 'Session persona pack is unavailable', 'VOICE_PERSONA_PACK_NOT_FOUND');
      const preferences = preferencesFor ? await preferencesFor(pack.childSafe).read() : null;
      const features = preferences?.values || {};
      const selectedMode = pack.modes.find((entry) => entry.id === session.modeId);
      if (!selectedMode) return fail(res, 409, 'Session mode is unavailable', 'VOICE_PERSONA_SESSION_MODE_UNAVAILABLE');
      if (access === 'child' && !pack.childSafe) {
        return fail(res, 403, 'Private persona turns require the guarded private route', 'VOICE_PERSONA_PRIVATE_ROUTE_REQUIRED');
      }
      if (access === 'private' && pack.childSafe) {
        return fail(res, 400, 'Child-safe persona turns use the public child route', 'VOICE_PERSONA_CHILD_ROUTE_REQUIRED');
      }
      if (requiredSession && (
        session.packId !== requiredSession.packId
        || session.modeId !== requiredSession.modeId
        || session.scopeId !== requiredSession.scopeId
      )) {
        return fail(
          res,
          403,
          'Native Family voice can use only its exact child-safe session contract',
          'VOIX_FAMILY_SESSION_REQUIRED'
        );
      }
      if (clientTurnId) {
        entry.snapshot = { sessionId: session.sessionId, packId: pack.id, modeId: session.modeId, scopeId: session.scopeId };
      }
      const requestedAttachments = runtimeServices.attachments.ids(req.body?.attachmentIds);
      const attachmentStore = !isLlmX && access === 'private' && session.packId === 'personal_operator' && session.scopeId === 'personal'
        ? personalAttachments(session.sessionId) : null;
      if (requestedAttachments.length && !attachmentStore) return fail(res, 400, 'Les pièces jointes sont disponibles dans Nestor personnel.', 'ATTACHMENTS_PERSONAL_ONLY');
      entry.attachments = requestedAttachments.length ? await attachmentStore.references(requestedAttachments) : [];
      if (!consult && !isLlmX && !teamAddress.addressedMember(userText, teamAddress.teamMembers(conversationEnv), agentIdFor(session))
          && (conversationWorks?.eligible(session, req.body?.channel)
            || await conversationWorks?.retained?.(session, req.body?.turnId, req.body?.channel))) {
        clientTurnId ||= req.body.turnId; entry.clientTurnId = clientTurnId;
        const intake = await conversationWorks.intake({ session, turnId: clientTurnId, text: userText, attachments: entry.attachments });
        entry.workId = intake.row._id; entry.traceId = clientTurnId; entry.snapshot ||= {
          sessionId: session.sessionId, packId: pack.id, modeId: session.modeId, scopeId: session.scopeId };
        if (intake.duplicate) { entry.auditWritten = true; return envelope(res, { accepted: true, turnId: clientTurnId, workId: entry.workId,
          outcome: intake.turn.outcome, reply: intake.turn.outcome === 'completed' ? { text: intake.turn.replyText } : null,
          replayed: false }, 202); }
        event('accepted', { turnId: clientTurnId, workId: entry.workId, state: intake.row.state });
      }
      entry.markReady(entry.snapshot || null);
      if (isLlmX) {
        if (isOpening) {
          const reserved = await conversations.updateSession({ sessionId: session.sessionId,
            'llmx.opening': null, 'llmx.humanStarted': { $ne: true }, turnCount: 0 },
          { $set: { 'llmx.opening': { version: llmx.OPENING_VERSION, status: 'pending', turnId: clientTurnId, requestedAt: new Date() } } });
          if (!reserved) {
            const current = await conversations.getSession({ sessionId: session.sessionId });
            return envelope(res, { ...openingPayload(current), opening: llmx.publicOpening(current?.llmx?.opening) || { version: 1, status: 'skipped', reason: 'human_first' } });
          }
          entry.openingReserved = true;
          entry.applicationEvent = llmx.openingEvent(session, req.llmx.sceneContext);
        } else {
          if (await conversations.getTurn({ sessionId: session.sessionId, packId: session.packId, scopeId: session.scopeId,
            source: 'graphysx-llmx', clientTurnId })) return fail(res, 409, 'This LLMx turn was already submitted. Read its history instead of generating it again.', 'LLMX_TURN_REPLAY');
          const accepted = await conversations.updateSession({ sessionId: session.sessionId, 'llmx.opening.status': { $ne: 'pending' } },
            { $set: { 'llmx.humanStarted': true } });
          if (!accepted) return fail(res, 409, 'The opening is still active or its completion is uncertain. Resume its history or start a new conversation.', 'LLMX_OPENING_UNSETTLED');
        }
      }
      const workshop = workshopContext(req.body?.workshop, session);
      const safety = assessSafety(userText, { adult: !pack.childSafe });
      const childBoundary = childBoundaryReply(pack, safety, userText), mathTurn = pack.childSafe && !isLlmX && !childBoundary && !safety.deterministicEscalation ? mathTurnFor(userText) : null;
      let replyText, sceneProposal = null, display = [];
      // Only browser child-safe turns offer clips, and never over a safety
      // escalation or boundary reply. Native VoiX owns its own playback and does
      // not consume this browser sound payload, so it must not invite a child to
      // listen and then produce silence.
      let sound = null;
      // Set when the turn addresses another team member (#41): who answers, and with which voice.
      let member = null, memberPersona = null, speaker = null, consultRequest = null;
      const serverPhases = {}; // where this turn's server time goes (turn-phases.js)
      let continuity = { status: 'not-required', source: 'session-audit', messageCount: 0 };
      let toolEvidence = null;
      let metadata = { model: '', hostKey: '', routingSource: 'deterministic' };
      let routeTier = 'deterministic';
      let fallbackUsed = false;
      let fallbackReason = '';
      let holdState = null;
      let knowledge = {
        status: safety.deterministicEscalation
          ? 'skipped_safety_escalation'
          : childBoundary ? 'skipped_child_boundary' : knowledgeState.status.status,
        enabled: false,
        used: false,
        sourceCount: 0,
        corpusFingerprint: knowledgeState.status.corpusFingerprint,
        context: ''
      };
      if (safety.deterministicEscalation) {
        replyText = escalationReply(pack, safety);
      } else if (childBoundary || mathTurn) { // #131: the picture first, then Nestor's exact answer without waiting for inference.
        replyText = childBoundary || mathTurn.reply; if (mathTurn) event('scene', { scene: mathTurn.scene });
      } else {
        // Scope chooses context and permissions. The same executor handles every
        // pack; its selected backend stays fixed for this conversation.
        const backend = conversationBackend(session.backend, conversationEnv);
        // #41: a turn that names another team member runs in that member's own session.
        const team = backend === 'openclaw' && !pack.childSafe && !isLlmX ? teamAddress.teamMembers(conversationEnv) : [];
        member = consult ? consult.member : teamAddress.addressedMember(userText, team, agentIdFor(session));
        // That member is still on an earlier question: the conversation's agent answers and says so.
        if (member && !consult && memberWork?.active(session.sessionId).some(job => job.agentId === member.agentId)) member = null;
        memberPersona = member ? await teamPersona(member.agentId, runtimeServices.personas) : null;
        const turnSession = member ? teamAddress.memberSession(session, member, memberPersona) : session;
        if (member) {
          speaker = { agentId: member.agentId, name: memberPersona?.name || member.agentId, personaId: memberPersona?.id || null };
          event('speaker', { speaker });
          // Speaking again does not cancel a member: its turn detaches and its reply is said later.
          if (clientTurnId && streaming && memberWork) entry.detach = () => {
            if (entry.detached || entry.executionSettled || abort.signal.aborted) return false;
            memberWork.start(session.sessionId, clientTurnId, { agentId: member.agentId, name: speaker.name, question: userText,
              cancel: () => { entry.interrupted = true; abort.abort(); } });
            event('detached', { speaker });
            entry.detached = true;
            if (activePersonaTurns.get(req.params.sessionId) === entry) activePersonaTurns.delete(req.params.sessionId);
            if (!res.writableEnded) res.end();
            return true;
          };
          // Heard at once: the member's first words can be many seconds away.
          event('status', { phase: 'activity', activity: { kind: 'member_addressed', agentId: member.agentId } });
        }
        if (backend === 'openclaw') await requireNativeAgent(agentIdFor(turnSession));
        let history = [], interruptedContext = '';
        const recoverInterrupted = backend === 'openclaw' && !member && personalVoice(turnSession, 'voice');
        if (features.historyContext !== false && (backend === 'agentx' || !turnSession.agentSessionKey || attachmentStore || recoverInterrupted)) {
          // Core inference reads a block window, so its history start (and the cached prefix) moves rarely.
          try {
            const rows = (await loadSessionAuditRows(conversations, session, pack)).filter(row => !entry.workId || row.traceId !== clientTurnId);
            history = sessionHistoryMessages(rows, pack, backend === 'agentx' ? { turnCount: session.turnCount || 0 } : {});
            if (recoverInterrupted) interruptedContext = interruptedRequestContext(rows);
          }
          catch { return fail(res, 503, 'Conversation history is unavailable; no out-of-context answer was generated.', 'VOICE_PERSONA_HISTORY_UNAVAILABLE'); }
        }
        if (!session.backend) {
          await conversations.updateSession({ sessionId: session.sessionId }, { $set: { backend, agentId: agentIdFor(session) } });
          session.backend = backend;
        }
        let memories = [], savedNow = false, family = {}, members = '';
        if (!isOpening) {
          const notes = notesFor(pack, session.scopeId);
          if (!pack.childSafe && features.householdContext !== false) members = await householdMembers(familyTasks, { logger });
          // Kids Room routines, and a child's idea or reminder kept for Dad (#41, #13).
          if (pack.childSafe) ({ savedNow, ...family } = await familyTurn({ userText, notes, familyTasks, detectMemoryRequest, logger, withChores: features.householdContext !== false && pack.id === VOIX_FAMILY_PACK_ID }));
          try {
            if (features.memoryContext !== false) memories = (await notes.search(userText, voiceRecallOptions(userText, personalVoice(session, req.body?.channel), MEMORY_RECALL_LIMIT))).notes;
          } catch (error) {
            logger?.error?.('Core note recall failed', { error: error.message });
            return fail(res, 503, 'Les souvenirs sont indisponibles. Réessaie avant de poursuivre.', 'MEMORY_NOTES_UNAVAILABLE');
          }
          if (features.knowledgeContext !== false && (pack.childSafe || backend === 'agentx')) {
            knowledge = await nestorKnowledge.retrieve(knowledgeState, pack.id, userText, {
              logger, memory: pack.childSafe ? familyMemory : ownerMemory
            });
          }
        }
        const browserSoundPlayback = (!requiredSession || requiredSession.browser === true) && req.body?.soundPlayback === true;
        // The clip an explicit request names is chosen here, in both spaces, so playing it never
        // depends on a model calling a tool: the voice model announced the sound and called nothing.
        sound = (pack.childSafe ? !requiredSession || requiredSession.browser === true : browserSoundPlayback) ? sounds.select(userText) : null;
        const preselected = Boolean(sound);
        const context = { memories, savedNow, captured: family.captured, knowledgeContext: [members, knowledge.context, family.chores].filter(Boolean).join('\n\n'),
          modeId: session.modeId, sound, latestUserText: userText };
        let lastProposal = null, previousBrowserOutput = null;
        const nativeBrowserReply = sceneEnabled && backend === 'openclaw';
        if (isLlmX && !isOpening) {
          const [latest] = await conversations.listTurns({ sessionId: session.sessionId, packId: pack.id, scopeId: session.scopeId,
            source: 'graphysx-llmx', outcome: 'completed', 'sceneProposal.schemaVersion': 1 }, { sort: { createdAt: -1 }, limit: 1 });
          if (latest) lastProposal = { turnId: latest.clientTurnId, environmentId: latest.sceneProposal.environmentId,
            revision: latest.sceneProposal.revision, intent: latest.sceneProposal.intent, receipt: latest.sceneReceipt || null };
          if (nativeBrowserReply) {
            const [lastTurn] = await conversations.listTurns({ sessionId: session.sessionId, packId: pack.id, scopeId: session.scopeId,
              source: 'graphysx-llmx', outcome: 'completed' }, { sort: { createdAt: -1 }, limit: 1 });
            previousBrowserOutput = llmx.browserReplyOutput(lastTurn);
          }
        }
        const sceneInstructions = isLlmX ? llmx.scenePrompt(req.llmx.sceneContext, { opening: isOpening, lastProposal, clientTool: nativeBrowserReply }) : '';
        const useOpen = !pack.childSafe && (session.inference?.open === true || selectedMode.id === 'open');
        if (useOpen) {
          holdState = await openHold.touch({ signal: abort.signal });
          holdState = await openHold.waitForResident(holdState, { signal: abort.signal,
            onStatus: state => event('status', { phase: state.phase }) });
        }
        // Instructions hold only what stays the same for the whole conversation, so the
        // model's prompt cache keeps them. Everything selected for this turn (notes,
        // members, knowledge, chores, saves, the sound note, the reply language, a team
        // member's last exchange and the reviewer's advice) goes last, beside the request.
        const turnContext = [systemPromptFor(pack, { ...context, contextOnly: true }), interruptedContext,
          member ? '' : teamAddress.exchangeContext(session.teamExchange), member ? '' : memberWork?.contextFor(session.sessionId) || '',
          isLlmX || features.reviewContext === false ? '' : brain.contextFor(session.sessionId),
          !isLlmX && !member && session.packId === 'personal_operator' && session.scopeId === 'personal' && agentIdFor(session) === 'main'
            ? await conversationWorks?.guardianContext?.(session.sessionId, entry.workId) || '' : '',
          isLlmX || member ? '' : await conversationImages?.contextFor?.(session), safety.advisoryNote || ''].join('').trim();
        if (entry.workId) await conversationWorks.prepare(entry.workId, turnContext);
        const acceptedTaskWork = entry.workId ? await conversationWorks.taskAcceptance?.(entry.workId) : null;
        const currentDirective = [turnDirective(context), acceptedTaskWork
          ? 'Core has already accepted this current personal task lookup. Its verified intake is ' + JSON.stringify(acceptedTaskWork)
            + '. Give a short acknowledgment and keep handling any other parts of the request with your existing capabilities. This lookup belongs to the separate worker: no second dispatch, task-list call or agent discovery is needed. Acceptance is not task data or task completion.'
          : ''].filter(Boolean).join('\n\n');
        const nativeInstructions = nativeInstructionsFor({ turnSession, pack, selectedMode, channel: req.body?.channel,
          soundPlayback: !pack.childSafe && browserSoundPlayback && !preselected,
          addressed: member ? (consult ? teamAddress.consultInstruction : teamAddress.memberInstruction)(speaker.name)
            : memberWork ? teamAddress.consultContract(team, agentIdFor(session)) : '',
          workshop, scene: sceneInstructions + (isOpening ? llmx.openingPrompt(entry.applicationEvent) : ''), llmxTurn: isLlmX,
          imageSession: session, imageBackend: backend, imagesEnabled: !member })
          + (entry.workId ? '\n\n' + conversationWorks.guardianInstructions : '');
        // Child presentation follows the selected adult personality on both
        // transports. Adult conversations keep their normal style overlay order.
        const agentxInstructions = [pack.childSafe ? session.persona?.identity : '',
          systemPromptFor(pack, { modeId: session.modeId }), pack.childSafe ? '' : session.persona?.identity,
          'This turn uses AgentX/Ollama inference with the supplied context. No native agent tools, skills or Dreaming run here. Do not claim to access OpenClaw memory or execute actions. A note is saved only when the supplied context explicitly confirms it.',
          workshopPrompt(workshop), sceneInstructions, isOpening ? llmx.openingPrompt(entry.applicationEvent) : '', isLlmX ? '' : replyChannels.contract({ family: pack.childSafe, imageSources: visuals.sources({ family: pack.childSafe }) }),
          isLlmX || member ? '' : conversationImages?.contract(session, backend)].filter(Boolean).join('\n\n');
        abort.signal.throwIfAborted();
        entry.dispatched = true;
        if (isLlmX) event('status', { phase: 'generating', origin: isOpening ? 'application_opening' : 'human' });
        const replyLanguage = (s => s.decided ? s.language : 'fr')(scoreSpeechLanguage(userText)), visualsWork = entry.visualsWork = [];
        const channels = entry.channels = isLlmX ? null : replyChannels.createReplyChannels({ allowSecrets: !pack.childSafe, language: replyLanguage,
          onSay: delta => { if (!res.writableEnded) event('delta', { delta }); },
          // One consultation per reply, and a member does not consult in turn.
          onConsult: request => { if (!member) consultRequest ||= teamAddress.consultedMember(request, team, agentIdFor(session)); }, onShow: block => {
            if (block.kind === 'image' && block.source === 'draw' && conversationImages) return;
            visualsWork.push(visuals.present(block, { family: pack.childSafe, language: replyLanguage })
              .then(shown => { if (!res.writableEnded) event('show', { block: shown }); }));
          } });
        // The opening warm-up shares this native session: its run ends before the first real turn starts.
        if (!member) { warmup?.noteTurn(session); await warmup?.settled(session.sessionId); }

        serverPhases.prepared = Date.now() - startedAt;
        const run = executeConversation({ backend, session: turnSession, pack: isOpening ? { ...pack, maxTokens: 180 }
          : sceneEnabled ? { ...pack, maxTokens: 4096 } : pack, text: userText, history: features.historyContext === false ? [] : history, streaming, channel: req.body?.channel,
          conversationFeatures: features,
          ...(acceptedTaskWork ? { readAcceptedTaskWork: () => conversationWorks.taskAcceptance(entry.workId) } : {}),
          attachments: entry.attachments, attachmentStore,
          ...(isOpening ? { applicationEvent: entry.applicationEvent } : {}),
          instructions: nativeInstructions, agentxInstructions, ...(turnContext ? { turnContext } : {}),
          ...(currentDirective ? { turnDirective: currentDirective } : {}),
          ...(nativeBrowserReply ? { browserReply: { context: req.llmx.sceneContext, previousOutput: previousBrowserOutput } } : {}),
          ...(useOpen ? { model: 'ollama/' + holdState.model, openTarget: { hostUrl: holdState.host.url, numCtx: holdState.numCtx } } : {}),
          signal: abort.signal, onWaiting: () => event('status', { phase: 'waiting_host' }), onActivity: activity => event('status', { phase: 'activity', activity }),
          onStarted: async (key, runId) => {
            if (entry.workId && runId) await conversationWorks.guardianStarted(entry.workId, key, runId);
            if (runId) entry.auditContext = { ...entry.auditContext,
              toolEvidence: { authority: `openclaw/${agentIdFor(turnSession)}`, sessionKey: key, runId } };
            if (member) {
              // The member's own native session; the conversation agent's key is never replaced.
              const keys = { ...(session.agentSessionKeys || {}), [member.agentId]: key };
              await conversations.updateSession({ sessionId: session.sessionId }, { $set: { agentSessionKeys: keys } });
              session.agentSessionKeys = keys;
            } else {
              await conversations.updateSession({ sessionId: session.sessionId }, { $set: { agentSessionKey: key } });
              session.agentSessionKey = key;
            }
            turnSession.agentSessionKey = key;
          },
          onSettled: () => { entry.executionSettled = true; },
          onDelta: delta => { entry.generated = (entry.generated + delta).slice(0, 5000); if (channels) channels.push(delta); else if (!isOpening && !sceneEnabled) event('delta', { delta }); }
        });
        entry.completion = run.then(() => null, error => error);
        const result = await run;
        serverPhases.executed = Date.now() - startedAt; serverPhases.agent = result.metadata?.phases;
        entry.executionSettled = true;
        metadata = result.metadata; if (metadata?.routing?.degraded) { fallbackUsed = true; fallbackReason = `task_fallback_${metadata.routing.reason}`; } // #135 degraded fallback
        routeTier = backend === 'openclaw' ? 'agent' : 'router';
        continuity = backend === 'openclaw' ? { status: 'ready', source: `openclaw/${agentIdFor(turnSession)}`, sessionKey: result.sessionKey }
          : { status: 'ready', source: 'session-audit', messageCount: history.length };
        if (!pack.childSafe) continuity.personal = { status: 'ready', authority: 'agentx.core', notes: memories };
        toolEvidence = result.tools;
        if (!pack.childSafe && browserSoundPlayback && !preselected) {
          const receipt = toolEvidence?.status === 'observed' && toolEvidence.runId ? toolEvidence.receipts?.filter(row =>
            ['agentx__get_sound', 'get_sound'].includes(row.tool) && row.runId === toolEvidence.runId).at(-1) : null;
          sound = receipt?.status === 'verified' ? sounds.get(receipt.soundId) : null;
        }
        if (backend === 'openclaw' && !pack.childSafe) knowledge = { ...knowledge, status: 'agent-managed', enabled: true,
          used: toolEvidence.receipts?.some(receipt => /rag_search|memory_search|wiki_search/.test(receipt.tool)) || false };
        entry.auditContext = { model: metadata.model || '', routingSource: metadata.routingSource || '', routeTier, toolEvidence,
          knowledgeStatus: knowledge.status, knowledgeSourceCount: knowledge.sourceCount,
          knowledgeCorpusFingerprint: knowledge.corpusFingerprint, safetyFlags: safety.flagIds,
          parentAttention: safety.requiresParentAttention, soundId: sound?.id || '' };
        if (abort.signal.aborted) return;
        if (channels && !channels.received) channels.push(result.text);
        // `say_end`: every spoken word is sent, so a voice page says its last clause
        // now instead of waiting for pictures, tool receipts and the record before `done`.
        if (channels) { ({ display } = channels.end()); event('say_end'); await Promise.all(visualsWork); }
        if (channels && !abort.signal.aborted) await conversationImages?.complete({ session, pack, backend, display,
          evidence: toolEvidence, turnId: clientTurnId || entry.imageTurnId, signal: abort.signal, member: Boolean(member),
          onShow: block => event('show', { block }) });
        const parsed = sceneEnabled ? llmx.sceneReply(result.text, req.llmx.sceneContext) : { text: channels ? channels.end().say : result.text, sceneProposal: null };
        replyText = plainReply(parsed.text, 5000);
        sceneProposal = parsed.sceneProposal;
        entry.naturalReply = replyText;
        if (isOpening && !abort.signal.aborted && (!/^Hello\b/.test(replyText) || replyText.length > 600)) {
          entry.generated = replyText;
          throw Object.assign(new Error('The agent did not produce the brief Hello opening. Its attempt was retained; no automatic retry was started.'), { code: 'LLMX_OPENING_INVALID' });
        }
        if (streaming) event('tools', { evidence: toolEvidence });
      }
      if (abort.signal.aborted) return;
      // Restart the idle window from the end of the reply, not its start.
      if (holdState?.active) {
        try { holdState = await openHold.touch({ warm: false }); } catch { /* keep the pre-turn status */ }
      }
      if (!replyText) replyText = 'Je n’ai pas réussi à préparer une réponse utile.';
      const traceId = entry.workId ? clientTurnId : crypto.randomUUID();
      const audit = await conversations[entry.workId ? 'settleTurn' : 'recordTurn']({
        traceId,
        ...(isLlmX ? { source: 'graphysx-llmx', origin: isOpening ? 'application_opening' : 'human', outcome: 'completed', applicationEvent: entry.applicationEvent || null } : {}),
        ...(sceneProposal ? { sceneProposal } : {}), ...(display.length ? { display: replyChannels.storedDisplay(display) } : {}),
        ...(clientTurnId ? { clientTurnId, interrupted: entry.interrupted } : {}),
        sessionId: session.sessionId,
        packId: pack.id,
        modeId: session.modeId,
        scopeId: session.scopeId,
        channel: req.body?.channel === 'voice' ? 'voice' : 'text',
        inputText: userText,
        attachments: entry.attachments,
        replyText: replyText,
        inputSha256: crypto.createHash('sha256').update(userText).digest('hex'),
        replySha256: crypto.createHash('sha256').update(replyText).digest('hex'),
        safetyFlags: safety.flagIds,
        parentAttention: safety.requiresParentAttention,
        soundId: sound?.id || '',
        model: metadata.model || '',
        hostKey: metadata.hostKey || '',
        routingSource: metadata.routingSource || '',
        routeTier,
        fallbackUsed,
        fallbackReason,
        knowledgeStatus: knowledge.status,
        knowledgeSourceCount: knowledge.sourceCount,
        knowledgeCorpusFingerprint: knowledge.corpusFingerprint,
        personalContinuity: continuity.personal || null, toolEvidence,
        speakerAgentId: speaker?.agentId || '',
        ...(speaker ? { speaker: { ...speaker, personaVersion: memberPersona?.version ?? null } } : {}),
        ...serverTimingsOf(serverPhases),
        durationMs: Date.now() - startedAt
      }, { sessionPatch: isOpening ? {
        'llmx.opening.status': 'completed', 'llmx.opening.completedAt': new Date(),
        'llmx.opening.traceId': traceId, 'llmx.opening.replyText': replyText
      } : {} });
      entry.auditWritten = true;
      entry.traceId = traceId;
      if (entry.workId) {
        if (routeTier === 'deterministic') await conversationWorks.handled(entry.workId);
        await conversationWorks.guardianSettled(entry.workId, 'completed');
      }
      if (!entry.workId && !isLlmX && (!preferencesFor || (await preferencesFor(pack.childSafe).read()).values.backgroundReview)) brain.schedule({ session, pack, traceId });
      entry.replyText = replyText;
      // The conversation's agent hears about a member's answer once, on its next turn.
      if (member) await conversations.updateSession({ sessionId: session.sessionId },
        { $set: { teamExchange: teamAddress.exchangeRecord(member, speaker.name, userText, replyText, { consulted: Boolean(consult) }) } });
      else if (session.teamExchange) await conversations.updateSession({ sessionId: session.sessionId }, { $unset: { teamExchange: '' } });
      if (entry.detached) {
        memberWork.finish(session.sessionId, clientTurnId, { traceId, text: speechText(replyText),
          language: spokenReplyLanguage(replyText, userText), speaker: audit.speaker, speech: audit.replySpeech });
        return undefined;
      }
      // #41: the conversation's agent asked for a member. Its turn starts once this one has ended;
      // the page collects the reply like a detached member turn and says it in the member's voice.
      let consulted = null;
      if (consultRequest && memberWork && !memberWork.active(session.sessionId).some(job => job.agentId === consultRequest.member.agentId)) {
        const persona = await teamPersona(consultRequest.member.agentId, runtimeServices.personas);
        const handoff = { ...consultRequest, turnId: crypto.randomUUID(), cancel: null };
        consulted = { turnId: handoff.turnId, speaker: { agentId: handoff.member.agentId, name: persona?.name || handoff.member.agentId } };
        memberWork.start(session.sessionId, handoff.turnId, { agentId: handoff.member.agentId, name: consulted.speaker.name,
          question: handoff.question, cancel: () => handoff.cancel?.() });
        const quiet = { on() {}, removeListener() {}, end() {}, write() {}, status() { return quiet; }, set() { return quiet; }, json() { return quiet; }, writableEnded: false, headersSent: false };
        void entry.finished.then(() => handle({ params: req.params, body: { channel: req.body?.channel }, consult: handoff }, quiet, access, requiredSession))
          .catch(error => logger?.error?.('Household consulted member turn failed', { error: error.message }))
          // A turn refused before it started settles here, so the page is not left waiting.
          .finally(() => memberWork.fail(session.sessionId, handoff.turnId, 'The consulted member did not answer.'));
      }
      const updated = await conversations.getSession({ sessionId: session.sessionId });
      const resultPayload = {
        traceId, speaker: audit.speaker, ...(consulted ? { consult: consulted } : {}),
        ...(isLlmX ? { origin: isOpening ? 'application_opening' : 'human', turnId: clientTurnId } : {}),
        ...(sceneProposal ? { sceneProposal } : {}), ...(display.length ? { display } : {}),
        session: publicSession(updated || session),
        pack: packSummary(pack),
        mode: modeSummary(pack.modes.find((entry) => entry.id === session.modeId) || pack.modes[0]),
        // The surface reads this aloud, so it is told which voice to use rather
        // than re-deriving it from the question and disagreeing with the text.
        reply: { text: req.body?.channel === 'voice' ? speechText(replyText) : replyText, language: spokenReplyLanguage(replyText, userText), speaker: audit.speaker,
          speech: audit.replySpeech },
        // Present only when a clip was selected; the browser may offer playback
        // once speech finishes, but this response is not a playback receipt.
        sound: sound ? { ...sound, play: 'after-reply' } : null,
        safety,
        model: { model: metadata.model || '', hostKey: metadata.hostKey || '' },
        routing: {
          source: metadata.routingSource || '',
          tier: routeTier,
          fallbackUsed,
          fallbackReason,
          hold: holdState
            ? {
                supported: holdState.supported,
                active: holdState.active,
                phase: holdState.phase,
                expiresAt: holdState.hold?.expiresAt || null
              }
            : null
        },
        knowledge: {
          status: knowledge.status,
          enabled: knowledge.enabled,
          used: knowledge.used,
          sourceCount: knowledge.sourceCount,
          corpusFingerprint: knowledge.corpusFingerprint
        },
        continuity, tools: toolEvidence,
        timings: { totalMs: Date.now() - startedAt },
        audit: { id: String(audit._id), traceId, createdAt: audit.createdAt }
      };
      if (streaming) { if (isOpening || (sceneEnabled && !sceneProposal)) event('delta', { delta: replyText }); event('done', { data: resultPayload }); return res.end(); }
      return envelope(res, resultPayload);
    } catch (error) {
      entry.error = abort.signal.aborted && !entry.dispatched ? null : error;
      if (entry.detached) {
        logger?.error?.('Household detached member turn failed', { error: error.message });
        memberWork.fail(req.params.sessionId, clientTurnId, error.message);
        return;
      }
      if (abort.signal.aborted) return;
      if (res.headersSent) { event('error', { message: error.message }); return res.end(); }
      logger?.error?.('Household persona turn failed', { error: error.message, ...(error.detail ? { detail: error.detail } : {}) });
      return fail(res, error.statusCode || 502, error.message || 'Voice persona turn failed', error.code || 'VOICE_PERSONA_INFERENCE_FAILED');
    } finally {
      try {
        if (entry.completion) { const error = await entry.completion; entry.error ||= error; }
        if ((entry.workId || (isOpening ? entry.openingReserved : entry.interrupted || (sceneEnabled && entry.dispatched))) && entry.snapshot && !entry.auditWritten) {
          const reply = sceneEnabled ? entry.naturalReply || '' : plainReply(entry.channels ? entry.channels.end().say : entry.generated, 5000);
          entry.traceId = entry.workId ? clientTurnId : crypto.randomUUID();
          await conversations[entry.workId ? 'settleTurn' : 'recordTurn']({
            ...entry.snapshot, traceId: entry.traceId, clientTurnId, interrupted: entry.interrupted,
            ...(isLlmX ? { source: 'graphysx-llmx', origin: isOpening ? 'application_opening' : 'human', outcome: abort.signal.aborted ? 'cancelled' : 'failed', applicationEvent: entry.applicationEvent || null } : {}),
            interruptionState: entry.error && !entry.executionSettled ? 'failed' : 'confirmed',
            channel: req.body?.channel === 'voice' ? 'voice' : 'text', inputText: userText, replyText: reply, ...(entry.channels?.end().display.length ? { display: replyChannels.storedDisplay(entry.channels.end().display) } : {}),
            attachments: entry.attachments,
            inputSha256: crypto.createHash('sha256').update(userText).digest('hex'),
            replySha256: crypto.createHash('sha256').update(reply).digest('hex'),
            ...entry.auditContext, durationMs: Date.now() - startedAt, ...(entry.workId ? { outcome: abort.signal.aborted ? 'cancelled' : 'failed' } : {})
          });
          if (entry.workId) await conversationWorks.guardianSettled(entry.workId, abort.signal.aborted ? 'cancelled' : 'failed');
        }
        if (entry.openingReserved && (!entry.auditWritten || entry.error || abort.signal.aborted)) {
          await conversations.updateSession({ sessionId: entry.snapshot.sessionId, 'llmx.opening.turnId': clientTurnId },
            { $set: { 'llmx.opening.status': abort.signal.aborted ? 'cancelled' : 'failed', 'llmx.opening.completedAt': new Date(),
              'llmx.opening.traceId': entry.traceId || null, 'llmx.opening.replyText': entry.replyText || plainReply(entry.generated, 5000), 'llmx.opening.reason': entry.humanFirst ? 'human_first' : entry.error?.code === 'LLMX_OPENING_INVALID' ? 'invalid_reply' : entry.error ? 'completion_unknown' : 'cancelled' } });
        }
      } catch (error) { entry.error = error; }
      finally {
        entry.markReady(null);
        // A detached turn already gave its place to the next turn.
        if (activePersonaTurns.get(req.params.sessionId) === entry) activePersonaTurns.delete(req.params.sessionId);
        if (entry.detached && abort.signal.aborted) memberWork.fail(req.params.sessionId, clientTurnId, 'cancelled');
        res.removeListener?.('close', disconnected);
        if (entry.interrupted && !res.writableEnded) res.end?.();
        entry.finish();
      }
    }
  };
  handle.openingInstructions = openingInstructions;
  return handle;
}

module.exports = { createPersonaTurnHandler, FAMILY_SURFACE_CONTRACT };
