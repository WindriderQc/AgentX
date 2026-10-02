'use strict';

// Check the exact routed model/host. Never drop images or silently reroute them.
async function requireImageSupport({ messages, model, hostUrl, signal, fetch }) {
  if (!messages?.some(message => message.images?.length)) return;
  const abort = new AbortController();
  const cancel = () => abort.abort(signal.reason);
  const timer = setTimeout(() => abort.abort(), 10000);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const response = await fetch(`${hostUrl.replace(/\/+$/, '')}/api/show`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal: abort.signal, redirect: 'error'
    });
    const body = response.ok ? JSON.parse(await response.text()) : null;
    if (!body?.capabilities?.includes('vision')) throw new Error('vision unavailable');
  } catch {
    signal?.throwIfAborted();
    throw Object.assign(new Error('Ce modèle ne confirme pas la prise en charge des images. Choisis un modèle avec vision avant de réessayer.'),
      { statusCode: 400, code: 'INFERENCE_VISION_REQUIRED' });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
module.exports = { requireImageSupport };
