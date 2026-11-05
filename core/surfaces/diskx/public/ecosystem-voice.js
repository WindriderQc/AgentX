/* Narration adapter: existing Nestor voice catalog, fallback ladder and stream player. */
(function (root) {
  'use strict';
  function createNarrator(env = root) {
    const speech = new env.VoixAudio.Speech({ retryUnplayed: true, playBrowser: env.AgentXVoice.speakWithBrowser });
    const ladder = env.AgentXSpeechLadder.createSpeechLadder({
      request: ({ text, language, choice }, signal) => env.fetch('/api/voix/synthesize/stream', {
        method: 'POST', signal, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language, voice: choice.voice, tts_provider: choice.provider })
      }),
      deviceVoice: () => !!env.speechSynthesis,
      unavailable: 'La voix est indisponible.'
    });
    let persona;
    async function choices(signal) {
      if (!persona) {
        const response = await env.fetch('/api/voice-personas/catalog', { signal, credentials: 'same-origin' });
        if (!response.ok) {
          if ([401, 403].includes(response.status)) throw new Error('Accès au catalogue de voix refusé.');
          return [];
        }
        const body = await response.json();
        persona = (body.data || body).personas?.find(item => item.id === 'nestor');
      }
      return env.PersonaPresentation.speechChoices(persona, 'fr');
    }
    return (text, signal) => {
      if (signal.aborted) return Promise.resolve();
      const stop = () => speech.cancel();
      signal.addEventListener('abort', stop, { once: true });
      // Speech opens/unlocks its context immediately, before fetching the catalog.
      return speech.speak(async (playSignal, _segment, after) => {
        const voices = await choices(playSignal);
        return ladder.speak({ text, language: 'fr', choices: voices, after }, playSignal);
      }).finally(() => signal.removeEventListener('abort', stop));
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createNarrator };
  else {
    root.customElements.whenDefined('agentx-ecosystem').then(() => {
      const view = root.document.querySelector('agentx-ecosystem');
      if (view && root.VoixAudio?.Speech) view.narrator = createNarrator();
      // A hidden or removed presentation must never keep speaking in the background.
      root.addEventListener('pagehide', () => view?.tour?.pause());
    });
  }
})(typeof window === 'undefined' ? globalThis : window);
