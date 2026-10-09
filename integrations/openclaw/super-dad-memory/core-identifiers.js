// Sensitive identifiers live encrypted in AgentX Core; the plugin relays.
export function createCoreIdentifiersClient({ baseUrl, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('Configure the canonical AgentX URL for this OpenClaw instance');
  const url = new URL('/api/consumers/nestor/v1/identifiers', baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('AgentX requires an HTTP URL');
  return async input => {
    const action = input?.action;
    if (!['list', 'reveal'].includes(action)) throw new Error('Unsupported identifier operation');
    const payload = action === 'reveal' ? { action, id: input.id } : { action };
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Core identifier vault unavailable (${response.status})`);
    const body = await response.json();
    const data = body.data;
    if (body.status !== 'success' || data?.ok !== true || data.authority !== 'agentx.core' || data.action !== action
        || (action === 'list' && !Array.isArray(data.identifiers))
        || (action === 'reveal' && (data.id !== input.id || typeof data.value !== 'string'))) {
      throw new Error('Core identifier receipt is invalid');
    }
    return data;
  };
}

// A value is shown only in the owner's Household (Super Dad) session, which
// stays on the local network; Telegram history lives on Telegram's servers.
export const householdOwnerSession = context => /^agent:main:household:direct:[a-f0-9-]{36}$/.test(context?.sessionKey || '');
