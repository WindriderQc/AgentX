'use strict';

// Plan editor on the Finances page: one tab per plan section, an editable
// table per tab, saved whole through PUT /api/finance/plan/:section. Amounts
// are typed in dollars and stored in integer cents; rates in percent.
(function financePlanEditor() {
  if (new URLSearchParams(window.location.search).get('ledger') === 'corp') return;
  const $ = (id) => document.getElementById(id);

  const SEVERITY = [['critical', 'Urgent'], ['warning', 'Important'], ['info', 'Info']];
  const SECTIONS = [
    { key: 'openItems', label: 'Dossiers ouverts', fields: [['title', 'Titre'], ['detail', 'Détail', 'long'], ['severity', 'Priorité', SEVERITY]] },
    { key: 'watch', label: 'Vigie', fields: [['date', 'Date'], ['what', 'Quoi', 'long'], ['status', 'Statut']] },
    { key: 'debts', label: 'Dettes', fields: [['name', 'Dette', 'long'], ['accountCode', 'Code compte'], ['issuer', 'Émetteur'],
      ['balanceCents', 'Solde ($, si pas lié)', 'money'], ['rateBp', 'Taux (%)', 'rate'], ['paymentCents', 'Paiement ($)', 'money'],
      ['status', 'Statut'], ['endDate', 'Fin (AAAA-MM-JJ)']] },
    { key: 'credit', label: 'Crédit', fields: [['name', 'Compte', 'long'], ['accountCode', 'Code compte'], ['issuer', 'Émetteur'],
      ['limitCents', 'Limite ($)', 'money'], ['balanceCents', 'Solde ($, si pas lié)', 'money'], ['status', 'Statut']] },
    { key: 'budget', label: 'Budget', fields: [['label', 'Poste', 'long'], ['category', 'Catégorie', 'category'], ['tag', 'Tag'],
      ['monthlyCents', 'Par mois ($)', 'money']] },
    { key: 'provisions', label: 'Provisions', fields: [['name', 'Dépense', 'long'], ['annualCents', 'Annuel ($)', 'money'], ['due', 'Échéance'], ['note', 'Note', 'long']] },
    { key: 'assets', label: 'Actifs', fields: [['name', 'Actif'], ['valueCents', 'Valeur ($)', 'money'], ['asOf', 'Au (AAAA-MM-JJ)'], ['note', 'Note']] },
    { key: 'taxRoom', label: 'Abris fiscaux', fields: [['name', 'Abri'], ['roomCents', 'Droits ($)', 'money'], ['asOf', 'Année / date']] },
    { key: 'allocations', label: 'Affectation', fields: [['step', 'Geste', 'long'], ['amountCents', 'Montant ($)', 'money'], ['amountText', 'ou texte'],
      ['status', 'Statut'], ['effect', 'Effet', 'long']] },
    { key: 'milestones', label: 'Réglé', fields: [['text', 'Élément', 'long'], ['done', 'Fait', 'bool']] },
    { key: 'phase', label: 'Phase', scalar: true },
    { key: 'excludeTags', label: 'Tags exceptionnels', list: true }
  ];

  let plan = null;
  let categories = [];
  let current = SECTIONS[0];

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value; else if (value !== false && value !== undefined) node.setAttribute(key, value);
    }
    for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child ?? '')));
    return node;
  }

  const toDollars = (cents) => (Number.isFinite(cents) ? (cents / 100).toFixed(2).replace('.', ',') : '');
  const toCents = (text) => {
    const clean = String(text).replace(/\s/g, '').replace(',', '.');
    return clean === '' ? null : Math.round(Number.parseFloat(clean) * 100);
  };

  function input(field, value) {
    const [key, , kind] = field;
    if (kind === 'bool') return el('input', { type: 'checkbox', 'data-key': key, checked: value ? '' : false });
    if (Array.isArray(kind) || kind === 'category') {
      const options = kind === 'category' ? categories.map((c) => [c, c]) : kind;
      const select = el('select', { 'data-key': key }, ...options.map(([v, label]) => el('option', { value: v }, label)));
      select.value = value || options[0]?.[0] || '';
      return select;
    }
    const shown = kind === 'money' ? toDollars(value) : kind === 'rate' ? (Number.isFinite(value) ? (value / 100).toString().replace('.', ',') : '') : (value ?? '');
    return el('input', { type: 'text', 'data-key': key, 'data-kind': kind || 'text', value: String(shown), class: kind === 'long' ? 'finance-edit-long' : '' });
  }

  function readRow(row, section) {
    const item = {};
    for (const [key, , kind] of section.fields) {
      const node = row.querySelector(`[data-key="${key}"]`);
      if (kind === 'bool') item[key] = node.checked;
      else if (kind === 'money') item[key] = toCents(node.value);
      else if (kind === 'rate') item[key] = node.value.trim() === '' ? null : Math.round(Number.parseFloat(node.value.replace(',', '.')) * 100);
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
        ...(current.scalar || current.list ? [] : [el('button', { type: 'button', class: 'finance-link', id: 'planAdd' }, '+ Ajouter une ligne')]),
        el('button', { type: 'button', class: 'finance-button', id: 'planSave' }, 'Enregistrer'),
        el('span', { class: 'finance-note', id: 'planStatus', 'aria-live': 'polite' })));
  }

  async function save() {
    let value;
    if (current.scalar) value = $('planScalar').value;
    else if (current.list) value = $('planList').value.split(',').map((t) => t.trim()).filter(Boolean);
    else value = [...$('planTable').tBodies[0].rows].map((row) => readRow(row, current));
    $('planStatus').textContent = 'Enregistrement…';
    try {
      const response = await fetch(`/api/finance/plan/${current.key}`, { method: 'PUT', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) });
      const body = await response.json();
      if (!response.ok || body.status !== 'success') throw new Error(body.message || `Erreur ${response.status}`);
      plan = body.data;
      $('planStatus').textContent = 'Enregistré — rechargement…';
      setTimeout(() => window.location.reload(), 600);
    } catch (error) {
      $('planStatus').textContent = `Refusé : ${error.message}`;
    }
  }

  async function open() {
    const panel = $('planEditor');
    panel.hidden = !panel.hidden;
    if (panel.hidden || plan) { if (plan) render(); return; }
    const [p, r] = await Promise.all([fetch('/api/finance/plan', { credentials: 'same-origin' }).then((x) => x.json()),
      fetch('/api/finance/rules', { credentials: 'same-origin' }).then((x) => x.json())]);
    plan = p.data;
    categories = r.data?.categories || [];
    render();
  }

  const header = document.querySelector('.finance-header');
  header.append(el('button', { type: 'button', class: 'finance-button finance-edit-toggle', id: 'planEditToggle' }, '✎ Modifier le plan'),
    el('section', { class: 'finance-card', id: 'planEditor', hidden: '' },
      el('h2', {}, 'Modifier le plan'),
      el('p', { class: 'finance-note' }, 'Choisis une section, modifie, puis « Enregistrer ». Montants en dollars (1234,56), taux en %. '
        + 'Un code compte (EOP, CARD, MC2, PR3…) lie la ligne au solde réel du ledger.'),
      el('div', { id: 'planEditorBody' })));
  $('planEditToggle').addEventListener('click', open);
  $('planEditor').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-section]');
    if (tab) { current = SECTIONS.find((s) => s.key === tab.dataset.section); render(); return; }
    if (event.target.closest('[data-remove]')) { event.target.closest('tr').remove(); return; }
    if (event.target.id === 'planAdd') {
      $('planTable').tBodies[0].append(el('tr', {}, ...current.fields.map((field) => el('td', {}, input(field, field[2] === 'bool' ? false : null))),
        el('td', {}, el('button', { type: 'button', class: 'finance-link', 'data-remove': '1' }, '✕'))));
      return;
    }
    if (event.target.id === 'planSave') save();
  });
}());
