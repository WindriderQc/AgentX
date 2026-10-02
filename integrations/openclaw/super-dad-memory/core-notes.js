// The native tool is a client of Core, never a second personal-note store.
export function createCoreNotesClient({ baseUrl, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('Configure the canonical AgentX URL for this OpenClaw instance');
  const url = new URL('/api/consumers/nestor/v1/memory/notes', baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('AgentX requires an HTTP URL');
  return async input => {
    const action = input?.action;
    if (!['remember', 'forget', 'list', 'search', 'context'].includes(action)) throw new Error('Unsupported personal-memory operation');
    const payload = { action };
    for (const key of ['id', 'text', 'query', 'kind', 'expiresAt', 'limit', 'offset']) {
      if (Object.hasOwn(input, key)) payload[key] = input[key];
    }
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Core personal notes unavailable (${response.status}); refresh before retrying a write`);
    const body = await response.json();
    const data = body.data;
    if (body.status !== 'success' || data?.ok !== true || data.authority !== 'agentx.core' || data.operation !== action
        || (['list', 'search', 'context'].includes(action) && !Array.isArray(data.notes))
        || (['remember', 'forget'].includes(action) && !/^[a-f0-9]{24}$/.test(data.id || ''))
        // Core may replace an identifier by a vault reference; nothing else may change.
        || (action === 'remember' && data.text !== input.text?.trim() && !data.sealed?.length)
        || (action === 'forget' && data.id !== input.id)) {
      throw new Error('Core personal-note receipt is invalid; refresh before retrying a write');
    }
    return { ...data, action };
  };
}

// Existing native jobs remain optional instance configuration. No operator
// cron IDs, identities or machine addresses are included in the repository.
// A key names the agent that owns the job; only that agent's session matches.
export function configuredJobContext(context, sessionKeys = []) {
  if (!context.agentId || context.sandboxed) return false;
  const prefix = `agent:${context.agentId}:`;
  return sessionKeys.some(key => typeof key === 'string' && key.startsWith(prefix)
    && (context.sessionKey === key || context.sessionKey?.startsWith(key + ':')));
}
