// Native identity comes from the host hook, never the model's parameters.
const key = (context, id) => `${context.sessionKey}:${id}`;
const household = context => /^[a-z][a-z0-9_-]{0,63}$/.test(context?.agentId || '') && new RegExp(`^agent:${context.agentId}:household:direct:[a-f0-9-]{36}$`).test(context.sessionKey || '');
export function createConversationWorkClient({ baseUrl, token, fetchImpl = fetch }) {
  return async (operation, context, input, callId) => {
    const response = await fetchImpl(new URL('/api/voice-personas/native/work', baseUrl), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operation, context: { agentId: context.agentId,
        sessionKey: context.sessionKey, runId: context.runId }, ...(input && { input }), ...(callId && { callId }) })
    });
    const body = await response.json();
    if (!response.ok || body.ok !== true || body.data?.authority !== 'core.conversation-works') {
      throw Object.assign(new Error(body.message || 'Conversation work unavailable; do not replay the request.'), { statusCode: response.status, code: body.code });
    }
    return body.data;
  };
}
export function registerConversationWork(api, { fetchImpl = fetch } = {}) {
  const config = api.pluginConfig || {};
  if (!config.conversationWorkToken || !/^[a-z][a-z0-9_-]{0,63}$/.test(config.conversationWorkAgentId || '')
      || ['main', 'family'].includes(config.conversationWorkAgentId)) return;
  const nativeCalls = new Map();
  const call = createConversationWorkClient({ baseUrl: config.agentxUrl, token: config.conversationWorkToken, fetchImpl });
  api.on('before_tool_call', async (event, context) => {
    if (!household(context)) return;
    const id = event.toolCallId || context.toolCallId, runId = event.runId || context.runId;
    const name = event.toolName === 'tool_call' ? String(event.params?.id || '').split(':').at(-1) : event.toolName;
    const native = { ...context, runId };
    if (name === 'conversation_work' && id && runId) {
      nativeCalls.set(key(context, id), native);
      if (nativeCalls.size > 1000) nativeCalls.delete(nativeCalls.keys().next().value);
    }
    const taskLookup = ['list_personal_tasks', 'agentx__list_personal_tasks', 'personal_briefing',
      'agentx__personal_briefing', 'nestor_briefing'].includes(name)
      || name === 'nestor_context' && (event.toolName === 'tool_call' ? event.params?.args : event.params)?.includeTasks === true;
    if (context.agentId !== 'main' || !taskLookup) return;
    try {
      const work = await call('request', native);
      return { block: true, blockReason: `Core has already accepted this lookup in work ${work.id}, execution ${work.execution}. Acknowledge this actual saved status and continue the conversation. If an explicit native acceptance receipt is needed, call tool_call with exactly {"id":"openclaw:super-dad-memory:conversation_work","args":{"operation":"request"}}. This is not task data or a completed lookup.` };
    } catch (cause) {
      if (cause.statusCode === 404 || cause.statusCode === 409 && cause.code === 'CONVERSATION_WORK_OBSERVE_ONLY') return;
      return { block: true, blockReason: 'The durable work owner cannot be reached. No task lookup or replacement dispatch was performed.' };
    }
  });
  api.on('after_tool_call', (event, context) => nativeCalls.delete(key(context, event.toolCallId || context.toolCallId)));
  api.registerTool(context => {
    if (!household(context) || !['main', config.conversationWorkAgentId].includes(context.agentId)) return null;
    const worker = context.agentId === config.conversationWorkAgentId;
    return { name: 'conversation_work', label: 'Nestor Conversation Work',
      description: worker
        ? 'Core owns your durable work. context reads the complete canonical request, selected context and verified receipt references. tasks reads current personal tasks (read-only). publish commits an answer, correction, clarification or no_work disposition with its exact receiptIds before your native run ends. You have no business mutations. The owner continues talking with Nestor meanwhile.'
        : 'Accept the current personal task lookup as a durable background work in Core. Returns an accepted-work receipt, never task data or completed actions. End this turn with a short acknowledgment and keep talking; Household retrieves and speaks the worker result at a pause. Only the current host-bound personal turn is eligible.',
      parameters: worker ? { type: 'object', properties: {
        operation: { type: 'string', enum: worker ? ['context', 'tasks', 'publish'] : ['request'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 }, includeDone: { type: 'boolean' },
        kind: { type: 'string', enum: ['answer', 'correction', 'clarification', 'no_work'] },
        text: { type: 'string', maxLength: 16000 },
        receiptIds: { type: 'array', items: { type: 'string', pattern: '^[a-f0-9]{64}$' }, maxItems: 16 }
      }, required: ['operation'], additionalProperties: false }
        : { type: 'object', properties: { operation: { type: 'string', enum: ['request'] } }, required: ['operation'], additionalProperties: false },
      async execute(id, params) {
        const native = nativeCalls.get(key(context, id));
        if (!native?.runId || native.agentId !== context.agentId || native.sessionKey !== context.sessionKey) throw new Error('The native tool-call binding is unavailable. No operation was dispatched.');
        if ((worker && params.operation === 'request') || (!worker && params.operation !== 'request')) throw new Error('The selected native role cannot perform this operation.');
        const input = params.operation === 'tasks' ? Object.fromEntries(['limit', 'includeDone'].filter(k => params[k] !== undefined).map(k => [k, params[k]]))
          : params.operation === 'publish' ? { kind: params.kind, text: params.text, receiptIds: params.receiptIds } : undefined;
        const result = await call(params.operation, native, input, id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } };
  }, { name: 'conversation_work', optional: true });
}
