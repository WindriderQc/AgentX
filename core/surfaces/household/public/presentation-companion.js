'use strict';

(function expose(root) {
  function create({ host, board, api, base, getSession, pollMs = 1200 }) {
    const label = document.createElement('label'), toggle = document.createElement('input');
    toggle.type = 'checkbox'; toggle.setAttribute('aria-label', 'Affichage contextuel');
    label.className = 'presentation-companion-toggle';
    label.append(toggle, document.createTextNode(' Affichage contextuel'));
    const status = document.createElement('small'); status.className = 'presentation-companion-status'; status.setAttribute('role', 'status');
    host.append(label, status);
    let sessionId = null, turnId = null, timer = null, controller = null, epoch = 0, paused = false, fingerprint = null;
    let enabledForTurn = false, expiresAt = 0;
    const clear = () => { clearTimeout(timer); timer = null; controller?.abort(); controller = null; };
    async function stopRemote(id, turn) {
      if (!id || !turn) return;
      try { await api(`${base}/${encodeURIComponent(id)}/companion/stop`, { method: 'POST', body: JSON.stringify({ turnId: turn }) }); } catch { /* next turn also invalidates it */ }
    }
    function pause() { paused = true; epoch++; clear(); if (enabledForTurn) void stopRemote(sessionId, turnId); }
    toggle.onchange = () => {
      pause(); status.textContent = toggle.checked ? 'Actif à partir du prochain message.' : '';
    };
    const manual = () => { pause(); status.textContent = toggle.checked ? 'Vue conservée pour ce message.' : ''; };
    root.addEventListener('nestor-presentation-user-change', manual);
    async function poll(generation) {
      if (generation !== epoch || paused || !enabledForTurn || Date.now() > expiresAt) return;
      if (getSession()?.sessionId !== sessionId) { pause(); return; }
      controller = new AbortController();
      try {
        const data = await api(`${base}/${encodeURIComponent(sessionId)}/companion/${encodeURIComponent(turnId)}`, { signal: controller.signal });
        if (generation !== epoch || paused || data.turnId !== turnId || getSession()?.sessionId !== sessionId) return;
        if (data.state === 'ready' && data.suggestion?.fingerprint !== fingerprint) {
          // Backend validation is authoritative; also constrain browser fixtures
          // and stale clients to the same inert display-only surface.
          const block = data.suggestion?.block;
          if (block?.from === 'companion' && ['page', 'text', 'list', 'table'].includes(block.kind)
              && board.addCompanion?.(block)) {
            fingerprint = data.suggestion.fingerprint; status.textContent = 'Affichage adapté au contexte.';
          }
        } else if (data.state === 'unavailable') status.textContent = 'Suivi visuel indisponible ; la conversation continue.';
        else if (data.state === 'limited') status.textContent = 'Suivi visuel en pause pour ce message.';
      } catch (error) {
        if (generation === epoch && error.name !== 'AbortError') status.textContent = 'Suivi visuel indisponible ; la conversation continue.';
      } finally {
        if (generation === epoch && !paused) timer = setTimeout(() => { void poll(generation); }, pollMs);
      }
    }
    const observer = new MutationObserver(() => {
      if (host.isConnected) return;
      observer.disconnect(); pause(); root.removeEventListener('nestor-presentation-user-change', manual);
    });
    observer.observe(host.closest('#app') || document.body, { childList: true, subtree: true });
    return {
      enabled: session => toggle.checked && session?.backend === 'hermes' && !session.ephemeral && board.canFollow?.() !== false,
      begin(session, id) {
        const previous = sessionId, previousTurn = turnId; clear(); epoch++; paused = false; fingerprint = null;
        sessionId = session.sessionId; turnId = id;
        enabledForTurn = this.enabled(session); expiresAt = Date.now() + 300000;
        if (previous && previous !== sessionId) void stopRemote(previous, previousTurn);
        status.textContent = '';
        return enabledForTurn;
      },
      follow() { if (enabledForTurn) void poll(epoch); },
      explicit: pause,
      configure(backend) { label.hidden = status.hidden = backend !== 'hermes'; if (backend !== 'hermes') pause(); },
      reset() { pause(); sessionId = turnId = null; status.textContent = ''; },
      destroy() { observer.disconnect(); pause(); root.removeEventListener('nestor-presentation-user-change', manual); label.remove(); status.remove(); }
    };
  }
  root.NestorPresentationCompanion = Object.freeze({ create });
}(typeof window === 'undefined' ? globalThis : window));
