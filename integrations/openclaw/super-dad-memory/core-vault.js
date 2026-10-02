// Nestor files notes through Core; the plugin never writes into the vault itself.
export function createCoreVaultClient({ baseUrl, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('Configure the canonical AgentX URL for this OpenClaw instance');
  const url = new URL('/api/consumers/nestor/v1/vault/notes', baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('AgentX requires an HTTP URL');
  return async input => {
    const payload = {};
    for (const key of ['title', 'body', 'tags']) {
      if (Object.hasOwn(input || {}, key)) payload[key] = input[key];
    }
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Core vault inbox unavailable (${response.status}); do not claim the note was saved`);
    const body = await response.json();
    const data = body.data;
    if (body.status !== 'success' || data?.ok !== true || data.authority !== 'agentx.core'
        || data.operation !== 'write_vault_note' || data.status !== 'inbox'
        || typeof data.file !== 'string' || !data.file.endsWith('.md')) {
      throw new Error('Core vault-note receipt is invalid; do not claim the note was saved');
    }
    return data;
  };
}
