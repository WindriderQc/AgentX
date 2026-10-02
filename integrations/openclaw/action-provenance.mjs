import { agentActionProvenance } from '../../shared/agentActionProvenance.cjs';

export function configuredJobContext(context, sessionKeys = []) {
  if (!context.agentId || context.sandboxed || !Array.isArray(sessionKeys)) return false;
  const prefix = `agent:${context.agentId}:`;
  return sessionKeys.some(key => typeof key === 'string' && key.startsWith(prefix)
    && (context.sessionKey === key || context.sessionKey?.startsWith(key + ':')));
}

export function privateOwnerContext(context, config = {}) {
  if (context.agentId !== 'main' || context.sandboxed) return false;
  if (/^agent:main:household:direct:[a-f0-9-]{36}$/.test(context.sessionKey || '')) return true;
  const match = /^agent:main:telegram:direct:([0-9]+)(?::thread:[0-9]+)?$/.exec(context.sessionKey || '');
  const owners = (config.channels?.telegram?.allowFrom || []).map(value => String(value).replace(/^telegram:/, '').trim());
  return Boolean(match && owners.includes(match[1]) && (!context.senderId || String(context.senderId) === match[1]));
}

// Only host hook context and operator configuration determine the origin.
// Tool parameters and results, including an apparent provenance, are ignored.
export function nativeActionProvenance(context = {}, config = {}, pluginConfig = {}) {
  const nestor = config.plugins?.entries?.['super-dad-memory']?.config || {};
  const secretaryKeys = pluginConfig.secretarySessionKeys ?? nestor.secretarySessionKeys;
  const briefingKeys = pluginConfig.briefingSessionKeys ?? nestor.briefingSessionKeys;
  const session = typeof context.sessionKey === 'string' ? context.sessionKey : '';
  const prefix = context.agentId ? `agent:${context.agentId}:` : '';
  const consistent = Boolean(prefix && session.startsWith(prefix));
  let origin = 'unknown';
  if (consistent) {
    const kind = session.slice(prefix.length);
    if (kind.startsWith('subagent:') || context.sandboxed) origin = 'delegated';
    else if (configuredJobContext(context, secretaryKeys)) origin = 'ingested_content';
    else if (kind.startsWith('cron:') || configuredJobContext(context, briefingKeys)) origin = 'scheduled';
    else if (privateOwnerContext(context, config) || context.requester?.senderIsOwner === true) origin = 'owner_turn';
  }
  return agentActionProvenance({ ...context, origin });
}

export function toolActionReceipt(event, provenance, phase, decision = null) {
  return {
    schema: 'agentx.tool-action-receipt/v1',
    tool: typeof event.toolName === 'string' ? event.toolName.slice(0, 120) : 'unknown',
    phase, decision, provenance,
    ...(phase === 'observed' ? {
      status: event.error || event.result?.isError ? 'failed' : event.result === undefined ? 'unknown' : 'observed',
    } : {}),
  };
}
