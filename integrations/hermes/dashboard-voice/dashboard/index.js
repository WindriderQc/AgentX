(function (root) {
  'use strict';
  const sdk = root.__HERMES_PLUGIN_SDK__, registry = root.__HERMES_PLUGINS__;
  const { React } = sdk, { useState, useEffect, useRef } = React;
  const h = React.createElement, scriptBase = new URL('.', document.currentScript.src);
  const name = 'agentx-voice';
  const assets = [
    '/js/voice/speech-language.js', '/js/voice/spoken-presentation.js', '/js/voice/voice-capture.js',
    '/js/voice/playback-hold.js', '/js/voice/voice-timeline.js', '/api/voix/player.js',
    '/js/voice/browser-conversation.js', '/js/voice/speech-ladder.js',
    '/assets/household/persona-presentation.js', '/js/voice/voice-settings.js',
    new URL('bridge.js', scriptBase).href, new URL('adapter.js', scriptBase).href
  ];
  let loading;
  function load() {
    return loading ||= assets.reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = src;
      script.onload = resolve; script.onerror = () => reject(new Error('Les composants vocaux sont indisponibles. Recharge la page.'));
      document.head.append(script);
    })), Promise.resolve());
  }
  const labels = { idle: 'Micro du PC arrêté', paused: 'Micro du PC arrêté', starting: 'Ouverture du micro…',
    listening: 'Je t’écoute', thinking: 'Nestor réfléchit…', preparing: 'Préparation de la voix…',
    speaking: 'Nestor parle', transcribing: 'Transcription…', error: 'Voix interrompue' };
  function Voice({ chat }) {
    const controller = useRef(null), spoken = useRef(true);
    const [state, setState] = useState('idle'), [error, setError] = useState(''), [ready, setReady] = useState(false);
    const [speech, setSpeech] = useState(true);
    useEffect(() => {
      let closed = false, bridge;
      setReady(false); setError(''); setState('idle');
      if (!chat?.ready) return;
      load().then(async () => {
        const persona = await root.AgentXHermesVoice.prepare();
        if (closed) return;
        bridge = new root.AgentXHermesVoiceBridge.Bridge(chat, { sdk });
        await bridge.connect();
        if (closed) { bridge.close(); return; }
        controller.current = root.AgentXHermesVoice.create({ chat, bridge, persona,
          speak: () => spoken.current,
          changed(next, detail) { if (!closed) { setState(next); setError(next === 'error' ? String(detail?.message || detail || 'Vérifie le micro et le service vocal.') : ''); } }
        });
        setReady(true);
      }).catch(e => { if (!closed) setError(e.message); });
      return () => { closed = true; controller.current?.destroy(); controller.current = null; bridge?.close(); };
    }, [chat?.scope, chat?.ready]);
    if (!chat) return h('div', { className: 'agentx-voice', role: 'status' }, 'L’extension vocale attend la mise à jour du dashboard.');
    const running = !['idle', 'paused', 'error'].includes(state);
    return h('section', { className: 'agentx-voice', 'aria-label': 'Voix du navigateur' },
      h('button', { type: 'button', disabled: !ready, onClick: () => {
        if (running) controller.current?.stop(); else { setError(''); controller.current?.start().catch(e => setError(e.message)); }
      } }, running ? 'Arrêter le micro' : 'Parler à Nestor'),
      h('span', { role: 'status', 'aria-live': 'polite' }, labels[state] || state),
      h('label', {}, h('input', { type: 'checkbox', checked: speech, onChange: e => { spoken.current = e.target.checked; setSpeech(e.target.checked); } }), ' Réponses parlées'),
      h('a', { href: '/voice-lab?scope=personal', target: '_blank', rel: 'noopener' }, 'Réglages vocaux'),
      error && h('span', { className: 'agentx-voice-error', role: 'alert' }, error));
  }
  registry.register(name, () => null);
  registry.registerSlot(name, 'chat:top', Voice);
})(window);
