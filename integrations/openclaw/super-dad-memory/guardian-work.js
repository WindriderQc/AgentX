// Only the exact Core-bound guardian loses execution of already delegated work.
// Complete Main, text turns and legacy work keep their installed tool scopes.
export function createGuardianWorkGuard(call, guardianAgentId) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(guardianAgentId || '') || ['main', 'family'].includes(guardianAgentId)) guardianAgentId = undefined;
  const runs = new Map();
  const remember = (key, value) => {
    runs.set(key, value);
    if (runs.size > 1000) runs.delete(runs.keys().next().value);
  };
  return async native => {
    if (guardianAgentId && native.agentId === guardianAgentId) return { block: true,
      blockReason: 'The dedicated conversational guardian has no tools. Core retains the complete request for native Main; continue the conversation from the supplied context.' };
    if (native.agentId !== 'main' || !/^resp_[a-f0-9-]{36}$/.test(native.runId || '')) return;
    const key = `${native.sessionKey}:${native.runId}`;
    if (runs.get(key) === 'ordinary') return;
    try {
      const work = await call('guardian_tool', native);
      if (work.delegated !== true) throw new Error('Invalid guardian work observation');
      remember(key, 'guardian');
      return { block: true, blockReason: `Core owns the requested work ${work.id}, execution ${work.execution}, through complete native Main. No tool was executed by the conversational guardian. Continue the conversation from its shared context and actual status. Do not redispatch, claim completion, narrate thinking, or say Nestor lacks Main’s or a specialist’s tools.` };
    } catch (cause) {
      if (runs.get(key) !== 'guardian' && (cause.statusCode === 404
          || cause.statusCode === 400 && cause.code === 'CONVERSATION_WORK_OPERATION_INVALID')) {
        remember(key, 'ordinary'); return;
      }
      return { block: true, blockReason: 'Core could not verify the already delegated guardian work. No tool was executed. Continue the conversation without a replacement dispatch or an invented result.' };
    }
  };
}
