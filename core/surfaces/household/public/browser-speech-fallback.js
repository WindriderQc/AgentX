/* Optional browser speech recognition when the local transcription peer is unavailable.
   Off unless the instance allows it AND the person consents in this browser, per space:
   Chrome and Edge send the microphone audio to the browser vendor's cloud service. */
(function (root) {
  'use strict';
  const NOTICE = 'La transcription locale est indisponible. Tu peux utiliser la reconnaissance vocale de ce navigateur à la place.';
  const DISCLAIMER = 'Attention : dans Chrome et Edge, l’audio du micro est envoyé au service infonuagique de l’éditeur du navigateur et quitte ce réseau local. '
    + 'Ce choix est mémorisé pour cet espace sur ce navigateur ; tu peux le retirer dans Réglages › Écoute.';
  const INDICATOR = 'Reconnaissance du navigateur — l’audio peut quitter cet appareil';
  const MODEL = 'browser-speech-recognition';

  // Only an unreachable peer counts: a refused or malformed request is not a reason
  // to send audio elsewhere. Network failures carry no HTTP status.
  function isUnavailable(error) {
    if (!error || error.name === 'AbortError') return false;
    return error.status === undefined ? error instanceof TypeError || /network|fetch/i.test(String(error.message))
      : [502, 503, 504].includes(Number(error.status));
  }

  function recognitionLanguage(language) { return language === 'en' ? 'en-US' : 'fr-CA'; }

  function createSpeechFallback({ space = 'personal', allowed = false, storage = null, Recognition = null, listening = () => false,
    language = () => 'fr', transcribeLocal, onChange = () => {}, now = () => Date.now(), waitMs = 4000, restartMs = 250 } = {}) {
    const key = 'household.space.' + space + '.browserStt';
    const available = allowed === true && typeof Recognition === 'function';
    let localDown = false, needed = false, blocked = '', recognizer = null, restart = null;
    let finals = [], markedAt = 0, waiter = null;
    const read = () => { try { return storage?.getItem(key) === 'on'; } catch { return false; } };
    const write = value => { try { if (value) storage?.setItem(key, 'on'); else storage?.removeItem(key); } catch { /* memory only */ } };
    let consented = available && read();
    const state = () => ({ available, consented, localDown, needed: available && needed && !consented,
      active: available && consented && localDown && !blocked, running: !!recognizer, blocked });
    const changed = () => onChange(state());

    function take() {
      const text = finals.filter(item => item.at >= markedAt).map(item => item.text.trim()).filter(Boolean).join(' ');
      finals = [];
      return text;
    }
    function stopRecognizer() {
      clearTimeout(restart); restart = null;
      const current = recognizer; recognizer = null;
      if (current) { current.onresult = current.onerror = current.onend = null; try { current.abort(); } catch { /* already ended */ } }
      finals = []; waiter?.('');
    }
    function startRecognizer() {
      const current = new Recognition();
      current.lang = recognitionLanguage(language());
      current.continuous = true; current.interimResults = false; current.maxAlternatives = 1;
      current.onresult = event => {
        for (let i = event.resultIndex || 0; i < event.results.length; i++) {
          const result = event.results[i];
          if (result?.isFinal && result[0]?.transcript) finals.push({ text: String(result[0].transcript), at: now() });
        }
        if (finals.length) waiter?.(take());
      };
      current.onerror = event => {
        if (!['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event?.error)) return;
        blocked = 'Ce navigateur a refusé la reconnaissance vocale.'; stopRecognizer(); changed();
      };
      // Browsers end continuous recognition after silence or a time limit.
      current.onend = () => {
        if (recognizer !== current) return;
        recognizer = null;
        restart = setTimeout(() => { restart = null; sync(); }, restartMs);
      };
      recognizer = current;
      try { current.start(); } catch { recognizer = null; }
    }
    // The recognizer runs only while the conversation listens and the fallback is active.
    function sync() {
      const run = state().active && listening();
      if (run && !recognizer && !restart) { startRecognizer(); changed(); }
      else if (!run && (recognizer || restart)) { stopRecognizer(); changed(); }
    }
    // Speech onset from the shared endpoint: results before it belong to an older sound.
    const mark = (at = now()) => { markedAt = at - 500; };

    return {
      state, sync, mark,
      text: { notice: NOTICE, disclaimer: DISCLAIMER, indicator: INDICATOR },
      consent() {
        if (!available) return false;
        consented = true; needed = false; blocked = ''; write(true); changed(); sync(); return true;
      },
      revoke() { consented = false; write(false); changed(); sync(); },
      dismiss() { needed = false; changed(); },
      async probe(health) {
        if (!available) return state();
        try { await health(); localDown = false; } catch (error) { if (isUnavailable(error)) { localDown = true; needed = true; } }
        changed(); sync(); return state();
      },
      wrapAudio(audio) {
        if (!available || !audio) return audio;
        return { ...audio, listen: (onUtterance, onSpeech, options) => audio.listen(onUtterance, () => { mark(); onSpeech?.(); }, options) };
      },
      // Same contract as the local transcriber, so the conversation turn path is unchanged.
      async transcribe(blob, lang, signal) {
        if (!state().active) {
          try { return await transcribeLocal(blob, lang, signal); }
          catch (error) {
            if (!available || !isUnavailable(error)) throw error;
            localDown = true; needed = true; changed(); sync();
            // Already consented here: keep listening through the browser (the indicator shows it).
            // This phrase is lost either way; without consent the page shows the notice.
            if (state().active) return { text: '', model: MODEL, fallback: 'activated' };
            throw error;
          }
        }
        let text = take();
        if (!text && !signal?.aborted) {
          text = await new Promise(resolve => {
            const done = value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (waiter === done) waiter = null; resolve(value); };
            const abort = () => done('');
            const timer = setTimeout(() => done(take()), waitMs);
            signal?.addEventListener('abort', abort, { once: true });
            waiter = done;
          });
        }
        return { text, model: MODEL, language: recognitionLanguage(language()).slice(0, 2) };
      }
    };
  }

  // Notice, settings toggle and indicator. The page provides the three hosts.
  function mountSpeechFallbackPanel(fallback, { notice, settings, indicator }, { onConsent = () => {} } = {}) {
    const text = fallback.text, doc = notice.ownerDocument;
    const node = (tag, props = {}) => Object.assign(doc.createElement(tag), props);
    const accept = node('button', { type: 'button', className: 'button primary', textContent: 'Utiliser la reconnaissance du navigateur' });
    const later = node('button', { type: 'button', className: 'button', textContent: 'Pas maintenant' });
    const actions = node('div', { className: 'conversation-audio-actions' }); actions.append(accept, later);
    notice.replaceChildren(node('p', { textContent: text.notice }), node('p', { className: 'muted', textContent: text.disclaimer }), actions);
    const toggle = node('input', { type: 'checkbox', id: 'conversationBrowserStt' });
    const label = node('label', { className: 'conversation-toggle' });
    label.append(toggle, ' Reconnaissance du navigateur si la transcription locale est indisponible');
    const status = node('p', { className: 'muted' });
    settings.replaceChildren(label, node('p', { className: 'muted', textContent: text.disclaimer }), status);
    indicator.textContent = text.indicator;
    accept.onclick = () => { if (fallback.consent()) onConsent(); };
    later.onclick = () => fallback.dismiss();
    toggle.onchange = () => { if (!toggle.checked) fallback.revoke(); else if (fallback.consent()) onConsent(); };
    const render = (current = fallback.state()) => {
      settings.hidden = !current.available; notice.hidden = !current.needed; indicator.hidden = !current.running;
      toggle.checked = current.consented;
      status.textContent = current.blocked || (current.active ? 'Active : la transcription locale est indisponible.' : '');
    };
    render();
    return render;
  }

  const api = { createSpeechFallback, mountSpeechFallbackPanel, isUnavailable, recognitionLanguage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NestorSpeechFallback = api;
})(typeof window === 'undefined' ? globalThis : window);
