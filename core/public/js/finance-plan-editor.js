'use strict';

// Plan editor on the Finances page: one tab per plan section, an editable
// table per tab, saved whole through PUT /api/finance/plan/:section. Amounts
// are typed in dollars and stored in integer cents; rates in percent.
(function financePlanEditor() {
  if (new URLSearchParams(window.location.search).get('ledger') === 'corp') return;
  const $ = (id) => document.getElementById(id);

  const SEVERITY = [['critical', 'Urgent'], ['warning', 'Important'], ['info', 'Info']];
  const SECTIONS = [
    { key: 'openItems', label: 'Open items', fields: [['title', 'Title'], ['detail', 'Detail', 'long'], ['severity', 'Priority', SEVERITY]] },
    { key: 'watch', label: 'Watch', fields: [['date', 'Date'], ['what', 'What', 'long'], ['status', 'Status']] },
    { key: 'debts', label: 'Debts', fields: [['name', 'Debt', 'long'], ['accountCode', 'Account code'], ['issuer', 'Issuer'],
      ['balanceCents', 'Balance ($, if not linked)', 'money'], ['rateBp', 'Rate (%)', 'rate'], ['paymentCents', 'Payment ($)', 'money'],
      ['status', 'Status'], ['endDate', 'End (YYYY-MM-DD)']] },
    { key: 'credit', label: 'Credit', fields: [['name', 'Account', 'long'], ['accountCode', 'Account code'], ['issuer', 'Issuer'],
      ['limitCents', 'Limit ($)', 'money'], ['balanceCents', 'Balance ($, if not linked)', 'money'], ['status', 'Status']] },
    { key: 'budget', label: 'Budget', fields: [['label', 'Line', 'long'], ['category', 'Category', 'category'], ['tag', 'Tag'],
      ['monthlyCents', 'Per month ($)', 'money']] },
    { key: 'provisions', label: 'Provisions', fields: [['name', 'Expense', 'long'], ['annualCents', 'Annual ($)', 'money'], ['due', 'Due'], ['note', 'Note', 'long']] },
    { key: 'assets', label: 'Assets', fields: [['name', 'Asset'], ['valueCents', 'Value ($)', 'money'], ['asOf', 'As of (YYYY-MM-DD)'], ['note', 'Note']] },
    { key: 'taxRoom', label: 'Tax shelters', fields: [['name', 'Shelter'], ['roomCents', 'Room ($)', 'money'], ['asOf', 'Year / date']] },
    { key: 'allocations', label: 'Allocation', fields: [['step', 'Step', 'long'], ['amountCents', 'Amount ($)', 'money'], ['amountText', 'or text'],
      ['status', 'Status'], ['effect', 'Effect', 'long']] },
    { key: 'milestones', label: 'Settled', fields: [['text', 'Item', 'long'], ['done', 'Done', 'bool']] },
    { key: 'phase', label: 'Phase', scalar: true },
    { key: 'excludeTags', label: 'Exceptional tags', list: true }
  ];

  let plan = null;
  let categories = [];
  let current = SECTIONS[0];
  let rendered = '';

  // The editor's typed state, to tell an edited section from the one rendered.
  function snapshot() {
    return JSON.stringify([...$('planEditorBody').querySelectorAll('input, select, textarea')]
      .map((node) => (node.type === 'checkbox' ? node.checked : node.value)));
  }
  const dirty = () => Boolean(plan) && !$('planEditor').hidden && snapshot() !== rendered;

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value; else if (value !== false && value !== undefined) node.setAttribute(key, value);
    }
    for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child ?? '')));
    return node;
  }

  const toDollars = (cents) => (Number.isFinite(cents) ? (cents / 100).toFixed(2) : '');
  // Accepts 1234.56, 1,234.56 and the French 1 234,56.
  const toNumber = (text) => {
    const clean = String(text).replace(/[\s$]/g, '');
    const plain = clean.includes('.') ? clean.replace(/,/g, '') : clean.replace(',', '.');
    // Anything but a plain number is unreadable, never a guess.
    return /^-?\d+(\.\d+)?$/.test(plain) ? Number(plain) : Number.NaN;
  };
  const toCents = (text) => (String(text).trim() === '' ? null : Math.round(toNumber(text) * 100));

  function input(field, value) {
    const [key, , kind] = field;
    if (kind === 'bool') return el('input', { type: 'checkbox', 'data-key': key, checked: value ? '' : false });
    if (Array.isArray(kind) || kind === 'category') {
      const options = kind === 'category' ? categories.map((c) => [c, c]) : kind;
      const select = el('select', { 'data-key': key }, ...options.map(([v, label]) => el('option', { value: v }, label)));
      select.value = value || options[0]?.[0] || '';
      return select;
    }
    const shown = kind === 'money' ? toDollars(value) : kind === 'rate' ? (Number.isFinite(value) ? (value / 100).toString() : '') : (value ?? '');
    return el('input', { type: 'text', 'data-key': key, 'data-kind': kind || 'text', value: String(shown), class: kind === 'long' ? 'finance-edit-long' : '' });
  }

  function readRow(row, section) {
    const item = {};
    for (const [key, , kind] of section.fields) {
      const node = row.querySelector(`[data-key="${key}"]`);
      if (kind === 'bool') item[key] = node.checked;
      else if (kind === 'money') item[key] = toCents(node.value);
      else if (kind === 'rate') item[key] = node.value.trim() === '' ? null : Math.round(toNumber(node.value) * 100);
      else item[key] = node.value.trim();
    }
    return item;
  }

  function render() {
    const body = $('planEditorBody');
    const tabs = SECTIONS.map((section) => el('button', { type: 'button', class: `finance-tab${section === current ? ' finance-tab-on' : ''}`,
      'data-section': section.key }, section.label));
    let editor;
    if (current.scalar) {
      editor = el('textarea', { id: 'planScalar', rows: '4', class: 'finance-edit-area' }, plan[current.key] || '');
    } else if (current.list) {
      editor = el('input', { type: 'text', id: 'planList', class: 'finance-edit-long', value: (plan[current.key] || []).join(', ') });
    } else {
      const rows = (plan[current.key] || []).map((item) => el('tr', {},
        ...current.fields.map((field) => el('td', {}, input(field, item[field[0]]))),
        el('td', {}, el('button', { type: 'button', class: 'finance-link', 'data-remove': '1' }, '✕'))));
      editor = el('table', { class: 'finance-table finance-edit-table', id: 'planTable' },
        el('thead', {}, el('tr', {}, ...current.fields.map(([, label]) => el('th', {}, label)), el('th', {}, ''))),
        el('tbody', {}, ...rows));
    }
    body.replaceChildren(el('div', { class: 'finance-tabs', role: 'tablist' }, ...tabs), editor,
      el('div', { class: 'finance-edit-actions' },
        ...(current.scalar || current.list ? [] : [el('button', { type: 'button', class: 'finance-link', id: 'planAdd' }, '+ Add a row')]),
        el('button', { type: 'button', class: 'finance-button', id: 'planSave' }, 'Save'),
        el('span', { class: 'finance-note', id: 'planStatus', 'aria-live': 'polite' })));
    rendered = snapshot();
  }

  async function save() {
    let value;
    if (current.scalar) value = $('planScalar').value;
    else if (current.list) value = $('planList').value.split(',').map((t) => t.trim()).filter(Boolean);
    else value = [...$('planTable').tBodies[0].rows].map((row) => readRow(row, current));
    const unreadable = Array.isArray(value) && value.some((item) => item && typeof item === 'object'
      && Object.values(item).some((field) => typeof field === 'number' && !Number.isFinite(field)));
    if (unreadable) { $('planStatus').textContent = 'Check the amounts and rates: write numbers such as 1234.56 or 4.5.'; return; }
    $('planStatus').textContent = 'Saving…';
    try {
      const response = await fetch(`/api/finance/plan/${current.key}`, { method: 'PUT', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) });
      const body = await response.json();
      if (!response.ok || body.status !== 'success') throw new Error(body.message || `Error ${response.status}`);
      plan = body.data;
      rendered = snapshot();
      $('planStatus').textContent = 'Saved — reloading…';
      setTimeout(() => window.location.reload(), 600);
    } catch (error) {
      $('planStatus').textContent = `Rejected: ${error.message}`;
    }
  }

  // Hiding the panel keeps what is typed in it; only the first opening loads the plan.
  async function open() {
    const panel = $('planEditor');
    panel.hidden = !panel.hidden;
    if (panel.hidden || plan) return;
    try {
      const [p, r] = await Promise.all([fetch('/api/finance/plan', { credentials: 'same-origin' }).then((x) => x.json()),
        fetch('/api/finance/rules', { credentials: 'same-origin' }).then((x) => x.json())]);
      if (p.status !== 'success' || !p.data) throw new Error(p.message || 'the plan could not be read');
      plan = p.data;
      categories = r.data?.categories || [];
      render();
    } catch (error) {
      $('planEditorBody').replaceChildren(el('p', { class: 'finance-error' }, `Plan unavailable: ${error.message}. Close and reopen to retry.`));
    }
  }

  const header = document.querySelector('.finance-header');
  header.append(el('button', { type: 'button', class: 'finance-button finance-edit-toggle', id: 'planEditToggle' }, '✎ Edit the plan'),
    el('section', { class: 'finance-card', id: 'planEditor', hidden: '' },
      el('h2', {}, 'Edit the plan'),
      el('p', { class: 'finance-note' }, 'Choose a section, edit it, then Save. Amounts in dollars (1234.56), rates in %. '
        + 'An account code (EOP, CARD, MC2, PR3…) links the row to the real ledger balance.'),
      el('div', { id: 'planEditorBody' })));
  $('planEditToggle').addEventListener('click', open);
  $('planEditor').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-section]');
    if (tab) {
      if (dirty() && !window.confirm(`Discard the unsaved changes to ${current.label}?`)) return;
      current = SECTIONS.find((s) => s.key === tab.dataset.section);
      render();
      return;
    }
    if (event.target.closest('[data-remove]')) { event.target.closest('tr').remove(); return; }
    if (event.target.id === 'planAdd') {
      $('planTable').tBodies[0].append(el('tr', {}, ...current.fields.map((field) => el('td', {}, input(field, field[2] === 'bool' ? false : null))),
        el('td', {}, el('button', { type: 'button', class: 'finance-link', 'data-remove': '1' }, '✕'))));
      return;
    }
    if (event.target.id === 'planSave') save();
  });
  window.addEventListener('beforeunload', (event) => { if (dirty()) event.preventDefault(); });
}());
