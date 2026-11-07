/* Historical page references come only from the resumed canonical turns.
   They never mount a frame or resolve a read cache. No second history store. */
(function (root) {
  'use strict';
  const clean = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : '';
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  function metadata(block, turn = {}) {
    turn = turn || {};
    const pages = root.AgentXScreenPages;
    const target = pages?.parse(block.body), previous = pages?.parse(turn.presentationContext?.page);
    const matches = target && previous && turn.presentationContext.kind === 'page'
      && pages.canonical(target) === pages.canonical(previous);
    // This is the observation at the INPUT of that turn, never a receipt that
    // the page proposed in the answer loaded. Preserve its captured values.
    const snapshot = matches ? JSON.parse(JSON.stringify(turn.presentationContext)) : null;
    return { recordedAt: date(turn.createdAt), sourceTurnId: clean(turn.clientTurnId || turn.traceId, 80), snapshot };
  }
  function create({ block, target, turn, onOpen }) {
    const data = metadata(block, turn);
    const holder = document.createElement('div'); holder.className = 'display-page-history display-block-text';
    const note = document.createElement('p'); note.className = 'display-block-note';
    note.textContent = 'Référence historique' + (data.recordedAt ? ` · tour du ${data.recordedAt}` : ' · date du tour non conservée')
      + '. Cette référence ne charge pas la page actuelle.';
    holder.append(note);
    const evidence = document.createElement('p');
    evidence.textContent = data.snapshot ? 'Observation conservée à l’entrée de ce tour, sans actualisation. Elle ne prouve pas le chargement de la page proposée dans la réponse.'
      : 'Aucune observation conservée pour cette référence. Les données actuelles sont inconnues.';
    holder.append(evidence);
    if (data.snapshot) {
      const details = document.createElement('details'), summary = document.createElement('summary');
      summary.textContent = 'Données conservées';
      const saved = document.createElement('pre'); saved.className = 'display-block-code';
      const source = JSON.stringify(data.snapshot, null, 2);
      saved.textContent = source.slice(0, 32768);
      details.append(summary, saved);
      if (source.length > 32768) {
        const limit = document.createElement('p'); limit.textContent = 'Aperçu limité à 32 768 caractères ; le tour conserve la source complète.'; details.append(limit);
      }
      holder.append(details);
    }
    const open = document.createElement('button'); open.type = 'button'; open.className = 'display-block-action';
    open.textContent = 'Ouvrir la vue actuelle';
    let opened = false;
    open.addEventListener('click', () => {
      if (opened || !holder.isConnected) return;
      // Revalidate against today's catalogue. An erased/detached conversation
      // and an unknown destination cannot produce a late frame or request.
      const current = root.AgentXScreenPages?.parse(block.body);
      if (!current || root.AgentXScreenPages.canonical(current) !== root.AgentXScreenPages.canonical(target)
        || onOpen({ ...block, body: root.AgentXScreenPages.canonical(current) }) !== true) {
        evidence.textContent = 'Cette destination n’est plus disponible dans le catalogue. Aucune page n’a été ouverte.'; return;
      }
      opened = true; open.disabled = true; open.textContent = 'Nouvelle lecture demandée';
    });
    holder.append(open);
    holder._historicalPage = data;
    return holder;
  }
  root.NestorPageHistory = Object.freeze({ metadata, create });
})(typeof window === 'undefined' ? globalThis : window);
