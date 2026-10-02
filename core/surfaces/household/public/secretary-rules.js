/* Secretary sender rules: the owner decides how recurring senders are sorted.
   Core stores the rules; the Gmail triage applies a match without the model. */
(function () {
  const CATEGORY_LABELS = { FYI: 'FYI (info, à archiver)', Newsletters: 'Infolettres / promos', Receipts: 'Reçus', Review: 'À revoir (Review)' };
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
    window.AgentXAccess?.assertCurrent?.();
    if (!response.ok || body.ok === false || body.status === 'error') throw new Error(body.message || `HTTP ${response.status}`);
    return body.data;
  }
  const options = (categories, selected) => categories.map((category) =>
    `<option value="${esc(category)}"${category === selected ? ' selected' : ''}>${esc(CATEGORY_LABELS[category] || category)}</option>`).join('');
  const lastHit = (value) => value && Number.isFinite(Date.parse(value)) ? ` · dernière ${new Date(value).toLocaleDateString()}` : '';

  function mount(host) {
    host.dataset.mounted = 'true';
    host.innerHTML = `<summary>Règles de tri Gmail <span data-rules-count class="pill">…</span></summary>
      <p class="muted">Un expéditeur couvert par une règle est classé directement, sans passer par le modèle. Les catégories d'action (Urgent, À répondre, En attente) restent décidées par le Secretary après lecture complète du courriel.</p>
      <form data-rules-form class="rules-form">
        <input name="from" required maxlength="200" placeholder="adresse@site.com ou @site.com" aria-label="Expéditeur">
        <input name="subjectContains" maxlength="120" placeholder="Sujet contient (optionnel)" aria-label="Sujet contient">
        <select name="category" aria-label="Catégorie"></select>
        <input name="note" maxlength="200" placeholder="Note (optionnel)" aria-label="Note">
        <button type="submit">Ajouter la règle</button>
      </form>
      <p data-rules-status class="muted" role="status"></p>
      <div data-rules-list class="stack"></div>
      <div class="row wrap rules-suggest-head"><h3 class="grow">Expéditeurs souvent laissés en Review</h3><button type="button" data-rules-suggest>Analyser Gmail</button></div>
      <div data-rules-suggestions class="stack"><p class="muted">Analyser lit seulement l'expéditeur et le sujet des derniers courriels classés Review.</p></div>`;
    const get = (name) => host.querySelector(`[data-rules-${name}]`);
    const form = get('form');
    let categories = ['FYI', 'Newsletters', 'Receipts', 'Review'];
    const status = (message) => { get('status').textContent = message; };

    const ruleRow = (rule) => `<div class="dad-task rules-row${rule.enabled ? '' : ' rules-off'}" data-rule="${esc(rule.id)}">
      <div class="dad-task-main dad-mail-main"><div><strong>${esc(rule.from)}${rule.subjectContains ? ` · sujet « ${esc(rule.subjectContains)} »` : ''}</strong>
      <small>${esc(rule.hits)} courriel${rule.hits === 1 ? '' : 's'} classé${rule.hits === 1 ? '' : 's'}${esc(lastHit(rule.lastHitAt))}${rule.note ? ` · ${esc(rule.note)}` : ''}</small></div></div>
      <div class="row wrap dad-task-actions"><select data-rule-category aria-label="Catégorie">${options(categories, rule.category)}</select>
      <button class="compact" type="button" data-rule-toggle>${rule.enabled ? 'Suspendre' : 'Activer'}</button>
      <button class="compact dad-done" type="button" data-rule-delete>Supprimer</button></div></div>`;

    async function load() {
      try {
        const data = await api('/api/secretary/triage-rules');
        categories = data.categories;
        form.elements.category.innerHTML = options(categories, 'FYI');
        get('count').textContent = `${data.rules.length} règle${data.rules.length === 1 ? '' : 's'}`;
        get('list').innerHTML = data.rules.length ? data.rules.map(ruleRow).join('') : '<p class="empty">Aucune règle. Ajoute un expéditeur ou utilise l’analyse ci-dessous.</p>';
      } catch (error) { status(`Les règles n'ont pas pu être chargées : ${error.message}`); }
    }
    async function create(rule) {
      await api('/api/secretary/triage-rules', { method: 'POST', body: JSON.stringify(rule) });
      status(`Règle ajoutée pour ${rule.from}. Elle s'applique au prochain passage du tri.`);
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
      try { await api(`/api/secretary/triage-rules/${row.dataset.rule}`, { method: 'PATCH', body: JSON.stringify({ category: event.target.value }) }); status('Catégorie mise à jour.'); }
      catch (error) { status(error.message); await load(); }
    });
    get('list').addEventListener('click', async (event) => {
      const row = event.target.closest('[data-rule]');
      if (!row) return;
      try {
        if (event.target.matches('[data-rule-toggle]')) {
          await api(`/api/secretary/triage-rules/${row.dataset.rule}`, { method: 'PATCH', body: JSON.stringify({ enabled: row.classList.contains('rules-off') }) });
        } else if (event.target.matches('[data-rule-delete]')) {
          if (event.target.dataset.confirmed !== 'true') { event.target.dataset.confirmed = 'true'; event.target.textContent = 'Confirmer'; return; }
          await api(`/api/secretary/triage-rules/${row.dataset.rule}`, { method: 'DELETE' });
        } else return;
        await load();
      } catch (error) { status(error.message); }
    });

    const suggestionRow = (row) => `<div class="dad-task" data-suggest-address="${esc(row.address)}" data-suggest-domain="${esc(row.domain)}">
      <div class="dad-task-main dad-mail-main"><div><strong>${esc(row.name || row.address)} · ${esc(row.count)} en Review</strong>
      <small>${esc(row.address)}${row.sampleSubject ? ` · « ${esc(row.sampleSubject)} »` : ''}${row.ruled ? ' · déjà couvert par une règle' : ''}</small></div></div>
      <div class="row wrap dad-task-actions"><select data-suggest-scope aria-label="Portée"><option value="address">Cette adresse</option><option value="domain">Tout @${esc(row.domain)}</option></select>
      <select data-suggest-category aria-label="Catégorie">${options(categories, 'FYI')}</select><button class="compact" type="button" data-suggest-create${row.ruled ? ' disabled' : ''}>Créer la règle</button></div></div>`;
    get('suggest').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      get('suggestions').innerHTML = '<p class="muted">Lecture des expéditeurs dans Gmail…</p>';
      try {
        const data = await api('/api/secretary/triage-rules/suggestions');
        get('suggestions').innerHTML = data.senders.length
          ? `<p class="muted">${esc(data.sampled)} courriels Review analysés${data.more ? ' (les plus récents)' : ''}.</p>${data.senders.map(suggestionRow).join('')}`
          : '<p class="empty">Aucun courriel en Review.</p>';
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
        row.querySelector('small').textContent += ' · règle créée';
      } catch (error) { event.target.disabled = false; status(error.message); }
    });
    host.addEventListener('toggle', () => { if (host.open && !host.dataset.loaded) { host.dataset.loaded = 'true'; load(); } });
  }

  // The desk page is rendered by app.js; mount whenever its host appears.
  const scan = () => document.querySelectorAll('[data-secretary-rules]:not([data-mounted])').forEach(mount);
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', scan);
}());
