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

module.exports = { registerTranscriptionProxy };
