'use strict';
(function exposeConversationImages(root) {
  const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const ROUTE = new RegExp('^/api/voice-personas/(family|private)/sessions/[a-zA-Z0-9_-]{1,80}/images/(' + UUID + ')$');
  const ACTIVE = new Set(['queued', 'accepted', 'reserving', 'generating', 'archiving', 'restoring']);
  const EN = {
    states: { queued: 'Your drawing is waiting its turn.', accepted: 'Your drawing has been requested.', reserving: 'Preparing the drawing…', generating: 'Your drawing is taking shape…',
    archiving: 'Saving the drawing…', restoring: 'Final checks…', completed: 'Your image is ready.',
    failed: 'The drawing could not be prepared.', cancelled: 'The drawing was cancelled.',
    archive_failed: 'The drawing is waiting to be recovered in the workshop.', unknown: 'The drawing’s state must be checked in the workshop. No new image is started automatically.' },
    unavailable: 'Image request unavailable.',
    workshop: 'Continue in the workshop',
    parent: 'The drawing needs a parent to check it. No new drawing is started automatically.',
    pendingProof: 'The image’s availability is still to be confirmed.',
    creation: 'Local creation',
    missing: 'This image is no longer available.',
    download: 'Download the image',
    gone: 'This request is no longer available in the conversation.',
    retry: 'Connection interrupted. Checking the drawing…',
  };
  const FR = {
    states: {
      queued: 'Ton dessin attend son tour.',
      accepted: 'Ta demande de dessin est reçue.',
      reserving: 'Préparation du dessin…',
      generating: 'Ton dessin prend forme…',
      archiving: 'Enregistrement du dessin…',
      restoring: 'Dernières vérifications…',
      completed: 'Ton image est prête.',
      failed: 'Le dessin n’a pas pu être préparé.',
      cancelled: 'Le dessin a été annulé.',
      archive_failed: 'Le dessin est à récupérer dans l’atelier.',
      unknown: 'L’état du dessin est à vérifier dans l’atelier.',
    },
    unavailable: 'La demande d’image est indisponible.',
    workshop: 'Continuer dans l’atelier',
    parent: 'Demande à un parent de vérifier ton dessin.',
    pendingProof: 'Je vérifie si l’image est disponible.',
    creation: 'Création locale',
    missing: 'Cette image est indisponible.',
    download: 'Télécharger l’image',
    gone: 'Cette demande est introuvable dans la conversation.',
    retry: 'Connexion interrompue. Vérification du dessin…',
  };
  function node(tag, text) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; }
  function valid(operation, space) {
    const match = ROUTE.exec(operation?.statusUrl || '');
    return Boolean(match && match[1] === (space === 'family' ? 'family' : 'private') && match[2] === operation.id);
  }
  function create(block, { space = 'personal', language = 'en', fetcher = root.fetch?.bind(root), delay = 1500 } = {}) {
    const labels = language === 'fr' ? FR : EN;
    const holder = node('div'); holder.className = 'conversation-image';
    const status = node('p'); status.className = 'display-block-note'; status.setAttribute?.('role', 'status');
    holder.append(status);
    let presentationState = 'unavailable';
    holder._presentationState = () => presentationState;
    let operation = block.operation, timer, controller, disposed = false;
    holder._dispose = () => { disposed = true; clearTimeout(timer); controller?.abort(); };
    if (!valid(operation, space)) { status.textContent = block.body || labels.unavailable; return holder; }
    const statusUrl = operation.statusUrl, id = operation.id;
    // The workshop is the adult Atelier: a family drawing stays in its conversation.
    const family = space === 'family';
    if (!family) {
      const links = node('div'); links.className = 'display-block-actions';
      const atelier = node('a', labels.workshop); atelier.href = `/images?operation=${id}`; atelier.target = '_blank'; atelier.rel = 'noopener noreferrer';
      links.append(atelier); holder.append(links);
    }
    function label(state) {
      const known = Object.hasOwn(labels.states, state);
      if (family && (!known || state === 'archive_failed' || state === 'unknown')) return labels.parent;
      return known ? labels.states[state] : labels.states.unknown;
    }
    let figure;
    function show(op) {
      operation = op;
      const ready = op.state === 'completed' && op.runtimeRestored === true
        && /^[a-f0-9]{64}$/.test(op.artifact?.sha256 || '') && op.artifact.url === statusUrl + '/image';
      presentationState = ready || ACTIVE.has(op.state) ? 'loading' : 'unavailable';
      status.textContent = ready ? labels.states.completed : op.state === 'completed' ? labels.pendingProof : label(op.state);
      if (ready && !figure) {
        figure = node('figure'); figure.className = 'display-block-figure';
        const img = node('img'); img.src = op.artifact.url; img.alt = block.title || block.body || labels.creation; img.loading = 'lazy'; img.decoding = 'async';
        img.addEventListener('load', () => { presentationState = 'visible'; }, { once: true });
        img.addEventListener('error', () => { presentationState = 'unavailable'; figure.replaceChildren(node('p', labels.missing)); }, { once: true });
        const download = node('a', labels.download); download.href = op.artifact.url; download.download = `image-${id}.png`;
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
        presentationState = 'unavailable';
        status.textContent = error.terminal ? labels.gone
          : labels.retry;
        if (!error.terminal) timer = setTimeout(poll, 5000);
      } finally { clearTimeout(timeout); }
    }
    show(operation);
    // Restored cards read the current receipt too. Reads never resubmit a creation.
    if (fetcher) timer = setTimeout(poll, 0);
    return holder;
  }
  function addExplicit(base, block, board, present = value => board.add(value)) {
    const space = /^\/api\/voice-personas\/(family|private)\/sessions\/[a-zA-Z0-9_-]{1,80}$/.exec(base)?.[1];
    const operation = block?.operation;
    if (!space || block?.kind !== 'image' || block.source !== 'local' || block.presentation === 'illustration'
        || !valid(operation, space) || operation.statusUrl !== base + '/images/' + operation.id) return false;
    if (!board.has('image:' + operation.id)) present(block);
    return true;
  }
  async function resume(base, add, { fetcher = root.fetch?.bind(root), current = () => true } = {}) {
    if (!/^\/api\/voice-personas\/(?:family|private)\/sessions\/[a-zA-Z0-9_-]{1,80}$/.test(base)) return;
    try {
      const response = await fetcher(base + '/images', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (!response.ok || !data.ok || !current()) return;
      for (const block of (data.blocks || []).slice(0, 30).reverse()) {
        // Illustrations belong to the live frame; a reopened conversation does not replay them.
        if (block.kind === 'image' && block.source === 'local' && block.presentation !== 'illustration'
          && block.operation?.statusUrl === base + '/images/' + block.operation.id) add(block);
      }
    } catch { /* Existing history remains usable; recovery never creates another image. */ }
  }
  root.ConversationImages = Object.freeze({ create, resume, valid, addExplicit });
}(typeof window !== 'undefined' ? window : globalThis));
