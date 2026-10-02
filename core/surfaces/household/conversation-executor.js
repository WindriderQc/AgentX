'use strict';

const { readReplyStream } = require('./persona-catalog');
const { conversationInput } = require('./llmx-conversation');
const interactivePriority = require('../../src/services/interactivePriorityService');

const HOST_BUSY_CODES = new Set(['BENCHMARK_CLAIM_ACTIVE', 'RUNTIME_INFERENCE_ADMISSION_DENIED']);

function configuredOpenClaw(env = process.env) {
  return Boolean(env.OPENCLAW_GATEWAY_URL && env.OPENCLAW_GATEWAY_TOKEN);
}

function conversationBackend(requested, env = process.env) {
  const backend = requested || env.HOUSEHOLD_CONVERSATION_BACKEND || 'auto';
  if (!['auto', 'openclaw', 'agentx'].includes(backend)) {
    throw Object.assign(new Error('Choose auto, openclaw or agentx for the conversation engine.'), { statusCode: 400 });
  }
  return backend === 'auto' ? configuredOpenClaw(env) ? 'openclaw' : 'agentx' : backend;
}

// These are transports, not two agent loops. OpenClaw runs its native agent;
// AgentX runs the existing routed inference contract. A started turn is never
// replayed through the other transport, including after an ambiguous failure.
function createConversationExecutor({ agentClient, inference, consumerContract }) {
  const run = runTurn({ agentClient, inference, consumerContract });
  // A household turn outranks evaluation work (#62). If the host stayed
  // reserved past the bounded wait, say so plainly instead of a generic error.
  return async request => {
    const startedAt = Date.now();
    const endTurn = interactivePriority.beginHouseholdTurn();
    const stopWaiting = interactivePriority.onWaiting(info => request.onWaiting?.(info));
    try {
      return await run(request);
    } catch (error) {
      if (interactivePriority.busySince(startedAt) || HOST_BUSY_CODES.has(error.code)) {
        throw interactivePriority.householdBusyError(error);
      }
      throw error;
    } finally {
      stopWaiting();
      endTurn();
    }
  };
}

function runTurn({ agentClient, inference, consumerContract }) {
  return async request => {
    const { backend, session, pack, history, instructions, agentxInstructions, signal, onDelta } = request;
    const messages = [...history, { role: 'user', content: conversationInput(request), attachments: request.attachments || [] }];
    const prepared = request.attachmentStore ? await request.attachmentStore.prepare(messages, backend) : messages;
    if (backend === 'openclaw') {
      const current = prepared.at(-1);
      // Native sessions keep their own dialogue, while Core rehydrates the
      // bounded attachment context explicitly on subsequent turns.
      const earlier = session.agentSessionKey ? prepared.slice(0, -1).flatMap(message => message.attachmentContent || []) : [];
      const currentContent = earlier.length ? [{ type: 'input_text', text: 'Earlier attachments from this conversation (reference data):' },
        ...earlier, ...(Array.isArray(current.content) ? current.content : [{ type: 'input_text', text: current.content }])] : current.content;
      return { ...await agentClient({ ...request, instructions, history: prepared.slice(0, -1), currentContent }), backend };
    }
    const result = await inference.execute({
      mode: 'chat', taskType: pack.taskType,
      ...(request.model ? { model: request.model.replace(/^ollama\//, '') } : {}),
      ...(request.openTarget ? { exclusiveHost: true, options: { num_ctx: request.openTarget.numCtx } } : {}),
      messages: [{ role: 'system', content: agentxInstructions }, ...prepared.map(({ attachments, ...message }) => message)],
      stream: request.streaming, think: false, temperature: pack.temperature, max_tokens: pack.maxTokens,
      callerDetail: `agentx-household/${pack.id}/${session.modeId}`, timeoutMs: 600000
    }, { signal, consumerContract, ...(request.openTarget ? { hostUrl: request.openTarget.hostUrl } : {}) });
    if (!result?.ok) {
      const error = result?.body?.error;
      throw Object.assign(new Error((typeof error === 'string' ? error : error?.message) || 'AgentX inference failed'), { statusCode: result?.status || 502 });
    }
    let streamed = '';
    try {
      if (result.stream) streamed = await readReplyStream(result.stream, onDelta, signal);
    } finally {
      if (result.stream) {
        if (!result.completion?.then) throw new Error('Core does not expose verified stream completion. Update the paired Product release.');
        await result.completion;
      }
    }
    return { backend, text: streamed || result.body?.message?.content || result.body?.response || result.body?.choices?.[0]?.message?.content || '',
      metadata: result.metadata || {},
      tools: { status: 'not_supported', authority: 'agentx/ollama', receipts: [],
        reason: 'This inference backend uses supplied context; native agent tools, skills and Dreaming are not running.' } };
  };
}

module.exports = { configuredOpenClaw, conversationBackend, createConversationExecutor };
