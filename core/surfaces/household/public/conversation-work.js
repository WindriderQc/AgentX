/* Core's durable work projection. Polling never starts inference. */
(function (root) {
  'use strict';
  const COPY = {
    en: {
      states: { received: 'Request saved', queued: 'Waiting to start', dispatching: 'Starting', paused: 'Request paused',
        running: 'In progress', uncertain: 'Execution to verify', failed: 'Request failed', cancelled: 'Request cancelled',
        result_ready: 'Answer ready', completed: 'Answer ready' },
      request: 'Your request', review: 'Answer review', missing: 'Original request unavailable', full: 'Read the full request',
      answer: 'Answer to verify', available: 'Answer available', presented: 'Answer presented',
      wait: 'Work has not started. No completion estimate is available.',
      blocked: 'Blocked before start', blockedDetail: 'An earlier execution must be verified before Main can start this request.',
      reviewQueued: 'Answer review waiting to start', authFailure: 'Authentication was refused for this attempt. It failed and was not restarted.',
      running: 'Work has started. No completion estimate is available.',
      paused: 'This request will wait until you resume it.', cancelled: 'This request was cancelled before execution.',
      controls: 'These controls apply only to this request. Voice controls are above.',
      unavailable: 'Controls are unavailable until the original request can be identified.',
      native: 'Execution has been handed off. These controls cannot stop it.',
      uncertain: 'Execution is unconfirmed. Its owner must verify it before another attempt.',
      failed: 'No answer was received. This request was not restarted.',
      pause: 'Pause this request', resume: 'Resume this request', cancel: 'Cancel this request',
      pauseBusy: 'Pausing…', resumeBusy: 'Resuming…', cancelBusy: 'Cancelling…',
      checking: 'Command not confirmed. Checking this request before allowing another command.',
      stale: 'Status unavailable. Showing the last received state; controls are disabled until it refreshes.',
      listen: 'Listen to this answer', requested: 'Playback requested at the next pause',
      playback: 'Answer kept · playback not confirmed', summary: 'Nestor’s requests', updated: 'Last update', unknownTime: 'time unavailable'
    },
    fr: {
      states: { received: 'Demande enregistrée', queued: 'En attente de démarrage', dispatching: 'Démarrage en cours', paused: 'Demande en pause',
        running: 'En cours', uncertain: 'Exécution à vérifier', failed: 'Demande échouée', cancelled: 'Demande annulée',
        result_ready: 'Réponse prête', completed: 'Réponse prête' },
      request: 'Votre demande', review: 'Vérification de réponse', missing: 'Demande originale indisponible', full: 'Lire la demande complète',
      answer: 'Réponse à vérifier', available: 'Réponse disponible', presented: 'Réponse présentée',
      wait: 'Le travail n’a pas commencé. Aucun délai de fin n’est disponible.',
      blocked: 'Bloquée avant démarrage', blockedDetail: 'Une exécution précédente doit être vérifiée avant que Main puisse commencer cette demande.',
      reviewQueued: 'Vérification de réponse en attente', authFailure: 'L’authentification a été refusée pour cette tentative. Elle a échoué et n’a pas été relancée.',
      running: 'Le travail a commencé. Aucun délai de fin n’est disponible.',
      paused: 'Cette demande attendra que vous la repreniez.', cancelled: 'Cette demande a été annulée avant son exécution.',
      controls: 'Ces commandes concernent cette demande seulement. Les commandes vocales sont en haut.',
      unavailable: 'Les commandes sont indisponibles tant que la demande originale ne peut pas être identifiée.',
      native: 'L’exécution a été transmise. Ces commandes ne peuvent plus l’arrêter.',
      uncertain: 'L’exécution n’est pas confirmée. Son responsable doit la vérifier avant un nouvel essai.',
      failed: 'Aucune réponse reçue. Cette demande n’a pas été relancée.',
      pause: 'Mettre cette demande en pause', resume: 'Reprendre cette demande', cancel: 'Annuler cette demande',
      pauseBusy: 'Mise en pause…', resumeBusy: 'Reprise…', cancelBusy: 'Annulation…',
      checking: 'Commande non confirmée. Vérification de cette demande avant de permettre une autre commande.',
      stale: 'État indisponible. Le dernier état reçu est affiché; les commandes sont désactivées jusqu’à son actualisation.',
      listen: 'Écouter cette réponse', requested: 'Lecture demandée à la prochaine pause',
      playback: 'Réponse conservée · lecture non confirmée', summary: 'Demandes de Nestor', updated: 'Dernière mise à jour', unknownTime: 'heure indisponible'
    }
  };
  function create({ host, base, api, getConversation, getLanguage = () => getConversation()?.selection?.language || 'en',
    maySpeak = () => true, onShow = () => {}, onSnapshot = () => {}, onPollError = () => {}, pollMs = 2000 }) {
    const deviceSession = root.crypto.randomUUID(), items = new Map(), cards = new Map(), attempted = new Set(), requested = new Set(), commands = new Map();
    let sessionId, cursor = 0, sequence = 0, timer, pollController, presenting = false, disposed = false, generation = 0, stale = false, refreshQueued = false, summary, dispatch;
    const language = () => getLanguage() === 'fr' ? 'fr' : 'en';
    const copy = () => COPY[language()];
    const url = () => `${base}/${encodeURIComponent(sessionId)}`;
    const receipt = (item, stage, claimToken) => api(`${base}/${encodeURIComponent(item.sessionId)}/work-deliveries/${encodeURIComponent(item.result.deliveryId)}/receipt`, {
      method: 'POST', keepalive: true, signal: AbortSignal.timeout(10000), body: JSON.stringify({ stage, resultVersion: item.result.version,
        sequence: ++sequence, deviceSession, ...(claimToken && { claimToken }) }) });
    const identity = item => `${item.id}:${item.result?.version || 0}`;
    const node = (tag, className, text) => {
      const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
    };
    function timestamp(value) {
      const date = new Date(value);
      const at = Number.isFinite(date.getTime()) ? date.toLocaleString(language() === 'fr' ? 'fr-CA' : 'en-CA',
        { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : copy().unknownTime;
      return at;
    }
    const requestIdentity = item => `${timestamp(item.receivedAt)} · #${item.id.slice(0, 8)}`;
    function updateSummary() { if (summary) summary.textContent = `${copy().summary} · ${cards.size}`; }
    function render(item) {
      let card = cards.get(item.id);
      if (!item.pending && !item.result && !['failed', 'uncertain', 'cancelled', 'paused'].includes(item.state)) {
        card?.remove(); cards.delete(item.id); host.hidden = !cards.size; updateSummary(); return;
      }
      if (!card) {
        card = document.createElement('article'); card.className = 'conversation-work-card'; card.dataset.workId = item.id;
        card.setAttribute('aria-labelledby', `work-title-${item.id}`);
        cards.set(item.id, card); host.append(card);
      }
      const c = copy(), request = typeof item.requestText === 'string' && item.requestText.trim() ? item.requestText : null;
      const command = commands.get(item.id);
      const blocked = !item.result && item.state === 'queued' && dispatch?.state === 'blocked';
      card.dataset.state = blocked ? 'blocked' : item.state;
      const heading = node('p', 'conversation-work-status', item.result ? (item.result.presentation === 'completed' ? c.presented : c.available)
        : item.pending && item.state === 'completed' ? c.answer : c.states[item.state] || c.states.received);
      if (!item.result && item.state === 'queued') heading.textContent = blocked ? c.blocked
        : item.classification === 'native_review' ? c.reviewQueued : c.states.queued;
      const title = node('h3', 'conversation-work-request', request ? request.length > 240 ? request.slice(0, 240) + '…' : request : c.missing);
      title.id = `work-title-${item.id}`;
      const meta = node('p', 'conversation-work-meta', `${item.classification === 'native_review' ? c.review : c.request} · ${requestIdentity(item)}`);
      const expanded = card.querySelector('.conversation-work-original')?.open;
      card.replaceChildren(meta, title, heading);
      if (request?.length > 240) {
        const details = document.createElement('details'); details.className = 'conversation-work-original'; details.open = Boolean(expanded);
        details.append(node('summary', '', c.full), node('p', '', request)); card.append(details);
      }
      let detail = item.state === 'queued' || item.state === 'received' ? c.wait
        : item.state === 'running' || item.state === 'dispatching' ? c.running
        : c[item.state] || '';
      if (blocked) detail = c.blockedDetail;
      if (item.reason === 'native_authentication_failed') detail = c.authFailure;
      if (item.result) detail = '';
      if (detail) card.append(node('p', 'conversation-work-detail', detail));
      if (item.pending && item.updatedAt) card.append(node('p', 'conversation-work-meta', `${c.updated} : ${timestamp(item.updatedAt)}`));
      if (stale || command?.unconfirmed) card.append(node('p', 'conversation-work-notice', stale ? c.stale : c.checking));
      if (item.result) {
        const text = node('p', 'conversation-work-answer', item.result.displayText ?? item.result.text);
        const button = node('button', 'button', requested.has(identity(item)) ? c.requested : c.listen); button.type = 'button';
        button.setAttribute('aria-label', `${c.listen} : ${request || c.missing} · ${requestIdentity(item)}`);
        button.onclick = () => { requested.add(identity(item)); render(item); void naturalPause(); };
        card.append(text, button);
      }
      if (item.controllable && request) {
        const actions = document.createElement('div'); actions.className = 'conversation-work-actions';
        for (const action of [item.state === 'paused' ? 'resume' : 'pause', 'cancel']) {
          const button = node('button', 'button', command?.action === action ? c[action + 'Busy'] : c[action]); button.type = 'button';
          button.dataset.action = action; button.disabled = stale || Boolean(command);
          button.setAttribute('aria-label', `${c[action]} : ${request} · ${requestIdentity(item)}`);
          button.onclick = () => control(item, action);
          actions.append(button);
        }
        card.append(actions, node('p', 'conversation-work-help', c.controls));
      } else if (item.controllable) card.append(node('p', 'conversation-work-help', c.unavailable));
      else if (item.pending && item.attempt && item.state !== 'uncertain') card.append(node('p', 'conversation-work-help', c.native));
      host.hidden = false; updateSummary();
    }
    function refresh() { for (const item of items.values()) render(item); }
    async function control(item, action) {
      const currentGeneration = generation;
      if (disposed || stale || item.sessionId !== sessionId || commands.has(item.id) || items.get(item.id) !== item) return;
      commands.set(item.id, { action }); render(item);
      try {
        const saved = await api(`${base}/${encodeURIComponent(item.sessionId)}/work/${encodeURIComponent(item.id)}/control`, {
          method: 'POST', signal: AbortSignal.timeout(10000), body: JSON.stringify({ action, revision: item.revision }) });
        if (currentGeneration !== generation) return;
        commands.delete(item.id);
        const latest = items.get(item.id);
        if (saved.revision >= latest.revision) {
          const updated = { ...latest, ...saved, pending: saved.state !== 'cancelled', controllable: saved.state !== 'cancelled' };
          items.set(item.id, updated); render(updated);
        } else render(latest);
      } catch {
        if (currentGeneration !== generation) return;
        // A lost mutation response requires a fresh read, never an automatic retry.
        commands.set(item.id, { action, revision: item.revision, unconfirmed: true }); render(items.get(item.id));
      }
      if (currentGeneration === generation) await poll({ refresh: true });
    }
    async function present(item, replay) {
      const currentGeneration = generation, currentSession = sessionId;
      const key = identity(item); attempted.add(key); presenting = true;
      let claim, scheduled = false, startedReceipt;
      try {
        claim = await receipt(item, replay ? 'replay' : 'claim');
        if (currentGeneration !== generation || currentSession !== sessionId) { await receipt(item, 'deferred', claim.claimToken); return; }
        const language = item.result.language || getConversation().selection?.language || 'fr';
        const text = replay ? item.result.readingText ?? item.result.text : item.result.spokenText ?? item.result.text;
        const spoken = await getConversation().interject({ text, language }, { readAloud: replay, preserveLanguage: true, onScheduled() {
          scheduled = true; startedReceipt = receipt(item, 'started', claim.claimToken); startedReceipt.catch(() => {});
        } });
        if (startedReceipt) await startedReceipt;
        if (currentGeneration !== generation) { await receipt(item, scheduled ? 'interrupted' : 'deferred', claim.claimToken); return; }
        await receipt(item, spoken && scheduled ? 'completed' : scheduled ? 'interrupted' : 'deferred', claim.claimToken);
        item.result.presentation = spoken && scheduled ? 'completed' : scheduled ? 'interrupted' : 'deferred';
        requested.delete(key); render(item);
      } catch {
        // A lost presentation receipt is not completion and does not authorize
        // automatic replay. The saved text remains available for explicit listening.
        if (currentGeneration === generation) {
          const status = cards.get(item.id)?.querySelector('.conversation-work-status');
          if (status) status.textContent = copy().playback;
        }
      } finally { presenting = false; }
    }
    async function naturalPause() {
      const conversation = getConversation();
      if (disposed || presenting || !sessionId || conversation?.session?.sessionId !== sessionId || !maySpeak()
          || conversation.state !== 'listening' || conversation.activeTurn || conversation.turnPending
          || conversation.selection?.wakeWord && !conversation.wake.active()) return;
      const item = [...items.values()].find(row => row.result && (requested.has(identity(row))
        || (row.result.automaticSpeech === true || row.result.automaticSpeech !== false && row.classification !== 'native_review')
          && !attempted.has(identity(row)) && ['available', 'displayed', 'deferred'].includes(row.result.presentation)));
      if (item) await present(item, requested.has(identity(item)));
    }
    async function poll({ refresh: fullRead = false } = {}) {
      refreshQueued ||= fullRead;
      if (disposed || pollController || !sessionId) return;
      let nextCursor = refreshQueued ? 0 : cursor;
      refreshQueued = false;
      const reconciling = new Set([...commands].filter(([, value]) => value.unconfirmed).map(([id]) => id));
      const currentGeneration = generation, controller = new AbortController();
      pollController = controller;
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        let more;
        do {
          const data = await api(`${url()}/work?cursor=${nextCursor}`, { signal: controller.signal });
          if (currentGeneration !== generation) return;
          const wasStale = stale; stale = false;
          const dispatchChanged = JSON.stringify(dispatch) !== JSON.stringify(data.dispatch);
          dispatch = data.dispatch;
          for (const item of data.items) {
            const previous = items.get(item.id);
            if (previous && item.revision < previous.revision) continue;
            const command = commands.get(item.id);
            if (command?.unconfirmed && (reconciling.has(item.id) || item.revision > command.revision)) commands.delete(item.id);
            items.set(item.id, item); render(item);
            if (item.result && previous?.result?.version !== item.result.version) {
              // Rebuild pages through the current server catalogue, including restored results.
              for (const block of item.result.display || []) if (block.kind === 'page') onShow(block);
              // Display is acknowledged after the DOM update, separately from speech.
              void receipt(item, 'displayed').catch(() => {});
            }
          }
          if (wasStale) refresh();
          else if (dispatchChanged) for (const item of items.values()) if (item.state === 'queued') render(item);
          onSnapshot(sessionId, data);
          cursor = nextCursor = data.cursor; more = data.hasMore;
        } while (more && !disposed);
      } catch { if (currentGeneration === generation) { stale = true; refresh(); onPollError(sessionId); } }
      finally {
        clearTimeout(timeout);
        if (pollController === controller) pollController = null;
      }
      if (currentGeneration === generation && refreshQueued) void poll();
      // Playback can take minutes. Core polling remains independent of it.
      void naturalPause();
    }
    function follow(id) {
      if (disposed || !id || id === sessionId) return;
      pollController?.abort(); pollController = null;
      ++generation; sessionId = id; cursor = 0; dispatch = null; stale = false; refreshQueued = false; commands.clear(); items.clear(); cards.clear(); attempted.clear(); requested.clear();
      summary = node('h2', 'conversation-work-summary', '');
      host.replaceChildren(summary); host.hidden = true; clearInterval(timer);
      timer = setInterval(() => { void poll(); }, pollMs); timer.unref?.(); void poll();
    }
    function reset() {
      pollController?.abort(); pollController = null;
      ++generation; sessionId = null; dispatch = null; clearInterval(timer); stale = false; refreshQueued = false; commands.clear(); items.clear(); cards.clear(); host.replaceChildren(); host.hidden = true;
    }
    function dispose() { disposed = true; reset(); }
    return { follow, reset, dispose, poll, naturalPause, refresh };
  }
  root.NestorWork = { create };
  if (typeof module === 'object' && module.exports) module.exports = { create };
})(typeof globalThis === 'undefined' ? this : globalThis);
