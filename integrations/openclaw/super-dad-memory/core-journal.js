// The mail journal lives in AgentX Core; the plugin only relays and checks receipts.
export function createCoreJournalClient({ baseUrl, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('Configure the canonical AgentX URL for this OpenClaw instance');
  const url = new URL('/api/consumers/nestor/v1/mail-journal', baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('AgentX requires an HTTP URL');
  return async input => {
    const action = input?.action;
    if (!['record', 'search'].includes(action)) throw new Error('Unsupported mail-journal operation');
    const payload = { action };
    for (const key of ['threadId', 'messageId', 'occurredAt', 'subject', 'counterpart', 'summary', 'tags', 'sourceRef',
      'query', 'since', 'until', 'limit']) {
      if (Object.hasOwn(input, key)) payload[key] = input[key];
    }
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (response.status === 400) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(`Core refused the mail-journal input: ${detail.message || 'invalid input'}`);
    }
    if (!response.ok) throw new Error(`Core mail journal unavailable (${response.status}); do not claim the entry was saved`);
    const body = await response.json();
    const data = body.data;
    if (body.status !== 'success' || data?.ok !== true || data.authority !== 'agentx.core' || data.action !== action
        || (action === 'search' && !Array.isArray(data.entries))
        || (action === 'record' && data.recorded === true && data.entry?.threadId !== String(input.threadId || '').trim())) {
      throw new Error('Core mail-journal receipt is invalid; do not claim the entry was saved');
    }
    return data;
  };
}
