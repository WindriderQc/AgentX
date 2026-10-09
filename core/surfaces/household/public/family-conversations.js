/* Family conversation management lives on the family follow-up page.
   Core owns the conversations; this card lists and calls its routes. */
(function () {
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const base = '/api/voice-personas/family/sessions';
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
    if (!response.ok || body.ok === false || body.status === 'error') throw new Error(body.message || `HTTP ${response.status}`);
    return body.data;
  }
  const when = (value) => value ? new Date(value).toLocaleString('fr-CA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';

  function mount(host) {
    host.dataset.mounted = 'true';
    host.innerHTML = `<details class="family-disclosure"><summary>Gérer les conversations Famille</summary><div class="row"><div class="grow">
      <p class="muted">Effacer retire les échanges et leurs pièces jointes d’AgentX et du journal. Les copies OpenClaw restent conservées.</p></div>
      <button type="button" class="compact" data-family-refresh>Actualiser</button></div>
      <p data-family-status class="muted" role="status"></p><div data-family-list class="stack"></div>
      <button type="button" class="compact" data-family-more hidden>Voir plus</button></details>`;
    const list = host.querySelector('[data-family-list]');
    const status = (message) => { host.querySelector('[data-family-status]').textContent = message; };
    const row = (session) => {
      const asked = session.lastTurn?.inputPreview || '';
      const answered = session.lastTurn?.replyPreview || '';
      const count = session.turnCount === 1 ? '1 échange' : `${session.turnCount} échanges`;
      return `<div class="parent-chore"><div class="grow"><strong>${esc(asked || 'Conversation')}</strong>
        <small>${esc(when(session.lastTurnAt || session.updatedAt))} · ${esc(count)}${answered ? ` · Nestor : ${esc(answered)}` : ''}</small></div>
        <button type="button" class="compact danger" data-family-erase="${esc(session.sessionId)}">Effacer</button></div>`;
    };
    const more = host.querySelector('[data-family-more]');
    const pageSize = 5;
    let oldest = null;
    // Pages of five, each older than the last one shown ("Voir plus").
    async function load({ append = false } = {}) {
      try {
        const before = append && oldest ? `&before=${encodeURIComponent(oldest)}` : '';
        const { sessions } = await api(`${base}/recent?limit=${pageSize}&preview=true${before}`);
        const rows = sessions.map(row).join('');
        if (append) list.insertAdjacentHTML('beforeend', rows);
        else list.innerHTML = rows || '<div class="empty">Aucune conversation Famille.</div>';
        if (sessions.length) oldest = sessions.at(-1).lastTurnAt || oldest;
        more.hidden = sessions.length < pageSize;
        status('');
      } catch (error) { status(error.message); }
    }
    host.querySelector('[data-family-refresh]').addEventListener('click', () => load());
    more.addEventListener('click', () => load({ append: true }));
    list.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-family-erase]');
      if (!button) return;
      if (!window.confirm('Effacer cette conversation Famille dans AgentX ? Ses échanges ne pourront plus être relus.')) return;
      button.disabled = true;
      try {
        await api(`${base}/${encodeURIComponent(button.dataset.familyErase)}`, { method: 'DELETE', body: JSON.stringify({ confirmation: 'DELETE CONVERSATION' }) });
        status('Conversation effacée.');
        document.getElementById('refreshJournal')?.click();
        await load();
      } catch (error) { button.disabled = false; status(error.message); }
    });
    load();
  }

  function scan() {
    const journal = document.getElementById('journal')?.closest('article');
    if (journal && !document.querySelector('[data-family-conversations]')) {
      journal.insertAdjacentHTML('afterend', '<article class="card full family-conversations" data-family-conversations></article>');
    }
    document.querySelectorAll('[data-family-conversations]:not([data-mounted])').forEach(mount);
  }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', scan);
}());
