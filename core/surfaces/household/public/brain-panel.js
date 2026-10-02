'use strict';

// "Pistes": what Nestor's background brain proposes after a turn (#169).
// Follow-up questions become buttons the person can tap; revisions go to the
// text zone; a short remark may be spoken at the next natural pause unless the
// person asked for quiet, which an urgent remark still overrides.
(function exposeBrainPanel(root) {
  const QUIET_CHOICES = Object.freeze([
    ['', 'Permises'], ['15', 'Silence 15 min'], ['60', 'Silence 1 h'], ['conversation', 'Silence pour cette conversation']
  ]);

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  // Quiet is a time, or the end of this conversation; `now` is injectable for tests.
  function quietState(choice, now = Date.now()) {
    if (choice === 'conversation') return { until: Infinity };
    const minutes = Number(choice);
    return Number.isFinite(minutes) && minutes > 0 ? { until: now + minutes * 60000 } : { until: 0 };
  }

  function mayInterject(quiet, interjection, now = Date.now()) {
    if (!interjection?.text) return false;
    return interjection.urgent === true || !(quiet.until > now);
  }

  function create(container, { base, fetchImpl = (...args) => root.fetch(...args), onAsk = () => {}, onRevision = () => {}, onInterject = () => {} } = {}) {
    const list = node('div', 'brain-suggestions');
    const select = node('select', 'brain-quiet');
    select.setAttribute('aria-label', 'Interventions vocales du cerveau');
    QUIET_CHOICES.forEach(([value, label]) => { const option = node('option', '', label); option.value = value; select.append(option); });
    const quietLabel = node('label', 'brain-quiet-label', 'Interventions vocales ');
    quietLabel.append(select);
    container.replaceChildren(node('h2', 'display-board-heading', 'Pistes'), list, quietLabel);
    let quiet = { until: 0 }, pending = null, generation = 0;
    select.addEventListener('change', () => { quiet = quietState(select.value); });

    function render(suggestions) {
      list.replaceChildren(...suggestions.map(question => {
        const button = node('button', 'brain-suggestion', question);
        button.type = 'button';
        button.addEventListener('click', () => onAsk(question));
        return button;
      }));
      container.hidden = !suggestions.length;
    }

    const panel = {
      get quiet() { return quiet; },
      // A new turn supersedes any review still being awaited, and its suggestions.
      cancel() { generation += 1; pending?.abort(); pending = null; render([]); },
      async follow(sessionId, traceId) {
        panel.cancel();
        if (!sessionId || !traceId) return null;
        const mine = generation, controller = new AbortController();
        pending = controller;
        try {
          const url = `${base}/${encodeURIComponent(sessionId)}/brain?after=${encodeURIComponent(traceId)}`;
          const response = await fetchImpl(url, { signal: controller.signal, credentials: 'include' });
          const body = response.ok ? await response.json() : null;
          const review = body?.data?.review;
          if (mine !== generation || !review) return null;
          render(review.suggestions || []);
          (review.revisions || []).forEach((revision, index) => onRevision({ id: `brain-${traceId}-${index}`, kind: 'text', title: `Révisé · ${revision.title}`, body: revision.body }));
          if (mayInterject(quiet, review.interjection)) onInterject(review.interjection);
          return review;
        } catch { return null; }
        finally { if (pending === controller) pending = null; }
      },
      // Quiet set "for this conversation" ends with it.
      reset() { panel.cancel(); select.value = ''; quiet = { until: 0 }; }
    };
    render([]);
    return panel;
  }

  root.NestorBrain = Object.freeze({ create, quietState, mayInterject });
}(typeof window !== 'undefined' ? window : globalThis));
