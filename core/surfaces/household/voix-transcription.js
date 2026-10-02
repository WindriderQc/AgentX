'use strict';

function registerTranscriptionProxy(router, { express, normalizeMultipart, voixUrl, fetchWithTimeout, timeoutMs, fail }) {
  router.post('/transcribe', express.raw({ type: () => true, limit: '32mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return fail(res, 400, 'audio payload is required', 'VOIX_INVALID_REQUEST');
    }
    try {
      const contentType = req.get('content-type') || 'application/octet-stream';
      const body = normalizeMultipart(req.body, contentType);
      const endpoint = process.env.VOIX_SPOKEN_CONTROLS_ENABLED === 'true'
        ? '/v1/audio/transcriptions/controls' : '/v1/audio/transcriptions';
      const response = await fetchWithTimeout(voixUrl(endpoint), {
        method: 'POST', headers: { 'Content-Type': contentType }, body
      }, timeoutMs());
      const buffer = Buffer.from(await response.arrayBuffer());
      res.status(response.status).set('Content-Type', response.headers.get('content-type') || 'application/json');
      return res.send(buffer);
    } catch (error) {
      return fail(res, 503, error.message, 'VOIX_UNAVAILABLE');
    }
  });
}

module.exports = { registerTranscriptionProxy };
