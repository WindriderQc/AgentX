'use strict';

const spoken = require('./spoken-consultation');
const { readReplyFrames, replyLimitError } = require('./persona-catalog');
const { sumUsage } = require('../../src/services/conversations/turnAccounting');
const { fingerprint } = require('../../src/services/conversations/relayContext');

// Router task of a spoken turn on Core inference; typed turns keep the pack's task.
function voiceTask(env = process.env) {
  const value = String(env.HOUSEHOLD_VOICE_TASK || '').trim();
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'voice_persona_chat';
}

// The relay keeps the canonical child/mode policy and read-only reply format.
// Principal-only tools, navigation and image actions are not relay capabilities.
function familyRelayInstructions(session, pack, env) {
  return [require('./family-clock').familyIdentity(session.persona),
    require('./persona-prompt').systemPromptFor(pack, { modeId: session.modeId, readOnlyRelay: true }),
    require('./family-clock').familyClockContext({ timeZone: env?.PLANNING_TIME_ZONE }),
    require('./reply-channels').contract({ family: true, math: false, pages: false })].join('\n\n');
}

function relayOptions(request, env, body, taskRequiresPrimary, usePrincipal = false) {
  const familyInstructions = request.pack.childSafe && [
    familyRelayInstructions(request.session, request.pack, env),
    request.preparedRelayContext || request.relayForecastContext || (request.guardianTools?.names.includes('weather') ? '' : request.familyWeatherContext)
  ].filter(Boolean).join('\n\n');
  return {
    speechLanguage: request.speechLanguage,
    relayPresentation: [!request.pack.childSafe && require('./packs').PERSONAL_STYLE,
      require('./persona-prompt').replyLanguageDirective(request.text, request.speechLanguage, request.automaticLanguage)].filter(Boolean).join(' '),
    relayGreeting: env[request.speechLanguage === 'en' ? 'HOUSEHOLD_RELAY_GREETING_EN' : 'HOUSEHOLD_RELAY_GREETING_FR'],
    taskRoute: !usePrincipal && !request.relayOccupation, requireOccupied: true, relayTools: request.guardianTools,
    allowUnavailable: !request.relayOccupation && request.pack.childSafe, requiresFamilyPrimary: taskRequiresPrimary,
    ...(env.HOUSEHOLD_PRIMARY_RELEASE_GRACE_ENABLED === 'true' && !request.relayOccupation && request.streaming === true && request.channel === 'voice'
      && request.session.packId === 'kidx_nestor' && request.session.scopeId === 'family' && request.pack.childSafe && {
      familyPrimaryPreference: { enabled: true, surface: 'family', backend: request.backend, channel: request.channel,
        windowMs: Number(env.HOUSEHOLD_PRIMARY_RELEASE_GRACE_MS) || 1500 },
      onPrimaryWait: () => request.onWaiting?.({ reason: 'primary_active' })
    }),
    ...(request.relayOccupation && { observeOccupation: request.relayOccupation }),
    ...(familyInstructions && { familyInstructions }),
    ...(usePrincipal && { relayHostKey: env.HOUSEHOLD_SPOKEN_RELAY_HOST }),
    relayRequest: { ...body, messages: usePrincipal ? body.messages.slice(1) : [...(request.history || []), { role: 'user', content: request.text }] }
  };
}

