'use strict';

// Simulations and trajectories on the Finances page: debt trajectory under a
// payment scenario, 12-month cash forecast, statement balance history and
// spending per category per month. Core computes; the browser draws.
(function financeSimulations() {
  const $ = (id) => document.getElementById(id);
  const CORP = new URLSearchParams(window.location.search).get('ledger') === 'corp';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Validated dark categorical steps (fixed order, never cycled).
  const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

  function money(cents) {
    if (!Number.isFinite(cents)) return '—';
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(Math.round(cents));
    return `${sign}$${String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(abs % 100).padStart(2, '0')}`;
  }
  const dollars = (value) => `${value < 0 ? '-' : ''}$${Math.abs(Math.round(value)).toLocaleString('en-US')}`;
  const monthLabel = (m) => { const [y, mm] = m.split('-'); return `${MONTHS[Number(mm) - 1]} ${y.slice(2)}`; };
  // Accepts 1234.56, 1,234.56 and the French 1 234,56; empty is 0 and anything else is
  // refused, never read as its leading digits.
  const parseAmount = (text) => {
    const clean = String(text).replace(/[\s$]/g, '');
    if (!clean) return 0;
    const plain = clean.includes('.') ? clean.replace(/,/g, '') : clean.replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(plain) ? Number(plain) : Number.NaN;
  };
  const toCents = (id) => {
    const value = parseAmount($(id).value);
    if (Number.isNaN(value)) {
      const label = $(id).closest('label')?.childNodes[0]?.textContent.trim() || 'an amount';
      throw new Error(`Check ${label}: write a number such as 1234.56.`);
    }
    return Math.round(value * 100);
  };

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
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(Math.round(c.parsed.y * 100))}` } }
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
    if (!response.ok || body?.status !== 'success') throw new Error(body?.message || `Error ${response.status}`);
    return body.data;
  }

  async function runDebt(event) {
    event?.preventDefault();
    try {
      const params = new URLSearchParams({
        months: String(Math.round((Number($('simYears').value) || 6) * 12)),
        extraMonthlyCents: String(toCents('simExtra')), lumpSumCents: String(toCents('simLump')),
        lumpSumMonth: String(Number($('simLumpMonth').value) || 1), annualBonusCents: String(toCents('simBonus'))
      });
      const d = await getJson(`/api/finance/simulate/debt?${params}`);
      const labels = d.baseline.points.map((p) => monthLabel(p.month));
      lineChart($('debtChart'), labels, [
        { label: 'A — current payments', data: d.baseline.points.map((p) => p.totalCents / 100), borderColor: SERIES[0], backgroundColor: SERIES[0], pointRadius: 0, borderWidth: 2 },
        { label: 'B — with the scenario', data: d.withScenario.points.map((p) => p.totalCents / 100), borderColor: SERIES[1], backgroundColor: SERIES[1], pointRadius: 0, borderWidth: 2 }
      ]);
      $('debtResult').replaceChildren(
        el('li', {}, `Debt at horizon: A ${money(d.baseline.endCents)} · B ${money(d.withScenario.endCents)}`),
        el('li', {}, `Interest paid: A ${money(d.baseline.interestCents)} · B ${money(d.withScenario.interestCents)} — `,
          el('strong', {}, `savings ${money(d.interestSavedCents)}`)),
        ...d.withScenario.debts.map((debt) => el('li', {}, `${debt.name}: paid off ${debt.paidOffMonth ? monthLabel(debt.paidOffMonth) : 'after the horizon'}`)),
        ...(d.excluded.length ? [el('li', { class: 'finance-note' }, `Not simulated (unknown rate or payment, or zero balance): ${d.excluded.join(', ')}`)] : []));
    } catch (error) {
      $('debtResult').replaceChildren(el('li', { class: 'finance-error' }, error.message));
    }
  }

  function readEvents() {
    return String($('fcEvents').value).split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [month, amount, ...label] = line.split(/[;|]/).map((part) => part.trim());
      const value = parseAmount(amount || '0');
      if (Number.isNaN(value)) throw new Error(`Check the event "${line}": its amount must be a number.`);
      return { month, amountCents: Math.round(value * 100), label: label.join(' ') };
    });
  }

  async function runForecast(event) {
    event?.preventDefault();
    try {
      const body = { months: 12, cushionCents: toCents('fcCushion'), events: readEvents(),
        includeProvisions: $('fcProvisions').checked ? 'true' : 'false' };
      if ($('fcIncome').value) body.incomeCents = toCents('fcIncome');
      if ($('fcSpend').value) body.spendCents = toCents('fcSpend');
      const f = await getJson('/api/finance/simulate/forecast', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!$('fcIncome').value) $('fcIncome').placeholder = String(Math.round(f.assumptions.incomeCents / 100));
      if (!$('fcSpend').value) $('fcSpend').placeholder = String(Math.round(f.assumptions.spendCents / 100));
      const labels = f.rows.map((r) => monthLabel(r.month));
      const datasets = [{ label: 'Projected cash', data: f.rows.map((r) => r.closingCents / 100), borderColor: SERIES[2], backgroundColor: SERIES[2], pointRadius: 3, borderWidth: 2 }];
      if (body.cushionCents) datasets.push({ label: 'Target cushion', data: f.rows.map(() => body.cushionCents / 100), borderColor: SERIES[3], borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5 });
      lineChart($('forecastChart'), labels, datasets);
      $('forecastNote').textContent = `Start ${money(f.startCashCents)} (${f.startCashAsOf || '—'}) · income ${money(f.assumptions.incomeCents)}/month `
        + `(budget ${money(f.assumptions.budgetIncome)}, recent actual ${money(f.assumptions.actualIncomeCents)}) · expenses ${money(f.assumptions.spendCents)}/month `
        + `(budget ${money(f.assumptions.budgetSpend)}, recent actual ${money(f.assumptions.actualSpendCents)}) · provisions ${money(f.assumptions.provisionsCents)}/month `
        + `· low point ${money(f.lowestCents)} · end ${money(f.endCashCents)}`;
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
        datasets.push({ label: 'Other categories', data: d.months.map((_, m) => rest.reduce((sum, c) => sum + c.perMonthCents[m], 0) / 100),
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
