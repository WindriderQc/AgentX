'use strict';

const { readReplyFrames } = require('./persona-catalog');
const { sumUsage } = require('../../src/services/conversations/turnAccounting');
const { fingerprint } = require('../../src/services/conversations/relayContext');

// Router task of a spoken turn on Core inference; typed turns keep the pack's task.
function voiceTask(env = process.env) {
  const value = String(env.HOUSEHOLD_VOICE_TASK || '').trim();
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'voice_persona_chat';
}

// The relay keeps the canonical child/mode policy and read-only reply format.
// Principal-only tools, navigation and image actions are not relay capabilities.
function familyRelayInstructions(session, pack) {
  return [require('./family-clock').familyIdentity(session.persona),
    require('./persona-prompt').systemPromptFor(pack, { modeId: session.modeId }),
    require('./reply-channels').contract({ family: true, math: false, pages: false })].join('\n\n');
}

async function runLocalConversation({ request, prepared, inference, consumerContract, env }) {
  const { backend, session, pack, signal, onDelta, agentxInstructions } = request;
  // A spoken turn takes the instance's voice lane, in any pack. LLMx scene
  // conversations keep their pack's task: they need its structured replies.
  const taskType = request.channel === 'voice' && !session.llmx ? voiceTask(env) : pack.taskType;
  // Famille may call the Core tools the instance turned on: the model's tool
  // calls run through Core's handlers, then the model answers from their
  // results. Without a tool call the first reply streams as before.
  const toolset = request.familyTools || null;
  const receipts = [];
  let conversation = [{ role: 'system', content: agentxInstructions }, ...prepared.map(({ attachments, ...message }) => message)];
  let result, streamed = '', toolCalls = [], toolsOffered = Boolean(toolset), rounds = 0;
  let relay = null, relaySource = null, emittedModelChars = 0;
  const fragment = () => ({ ...relaySource, completed: false,
    fragment: { observation: 'reply_parser_input', modelChars: emittedModelChars, playback: 'unverified' } });
  const emit = delta => {
    onDelta?.(delta);
    if (relaySource && delta && typeof onDelta === 'function') {
      emittedModelChars += delta.length;
      request.onRelayProgress?.(fragment());
    }
  };
  // Measured counts of every call this reply made, summed into the turn.
  const callUsage = [];
  for (;;) {
    const offerTools = toolsOffered && rounds < toolset.maxRounds;
    const execute = async (withTools) => {
      const body = {
        mode: 'chat', taskType,
        ...(request.model ? { model: request.model.replace(/^ollama\//, '') } : {}),
        ...(request.openTarget ? { exclusiveHost: true, options: { num_ctx: request.openTarget.numCtx } } : {}),
        messages: conversation, ...(withTools ? { tools: toolset.definitions } : {}),
        stream: request.streaming, think: false, temperature: pack.temperature, max_tokens: pack.maxTokens,
        callerDetail: `agentx-household/${pack.id}/${session.modeId}`, timeoutMs: 600000
      };
      const options = { signal, consumerContract, ...(session.ephemeral ? { contentRetention: 'ephemeral' } : {}), ...(request.openTarget ? { hostUrl: request.openTarget.hostUrl } : {}) };
      const eligible = env.HOUSEHOLD_CONVERSATION_RELAY_ENABLED === 'true' && !session.ephemeral && !session.llmx && !request.openTarget
        && !rounds && !receipts.length && (pack.childSafe && session.packId === 'kidx_nestor' || request.relayOccupation);
      if (request.relayOccupation && request.attachments?.length) return require('../../src/services/routing/conversationContinuityContext')
        .statusResult(body, 'Le relais sans outils ne peut pas analyser ces pièces jointes. La demande native d’origine est conservée.', 'relay_attachments_unavailable');
      if (eligible && inference.conversation) {
        const continued = await inference.conversation({ ...body, ...(request.relayOccupation ? { model: 'agentx-primary' } : {}) }, {
          ...options, taskRoute: !request.relayOccupation, requireOccupied: true,
          ...(request.relayOccupation ? { observeOccupation: request.relayOccupation } : { familyInstructions: [familyRelayInstructions(session, pack), request.familyWeatherContext].filter(Boolean).join('\n\n') }),
          relayRequest: { ...body, messages: [...(request.history || []), { role: 'user', content: request.text }] }
        });
        if (continued) return continued;
      }
      if (request.relayOccupation) return require('../../src/services/routing/conversationContinuityContext')
        .statusResult(body, 'Le relais local n’est pas disponible; la demande native d’origine est conservée.', 'relay_unavailable');
      return inference.execute(body, options);
    };
    result = await execute(offerTools);
    if (result?.metadata?.conversationContinuity?.state === 'backup') {
      toolsOffered = false;
      relay = result.metadata.conversationContinuity;
      relaySource = { authority: 'core.conversation-continuity', role: 'relay', model: relay.model, hostKey: relay.hostKey,
        requestSha256: fingerprint(request.text), ...(relay.relayFor && { relayFor: relay.relayFor }) };
    }
    if (result?.metadata?.conversationContinuity?.state === 'status_only') toolsOffered = false;
    // A model whose runtime refuses tools answers the turn without them.
    if (offerTools && !result?.ok && /does not support tools/i.test(JSON.stringify(result?.body?.error || ''))) {
      toolsOffered = false;
      result = await execute(false);
    }
    if (!result?.ok) {
      const error = result?.body?.error;
      throw Object.assign(new Error((typeof error === 'string' ? error : error?.message) || 'AgentX inference failed'), { statusCode: result?.status || 502 });
    }
    request.onExecution?.({ model: result.metadata?.model || '', backend: 'agentx', continuity: result.metadata?.conversationContinuity || null });
    let frames = { text: '', toolCalls: [] };
    if (result.stream && result.conversationNotice) { streamed += result.conversationNotice + '\n\n'; onDelta?.(result.conversationNotice + '\n\n'); }
    try {
      if (result.stream) frames = await readReplyFrames(result.stream, emit, signal);
    } finally {
      if (result.stream) {
        if (!result.completion?.then) throw new Error('Core does not expose verified stream completion. Update the paired Product release.');
        callUsage.push(await result.completion);
      }
    }
    if (!result.stream) callUsage.push(result.body);
    const message = result.body?.message;
    const text = frames.text || message?.content || result.body?.response || result.body?.choices?.[0]?.message?.content || '';
    streamed += text;
    toolCalls = result.stream ? frames.toolCalls : (Array.isArray(message?.tool_calls) ? message.tool_calls : []);
    if (!offerTools || !toolsOffered || !toolCalls.length || signal?.aborted) break;
    rounds += 1;
    const calls = toolCalls.slice(0, toolset.maxCallsPerRound);
    conversation = [...conversation, { role: 'assistant', content: text, tool_calls: calls }];
    for (const call of calls) {
      const answered = await toolset.execute(call);
      receipts.push(answered.receipt);
      conversation.push(answered.message);
    }
  }
  if (signal?.aborted) relay = null;
  return { backend, text: streamed,
    metadata: { ...(result.metadata || {}), ...(toolset ? { toolRounds: rounds } : {}), usage: sumUsage(callUsage) },
    tools: relay ? { status: 'not_supported', authority: 'agentx/ollama', receipts: [], conversationRelay: { ...relaySource, completed: true } }
      : relaySource && emittedModelChars > 0 ? { status: 'partial', authority: 'agentx/ollama', receipts: [], conversationRelay: fragment() }
      : toolset && toolsOffered
      ? { status: 'observed', authority: 'agentx/core', offered: toolset.names, receipts }
      : { status: 'not_supported', authority: 'agentx/ollama', receipts: [],
        reason: toolset ? 'The selected model runtime does not accept tools; the turn used supplied context only.'
          : 'This inference backend uses supplied context; native agent tools, skills and Dreaming are not running.' } };
}
module.exports = { runLocalConversation, voiceTask };
