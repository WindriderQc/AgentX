'use strict';

// Speech synthesis proxy (whole file and streamed). Synthesis is stateless, so
// it follows the primary/backup choice of voix-upstream; the answer names the
// upstream that spoke in X-Voix-Upstream.

const { Readable } = require('node:stream');
const { pipeline: pipeStream } = require('node:stream/promises');
const { normalizeSpeechLanguage, synthesisText, speechProfile } = require('./public/speech-language');

const PROVIDERS = ['kokoro', 'windows_sapi', 'voxcpm'];

function createSynthesisHandler({ upstream, timeoutMs, fail, cleanText }) {
  return async function synthesizeSpeech(req, res) {
    const text = synthesisText(cleanText(req.body?.text || req.body?.input, 4000), req.body?.tts_provider);
    if (!text) return fail(res, 400, 'text is required', 'VOIX_INVALID_REQUEST');
    const requestedLanguage = cleanText(req.body?.language, 16);
    if (requestedLanguage && !normalizeSpeechLanguage(requestedLanguage)) {
      return fail(res, 400, 'language must be en or fr', 'VOIX_INVALID_LANGUAGE');
    }
    const profile = speechProfile(text, requestedLanguage);
    const requestedVoice = cleanText(req.body?.voice, 120);
    const provider = cleanText(req.body?.tts_provider, 40) || 'kokoro';
    if (!PROVIDERS.includes(provider)) return fail(res, 400, 'Unknown voice provider', 'VOIX_INVALID_TTS_PROVIDER');
    const streaming = (req.path || '').endsWith('/stream');
    const abort = new AbortController();
    const disconnected = () => { if (!res.writableFinished) abort.abort(); };
    res.once?.('close', disconnected);
    const body = JSON.stringify({
      text,
      language: profile.language,
      voice: requestedVoice || (provider === 'kokoro' && req.body?.native_defaults !== true ? profile.nativeVoice : ''),
      tts_provider: provider,
      native_defaults: req.body?.native_defaults === true,
      response_format: cleanText(req.body?.response_format || 'wav', 16),
      save: false
    });
    try {
      const { response, upstream: used } = await upstream.send(streaming ? '/api/tts/stream' : '/api/tts', (url) => fetch(url, {
        method: 'POST',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs())]),
        headers: { 'Content-Type': 'application/json' },
        body
      }), { canRetry: () => !abort.signal.aborted });
      res.set('X-Voix-Upstream', used);
      if (!response.ok) {
        const detail = await response.text();
        return fail(res, response.status >= 500 ? 503 : response.status, detail || 'VoiX synthesis failed', 'VOIX_BAD_RESPONSE');
      }
      res.status(200).set({
        'Content-Type': response.headers.get('content-type') || 'audio/wav',
        'X-Nestor-Speech-Language': profile.language,
        'X-Nestor-Speech-Voice': response.headers.get('x-voix-voice') || requestedVoice || (provider === 'kokoro' ? profile.nativeVoice : ''),
        'X-Voix-Provider': response.headers.get('x-voix-provider') || provider,
        'X-Voix-Voice': response.headers.get('x-voix-voice') || '',
        'X-Voix-Language': response.headers.get('x-voix-language') || profile.language,
        'Cache-Control': 'no-store'
      });
      if (streaming) {
        res.set('X-Accel-Buffering', 'no');
        await pipeStream(Readable.fromWeb(response.body), res);
        return;
      }
      return res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (abort.signal.aborted || res.headersSent) { res.destroy(); return; }
      return fail(res, 503, error.message, 'VOIX_UNAVAILABLE');
    } finally {
      res.off?.('close', disconnected);
    }
  };
}

module.exports = { createSynthesisHandler };
