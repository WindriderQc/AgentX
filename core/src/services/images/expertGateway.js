'use strict';
// Credentials stay in Core. The browser only reaches the Atelier surface API.
function configured(env = process.env) { return !!(env.OPENCLAW_GATEWAY_URL && env.OPENCLAW_GATEWAY_TOKEN); }
async function invoke(input, { onEvent = () => {}, signal, timeoutMs = 180000, env = process.env, fetchImpl = fetch } = {}) {
  if (!configured(env)) throw Object.assign(new Error('Le lien vers Hermes n’est pas configuré.'), { statusCode: 503 });
  const base = new URL(env.OPENCLAW_GATEWAY_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid expert gateway origin');
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(new URL('/api/agentx/imagex/studio', base), {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input)
    });
    if (!response.ok) throw new Error('Le relais Hermes est indisponible.');
    const decoder = new TextDecoder(); let pending = '', bytes = 0, result;
    const consume = async line => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.message || 'La consultation Hermes a échoué.');
      if (event.type === 'result') {
        if (result) throw new Error('Duplicate expert result');
        result = event.result;
      } else if (['started', 'tool_use', 'tool_result'].includes(event.type)) await onEvent(event);
    };
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 262144) throw new Error('La réponse Hermes dépasse la limite.');
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) await consume(line);
    }
    pending += decoder.decode(); if (pending) await consume(pending);
    if (result?.ok !== true || result.expert !== 'hermes') throw new Error('Hermes n’a pas fourni de résultat confirmé.');
    return result;
  } finally { controller.abort(); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
module.exports = { configured, invoke };
