/* The guide has its own French voice; conversation persona/preferences stay untouched. */
(function (root) {
  'use strict';
  function createNarrator(env = root) {
    const speech = new env.VoixAudio.Speech({ retryUnplayed: true, playBrowser: env.AgentXVoice.speakWithBrowser });
    const choice = { provider: 'kokoro', voice: env.NestorSpeech?.PROFILES?.fr?.nativeVoice || 'ff_siwis' };
    const ladder = env.AgentXSpeechLadder.createSpeechLadder({
      request: ({ text, language, choice }, signal) => env.fetch('/api/voix/synthesize/stream', {
        method: 'POST', signal, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language, voice: choice.voice, tts_provider: choice.provider })
      }),
      deviceVoice: () => !!env.speechSynthesis,
      unavailable: 'La voix du guide est indisponible.'
    });
    let unlocked = false;
    // A suspended autoplay context can leave resume() pending forever. Detect that
    // before opening a synthesis request; the ordinary Play gesture can retry it.
    async function unlock(signal) {
      const Context = env.AudioContext || env.webkitAudioContext;
      if (unlocked || !Context) return;
      const context = new Context();
      let timer, abort;
      try {
        await Promise.race([context.resume(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('Le navigateur attend un geste pour autoriser le son.'), { name: 'NotAllowedError' })), 1000);
          abort = () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        })]);
        unlocked = context.state === 'running';
        if (!unlocked) throw Object.assign(new Error('Audio verrouillé.'), { name: 'NotAllowedError' });
      } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); await context.close().catch(() => {}); }
    }
    return async (text, signal) => {
      if (signal.aborted) return;
      await unlock(signal);
      if (signal.aborted) return;
      const stop = () => speech.cancel();
      signal.addEventListener('abort', stop, { once: true });
      try {
        await speech.speak((playSignal, _segment, after) => ladder.speak({ text, language: 'fr', choices: [choice], after }, playSignal));
      } finally { signal.removeEventListener('abort', stop); }
    };
  }
  function bindConversation(view, { embedded = false } = {}) {
    let context = { visible: !embedded, busy: false }, startPending = embedded;
    function update(next) {
      context = { visible: next?.visible === true, busy: next?.busy === true };
      view.tour?.conversation?.(!context.visible || context.busy);
      if (startPending && context.visible && !context.busy && view.tour) {
        startPending = false; view.tour.play();
      }
    }
    update(context);
    return Object.freeze({
      update,
      pause() { startPending = false; view.tour?.conversation?.(true); if (context.visible && !context.busy) view.tour?.conversation?.(false); }
    });
  }
  if (typeof module === 'object' && module.exports) module.exports = { createNarrator, bindConversation };
  else {
    if (root.document.querySelector('agentx-ecosystem')?.getAttribute('voice') === 'off') return;
    const managed = !!root.frameElement?.closest('.page-presentation');
    let latest = { visible: !managed, busy: false }, controller, questionPending = false;
    const parentPresence = event => root.AgentXEcosystemConversation.update({ visible: true, busy: event.detail?.conversationBusy === true });
    const parentQuestion = () => root.AgentXEcosystemConversation.pause();
    // Family's simple board also embeds pages, without the personal workspace.
    if (!managed && root.parent !== root) {
      try { latest.busy = root.parent.document.getElementById('conversationPresence')?.dataset.conversationBusy === 'true'; } catch { /* another origin */ }
      try { root.parent.addEventListener('persona-presence', parentPresence); root.parent.addEventListener('nestor-question-start', parentQuestion); } catch { /* another origin cannot coordinate this view */ }
    }
    root.AgentXEcosystemConversation = Object.freeze({
      update(next) { latest = next; controller?.update(next); },
      pause() { questionPending = true; controller?.pause(); }
    });
    root.customElements.whenDefined('agentx-ecosystem').then(() => {
      const view = root.document.querySelector('agentx-ecosystem');
      if (!view) return;
      controller = bindConversation(view, { embedded: root.parent !== root });
      if (questionPending) controller.pause();
      controller.update(latest);
      if (root.VoixAudio?.Speech) view.narrator = createNarrator();
      root.addEventListener('pagehide', () => {
        view.tour?.pause();
        if (!managed && root.parent !== root) {
          try { root.parent.removeEventListener('persona-presence', parentPresence); root.parent.removeEventListener('nestor-question-start', parentQuestion); } catch { /* another origin */ }
        }
      });
    });
  }
})(typeof window === 'undefined' ? globalThis : window);
