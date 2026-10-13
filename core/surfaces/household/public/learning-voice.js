/* Scoped learning pages use Core's existing hands-free loop, never personal routes. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HouseholdLearningVoice = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const shared = typeof module === 'object' && module.exports
    ? require('../../../public/js/voice/browser-conversation') : root.AgentXVoice;
  const speech = typeof module === 'object' && module.exports
    ? require('../../../public/js/voice/speech-language') : root.NestorSpeech;

  function create({ turn, transcribe, synthesize, language = () => 'fr', muted = () => false,
    changed = () => {}, openAudio = (signal, failed, options) => shared.openAudio(signal, failed, { ...options, observeSpeech: true }) }) {
    let pending = null;
    const conversation = new shared.Conversation({
      holdingDelayMs: null,
      openAudio,
      // The page's turn adapter owns its pack, mode and canonical Core session.
      // This ephemeral loop handle cannot select a different memory or tool scope.
      createSession: async () => ({ surface: 'household-learning' }),
      transcribe,
      message() {},
      speechText: text => muted() ? '' : speech.speechText(text),
      async turn(_handle, text, signal) {
        const current = pending = Promise.resolve().then(() => turn(text, signal));
        try {
          const reply = await current;
          return { ...reply, ...(muted() ? { sound: null } : {}) };
        } finally { if (pending === current) pending = null; }
      },
      // Stop controls playback. A scoped request already sent may still settle
      // and render its complete result; a new request waits for that same request.
      async interrupt() { await pending?.catch(() => {}); },
      synthesize,
    }, changed);
    return {
      conversation,
      start: () => conversation.start({ language: language(), wakeWord: true, interruption: true }),
      pause: () => conversation.stop(true),
      setLanguage: value => conversation.setLanguage(value),
      stopSpeech: () => conversation.interrupt(undefined, { stop: true }),
      async typed(text) {
        if (!conversation.audio) return null;
        if (!conversation.canType()) return false;
        return conversation.typed(text);
      },
      async read(reply) {
        if (!conversation.audio) return null;
        conversation.wake.extend(); // an explicit reading button addresses Nestor
        return conversation.interject(reply);
      },
    };
  }

  function mount({ button, micToggle, soundToggle, status, turn, transcribe, synthesize,
    language, muted, setMuted, stopPlayback }) {
    const labels = { idle: 'Microphone off · enable voice to start', paused: 'Microphone off',
      starting: 'Opening the microphone…', listening: 'Listening · Hey/Eille/Oh/Ah Nestor to activate',
      hearing: 'Listening…', transcribing: 'Transcribing…', thinking: 'Preparing the answer…',
      waiting: 'Waiting for the current request…', preparing: 'Preparing speech…',
      speaking: 'Nestor is speaking · say Stop to interrupt', reviewing: 'Transcription failed · Resume to continue',
      resuming: 'Listening again…' };
    let controller;
    const render = (phase, detail) => {
      const resting = ['idle', 'paused', 'error', 'reviewing'].includes(phase);
      button.textContent = resting ? phase === 'reviewing' ? 'Resume' : 'Enable voice' : 'Pause';
      button.setAttribute('aria-label', button.textContent);
      button.setAttribute('aria-pressed', String(!resting));
      micToggle.textContent = resting ? 'Mic off' : 'Mic on';
      micToggle.setAttribute('aria-pressed', String(!resting));
      status.dataset.state = phase;
      status.textContent = phase === 'error' ? detail || 'Voice unavailable · use the keyboard' : labels[phase] || detail;
      if (phase === 'listening' && controller?.conversation.wake.active()) status.textContent = 'Conversation active · continues until Pause';
    };
    controller = create({ turn, transcribe, synthesize, language, muted, changed: render });
    const toggle = async () => {
      if (['idle', 'paused', 'error', 'reviewing'].includes(controller.conversation.state)) {
        stopPlayback(); await controller.start();
      } else controller.pause();
    };
    button.addEventListener('click', toggle);
    micToggle.addEventListener('click', toggle);
    soundToggle.addEventListener('click', () => {
      setMuted(!muted());
      soundToggle.textContent = muted() ? 'Sound off' : 'Sound on';
      soundToggle.setAttribute('aria-pressed', String(muted()));
      if (muted()) { controller.stopSpeech(); stopPlayback(); }
    });
    root.document.addEventListener('visibilitychange', () => { if (root.document.hidden) controller.pause(); });
    root.addEventListener('pagehide', controller.pause);
    render('idle');
    return controller;
  }
  return { create, mount };
});
