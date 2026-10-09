'use strict';

// VoiX HTTP routes of the Household surface: the browser-facing /api/voix
// proxy to the speech service (its state, voice catalog, player, recognition
// and synthesis). Spoken conversation itself runs in the page (#478).

const { createScriptRelay } = require('./asset-relay');
const { getVoiceUpstream } = require('../../src/services/voice/transport');
const { createSynthesisHandler } = require('../../src/services/voice/voix-synthesis');
const { VOIX_TIMEOUT_MS, fetchWithTimeout, voixUrl, upstreamJson, readUpstreamJson } = require('./voix-client');

const VOIX_LONG_TIMEOUT_MS = () => Math.max(5000, Number(process.env.VOIX_LONG_TIMEOUT_MS) || 120000);

function registerVoixRoutes(app, {
  express, standardJsonParser, fail, envelope, cleanText, normalizeVoixTranscriptionMultipart,
  voixUpstream = getVoiceUpstream()
}) {
  const voix = express.Router();
  voix.get('/health', async (_req, res) => {
    try { return envelope(res, await upstreamJson('/health')); }
    catch (error) { return fail(res, error.status || 503, error.message, error.code || 'VOIX_UNAVAILABLE'); }
  });
  // Stateless routes below may be answered by VOIX_FALLBACK_URL; see voix-upstream.
  voix.get('/upstream', async (_req, res) => envelope(res, await voixUpstream.status()));
  voix.get('/catalog', async (_req, res) => {
    try {
      const { response, upstream } = await voixUpstream.send('/api/voices', (url) => fetchWithTimeout(url, {}, VOIX_TIMEOUT_MS()));
      res.set('X-Voix-Upstream', upstream);
      return envelope(res, await readUpstreamJson(response));
    } catch (error) { return fail(res, 503, error.message, 'VOIX_UNAVAILABLE'); }
  });
  voix.get('/player.js', createScriptRelay({ resolveUrl: () => voixUrl('/assets/voice-audio.js'), fetchWithTimeout,
    fetchUpstream: (_url, ms) => voixUpstream.send('/assets/voice-audio.js', (url) => fetchWithTimeout(url, {}, ms)),
    unavailable: (res, error) => fail(res, 503, error.message || 'Local speech player is unavailable', 'VOIX_UNAVAILABLE') }));
  const speechRecognition = require('../../src/services/voice/voix-transcription');
  speechRecognition.registerTranscriptionProxy(voix, {
    express, normalizeMultipart: normalizeVoixTranscriptionMultipart, upstream: voixUpstream,
    fetchWithTimeout, timeoutMs: VOIX_LONG_TIMEOUT_MS, fail
  });
  speechRecognition.registerRecognitionWarmProxy(voix, { upstream: voixUpstream, fetchWithTimeout });
  voix.use(standardJsonParser);
  const synthesizeSpeech = createSynthesisHandler({ upstream: voixUpstream, timeoutMs: VOIX_LONG_TIMEOUT_MS, fail, cleanText });
  voix.post('/synthesize', synthesizeSpeech);
  voix.post('/synthesize/stream', synthesizeSpeech);
  app.use('/api/voix', voix);
}

module.exports = { registerVoixRoutes };
