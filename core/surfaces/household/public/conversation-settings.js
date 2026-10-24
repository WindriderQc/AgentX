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
  window.ConversationSettings = { mount };
}());
