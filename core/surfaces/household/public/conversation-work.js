/* Core's durable work projection. Polling never starts inference. */
(function (root) {
  'use strict';
  const labels = { received: 'Request saved', queued: 'Handling it in the background', dispatching: 'Being picked up',
    paused: 'Request paused', running: 'Working on your request', uncertain: 'Receipt awaiting verification', failed: 'The work did not succeed',
    cancelled: 'Work stopped', result_ready: 'Result available', completed: 'Result available' };
  function create({ host, base, api, getConversation, maySpeak = () => true, onSnapshot = () => {}, onPollError = () => {}, pollMs = 2000 }) {
    const deviceSession = root.crypto.randomUUID(), items = new Map(), cards = new Map(), attempted = new Set(), requested = new Set();
    let sessionId, cursor = 0, sequence = 0, timer, polling = false, presenting = false, disposed = false, generation = 0;
    const url = () => `${base}/${encodeURIComponent(sessionId)}`;
    const receipt = (item, stage, claimToken) => api(`${base}/${encodeURIComponent(item.sessionId)}/work-deliveries/${encodeURIComponent(item.result.deliveryId)}/receipt`, {
      method: 'POST', keepalive: true, signal: AbortSignal.timeout(10000), body: JSON.stringify({ stage, resultVersion: item.result.version,
        sequence: ++sequence, deviceSession, ...(claimToken && { claimToken }) }) });
    const identity = item => `${item.id}:${item.result?.version || 0}`;
    function render(item) {
      let card = cards.get(item.id);
      if (!item.pending && !item.result && item.state !== 'failed' && item.state !== 'uncertain') {
        card?.remove(); cards.delete(item.id); host.hidden = !cards.size; return;
      }
      if (!card) {
        card = document.createElement('article'); card.className = 'conversation-work-card'; card.dataset.workId = item.id;
        cards.set(item.id, card); host.append(card);
      }
      const heading = document.createElement('p'); heading.className = 'conversation-work-status';
      heading.textContent = item.result ? (item.result.presentation === 'completed' ? 'Nestor · result presented' : 'Nestor · result available') : item.pending && item.state === 'completed' ? 'Request saved · answer to verify' : labels[item.state] || 'Request saved';
      card.replaceChildren(heading);
      if (item.result) {
        const text = document.createElement('p'); text.className = 'conversation-work-answer'; text.textContent = item.result.displayText ?? item.result.text;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'button';
        button.textContent = requested.has(identity(item)) ? 'Playback requested at the next pause' : 'Listen';
        button.onclick = () => { requested.add(identity(item)); render(item); void naturalPause(); };
        card.append(text, button);
      }
      if (item.controllable) {
        for (const action of [item.state === 'paused' ? 'resume' : 'pause', 'cancel']) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'button';
          button.textContent = { pause: 'Pause', resume: 'Resume the work', cancel: 'Cancel this request' }[action];
          button.onclick = async () => {
            button.disabled = true;
            try { await api(`${url()}/work/${encodeURIComponent(item.id)}/control`, { method: 'POST',
              body: JSON.stringify({ action, revision: item.revision }) }); await poll(); }
            catch { heading.textContent = 'The request changed. Checking its state.'; button.disabled = false; void poll(); }
          };
          card.append(button);
        }
      }
      host.hidden = false;
    }
    async function present(item, replay) {
      const currentGeneration = generation, currentSession = sessionId;
      const key = identity(item); attempted.add(key); presenting = true;
      let claim, scheduled = false, startedReceipt;
      try {
        claim = await receipt(item, replay ? 'replay' : 'claim');
        if (currentGeneration !== generation || currentSession !== sessionId) { await receipt(item, 'deferred', claim.claimToken); return; }
        const language = getConversation().selection?.language || 'fr';
        const text = replay ? item.result.readingText ?? item.result.text : item.result.spokenText ?? item.result.text;
        const spoken = await getConversation().interject({ text, language }, { readAloud: replay, onScheduled() {
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
          if (status) status.textContent = 'Result kept · playback not confirmed';
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
    async function poll() {
      if (disposed || polling || !sessionId) return;
      const currentGeneration = generation; polling = true;
      try {
        let more;
        do {
          const data = await api(`${url()}/work?cursor=${cursor}`);
          if (currentGeneration !== generation) return;
          for (const item of data.items) {
            const previous = items.get(item.id); items.set(item.id, item); render(item);
            if (item.result && previous?.result?.version !== item.result.version) {
              // Display is acknowledged after the DOM update, separately from speech.
              void receipt(item, 'displayed').catch(() => {});
            }
          }
          onSnapshot(sessionId, data);
          cursor = data.cursor; more = data.hasMore;
        } while (more && !disposed);
      } catch { if (currentGeneration === generation) onPollError(sessionId); }
      finally { polling = false; }
      // Playback can take minutes. Core polling remains independent of it.
      void naturalPause();
    }
    function follow(id) {
      if (disposed || !id || id === sessionId) return;
      ++generation; sessionId = id; cursor = 0; items.clear(); cards.clear(); attempted.clear(); requested.clear();
      host.replaceChildren(); host.hidden = true; clearInterval(timer);
      timer = setInterval(() => { void poll(); }, pollMs); timer.unref?.(); void poll();
    }
    function reset() {
      ++generation; sessionId = null; clearInterval(timer); items.clear(); cards.clear(); host.replaceChildren(); host.hidden = true;
    }
    function dispose() { disposed = true; reset(); }
    return { follow, reset, dispose, poll, naturalPause };
  }
  root.NestorWork = { create };
  if (typeof module === 'object' && module.exports) module.exports = { create };
})(typeof globalThis === 'undefined' ? this : globalThis);
