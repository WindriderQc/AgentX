'use strict';

// Wallet Beefer "situation" sections: plan (budget, debts, credit, provisions,
// milestones) combined by Core with the ledger. The browser only formats.
(function financeSituation() {
  const $ = (id) => document.getElementById(id);
  if (new URLSearchParams(window.location.search).get('ledger') === 'corp') return; // the plan is personal

  function money(cents) {
    if (!Number.isFinite(cents)) return '—';
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(Math.round(cents));
    return `${sign}${String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${String(abs % 100).padStart(2, '0')} $`;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value; else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child ?? '')));
    return node;
  }

  function tile(label, value, detail, tone = '') {
    return el('article', { class: `finance-tile ${tone}` },
      el('span', { class: 'finance-tile-label' }, label),
      el('strong', { class: 'finance-tile-value' }, value),
      el('span', { class: 'finance-tile-date' }, detail || ''));
  }

  function rate(bp) {
    return Number.isFinite(bp) ? `${(bp / 100).toFixed(2).replace('.', ',')} %` : '—';
  }

  function show(id, visible) { $(id).hidden = !visible; }

  // Status words get a colored dot; the word itself always stays visible.
  function badge(status) {
    const text = String(status || '');
    if (!text) return '';
    const key = text.toLowerCase();
    const tone = /(pay|sold|sain|fait|décid|attendu|ferm|coussin|réglé|ok)/.test(key) ? 'good'
      : /(bloqu|échu|retard|ouvert|critique)/.test(key) ? 'bad' : 'warn';
    return el('span', { class: `finance-badge finance-badge-${tone}` }, text);
  }

  function renderNet(months, excludedTags = []) {
    const canvas = $('netChart');
    const css = getComputedStyle(document.querySelector('.finance-page'));
    const good = css.getPropertyValue('--good').trim();
    const bad = css.getPropertyValue('--series-out').trim();
    const text = css.getPropertyValue('--finance-muted').trim();
    const grid = css.getPropertyValue('--finance-grid').trim();
    const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
    const labels = months.map((m) => { const [y, mm] = m.month.split('-'); return `${MONTHS[Number(mm) - 1]} ${y.slice(2)}`; });
    const values = months.map((m) => m.netCents / 100);
    const labelPlugin = {
      id: 'netLabels',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        ctx.save();
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = css.getPropertyValue('--text').trim() || '#e8edf5';
        ctx.textAlign = 'center';
        chart.getDatasetMeta(0).data.forEach((bar, i) => {
          const v = months[i].netCents;
          ctx.fillText(`${v > 0 ? '+' : ''}${Math.round(v / 100).toLocaleString('fr-CA')} $`, bar.x, v >= 0 ? bar.y - 5 : bar.y + 13);
        });
        ctx.restore();
      }
    };
    if (window.Chart) {
      window.Chart.getChart(canvas)?.destroy();
      new window.Chart(canvas, {
        type: 'bar',
        data: { labels, datasets: [{ data: values, backgroundColor: values.map((v) => (v >= 0 ? good : bad)), borderRadius: 4, maxBarThickness: 40 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `Net : ${money(Math.round(c.parsed.y * 100))}` } } },
          scales: { x: { grid: { display: false }, ticks: { color: text } },
            y: { grid: { color: grid }, border: { display: false }, ticks: { color: text, callback: (v) => `${Math.round(v).toLocaleString('fr-CA')} $` } } } },
        plugins: [labelPlugin]
      });
    }
    $('financeNetNote').textContent = 'Entrées − sorties par mois, tous comptes, virements internes exclus'
      + (excludedTags.length ? ` et mouvements exceptionnels (${excludedTags.map((t) => `#${t}`).join(', ')}) exclus` : '')
      + ' · 12 derniers mois avec données';
  }

  function render(s) {
    $('financePhase').textContent = s.phase || '';
    const asOf = s.cash?.asOf ? `au ${s.cash.asOf}` : '';
    const window = s.window?.months?.length ? `moyenne ${s.window.months[0]} → ${s.window.months.at(-1)}` : '';
    $('financeSituation').replaceChildren(
      tile('Encaisse (compte EOP)', s.cash ? money(s.cash.balanceCents) : '—', asOf),
      tile('Dette totale', money(s.totalDebtCents), `${s.debts.length} dette(s) suivie(s)`),
      tile('Crédit disponible', money(s.creditAvailableCents), 'limites − soldes utilisés'),
      tile('Valeur nette', money(s.netWorthCents),
        s.assets.length ? `${s.assets.map((a) => `${a.name} ${money(a.valueCents)}`).join(' + ')} + encaisse − dettes` : 'actifs + encaisse − dettes',
        s.netWorthCents < 0 ? 'finance-tile-bad' : ''),
      ...(s.taxRoom.length ? [tile('Abris fiscaux disponibles', money(s.taxRoomCents),
        s.taxRoom.map((t) => `${t.name} ${money(t.roomCents)}`).join(' + '))] : []),
      tile('Net mensuel moyen', money(s.monthly.netCents), window, s.monthly.netCents < 0 ? 'finance-tile-bad' : 'finance-tile-good'));
    $('financeSituationNote').textContent = s.planUpdatedAt
      ? `Plan mis à jour le ${String(s.planUpdatedAt).slice(0, 10)} · soldes et réels tirés du ledger, virements internes`
        + `${s.excludeTags?.length ? ` et mouvements exceptionnels (${s.excludeTags.map((t) => `#${t}`).join(', ')})` : ''} exclus.`
      : 'Aucun plan enregistré : budget, dettes et provisions apparaîtront une fois le plan importé.';

    $('financeDone').replaceChildren(...s.milestones.map((m) => el('li', { class: m.done ? 'finance-done' : 'finance-todo' },
      `${m.done ? '✓' : '○'} ${m.text}`)));
    show('financeMilestonesCard', s.milestones.length > 0);

    $('financeOpen').replaceChildren(...s.openItems.map((item) => el('li', { class: `finance-open-${item.severity}` },
      el('strong', {}, item.title), item.detail ? ` — ${item.detail}` : '')));
    show('financeOpenCard', s.openItems.length > 0);

    $('financeAlloc').tBodies[0].replaceChildren(...s.allocations.map((a) => el('tr', {},
      el('td', {}, a.step), el('td', { class: 'num' }, a.amountText || money(a.amountCents)),
      el('td', {}, badge(a.status), ` ${a.effect || ''}`))));
    show('financeAllocCard', s.allocations.length > 0);

    $('financeWatch').tBodies[0].replaceChildren(...s.watch.map((w) => el('tr', {},
      el('td', { class: 'finance-nowrap' }, w.date), el('td', {}, w.what), el('td', {}, badge(w.status)))));
    show('financeWatchCard', s.watch.length > 0);

    $('financeDebts').tBodies[0].replaceChildren(...s.debts.map((d) => el('tr', {},
      el('td', {}, d.name), el('td', { class: 'num' }, money(d.currentCents), d.asOf ? el('small', {}, ` au ${d.asOf}`) : ''),
      el('td', { class: 'num' }, rate(d.rateBp)), el('td', { class: 'num' }, money(d.paymentCents)), el('td', {}, badge(d.status)))));
    show('financeDebtsCard', s.debts.length > 0);

    $('financeCredit').tBodies[0].replaceChildren(...s.credit.map((c) => el('tr', {},
      el('td', {}, c.name), el('td', { class: 'num' }, money(c.limitCents)), el('td', { class: 'num' }, money(c.usedCents)),
      el('td', { class: 'num' }, money(c.availableCents)), el('td', {}, badge(c.status)))));
    show('financeCreditCard', s.credit.length > 0);

    const lines = s.budget.filter((b) => b.category !== 'Revenus');
    const largest = Math.max(1, ...lines.map((b) => Math.max(b.monthlyCents, b.actualMonthlyCents)));
    $('financeBudget').tBodies[0].replaceChildren(...s.budget.map((b) => {
      const income = b.category === 'Revenus';
      const over = income ? b.gapCents < 0 : b.gapCents > 0;
      const width = (value) => `${Math.min(100, (value / largest) * 100).toFixed(1)}%`;
      return el('tr', { class: over ? 'finance-over' : '' },
        el('td', {}, b.label, el('small', {}, ` · ${b.category}${b.tag ? ` #${b.tag}` : ''}`)),
        el('td', { class: 'num' }, money(b.monthlyCents)), el('td', { class: 'num' }, money(b.actualMonthlyCents)),
        el('td', { class: 'num' }, `${b.gapCents > 0 ? '+' : ''}${money(b.gapCents)}`),
        el('td', { class: 'finance-budget-bar-col' }, income ? '' : el('span', { class: 'finance-budget-track' },
          el('span', { class: 'finance-budget-plan', style: `width:${width(b.monthlyCents)}` }),
          el('span', { class: `finance-budget-actual${over ? ' finance-budget-actual-over' : ''}`, style: `width:${width(b.actualMonthlyCents)}` }))));
    }));
    $('financeBudgetNote').textContent = s.window?.months?.length
      ? `Réel = moyenne de ${s.window.months.length} mois (${s.window.months[0]} → ${s.window.months.at(-1)}) · total dépenses budget ${money(s.budgetTotals.monthlyCents)} vs réel ${money(s.budgetTotals.actualMonthlyCents)}`
      : '';
    show('financeBudgetCard', s.budget.length > 0);

    $('financeProvisions').tBodies[0].replaceChildren(...s.provisions.map((p) => el('tr', {},
      el('td', {}, p.name), el('td', { class: 'num' }, money(p.annualCents)), el('td', { class: 'num' }, money(Math.round(p.annualCents / 12))),
      el('td', {}, [p.due, p.note].filter(Boolean).join(' · ')))));
    $('financeProvisionsNote').textContent = s.provisions.length ? `≈ ${money(s.provisionsMonthlyCents)} à mettre de côté chaque mois` : '';
    show('financeProvisionsCard', s.provisions.length > 0);
  }

  fetch('/api/finance/situation', { credentials: 'same-origin' })
    .then((response) => response.json())
    .then((body) => {
      if (body?.status !== 'success') return;
      render(body.data);
      const excluded = (body.data.excludeTags || []).join(',');
      fetch(`/api/finance/summary/monthly?excludeCategory=Virements%20internes&excludeTag=${encodeURIComponent(excluded)}`, { credentials: 'same-origin' })
        .then((response) => response.json())
        .then((monthly) => { if (monthly?.status === 'success') renderNet(monthly.data.months.slice(-12), body.data.excludeTags || []); })
        .catch(() => {});
    })
    .catch(() => { $('financeSituationNote').textContent = 'Situation indisponible pour le moment.'; });
}());