async function runLocalConversation({ request, prepared, inference, consumerContract, env }) {
  const { backend, session, pack, signal, onDelta, agentxInstructions } = request;
  // A spoken turn takes the instance's voice lane, in any pack. LLMx scene
  // conversations keep their pack's task: they need its structured replies.
  const taskType = request.channel === 'voice' && !session.llmx ? voiceTask(env) : pack.taskType;
  let thinker = null, frontUsage = null, pendingRelay = null;
  if (request.spoken) {
    const decision = await spoken.decide(request, inference, consumerContract, env, spoken.pinned, async body => {
      if (env.HOUSEHOLD_CONVERSATION_RELAY_ENABLED !== 'true' || !inference.conversation) return null;
      return inference.conversation(body, { signal, consumerContract, ...relayOptions(request, env, body, false, true) });
    });
    frontUsage = decision.body;
    if (decision.mode === 'parler') {
      onDelta?.(decision.texte);
      return { backend, text: decision.texte, metadata: { ...decision.metadata, usage: sumUsage([frontUsage]) },
        tools: { status: 'observed', authority: 'agentx/core', offered: [], receipts: [], spokenDialogue: 'direct' } };
    }
    if (decision.mode === 'relay') pendingRelay = decision.result;
    else {
      thinker = await spoken.pinned(env.HOUSEHOLD_THINKER_HOST);
      request.spoken.consulting();
    }
  }
  // Famille may call the Core tools the instance turned on: the model's tool
  // calls run through Core's handlers, then the model answers from their
  // results. Without a tool call the first reply streams as before.
  let toolset = request.familyTools || (thinker && request.spoken.personalReads) || null;
  const receipts = [];
  const taskRequiresPrimary = request.requiresFamilyPrimary === true && backend === 'agentx' && pack.childSafe
    && session.packId === 'kidx_nestor' && session.scopeId === 'family' && request.channel === 'voice';
  const instructions = thinker && request.spoken.personalReads ? agentxInstructions + '\nOnly the listed Core read tools are available. Base current task and calendar answers on their receipts.' : agentxInstructions;
  let conversation = [{ role: 'system', content: instructions }, ...prepared.map(({ attachments, ...message }) => message)];
  let result, streamed = '', toolCalls = [], toolsOffered = Boolean(toolset), rounds = 0;
  let relay = null, relaySource = null, emittedModelChars = 0, relayContinuation = null, relayEndReason = null;
  const fragment = () => ({ ...relaySource, completed: false,
    fragment: { observation: 'reply_parser_input', modelChars: emittedModelChars, playback: 'unverified' } });
  let emittedText = false;
  const emit = delta => {
    if (delta) emittedText = true;
    onDelta?.(delta);
    if (relaySource && delta && typeof onDelta === 'function') {
      emittedModelChars += delta.length;
      request.onRelayProgress?.(fragment());
    }
  };
  const settleChangedOccupation = error => {
    if (backend !== 'agentx' || session.packId !== 'kidx_nestor' || session.scopeId !== 'family'
        || !relayContinuation || !relaySource || signal?.aborted || error?.code !== 'RELAY_OCCUPATION_CHANGED') return false;
    const notice = '\n\nLe relais s’arrête ici : l’occupation de Nestor n’est plus confirmée. Cette réponse n’est pas terminée et aucune lecture supplémentaire n’a été lancée.';
    relayEndReason = 'occupation_changed';
    streamed += notice;
    emit(notice);
    return true;
  };
  // Measured counts of every call this reply made, summed into the turn.
  const callUsage = frontUsage ? [frontUsage] : [];
  for (;;) {
    const offerTools = toolsOffered && rounds < toolset.maxRounds;
    const execute = async (withTools) => {
      if (relayContinuation) return relayContinuation.execute(conversation, withTools ? toolset.definitions : undefined, { announce: rounds === 0 });
      const body = {
        mode: 'chat', taskType: thinker ? 'deep_reasoning' : taskType,
        ...(request.model ? { model: request.model.replace(/^ollama\//, '') } : {}),
        ...(request.openTarget ? { exclusiveHost: true, options: { num_ctx: request.openTarget.numCtx } } : {}),
        messages: conversation, ...(withTools ? { tools: toolset.definitions } : {}),
        stream: request.streaming, ...(thinker ? { model: thinker.model, thinkingMode: 'auto' } : { think: false }), temperature: pack.temperature,
        max_tokens: thinker ? Math.max(4096, pack.maxTokens) : pack.maxTokens,
        callerDetail: thinker ? 'agentx-household/local-consultation' : `agentx-household/${pack.id}/${session.modeId}`, timeoutMs: 600000
      };
      const options = { signal, consumerContract, ...(thinker && { hostUrl: thinker.hostUrl, retry: { enabled: false } }), ...(session.ephemeral ? { contentRetention: 'ephemeral' } : {}), ...(request.openTarget ? { hostUrl: request.openTarget.hostUrl } : {}) };
      const eligible = !thinker && env.HOUSEHOLD_CONVERSATION_RELAY_ENABLED === 'true' && !session.ephemeral && !session.llmx && !request.openTarget
        && !rounds && !receipts.length && (pack.childSafe && session.packId === 'kidx_nestor' || request.relayOccupation);
      if (request.relayOccupation && request.attachments?.length) return require('../../src/services/routing/conversationContinuityContext')
        .statusResult(body, 'Le relais sans outils ne peut pas analyser ces pièces jointes. La demande native d’origine est conservée.', 'relay_attachments_unavailable');
      if (eligible && inference.conversation) {
        const continued = await inference.conversation({ ...body, ...(request.relayOccupation ? { model: 'agentx-primary' } : {}) }, {
          ...options, ...relayOptions(request, env, body, taskRequiresPrimary)
        });
        if (continued) return continued;
      }
      if (taskRequiresPrimary) return require('../../src/services/routing/conversationContinuityContext')
        .statusResult(body, 'La voie principale Famille ne peut pas être vérifiée.', 'family_primary_required');
      if (request.relayOccupation) return require('../../src/services/routing/conversationContinuityContext')
        .statusResult(body, 'Le relais local n’est pas disponible; la demande native d’origine est conservée.', 'relay_unavailable');
      return inference.execute(body, options);
    };
    try {
      result = pendingRelay || await execute(offerTools);
      pendingRelay = null;
    } catch (error) {
      if (!settleChangedOccupation(error)) throw error;
      break;
    }
    if (result?.metadata?.conversationContinuity?.state === 'backup' && !relayContinuation) {
      relayContinuation = result.relayContinuation || null;
      toolset = relayContinuation ? request.guardianTools : null;
      toolsOffered = Boolean(toolset);
      if (relayContinuation) conversation = relayContinuation.messages;
      relay = result.metadata.conversationContinuity;
      relaySource = { authority: 'core.conversation-continuity', role: 'relay', model: relay.model, hostKey: relay.hostKey,
        requestSha256: fingerprint(request.text), ...(relay.relayFor && { relayFor: relay.relayFor }),
        ...(relay.handoffCategory && { handoffCategory: relay.handoffCategory }), ...(relay.primaryRefusal && { primaryRefusal: relay.primaryRefusal }) };
    }
    if (result?.metadata?.conversationContinuity?.state === 'status_only') toolsOffered = false;
    // A model whose runtime refuses tools answers the turn without them.
    if (!thinker && toolsOffered && !result?.ok && /does not support tools/i.test(JSON.stringify(result?.body?.error || ''))) {
      toolsOffered = false;
      if (toolset.names.includes('family_kitchen_timer')) {
        conversation = [{ ...conversation[0], content: conversation[0].content
          + '\nThe inference runtime refused tools on this turn. Ignore earlier tool-availability instructions. No timer action or live status is confirmed. State this limitation if asked about the kitchen timer.' }, ...conversation.slice(1)];
      }
      try { result = await execute(false); }
      catch (error) {
        if (!settleChangedOccupation(error)) throw error;
        break;
      }
    }
    if (!result?.ok) {
      const error = result?.body?.error;
      throw Object.assign(new Error((typeof error === 'string' ? error : error?.message) || 'AgentX inference failed'), { statusCode: result?.status || 502 });
    }
    request.onExecution?.({ model: result.metadata?.model || '', backend: 'agentx', continuity: result.metadata?.conversationContinuity || null });
    const finishSoundAnswer = Boolean(streamed.trim() && receipts.some(row => row.tool === 'get_sound'));
    let frames = { text: '', toolCalls: [] };
    if (result.stream && result.conversationNotice) { streamed += result.conversationNotice + '\n\n'; onDelta?.(result.conversationNotice + '\n\n'); }
    try {
      if (result.stream) frames = await readReplyFrames(result.stream, finishSoundAnswer ? () => {} : emit, signal);
    } finally {
      if (result.stream) {
        if (!result.completion?.then) throw new Error('Core does not expose verified stream completion. Update the paired Product release.');
        callUsage.push(await result.completion);
      }
    }
    if (!result.stream) {
      if (result.body?.done_reason === 'length') throw replyLimitError();
      callUsage.push(result.body);
    }
    const message = result.body?.message;
    const text = frames.text || message?.content || result.body?.response || result.body?.choices?.[0]?.message?.content || '';
    if (finishSoundAnswer) {
      // A model can explain before its tool call and repeat that explanation
      // after it. Preserve what the listener already received exactly once.
      const extra = text.trim() === streamed.trim() || !text.trim() ? ''
        : text.startsWith(streamed) ? text.slice(streamed.length) : '\n\n' + text;
      streamed += extra;
      if (emittedText && extra) emit(extra);
    } else streamed += text;
    toolCalls = result.stream ? frames.toolCalls : (Array.isArray(message?.tool_calls) ? message.tool_calls : []);
    if (!toolsOffered || !toolCalls.length || signal?.aborted || rounds >= toolset.maxRounds) break;
    rounds += 1;
    const calls = toolCalls.slice(0, toolset.maxCallsPerRound);
    conversation = [...conversation, { role: 'assistant', content: text, tool_calls: calls }];
    for (const call of calls) {
      try { if (relayContinuation) await relayContinuation.assertOccupied(); }
      catch (error) {
        if (!settleChangedOccupation(error)) throw error;
        break;
      }
      const answered = await toolset.execute(call, { signal });
      if (answered.receipt) receipts.push(answered.receipt);
      conversation.push(answered.message);
    }
    if (relayEndReason) break;
  }
  if (signal?.aborted) relay = null;
  else if (!streamed.trim() && receipts.some(receipt => receipt.tool === 'artx_present' && receipt.status === 'failed')) {
    // A completed tools-only exchange has no model answer to speak. Its
    // truthful fallback must pass through normal voice/written projection.
    streamed = request.speechLanguage === 'en' ? 'I couldn’t complete the display request.'
      : 'Je n’ai pas pu terminer la demande d’affichage.';
    onDelta?.(streamed);
  }
  const tools = result.metadata?.conversationContinuity?.state === 'status_only'

      ? { status: 'not_run', authority: 'agentx/core', receipts: [], reason: 'automatic_service_notice',
        conversationContinuity: result.metadata.conversationContinuity }
      : relayEndReason ? { status: 'partial', authority: 'agentx/core', receipts,
        conversationRelay: { ...fragment(), reason: relayEndReason } }
      : relay ? { status: toolset && toolsOffered ? 'observed' : 'not_supported', authority: toolset && toolsOffered ? 'agentx/core' : 'agentx/ollama', receipts, ...(toolset && toolsOffered ? { offered: toolset.names } : {}),
      ...(toolset && !toolsOffered ? { reason: 'The selected relay runtime does not accept tools; the same guardian answered from supplied context only.' } : {}), conversationRelay: { ...relaySource, completed: true } }
      : relaySource && emittedModelChars > 0 ? { status: 'partial', authority: 'agentx/ollama', receipts: [], conversationRelay: fragment() }
      : toolset && toolsOffered
      ? { status: 'observed', authority: 'agentx/core', offered: toolset.names, receipts }
      : { status: 'not_supported', authority: 'agentx/ollama', receipts: [],
        reason: toolset ? 'The selected model runtime does not accept tools; the turn used supplied context only.'
          : 'This inference backend uses supplied context; native agent tools, skills and Dreaming are not running.' };
  return { backend, text: streamed, tools: thinker ? { ...tools, spokenDialogue: 'consulted' } : tools,
    metadata: { ...(result.metadata || {}), ...(toolset ? { toolRounds: rounds } : {}), usage: sumUsage(callUsage) } };
}
module.exports = { runLocalConversation, voiceTask };
