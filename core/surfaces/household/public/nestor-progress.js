/* Compact read-only status, sourced from the existing workflow receipts. */
(function (root) {
  'use strict';
  const terminal = new Set(['completed', 'result_ready', 'failed', 'cancelled', 'interrupted']);
  const names = {
    fr: { received: 'Demande envoyée', queued: 'En attente', dispatching: 'Démarrage', running: 'Traitement Nestor',
      tool: 'Outil en cours', uncertain: 'État à vérifier', paused: 'En pause', completed: 'Terminé', result_ready: 'Résultat prêt',
      failed: 'Erreur', cancelled: 'Annulé', interrupted: 'Interrompu', stale: 'État indisponible', remaining: 'restantes', elapsed: 'écoulées' },
    en: { received: 'Request sent', queued: 'Waiting', dispatching: 'Starting', running: 'Nestor processing',
      tool: 'Tool running', uncertain: 'State to verify', paused: 'Paused', completed: 'Completed', result_ready: 'Result ready',
      failed: 'Error', cancelled: 'Cancelled', interrupted: 'Interrupted', stale: 'Status unavailable', remaining: 'remaining', elapsed: 'elapsed' }
  };
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const seconds = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  function project(view, now = Date.now(), thresholdMs = 5000) {
    const items = [];
    for (const row of view.turns || []) {
      if (Number.isFinite(row.browserStartedAt) && !(row.deferred && row.works?.length)) {
        const elapsedMs = Math.max(0, (row.browserEndedAt ?? now) - row.browserStartedAt);
        const activity = row.currentActivity;
        const state = row.error ? 'failed' : row.interrupted ? 'interrupted' : row.done ? 'completed'
          : row.deferred ? 'queued' : activity?.kind === 'tool' ? 'tool' : row.phase === 'waiting_host' ? 'queued'
            : ['processing', 'tool_result'].includes(activity?.kind) || row.firstText || row.phase === 'generating' ? 'running' : 'received';
        if (elapsedMs >= thresholdMs || state === 'failed') items.push({ id: row.id, state, elapsedMs,
          stale: !terminal.has(state) && view.stale, tool: state === 'tool' ? activity.tool : null });
      }
      for (const work of row.works || []) {
        // The foreground request already has its own record; retain separately owned background work.
        if (work.classification === 'native_only' && (row.live || row.done)) continue;
        const start = Date.parse(work.receivedAt);
        if (!Number.isFinite(start)) continue;
        const finished = terminal.has(work.state) ? Date.parse(work.updatedAt) : now;
        const elapsedMs = Math.max(0, (Number.isFinite(finished) ? finished : now) - start);
        if (elapsedMs < thresholdMs && work.state !== 'failed') continue;
        items.push({ id: work.id, state: work.state, elapsedMs, stale: view.stale && !terminal.has(work.state),
          ...(valid(work.remainingMs) && { remainingMs: work.remainingMs }) });
      }
    }
    return items;
  }
  function create({ host, getLanguage = () => 'fr' }) {
    let view = { turns: [] }, disposed = false;
    const document = host.ownerDocument;
    const parent = host.parentNode, next = host.nextSibling;
    function place() {
      const scene = ['plein', 'montre'].includes(document.body.dataset.avatarView)
        && document.querySelector('.avatar-scene-bar');
      if (scene && host.parentNode !== scene) scene.prepend(host);
      else if (!scene && host.parentNode !== parent) parent.insertBefore(host, next?.parentNode === parent ? next : null);
    }
    const observer = new root.MutationObserver(place);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-avatar-view'] });
    place();
    const details = document.createElement('details'); details.className = 'nestor-progress';
    const summary = document.createElement('summary'), label = document.createElement('span'), clock = document.createElement('span');
    label.setAttribute('role', 'status'); clock.setAttribute('aria-live', 'off'); summary.append(label, clock);
    const list = document.createElement('ul'); details.append(summary, list); host.append(details);
    function render() {
      if (disposed) return;
      if (!parent.isConnected) { dispose(); return; }
      const items = project(view), copy = names[getLanguage() === 'en' ? 'en' : 'fr'];
      host.hidden = !items.length;
      if (!items.length) return;
      const active = items.filter(item => !terminal.has(item.state));
      const current = active.at(-1) || items.at(-1);
      const state = item => copy[item.stale ? 'stale' : item.state] || copy.uncertain;
      const text = `Nestor · ${state(current)}${active.length > 1 ? ` · ${active.length}` : ''}`;
      if (label.textContent !== text) label.textContent = text;
      clock.textContent = ` · ${seconds(current.elapsedMs)} ${copy.elapsed}`
        + (valid(current.remainingMs) ? ` · ~${seconds(current.remainingMs)} ${copy.remaining}` : '');
      list.replaceChildren(...items.slice(-12).map(item => {
        const li = document.createElement('li'); li.dataset.state = item.state;
        li.textContent = `${state(item)} · ${seconds(item.elapsedMs)}${item.tool ? ` · ${item.tool}` : ''}`;
        return li;
      }));
    }
    const timer = setInterval(render, 1000); timer.unref?.();
    render();
    function dispose() { disposed = true; observer.disconnect(); clearInterval(timer); host.replaceChildren(); host.hidden = true;
      if (host.parentNode !== parent) host.remove(); }
    return { update(next) { view = next; render(); }, dispose };
  }
  root.NestorProgress = { create, project };
  if (typeof module === 'object' && module.exports) module.exports = { project };
})(typeof window === 'undefined' ? globalThis : window);
