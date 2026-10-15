/* Diagnostic adapters use the same capture, recognition and speech ladder as their surface. */
(function (root) {
  'use strict';
  function create({ scope, language, capture, preferences, persona, changed = () => {}, result = () => {}, timing = () => {}, receipt = () => {}, scheduled = () => {},
    fetchImpl = root.fetch.bind(root), openAudio = root.AgentXVoice.openAudio }) {
    const psyx = scope === 'psyx';
    let latest = null, lastSpeech = null, stopped = false;
    const aborts = new Set();
    async function transcribe(blob, lang, signal) {
      let body = blob, headers = { 'Content-Type': blob.type || 'audio/wav', 'X-PsyX-Language': lang };
      if (!psyx) { body = new FormData(); body.append('file', blob, 'voice-test.wav'); body.append('language', lang); headers = {}; }
      const response = await fetchImpl(psyx ? '/api/psyx/voice/transcribe' : '/api/voix/transcribe',
        { method: 'POST', credentials: 'same-origin', body, headers, signal });
      const payload = await response.json().catch(() => ({}));
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (psyx && payload.code === 'PSYX_VOICE_NO_SPEECH') return { text: '', language: lang };
      if (!response.ok || payload.ok === false) throw Object.assign(new Error(payload.message || payload.error || `Recognition failed (${response.status}).`),
        { status: response.status, retryAfter: response.headers.get('Retry-After') });
      const value = payload.data || payload, upstream = response.headers.get('X-Voix-Upstream');
      return { ...value, ...(['primary','fallback'].includes(upstream) ? { usedUpstream:upstream } : {}) };
    }
    const session = new root.AgentXVoice.Conversation({
      holdingDelayMs: null,
      openAudio: (signal, failed, options) => openAudio(signal, failed, { ...options, captureScope: scope, capture: capture(), inputDeviceId: preferences().inputDeviceId || '' }),
      createSession: async () => ({ surface: 'voice-workshop', testOnly: true }),
      async transcribe(blob, lang, signal) {
        const response = await transcribe(blob, lang, signal); latest = response;
        result(response); return response;
      },
      // Diagnostic turns never dispatch a business request or write a conversation.
      turn: async () => ({ text: '' }), message() {},
      timings: async (_session, _turn, values) => timing(values),
    }, changed);
    const ladder = root.AgentXSpeechLadder.createSpeechLadder({
      async request({ text, language, choice }, signal) {
        return fetchImpl(psyx ? '/api/psyx/voice/synthesize/stream' : '/api/voix/synthesize/stream', {
          method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(psyx ? { text, language, ttsProvider: choice.provider, voice: choice.voice || '' }
            : { text, language, tts_provider: choice.provider, voice: choice.voice || '' }) });
      },
      deviceVoice: ({ language: requestedLanguage }) => psyx ? requestedLanguage === 'en' && root.speechSynthesis ? { localOnly: true } : false : Boolean(root.speechSynthesis),
      unavailable: 'Speech is unavailable for this choice. The complete text remains visible.'
    });
    const speech = root.VoixAudio?.Speech ? new root.VoixAudio.Speech({ retryUnplayed: true, playBrowser: root.AgentXVoice.speakWithBrowser, onReceipt: receipt, onMetrics: timing, onScheduled: scheduled }) : { cancel() {}, async speak() { throw new Error('The speech player is unavailable. Reload the workshop after restoring the voice service.'); } };
    function clip() {
      const info = session.audio?.reviewStatus();
      return info?.id && info.expiresAt > Date.now() ? info : null;
    }
    function pause() {
      stopped = true; speech.cancel(); aborts.forEach(a => a.abort()); aborts.clear(); session.stop(true); latest = null;
    }
    return {
      conversation: session,
      start() { stopped = false; return session.start({ language: language(), wakeWord: preferences().wakeWord, interruption: false }); },
      pause,
      review(kind = 'last') { return session.review(kind); }, replay: () => session.replay(),
      erase() { session.forgetReview(); latest = null; },
      clip, latest: () => latest,
      // An explicit, bounded two-request comparison of the same still-live excerpt.
      // No background retry, audio archive or conversation write is involved.
      async compare(otherLanguage) {
        const info = clip();
        if (!info || session.state !== 'reviewing') throw new Error('Pause for replay and select an unexpired excerpt first.');
        const blob = session.audio.reviewBlob();
        if (!blob) throw new Error('The excerpt has expired.');
        const abort = new AbortController(); aborts.add(abort);
        const expires = setTimeout(() => abort.abort(), Math.max(0, info.expiresAt - Date.now()));
        try {
          const rows = [];
          for (const lang of [language(), otherLanguage]) {
            if (stopped || abort.signal.aborted || clip()?.id !== info.id) throw new DOMException('Excerpt expired or replaced', 'AbortError');
            const start = root.performance.now(), value = await transcribe(blob, lang, abort.signal);
            rows.push({ language: lang, result: value, elapsedMs: Math.round(root.performance.now() - start) });
          }
          return { excerptId: info.id, seconds: info.seconds, rawCapture: true, rows };
        } finally { clearTimeout(expires); aborts.delete(abort); }
      },
      async speak(text, choice, speechLanguage = language()) {
        const segments = root.NestorSpeech.splitSpeechText(root.NestorSpeech.speechText(text, { readAloud: true }));
        if (!segments.some(segment => segment.trim())) throw new Error('Ajoutez du texte à lire avant de lancer cet essai.');
        session.stop(true); // One microphone owner; the TTS test does not hear itself.
        lastSpeech = null;
        const profile = preferences(), choices = choice ? [choice] : psyx
          ? [{ provider: profile.voice?.split('|')[0] || 'kokoro', voice: profile.voice?.split('|')[1] || '' }]
          : root.PersonaPresentation.speechChoices(persona(), speechLanguage, { selections: speechLanguage === language() && profile.voice ? { [speechLanguage]: profile.voice } : {} });
        await speech.speak((signal, segment, after) => ladder.speak({ text: segment, language: speechLanguage, choices, after }, signal),
          { segments });
        return lastSpeech;
      },
      stopSpeech() { speech.cancel(); },
      destroy: pause,
    };
  }
  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentXVoiceWorkshopSession = api;
})(typeof window === 'undefined' ? globalThis : window);
