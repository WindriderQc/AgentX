'use strict';
(function exposeConversationImages(root) {
  const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const ROUTE = new RegExp('^/api/voice-personas/(family|private)/sessions/[a-zA-Z0-9_-]{1,80}/images/(' + UUID + ')$');
  const ACTIVE = new Set(['queued', 'accepted', 'reserving', 'generating', 'archiving', 'restoring']);
  const LABELS = { queued: 'Ton dessin attend son tour.', accepted: 'Ton dessin est demandé.', reserving: 'Préparation du dessin…', generating: 'Ton dessin prend forme…',
    archiving: 'Conservation du dessin…', restoring: 'Dernières vérifications…', completed: 'Ton image est prête.',
    failed: 'Le dessin n’a pas pu être préparé.', cancelled: 'Le dessin a été annulé.',
    archive_failed: 'Le dessin attend sa récupération dans l’atelier.', unknown: 'L’état du dessin doit être vérifié dans l’atelier. Aucune nouvelle image n’est lancée automatiquement.' };
  function node(tag, text) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; }
  function valid(operation, space) {
    const match = ROUTE.exec(operation?.statusUrl || '');
    return Boolean(match && match[1] === (space === 'family' ? 'family' : 'private') && match[2] === operation.id);
  }
  function create(block, { space = 'personal', fetcher = root.fetch?.bind(root), delay = 1500 } = {}) {
    const holder = node('div'); holder.className = 'conversation-image';
    const status = node('p'); status.className = 'display-block-note'; status.setAttribute?.('role', 'status');
    holder.append(status);
    let operation = block.operation, timer, controller, disposed = false;
    holder._dispose = () => { disposed = true; clearTimeout(timer); controller?.abort(); };
    if (!valid(operation, space)) { status.textContent = block.body || 'Demande image indisponible.'; return holder; }
    const statusUrl = operation.statusUrl, id = operation.id;
    const links = node('div'); links.className = 'display-block-actions';
    const atelier = node('a', 'Continuer dans l’atelier'); atelier.href = `/images?operation=${id}`; atelier.target = '_blank'; atelier.rel = 'noopener noreferrer';
    links.append(atelier); holder.append(links);
    let figure;
    function show(op) {
      operation = op;
      const ready = op.state === 'completed' && op.runtimeRestored === true
        && /^[a-f0-9]{64}$/.test(op.artifact?.sha256 || '') && op.artifact.url === statusUrl + '/image';
      status.textContent = ready ? LABELS.completed : op.state === 'completed' ? 'La disponibilité de l’image reste à confirmer.' : LABELS[op.state] || LABELS.unknown;
      if (ready && !figure) {
        figure = node('figure'); figure.className = 'display-block-figure';
        const img = node('img'); img.src = op.artifact.url; img.alt = block.title || block.body || 'Création locale'; img.loading = 'lazy'; img.decoding = 'async';
        img.addEventListener('error', () => { figure.replaceChildren(node('p', 'Cette image n’est plus disponible.')); }, { once: true });
        const download = node('a', 'Télécharger l’image'); download.href = op.artifact.url; download.download = `image-${id}.png`;
        figure.append(img, download); holder.append(figure);
      }
      if (!ready && figure) { figure.remove(); figure = null; }
      return ACTIVE.has(op.state);
    }
    async function poll() {
      if (disposed || holder.isConnected === false) return holder._dispose();
      let timeout;
      try {
        controller = new AbortController(); timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetcher(statusUrl, { signal: controller.signal, cache: 'no-store', redirect: 'error' });
        const data = await response.json();
        if (!response.ok || !data.ok) throw Object.assign(new Error('Read unavailable'), { terminal: response.status === 404 });
        if (data.operation?.id !== id || data.operation.statusUrl !== statusUrl || !valid(data.operation, space)) throw Object.assign(new Error('Invalid receipt'), { terminal: true });
        if (!disposed && show(data.operation)) timer = setTimeout(poll, delay);
      } catch (error) {
        if (disposed) return;
        status.textContent = error.terminal ? 'Cette demande n’est plus disponible dans la conversation.'
          : 'Connexion interrompue. Vérification du dessin en cours…';
        if (!error.terminal) timer = setTimeout(poll, 5000);
      } finally { clearTimeout(timeout); }
    }
    show(operation);
    // Restored cards read the current receipt too. Reads never resubmit a creation.
    if (fetcher) timer = setTimeout(poll, 0);
    return holder;
  }
  async function resume(base, add, { fetcher = root.fetch?.bind(root), current = () => true } = {}) {
    if (!/^\/api\/voice-personas\/(?:family|private)\/sessions\/[a-zA-Z0-9_-]{1,80}$/.test(base)) return;
    try {
      const response = await fetcher(base + '/images', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (!response.ok || !data.ok || !current()) return;
      for (const block of (data.blocks || []).slice(0, 30).reverse()) {
        if (block.kind === 'image' && block.source === 'local' && block.operation?.statusUrl === base + '/images/' + block.operation.id) add(block);
      }
    } catch { /* Existing history remains usable; recovery never creates another image. */ }
  }
  root.ConversationImages = Object.freeze({ create, resume, valid });
}(typeof window !== 'undefined' ? window : globalThis));
