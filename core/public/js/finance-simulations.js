'use strict';

// Simulations and trajectories on the Finances page: debt trajectory under a
// payment scenario, 12-month cash forecast, statement balance history and
// spending per category per month. Core computes; the browser draws.
(function financeSimulations() {
  const $ = (id) => document.getElementById(id);
  const CORP = new URLSearchParams(window.location.search).get('ledger') === 'corp';
  const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  // Validated dark categorical steps (fixed order, never cycled).
  const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

  function money(cents) {
    if (!Number.isFinite(cents)) return '—';
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(Math.round(cents));
    return `${sign}${String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${String(abs % 100).padStart(2, '0')} $`;
  }
  const dollars = (value) => `${Math.round(value).toLocaleString('fr-CA')} $`;
  const monthLabel = (m) => { const [y, mm] = m.split('-'); return `${MONTHS[Number(mm) - 1]} ${y.slice(2)}`; };
  const toCents = (id) => Math.round((Number.parseFloat(String($(id).value).replace(/\s/g, '').replace(',', '.')) || 0) * 100);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) { if (key === 'class') node.className = value; else node.setAttribute(key, value); }
    for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child ?? '')));
    return node;
  }

  function theme() {
    const css = getComputedStyle(document.querySelector('.finance-page'));
    return { text: css.getPropertyValue('--finance-muted').trim(), grid: css.getPropertyValue('--finance-grid').trim() };
  }

  function lineChart(canvas, labels, datasets, { stacked = false, type = 'line' } = {}) {
    if (!window.Chart) return;
    const t = theme();
    window.Chart.getChart(canvas)?.destroy();
    new window.Chart(canvas, {
      type,
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: datasets.length > 1, labels: { color: t.text, boxWidth: 12 } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label} : ${money(Math.round(c.parsed.y * 100))}` } }
        },
        scales: {
          x: { stacked, grid: { display: false }, ticks: { color: t.text, maxTicksLimit: 14 } },
          y: { stacked, grid: { color: t.grid }, border: { display: false }, ticks: { color: t.text, callback: dollars } }
        }
      }
    });
  }

  async function getJson(path, options) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== 'success') throw new Error(body?.message || `Erreur ${response.status}`);
    return body.data;
  }

  async function runDebt(event) {
    event?.preventDefault();
    const params = new URLSearchParams({
      months: String(Math.round((Number($('simYears').value) || 6) * 12)),
      extraMonthlyCents: String(toCents('simExtra')), lumpSumCents: String(toCents('simLump')),
      lumpSumMonth: String(Number($('simLumpMonth').value) || 1), annualBonusCents: String(toCents('simBonus'))
    });
    try {
      const d = await getJson(`/api/finance/simulate/debt?${params}`);
      const labels = d.baseline.points.map((p) => monthLabel(p.month));
      lineChart($('debtChart'), labels, [
        { label: 'A — paiements actuels', data: d.baseline.points.map((p) => p.totalCents / 100), borderColor: SERIES[0], backgroundColor: SERIES[0], pointRadius: 0, borderWidth: 2 },
        { label: 'B — avec le scénario', data: d.withScenario.points.map((p) => p.totalCents / 100), borderColor: SERIES[1], backgroundColor: SERIES[1], pointRadius: 0, borderWidth: 2 }
      ]);
      $('debtResult').replaceChildren(
        el('li', {}, `Dette à l'horizon : A ${money(d.baseline.endCents)} · B ${money(d.withScenario.endCents)}`),
        el('li', {}, `Intérêts payés : A ${money(d.baseline.interestCents)} · B ${money(d.withScenario.interestCents)} — `,
          el('strong', {}, `économie ${money(d.interestSavedCents)}`)),
        ...d.withScenario.debts.map((debt) => el('li', {}, `${debt.name} : éteinte ${debt.paidOffMonth ? monthLabel(debt.paidOffMonth) : 'après l’horizon'}`)),
        ...(d.excluded.length ? [el('li', { class: 'finance-note' }, `Hors simulation (taux ou paiement inconnu, ou solde nul) : ${d.excluded.join(', ')}`)] : []));
    } catch (error) {
      $('debtResult').replaceChildren(el('li', { class: 'finance-error' }, error.message));
    }
  }

  function readEvents() {
    return String($('fcEvents').value).split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [month, amount, ...label] = line.split(/[;|]/).map((part) => part.trim());
      return { month, amountCents: Math.round((Number.parseFloat(String(amount || '0').replace(/\s/g, '').replace(',', '.')) || 0) * 100), label: label.join(' ') };
    });
  }

  async function runForecast(event) {
    event?.preventDefault();
    const body = { months: 12, cushionCents: toCents('fcCushion'), events: readEvents(),
      includeProvisions: $('fcProvisions').checked ? 'true' : 'false' };
    if ($('fcIncome').value) body.incomeCents = toCents('fcIncome');
    if ($('fcSpend').value) body.spendCents = toCents('fcSpend');
    try {
      const f = await getJson('/api/finance/simulate/forecast', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!$('fcIncome').value) $('fcIncome').placeholder = String(Math.round(f.assumptions.incomeCents / 100));
      if (!$('fcSpend').value) $('fcSpend').placeholder = String(Math.round(f.assumptions.spendCents / 100));
      const labels = f.rows.map((r) => monthLabel(r.month));
      const datasets = [{ label: 'Encaisse projetée', data: f.rows.map((r) => r.closingCents / 100), borderColor: SERIES[2], backgroundColor: SERIES[2], pointRadius: 3, borderWidth: 2 }];
      if (body.cushionCents) datasets.push({ label: 'Coussin visé', data: f.rows.map(() => body.cushionCents / 100), borderColor: SERIES[3], borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5 });
      lineChart($('forecastChart'), labels, datasets);
      $('forecastNote').textContent = `Départ ${money(f.startCashCents)} (${f.startCashAsOf || '—'}) · revenus ${money(f.assumptions.incomeCents)}/mois `
        + `(budget ${money(f.assumptions.budgetIncome)}, réel récent ${money(f.assumptions.actualIncomeCents)}) · dépenses ${money(f.assumptions.spendCents)}/mois `
        + `(budget ${money(f.assumptions.budgetSpend)}, réel récent ${money(f.assumptions.actualSpendCents)}) · provisions ${money(f.assumptions.provisionsCents)}/mois `
        + `· point bas ${money(f.lowestCents)} · fin ${money(f.endCashCents)}`;
      $('forecastTable').tBodies[0].replaceChildren(...f.rows.map((r) => el('tr', { class: r.belowCushion ? 'finance-over' : '' },
        el('td', {}, monthLabel(r.month)), el('td', { class: 'num' }, money(r.incomeCents)), el('td', { class: 'num' }, money(-r.spendCents - r.provisionsCents)),
        el('td', { class: 'num' }, r.eventsCents ? `${money(r.eventsCents)} ${r.events.join(', ')}` : ''), el('td', { class: 'num' }, money(r.closingCents)))));
    } catch (error) {
      $('forecastNote').textContent = error.message;
    }
  }

  async function renderHistory() {
    try {
      const { series } = await getJson(`/api/finance/history/balances${CORP ? '?ledger=corp' : ''}`);
      const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date.slice(0, 7))))].sort();
      const top = series.sort((a, b) => Math.max(...b.points.map((p) => Math.abs(p.balanceCents))) - Math.max(...a.points.map((p) => Math.abs(p.balanceCents))))
        .filter((s) => $('histKind').value === 'all' || (s.code === 'EOP') === ($('histKind').value === 'cash'))
        .slice(0, SERIES.length);
      lineChart($('historyChart'), dates.map(monthLabel), top.map((s, i) => {
        const byMonth = new Map(s.points.map((p) => [p.date.slice(0, 7), p.balanceCents / 100]));
        return { label: `${s.code} · ${s.issuer}`, data: dates.map((m) => byMonth.get(m) ?? null), spanGaps: true,
          borderColor: SERIES[i], backgroundColor: SERIES[i], pointRadius: 0, borderWidth: 2 };
      }));
    } catch (error) {
      $('historyNote').textContent = error.message;
    }
  }

  async function renderCategoryMonths() {
    try {
      const d = await getJson(`/api/finance/summary/category-months?months=${$('catMonths').value}${CORP ? '&ledger=corp' : ''}`);
      const main = d.categories.slice(0, SERIES.length - 1);
      const rest = d.categories.slice(SERIES.length - 1);
      const datasets = main.map((c, i) => ({ label: c.category, data: c.perMonthCents.map((v) => v / 100), backgroundColor: SERIES[i], borderWidth: 0 }));
      if (rest.length) {
        datasets.push({ label: 'Autres catégories', data: d.months.map((_, m) => rest.reduce((sum, c) => sum + c.perMonthCents[m], 0) / 100),
          backgroundColor: '#6b7280', borderWidth: 0 });
      }
      lineChart($('categoryMonthsChart'), d.months.map(monthLabel), datasets, { stacked: true, type: 'bar' });
    } catch (error) {
      $('categoryMonthsNote').textContent = error.message;
    }
  }

  $('debtForm').addEventListener('submit', runDebt);
  $('forecastForm').addEventListener('submit', runForecast);
  $('histKind').addEventListener('change', renderHistory);
  $('catMonths').addEventListener('change', renderCategoryMonths);
  if (!CORP) {
    runDebt();
    runForecast();
  }
  renderHistory();
  renderCategoryMonths();
}());
