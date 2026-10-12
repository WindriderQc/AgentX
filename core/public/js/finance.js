'use strict';

// Finances page: every figure comes from /api/finance, which computes totals
// in integer cents. The browser only formats and draws.
(function financePage() {
  const $ = (id) => document.getElementById(id);
  const LEDGER = new URLSearchParams(window.location.search).get('ledger') === 'corp' ? 'corp' : '';
  document.body.dataset.ledger = LEDGER || 'perso';
  document.getElementById(LEDGER ? 'ledgerCorp' : 'ledgerPerso')?.setAttribute('aria-current', 'page');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const CONFIDENCE = { haute: 'high', moyenne: 'medium', basse: 'low' };
  let monthlyChart = null;

  function money(cents) {
    if (!Number.isFinite(cents)) return '—';
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(Math.round(cents));
    const dollars = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
  }

  function monthLabel(month) {
    const [year, m] = String(month).split('-');
    return `${MONTHS[Number(m) - 1] || m} ${year}`;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
  }

  async function api(path, params = {}) {
    const url = new URL(`/api/finance/${path}`, window.location.origin);
    for (const [key, value] of Object.entries({ ...params, ledger: LEDGER })) if (value) url.searchParams.set(key, value);
    const response = await fetch(url, { credentials: 'same-origin' });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== 'success') throw new Error(body?.message || `Error ${response.status}`);
    return body.data;
  }

  function filters() {
    return { account: $('financeAccount').value, from: $('financeFrom').value, to: $('financeTo').value,
      category: $('financeCategory').value, tag: $('financeTag').value,
      excludeCategory: $('financeExcludeTransfers').checked ? 'Virements internes' : '' };
  }

  function showError(error) {
    const box = $('financeError');
    box.hidden = !error;
    box.textContent = error ? `Data unavailable: ${error.message}` : '';
  }

  function renderBalances(accounts) {
    const tiles = $('financeBalances');
    tiles.replaceChildren(...accounts.map((account) => el('article', { class: 'finance-tile' },
      el('span', { class: 'finance-tile-label' }, `${account.code} · ${account.issuer}`),
      el('strong', { class: 'finance-tile-value' }, money(account.balanceCents)),
      el('span', { class: 'finance-tile-date' }, `as of ${account.asOf}`))));
    if (!accounts.length) tiles.append(el('p', { class: 'finance-note' }, 'No reconciled statement yet.'));
    const select = $('financeAccount');
    const known = new Set([...select.options].map((option) => option.value));
    for (const code of [...new Set(accounts.map((account) => account.code))].sort()) {
      if (!known.has(code)) select.append(el('option', { value: code }, code));
    }
  }

  function renderMonthly(data) {
    const months = data.months || [];
    const css = getComputedStyle(document.querySelector('.finance-page'));
    const colors = { in: css.getPropertyValue('--series-in').trim(), out: css.getPropertyValue('--series-out').trim(),
      grid: css.getPropertyValue('--finance-grid').trim(), text: css.getPropertyValue('--finance-muted').trim() };
    const labels = months.map((m) => monthLabel(m.month));
    const datasets = [
      { label: 'In', data: months.map((m) => m.inCents / 100), backgroundColor: colors.in },
      { label: 'Out', data: months.map((m) => -m.outCents / 100), backgroundColor: colors.out }
    ].map((set) => ({ ...set, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, borderWidth: 0 }));
    if (monthlyChart) monthlyChart.destroy();
    if (window.Chart) {
      monthlyChart = new window.Chart($('monthlyChart'), {
        type: 'bar',
        data: { labels, datasets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${money(Math.round(ctx.parsed.y * 100))}`,
              footer: (items) => `Net: ${money(months[items[0].dataIndex].netCents)}`
            } }
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: colors.text } },
            y: { beginAtZero: true, grid: { color: colors.grid }, border: { display: false },
              ticks: { color: colors.text, callback: (value) => `$${Math.round(value).toLocaleString('en-US')}` } }
          }
        }
      });
    }
    $('monthlyTable').tBodies[0].replaceChildren(...months.map((m) => el('tr', {},
      el('td', {}, monthLabel(m.month)), el('td', {}, money(m.inCents)), el('td', {}, money(m.outCents)),
      el('td', {}, money(m.netCents)), el('td', {}, m.count))));
    $('monthlyNote').textContent = months.length
      ? `Average net: ${money(data.averageNetCents)} per month over ${months.length} months`
        + (filters().account || filters().excludeCategory ? '' : ' · all accounts combined, internal transfers included')
      : 'No transactions for these filters.';
  }

  function renderMerchants(merchants) {
    const list = $('financeMerchants');
    const largest = Math.max(1, ...merchants.map((m) => -m.outCents));
    list.replaceChildren(...merchants.map((m) => el('li', {},
      el('span', { class: 'finance-bar-label' }, m.description),
      el('span', { class: 'finance-bar-track' }, el('span', { class: 'finance-bar', style: `width:${Math.max(2, (-m.outCents / largest) * 100).toFixed(1)}%` })),
      el('span', { class: 'finance-bar-value' }, `${money(-m.outCents)} · ${m.count}×`))));
    if (!merchants.length) list.append(el('li', { class: 'finance-note' }, 'No spending for these filters.'));
  }

  function renderCategories(rows, pending) {
    const list = $('financeCategories');
    const spending = rows.filter((row) => row.outCents < 0);
    const largest = Math.max(1, ...spending.map((row) => -row.outCents));
    list.replaceChildren(...spending.map((row) => el('li', {},
      el('span', { class: 'finance-bar-label' }, row.category || 'Uncategorized'),
      el('span', { class: 'finance-bar-track' }, el('span', { class: `finance-bar${row.category ? '' : ' finance-bar-muted'}`,
        style: `width:${Math.max(2, (-row.outCents / largest) * 100).toFixed(1)}%` })),
      el('span', { class: 'finance-bar-value' }, `${money(-row.outCents)} · ${row.count}×`))));
    if (!spending.length) list.append(el('li', { class: 'finance-note' }, 'No spending for these filters.'));
    $('financeUncategorized').textContent = pending?.remainingDescriptions
      ? `${pending.remainingDescriptions} description(s) to categorize — the Accountant asks you about them in Fisc.`
      : 'Everything is categorized.';
  }

  const ALERT_ICONS = { critical: '⛔', warning: '⚠', info: 'ℹ' };

  function renderAlerts(alerts) {
    $('financeAlertsCard').hidden = !alerts.length;
    $('financeAlerts').replaceChildren(...alerts.map((alert) => {
      const amount = alert.facts?.amountCents ?? alert.facts?.balanceCents ?? alert.facts?.yearlyCents;
      return el('li', { class: `finance-alert finance-alert-${alert.severity}` },
        el('span', { 'aria-hidden': 'true' }, ALERT_ICONS[alert.severity] || '•'),
        el('span', {}, alert.title + (Number.isFinite(amount) ? ` — ${money(amount)}` : '')));
    }));
  }

  function renderCoverage(series) {
    $('financeCoverageList').replaceChildren(...series.map((s) => el('li', {},
      el('strong', {}, s.series), `: ${s.first} → ${s.last} · ${s.months} months`,
      s.missing.length
        ? el('span', { class: 'finance-missing' }, ` · missing: ${s.missing.join(', ')}`)
        : el('span', { class: 'finance-complete' }, ' · complete'))));
  }

  function renderStatements(statements) {
    $('statementsTable').tBodies[0].replaceChildren(...statements.map((s) => el('tr', {},
      el('td', {}, s.fileName), el('td', {}, `${s.periodStart || '?'} → ${s.periodEnd || '?'}`),
      el('td', {}, (s.accounts || []).map((a) => a.code).join(', ')),
      el('td', {}, el('span', { class: `finance-status finance-status-${s.status}` },
        s.status === 'reconciled' ? '✓ Reconciled' : `⚠ To check${s.problems?.length ? ` (${s.problems.length})` : ''}`)))));
    const reconciled = statements.filter((s) => s.status === 'reconciled');
    const latest = reconciled.map((s) => s.periodEnd).filter(Boolean).sort().pop();
    $('financeCoverage').textContent = `Ledger reconciled to the cent · ${reconciled.length} statement(s)`
      + (latest ? ` · data through ${latest}` : '');
  }

  function searchParams() {
    return { ...filters(), q: $('financeQuery').value.trim() };
  }

  function updateExportLink() {
    const url = new URL('/api/finance/export.csv', window.location.origin);
    for (const [key, value] of Object.entries({ ...searchParams(), ledger: LEDGER })) if (value) url.searchParams.set(key, value);
    $('financeExport').href = url.pathname + url.search;
  }

  async function renderYearly() {
    const data = await api('summary/yearly', searchParams());
    $('yearlyTable').tBodies[0].replaceChildren(...data.years.map((y) => el('tr', {},
      el('td', {}, y.year), el('td', {}, money(y.inCents)), el('td', {}, money(y.outCents)), el('td', {}, money(y.netCents)),
      el('td', {}, y.count), el('td', {}, `${y.firstDate} → ${y.lastDate}`))));
  }

  // Inline decision for one transaction: category + tags, kept even if a rule changes.
  function editRow(button) {
    const row = button.closest('tr');
    const cell = row.querySelector('.finance-cat-cell');
    const select = el('select', { 'aria-label': 'Category' }, el('option', { value: '' }, '— rules decide —'),
      ...categoryList.map((name) => el('option', { value: name }, name)));
    const tags = el('input', { type: 'text', placeholder: 'tags, comma-separated', 'aria-label': 'Tags', maxlength: '120' });
    // Start from the owner's current decision, so OK without a change keeps it.
    const decided = row.dataset.category || '';
    select.value = decided;
    tags.value = row.dataset.tags || '';
    const save = el('button', { type: 'button', class: 'finance-link' }, 'OK');
    cell.replaceChildren(select, tags, save);
    button.remove();
    save.addEventListener('click', async () => {
      cell.querySelector('.finance-error')?.remove();
      const fail = (message) => cell.append(el('span', { class: 'finance-error' }, ` ${message}`));
      // No category means "let the rules decide", which drops the decision and its tags.
      if (!select.value && tags.value.trim()) return fail('Pick a category to keep tags.');
      if (!select.value && !decided) return search();
      if (!select.value && !window.confirm('Remove your decision for this transaction? The rules apply again.')) return;
      try {
        await post('transactions/decisions', { transactions: [{ id: row.dataset.id, category: select.value || null,
          tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean) }] });
        await search();
      } catch (error) {
        fail(error.message);
      }
    });
  }

  async function search(event) {
    event?.preventDefault();
    const { q, tag } = searchParams();
    const box = $('financeSearchResult');
    updateExportLink();
    await renderYearly().catch(showError);
    if (!q && !tag && !$('financeCategory').value) { box.replaceChildren(); return; }
    try {
      const data = await api('transactions', { ...searchParams(), limit: 50 });
      const t = data.totals;
      box.replaceChildren(
        el('p', { class: 'finance-search-total' }, `${t.count} transaction(s) · out ${money(t.outCents)} · in ${money(t.inCents)}`),
        el('table', { class: 'finance-table' },
          el('tbody', {}, ...data.rows.map((row) => el('tr', { 'data-id': row.id, 'data-category': row.manual ? row.category || '' : '',
            'data-tags': row.manual ? (row.tags || []).join(', ') : '' },
            el('td', {}, row.date), el('td', {}, row.description), el('td', {}, row.accountCode),
            el('td', { class: 'finance-cat-cell' }, `${row.category || '—'}${row.tags?.length ? ` #${row.tags.join(' #')}` : ''}${row.manual ? ' ✎' : ''}`),
            el('td', { class: 'num' }, money(row.flowCents ?? row.amountCents)),
            el('td', {}, el('button', { type: 'button', class: 'finance-link', 'data-edit': row.id }, 'Categorize')))))),
        ...(data.truncated ? [el('p', { class: 'finance-note' }, 'The 50 most recent are shown; the total covers everything.')] : []));
    } catch (error) {
      box.replaceChildren(el('p', { class: 'finance-error' }, error.message));
    }
  }

  let categoryList = [];

  async function post(path, body) {
    const response = await fetch(`/api/finance/${path}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.status !== 'success') throw new Error(data?.message || `Error ${response.status}`);
    return data.data;
  }

  async function proposeCategories() {
    const status = $('financeSuggestStatus');
    const button = $('financeSuggest');
    button.disabled = true;
    status.textContent = 'The local model is thinking (up to a minute)…';
    try {
      if (!categoryList.length) categoryList = (await api('rules')).categories || [];
      const { suggestions } = await post('suggestions', { limit: 15 });
      const rows = suggestions.map((s, index) => {
        const select = el('select', { 'data-field': 'category', 'aria-label': `Category for ${s.description}` },
          el('option', { value: '' }, '—'), ...categoryList.map((name) => el('option', { value: name }, name)));
        select.value = s.category || '';
        return el('tr', { 'data-pattern': s.pattern },
          el('td', {}, el('input', { type: 'checkbox', 'data-field': 'pick', 'aria-label': 'Keep', ...(s.confidence === 'haute' && s.category ? { checked: '' } : {}) })),
          el('td', {}, s.description), el('td', {}, s.count), el('td', { class: 'num' }, money(s.totalCents)),
          el('td', {}, select),
          el('td', {}, el('input', { type: 'text', 'data-field': 'tags', value: (s.tags || []).join(', '), maxlength: '80', 'aria-label': 'Tags' })),
          el('td', {}, el('span', { class: `finance-confidence finance-confidence-${s.confidence}` }, CONFIDENCE[s.confidence] || s.confidence)));
      });
      $('financeSuggestTable').tBodies[0].replaceChildren(...rows);
      $('financeSuggestTable').hidden = !rows.length;
      $('financeSaveRules').hidden = !rows.length;
      status.textContent = rows.length ? `${rows.length} suggestions. High-confidence rows are pre-checked.` : 'Everything is categorized.';
    } catch (error) {
      status.textContent = `Suggestions unavailable: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  async function saveRules() {
    const rules = [...$('financeSuggestTable').tBodies[0].rows]
      .filter((row) => row.querySelector('[data-field="pick"]').checked && row.querySelector('[data-field="category"]').value)
      .map((row) => ({ pattern: row.dataset.pattern, category: row.querySelector('[data-field="category"]').value,
        tags: row.querySelector('[data-field="tags"]').value.split(',').map((t) => t.trim()).filter(Boolean) }));
    const status = $('financeSuggestStatus');
    if (!rules.length) { status.textContent = 'Check at least one row with a category.'; return; }
    try {
      const result = await post('rules', { rules, createdBy: 'owner-page' });
      status.textContent = `${rules.length} rule(s) saved, ${result.transactionsUpdated} transaction(s) categorized.`;
      $('financeSuggestTable').hidden = true;
      $('financeSaveRules').hidden = true;
      await refresh();
    } catch (error) {
      status.textContent = `Save rejected: ${error.message}`;
    }
  }

  async function refresh() {
    try {
      const f = filters();
      const [monthly, merchants, byCategory, pending] = await Promise.all([api('summary/monthly', f),
        api('summary/merchants', { ...f, limit: 12 }), api('summary/categories', f), api('uncategorized', { limit: 1 })]);
      renderMonthly(monthly);
      renderMerchants(merchants.merchants || []);
      renderCategories(byCategory.categories || [], pending);
      await search();
      showError(null);
    } catch (error) {
      showError(error);
    }
  }

  async function start() {
    try {
      const [balances, statements, coverage, alerts, rules, tagList] = await Promise.all([api('balances'), api('statements'),
        api('coverage'), api('alerts'), api('rules'), api('tags')]);
      categoryList = rules.categories || [];
      $('financeCategory').append(...categoryList.map((name) => el('option', { value: name }, name)));
      $('financeTag').append(...(tagList.tags || []).map((t) => el('option', { value: t.tag }, `${t.tag} (${t.count})`)));
      renderBalances(balances.accounts || []);
      renderStatements(statements.statements || []);
      renderCoverage(coverage.series || []);
      renderAlerts(alerts.alerts || []);
      if ([...$('financeAccount').options].some((o) => o.value === 'EOP')) $('financeAccount').value = 'EOP';
      await refresh();
    } catch (error) {
      showError(error);
    }
  }

  for (const id of ['financeAccount', 'financeFrom', 'financeTo', 'financeCategory', 'financeTag', 'financeExcludeTransfers']) {
    $(id).addEventListener('change', refresh);
  }
  $('financeSearch').addEventListener('submit', search);
  $('financeSearchResult').addEventListener('click', (event) => {
    const button = event.target.closest('[data-edit]');
    if (button) editRow(button);
  });
  $('financeSuggest').addEventListener('click', proposeCategories);
  $('financeSaveRules').addEventListener('click', saveRules);
  start();
}());
