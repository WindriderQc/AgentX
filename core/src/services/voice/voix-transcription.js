'use strict';

function registerTranscriptionProxy(router, { express, normalizeMultipart, upstream, fetchWithTimeout, timeoutMs, fail }) {
  router.post('/transcribe', express.raw({ type: () => true, limit: '32mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return fail(res, 400, 'audio payload is required', 'VOIX_INVALID_REQUEST');
    }
    const abort = new AbortController();
    const close = () => { if (!res.writableFinished) abort.abort(); };
    res.once?.('close', close);
    try {
      const contentType = req.get('content-type') || 'application/octet-stream';
      const body = normalizeMultipart(req.body, contentType);
      const endpoint = process.env.VOIX_SPOKEN_CONTROLS_ENABLED === 'true'
        ? '/v1/audio/transcriptions/controls' : '/v1/audio/transcriptions';
      // Transcription is stateless: the backup may answer while the primary is down.
      const { response, upstream: used } = await upstream.send(endpoint, (url) => fetchWithTimeout(url, {
        method: 'POST', signal: abort.signal, headers: { 'Content-Type': contentType }, body
      }, timeoutMs()), { canRetry: () => !abort.signal.aborted });
      const buffer = Buffer.from(await response.arrayBuffer());
      if (abort.signal.aborted) return;
      res.status(response.status).set({
        'Content-Type': response.headers.get('content-type') || 'application/json',
        'X-Voix-Upstream': used
      });
      return res.send(buffer);
    } catch (error) {
      if (abort.signal.aborted) return;
      return fail(res, 503, error.message, 'VOIX_UNAVAILABLE');
    } finally {
      res.off?.('close', close);
    }
  });
}

// Someone starts speaking: ask the speech service to run its recognition model
// once now, so the utterance that follows is not its first inference after a
// pause. Best effort on the primary only: a speech service that is unreachable,
// or older than this request, is never an error for the conversation.
const WARM_TIMEOUT_MS = 4000;
async function warmRecognition({ upstream, fetchWithTimeout }) {
  try {
    const { response } = await upstream.send('/api/stt/warm', (url) => fetchWithTimeout(url, { method: 'POST' }, WARM_TIMEOUT_MS),
      { canRetry: () => false });
    const body = response.ok ? await response.json().catch(() => null) : null;
    const warmMs = Number(body?.warmMs);
    return { warmed: body?.warmed === true, ...(body?.warmed === true && Number.isFinite(warmMs) && warmMs >= 0 ? { warmMs: Math.round(warmMs) } : {}) };
  } catch {
    return { warmed: false };
  }
}

function registerRecognitionWarmProxy(router, dependencies) {
  router.post('/warm', async (_req, res) => res.json(await warmRecognition(dependencies)));
}

module.exports = { registerTranscriptionProxy, registerRecognitionWarmProxy, warmRecognition };
