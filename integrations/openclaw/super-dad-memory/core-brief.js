// A collaborator's standing brief is computed by AgentX Core; the plugin only relays and checks the receipt.
export function createCoreBriefClient({ baseUrl, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('Configure the canonical AgentX URL for this OpenClaw instance');
  const url = new URL('/api/consumers/nestor/v1/team-brief', baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('AgentX requires an HTTP URL');
  return async input => {
    const member = String(input?.member || '').trim().toLowerCase();
    if (!member) throw new Error('Name the collaborator whose brief you want');
    const payload = { member, ...(Number.isInteger(input?.days) && { days: input.days }) };
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (response.status === 400) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(`Core refused the brief request: ${detail.message || 'invalid input'}`);
    }
    if (!response.ok) throw new Error(`Core team brief unavailable (${response.status}); do not answer from memory`);
    const body = await response.json();
    const data = body.data;
    if (body.status !== 'success' || data?.ok !== true || data.authority !== 'agentx.core' || data.kind !== 'team_brief'
        || data.member !== member || !data.sections || typeof data.sections !== 'object') {
      throw new Error('Core team-brief receipt is invalid; do not answer from memory');
    }
    return data;
  };
}
