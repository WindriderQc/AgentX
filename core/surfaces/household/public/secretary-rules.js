/* Secretary sender rules: the owner decides how recurring senders are sorted.
   Core stores the rules; the Gmail triage applies a match without the model. */
(function () {
  const CATEGORY_LABELS = { FYI: 'FYI (info, to archive)', Newsletters: 'Newsletters / promos', Receipts: 'Receipts', Review: 'To review (Review)' };
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
    if (!response.ok || body.ok === false || body.status === 'error') throw new Error(body.message || `HTTP ${response.status}`);
    return body.data;
  }
  const options = (categories, selected) => categories.map((category) =>
    `<option value="${esc(category)}"${category === selected ? ' selected' : ''}>${esc(CATEGORY_LABELS[category] || category)}</option>`).join('');
  const lastHit = (value) => value && Number.isFinite(Date.parse(value)) ? ` · last ${new Date(value).toLocaleDateString()}` : '';

  function mount(host) {
    host.dataset.mounted = 'true';
    host.innerHTML = `<summary>Gmail triage rules <span data-rules-count class="pill">…</span></summary>
      <p class="muted">A sender covered by a rule is sorted directly, without the model. Action categories (Urgent, To reply, Waiting) are still decided by the Secretary after reading the whole email.</p>
      <form data-rules-form class="rules-form">
        <input name="from" required maxlength="200" placeholder="address@site.com or @site.com" aria-label="Sender">
        <input name="subjectContains" maxlength="120" placeholder="Subject contains (optional)" aria-label="Subject contains">
        <select name="category" aria-label="Category"></select>
        <input name="note" maxlength="200" placeholder="Note (optional)" aria-label="Note">
        <button type="submit">Add rule</button>
      </form>
      <p data-rules-status class="muted" role="status"></p>
      <div data-rules-list class="stack"></div>
      <div class="row wrap rules-suggest-head"><h3 class="grow">Senders often left in Review</h3><button type="button" data-rules-suggest>Analyze Gmail</button></div>
      <div data-rules-suggestions class="stack"><p class="muted">Analyze only reads the sender and subject of the latest emails sorted as Review.</p></div>`;
    const get = (name) => host.querySelector(`[data-rules-${name}]`);
    const form = get('form');
    let categories = ['FYI', 'Newsletters', 'Receipts', 'Review'];
    const status = (message) => { get('status').textContent = message; };

    const ruleRow = (rule) => `<div class="dad-task rules-row${rule.enabled ? '' : ' rules-off'}" data-rule="${esc(rule.id)}">
      <div class="dad-task-main dad-mail-main"><div><strong>${esc(rule.from)}${rule.subjectContains ? ` · subject “${esc(rule.subjectContains)}”` : ''}</strong>
      <small>${esc(rule.hits)} email${rule.hits === 1 ? '' : 's'} sorted${esc(lastHit(rule.lastHitAt))}${rule.note ? ` · ${esc(rule.note)}` : ''}</small></div></div>
      <div class="row wrap dad-task-actions"><select data-rule-category aria-label="Category">${options(categories, rule.category)}</select>
      <button class="compact" type="button" data-rule-toggle>${rule.enabled ? 'Pause' : 'Enable'}</button>
      <button class="compact dad-done" type="button" data-rule-delete>Delete</button></div></div>`;

    async function load() {
      try {
        const data = await api('/api/secretary/triage-rules');
        categories = data.categories;
        form.elements.category.innerHTML = options(categories, 'FYI');
        get('count').textContent = `${data.rules.length} rule${data.rules.length === 1 ? '' : 's'}`;
        get('list').innerHTML = data.rules.length ? data.rules.map(ruleRow).join('') : '<p class="empty">No rules. Add a sender or use the analysis below.</p>';
      } catch (error) { status(`The rules could not be loaded: ${error.message}`); }
    }
    async function create(rule) {
      await api('/api/secretary/triage-rules', { method: 'POST', body: JSON.stringify(rule) });
      status(`Rule added for ${rule.from}. It applies on the next triage run.`);
      await load();
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());
      try { await create(values); form.reset(); form.elements.category.value = 'FYI'; } catch (error) { status(error.message); }
    });
    get('list').addEventListener('change', async (event) => {
      const row = event.target.closest('[data-rule]');
      if (!row || !event.target.matches('[data-rule-category]')) return;
      try { await api(`/api/secretary/triage-rules/${row.dataset.rule}`, { method: 'PATCH', body: JSON.stringify({ category: event.target.value }) }); status('Category updated.'); }
      catch (error) { status(error.message); await load(); }
    });
    get('list').addEventListener('click', async (event) => {
      const row = event.target.closest('[data-rule]');
      if (!row) return;
      try {
        if (event.target.matches('[data-rule-toggle]')) {
          await api(`/api/secretary/triage-rules/${row.dataset.rule}`, { method: 'PATCH', body: JSON.stringify({ enabled: row.classList.contains('rules-off') }) });
        } else if (event.target.matches('[data-rule-delete]')) {
          if (event.target.dataset.confirmed !== 'true') { event.target.dataset.confirmed = 'true'; event.target.textContent = 'Confirm'; return; }
          await api(`/api/secretary/triage-rules/${row.dataset.rule}`, { method: 'DELETE' });
        } else return;
        await load();
      } catch (error) { status(error.message); }
    });

    const suggestionRow = (row) => `<div class="dad-task" data-suggest-address="${esc(row.address)}" data-suggest-domain="${esc(row.domain)}">
      <div class="dad-task-main dad-mail-main"><div><strong>${esc(row.name || row.address)} · ${esc(row.count)} in Review</strong>
      <small>${esc(row.address)}${row.sampleSubject ? ` · “${esc(row.sampleSubject)}”` : ''}${row.ruled ? ' · already covered by a rule' : ''}</small></div></div>
      <div class="row wrap dad-task-actions"><select data-suggest-scope aria-label="Scope"><option value="address">This address</option><option value="domain">All @${esc(row.domain)}</option></select>
      <select data-suggest-category aria-label="Category">${options(categories, 'FYI')}</select><button class="compact" type="button" data-suggest-create${row.ruled ? ' disabled' : ''}>Create rule</button></div></div>`;
    get('suggest').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      get('suggestions').innerHTML = '<p class="muted">Reading senders in Gmail…</p>';
      try {
        const data = await api('/api/secretary/triage-rules/suggestions');
        get('suggestions').innerHTML = data.senders.length
          ? `<p class="muted">${esc(data.sampled)} Review emails analyzed${data.more ? ' (most recent)' : ''}.</p>${data.senders.map(suggestionRow).join('')}`
          : '<p class="empty">No email in Review.</p>';
      } catch (error) { get('suggestions').innerHTML = `<p class="empty">${esc(error.message)}</p>`; }
      finally { button.disabled = false; }
    });
    get('suggestions').addEventListener('click', async (event) => {
      if (!event.target.matches('[data-suggest-create]')) return;
      const row = event.target.closest('[data-suggest-address]');
      const scope = row.querySelector('[data-suggest-scope]').value;
      event.target.disabled = true;
      try {
        await create({ from: scope === 'domain' ? `@${row.dataset.suggestDomain}` : row.dataset.suggestAddress,
          category: row.querySelector('[data-suggest-category]').value, note: 'Créée depuis l’analyse Review' });
        row.querySelector('small').textContent += ' · rule created';
      } catch (error) { event.target.disabled = false; status(error.message); }
    });
    host.addEventListener('toggle', () => { if (host.open && !host.dataset.loaded) { host.dataset.loaded = 'true'; load(); } });
  }

  // The desk page is rendered by app.js; mount whenever its host appears.
  const scan = () => document.querySelectorAll('[data-secretary-rules]:not([data-mounted])').forEach(mount);
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', scan);
}());
