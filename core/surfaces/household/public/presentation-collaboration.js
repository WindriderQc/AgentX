'use strict';

(function expose(root) {
  function observer({ board, api, base, getSession }) {
    let generation = 0, timer, sequence = 0, previous = '', binding = null, detach = null;
    const manual = () => root.dispatchEvent(new CustomEvent('nestor-presentation-user-change'));
    function bindFrame() {
      const frame = document.querySelector('.page-presentation .display-block:not([hidden]) iframe');
      try {
        const doc = frame?.contentDocument;
        if (frame === bindFrame.current && doc === bindFrame.document && detach) return;
        detach?.(); detach = null; bindFrame.current = frame; bindFrame.document = doc;
        if (!frame || !doc?.body || doc.location.href === 'about:blank' || frame.contentWindow.location.origin !== root.location.origin) return;
        const child = frame.contentWindow;
        child.addEventListener('pointerdown', manual, true); child.addEventListener('keydown', manual, true);
        detach = () => { child.removeEventListener('pointerdown', manual, true); child.removeEventListener('keydown', manual, true); };
      } catch { /* External pages expose no local interaction or read capability. */ }
    }
    function stop() { generation++; clearTimeout(timer); detach?.(); detach = null; bindFrame.current = bindFrame.document = null; binding = null; }
    function begin(sessionId, turnId) {
      stop(); binding = { sessionId, turnId, expiresAt: Date.now() + 300000 }; sequence = 0; previous = '';
      const epoch = generation;
      async function tick() {
        if (epoch !== generation || !binding || Date.now() > binding.expiresAt || getSession()?.sessionId !== sessionId) return;
        bindFrame();
        const screen = board.context(), value = JSON.stringify(screen);
        if (value !== previous) {
          previous = value;
          try {
            await api(`${base}/${encodeURIComponent(sessionId)}/companion/observations`, {
              method: 'POST', body: JSON.stringify({ turnId, sequence: ++sequence, screen }) });
          } catch { previous = ''; /* Retry the idempotent current observation, never claim delivery. */ }
        }
        if (epoch === generation) timer = setTimeout(() => { void tick(); }, 1000);
      }
      void tick();
    }
    return { begin, stop };
  }
  function focus(card, block) {
    if (!card?._screenFrame || card._screenTarget?.page !== 'ecosystem') return false;
    const target = root.AgentXScreenPages.parse(block.body);
    if (target?.page !== 'ecosystem' || !target.focus.play) return false;
    try {
      const frame = card._screenFrame;
      if (frame.contentWindow.location.origin !== root.location.origin) return false;
      const result = frame.contentWindow.AgentXPresentationControls?.present({ page: 'ecosystem', play: target.focus.play });
      if (result?.accepted !== true) return false;
      card._screenTarget = target; card._displayBlock = block;
      card.querySelector('.display-block-title').textContent = block.title;
      // A requested focus is not a rendered or domain-effect receipt. The next
      // observation reads the component's actual post-render state.
      return true;
    } catch { return false; }
  }
  function review(block, { content, actions, space }) {
    if (space !== 'personal') return false;
    const target = root.AgentXScreenPages.parse(block.destination);
    if (!target || !root.AgentXScreenPages.keepsConversation(target)) return false;
    const note = document.createElement('p'); note.className = 'display-block-note';
    note.textContent = 'Proposition à vérifier. Aucun envoi, suppression ou changement n’a été exécuté.';
    content.append(note);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'display-block-action';
    button.textContent = 'Vérifier dans l’outil';
    button.addEventListener('click', () => {
      root.dispatchEvent(new CustomEvent('nestor-presentation-user-change'));
      root.dispatchEvent(new CustomEvent('nestor-review-destination', { detail: { kind: 'page', body: block.destination,
        title: root.AgentXScreenPages.label(target) } }));
    });
    actions.append(button);
    return true;
  }
  root.NestorPresentationCollaboration = Object.freeze({ observer, focus, review });
}(typeof window === 'undefined' ? globalThis : window));
