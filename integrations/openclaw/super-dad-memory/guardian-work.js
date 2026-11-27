// Only the exact Core-bound guardian loses execution of already delegated work.
// Complete Main, text turns and legacy work keep their installed tool scopes.
import { isDelegationTool } from '../../../shared/nativeDelegation.cjs';

function foregroundTool(event, native, localForeground) {
  const wrapped = event.toolName === 'tool_call';
  const id = wrapped ? event.params?.id : event.toolName;
  const tool = typeof id === 'string' ? id.replace(/^openclaw:core:/, '') : '';
  if (!isDelegationTool(tool)) return;
  const args = wrapped ? event.params?.args : event.params;
  if (tool === 'sessions_spawn') {
    if (!args?.agentId || args.context !== 'isolated'
        || args.visible !== undefined && args.visible !== false
        || args.runtime && args.runtime !== 'subagent'
        || args.mode && args.mode !== 'run' || Object.keys(args).some(k =>
          !['agentId', 'task', 'context', 'visible', 'mode', 'runtime', 'label', 'runTimeoutSeconds', 'timeoutSeconds'].includes(k))) return;
    if (localForeground?.(native, args.agentId)) return tool;
  } else if (localForeground?.(native)) return tool;
}

export function createGuardianWorkGuard(call, guardianAgentId, localForeground) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(guardianAgentId || '') || ['main', 'family'].includes(guardianAgentId)) guardianAgentId = undefined;
  const runs = new Map();
  const remember = (key, value) => {
    runs.set(key, value);
    if (runs.size > 1000) runs.delete(runs.keys().next().value);
  };
  return async (native, event = {}) => {
    if (guardianAgentId && native.agentId === guardianAgentId) {
      const wrapped = event.toolName === 'tool_call';
      const params = wrapped ? event.params?.args : event.params;
      const transport = event.toolName === 'conversation_work' || wrapped
        && /^(?:openclaw|plugin):super-dad-memory:conversation_work$/.test(event.params?.id || '');
      if (transport && ['guardian_tools', 'guardian_read'].includes(params?.operation)) {
        try {
          const work = await call('guardian_tool', native);
          if (work.delegated === true) return;
        } catch { /* An unknown native binding never grants a read. */ }
      }
      return { block: true, blockReason: 'The dedicated guardian can only use Core conversation_work guardian_tools and guardian_read under the server read allowlist. Core retains complete Main work. No other tool or replacement dispatch was executed.' };
    }
    if (native.agentId !== 'main' || !/^resp_[a-f0-9-]{36}$/.test(native.runId || '')) return;
    const key = `${native.sessionKey}:${native.runId}`;
    if (runs.get(key) === 'ordinary') return;
    try {
      const tool = foregroundTool(event, native, localForeground);
      const callId = event.toolCallId || native.toolCallId;
      const work = await call('guardian_tool', native, tool && { tool }, callId);
      if (tool && work.foreground === true && work.delegated === false && runs.get(key) !== 'guardian') {
        remember(key, 'foreground');
        return;
      }
      if (work.delegated !== true) throw new Error('Invalid guardian work observation');
      remember(key, 'guardian');
      return { block: true, blockReason: `Core owns the requested work ${work.id}, execution ${work.execution}, through complete native Main. No tool was executed by the conversational guardian. Continue the conversation from its shared context and actual status. Do not redispatch, claim completion, narrate thinking, or say Nestor lacks Main’s or a specialist’s tools.` };
    } catch (cause) {
      if (!runs.has(key) && (cause.statusCode === 404
          || cause.statusCode === 400 && cause.code === 'CONVERSATION_WORK_OPERATION_INVALID')) {
        remember(key, 'ordinary'); return;
      }
      return { block: true, blockReason: 'Core could not verify the already delegated guardian work. No tool was executed. Continue the conversation without a replacement dispatch or an invented result.' };
    }
  };
}
