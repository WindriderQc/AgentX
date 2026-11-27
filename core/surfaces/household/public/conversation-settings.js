/* Keep the conversation settings and engine choice reachable on small screens. */
(function () {
  'use strict';
  function mount({ panel, toggle, engine, newButton, startNew }) {
    function setOpen(visible) {
      panel.hidden = !visible;
      toggle.setAttribute('aria-expanded', String(visible));
      if (!visible) return;
      panel.scrollIntoView({ block: 'start' });
      const rect = engine.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight) engine.scrollIntoView({ block: 'center' });
    }
    toggle.onclick = () => setOpen(panel.hidden);
    panel.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      setOpen(false); toggle.focus();
    });
    newButton.onclick = () => {
      startNew();
      setOpen(true);
      engine.focus({ preventScroll: true });
    };
    return { setOpen };
  }
  async function startVoiceOnArrival({ waitForVisible, current, start, status, french, signal }) {
    function defer() {
      if (!waitForVisible) return;
      const onVisible = () => {
        if (document.hidden) return;
        document.removeEventListener('visibilitychange', onVisible);
        void checkPermission();
      };
      document.addEventListener('visibilitychange', onVisible, { signal });
    }
    async function checkPermission() {
      if (!current()) return;
      if (document.hidden) return defer();
      try {
        const permission = await navigator.permissions?.query({ name: 'microphone' });
        if (!current()) return;
        if (document.hidden) return defer();
        if (permission?.state === 'granted') await start();
        else status.textContent = french() ? 'Appuyez sur Activer Nestor pour autoriser le micro et le son.' : 'Turn on Nestor once to allow the mic and sound.';
      } catch {
        if (current() && !document.hidden) status.textContent = french() ? 'Appuyez sur Activer Nestor pour reprendre le micro et le son.' : 'Press Turn on Nestor to set up this device.';
      }
    }
    return checkPermission();
  }
  window.ConversationSettings = { mount, startVoiceOnArrival };
}());
