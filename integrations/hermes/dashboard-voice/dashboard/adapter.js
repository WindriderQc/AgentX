/* Browser capture/playback and speech policy remain in AgentX's shared voice modules. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentXHermesVoice = api;
})(typeof window === 'undefined' ? globalThis : window, function (root) {
  'use strict';
  async function json(url, init) {
    const r = await root.fetch(url, { credentials: 'same-origin', ...init });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.ok === false) throw new Error(body.message || body.error || `Service vocal indisponible (${r.status}).`);
    return body.data || body;
  }
  async function prepare() {
    const catalog = await json('/api/voice-personas/catalog');
    const persona = catalog.personas?.find(p => p.id === 'nestor');
    if (!persona) throw new Error('La voix de Nestor est indisponible dans le catalogue AgentX.');
    return persona;
  }
  function create({ chat, bridge, persona, changed, speak = () => true }) {
    // Same origin and the personal scope reuse /dad's saved microphone, VAD and voice choices.
    const preferences = () => root.AgentXVoiceSettings.read('personal', [persona]);
    const ladder = root.AgentXSpeechLadder.createSpeechLadder({
      request: ({ text, language, choice }, signal) => root.fetch('/api/voix/synthesize/stream', {
        method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language, tts_provider: choice.provider, voice: choice.voice || '' })
      }),
      deviceVoice: () => Boolean(root.speechSynthesis),
      unavailable: 'La lecture est indisponible. La réponse complète reste dans le chat.'
    });
    const conversation = new root.AgentXVoice.Conversation({
      openAudio(signal, failed, options) {
        const prefs = preferences();
        return root.AgentXVoice.openAudio(signal, failed, { ...options, captureScope: 'personal',
          capture: prefs.capture, inputDeviceId: prefs.inputDeviceId || '' }).then(audio => ({ ...audio,
            play(bytes, ...args) { return bytes?.silent || !speak() ? Promise.resolve() : audio.play(bytes, ...args); }
          }));
      },
      createSession: async () => ({ scope: chat.scope }),
      async transcribe(blob, language, signal) {
        const body = new FormData(); body.append('file', blob, 'voice.wav'); body.append('language', language);
        return json('/api/voix/transcribe', { method: 'POST', body, signal });
      },
      turn: (_session, text, signal, delta) => bridge.turn(text, signal, delta),
      // The embedded TUI already renders both messages in its existing native conversation.
      message() {},
      synthesize({ text, language, after }, signal) {
        if (!speak()) return { silent: true };
        const saved = root.PersonaPresentation.read(root.localStorage, [persona]);
        const choices = root.PersonaPresentation.speechChoices(persona, language, saved.profiles.nestor);
        return ladder.speak({ text, language, choices, after }, signal);
      },
      holdingDelayMs: null
    }, changed);
    return {
      start() {
        const prefs = preferences();
        // Half-duplex capture cannot hear its own reply or cancel an unrelated typed turn.
        return conversation.start({ language: prefs.language, wakeWord: prefs.wakeWord, interruption: false });
      },
      stop() { conversation.stop(); },
      destroy() { conversation.stop(); bridge.close(); },
      state: () => conversation.state,
    };
  }
  return { prepare, create };
});
