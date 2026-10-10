'use strict';

const iotCombined = { chart: null, model: null, hoverTime: null };
const iotCombinedTime = (time, seconds = true) => {
  const at = new Date(time);
  return [at.getHours(), at.getMinutes(), ...(seconds ? [at.getSeconds()] : [])].map(value => String(value).padStart(2, '0')).join(':');
};
const iotCombinedDate = time => `${new Date(time).toLocaleDateString()} · ${iotCombinedTime(time)}`;

// Each metric keeps its own units and scale. All datasets share actual timestamps.
function iotCombinedModel() {
  const series = iotState.series || {};
  const live = iotState.period === 'live';
  const bucket = Math.max(1, Number(series.bucketSeconds) || 60) * 1000;
  let start = Infinity; let end = -Infinity;
  const metrics = iotState.keys.map((key, index) => {
    const measure = series.measures?.[key];
    const known = array(iotDevice()?.measures).find(item => item.key === key);
    const visual = iotMetric(key, known?.name || measure?.name);
    const raw = array(measure?.points).map(point => ({
      ts: new Date(point.ts).getTime(), value: live ? point.value : point.mean,
      min: live ? point.value : point.min, max: live ? point.value : point.max,
      count: live ? 1 : point.count, partial: point.partial === true
    })).filter(point => Number.isFinite(point.ts)).sort((a, b) => a.ts - b.ts);
    const points = raw.filter(point => Number.isFinite(point.value));
    const gaps = points.slice(1).map((point, i) => point.ts - points[i].ts).filter(gap => gap > 0);
    const cadence = live ? gaps.reduce((min, gap) => Math.min(min, gap), 5000) : bucket;
    const gapLimit = live ? Math.max(15000, cadence * 3) : bucket * 1.5;
    let min = Infinity; let max = -Infinity;
    for (const point of points) {
      start = Math.min(start, point.ts); end = Math.max(end, point.ts);
      min = Math.min(min, iotState.ranges && Number.isFinite(point.min) ? point.min : point.value);
      max = Math.max(max, iotState.ranges && Number.isFinite(point.max) ? point.max : point.value);
    }
    const divisor = points.length ? (Math.max(Math.abs(min), Math.abs(max)) || 1) : 1;
    const low = points.length ? min / divisor : 0; const high = points.length ? max / divisor : 1;
    const pad = high === low ? .04 : (high - low) * .12;
    const data = []; let previous = null;
    for (const point of raw) {
      if (previous && point.ts - previous.ts > gapLimit) data.push({ x: previous.ts + (point.ts - previous.ts) / 2, y: null });
      data.push({ x: point.ts, y: Number.isFinite(point.value) ? point.value / divisor : null });
      previous = point;
    }
    return { key, ...visual, unit: measure?.unit || known?.unit || '', points, data, divisor,
      axis: `iotY${index}`, low: low - pad, high: high + pad, min, max,
      tolerance: live ? Math.max(7500, cadence * 1.5) : bucket * .51 };
  });
  const from = new Date(series.from).getTime(); const to = new Date(series.to).getTime();
  if (!live && Number.isFinite(from) && Number.isFinite(to) && to > from) { start = from; end = to; }
  const populated = metrics.filter(metric => metric.points.length);
  const axis = populated.find(metric => metric.key === iotState.axis) || populated[0];
  return { metrics, populated, live, axis, start, end: Math.max(end, start + 1000) };
}

function iotNearestValue(metric, time) {
  const points = metric.points;
  if (!points.length) return null;
  let low = 0; let high = points.length - 1;
  while (low < high) { const mid = (low + high) >> 1; if (points[mid].ts < time) low = mid + 1; else high = mid; }
  const before = points[Math.max(0, low - 1)]; const after = points[low];
  const point = Math.abs(before.ts - time) < Math.abs(after.ts - time) ? before : after;
  return Math.abs(point.ts - time) <= metric.tolerance ? point : null;
}

function iotCombinedReadings(model) {
  return model.metrics.map(metric => {
    const last = metric.points.at(-1);
    return `<div class="iot-overlay-reading" style="--series:${metric.color}"><span><i aria-hidden="true"></i>${e(metric.label)}</span><strong>${e(iotValue(last?.value))}<small>${e(metric.unit)}</small></strong><small>${last ? e(iotAge(last.ts)) : 'Aucune mesure'}</small></div>`;
  }).join('');
}

function iotCombinedTables(model) {
  return model.metrics.map(metric => `<details class="iot-data"><summary>${e(metric.label)} · ${number(metric.points.length)} points${model.live ? '' : ' · moyenne et min–max'}</summary>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Valeurs de ${e(metric.label)}"><table><thead><tr><th scope="col">Heure</th><th scope="col">${model.live ? 'Valeur' : 'Moyenne'}</th>${model.live ? '' : '<th scope="col">Min</th><th scope="col">Max</th><th scope="col">Mesures</th>'}</tr></thead><tbody>${metric.points.map(point => `<tr><th scope="row">${e(date(point.ts))}${point.partial ? ' (en cours)' : ''}</th><td>${e(String(point.value))} ${e(metric.unit)}</td>${model.live ? '' : `<td>${Number.isFinite(point.min) ? e(String(point.min)) : '—'}</td><td>${Number.isFinite(point.max) ? e(String(point.max)) : '—'}</td><td>${number(point.count)}</td>`}</tr>`).join('')}</tbody></table></div></details>`).join('');
}

function iotCombinedHtml() {
  const model = iotCombinedModel();
  if (!model.populated.length) return '<p class="iot-empty">Aucune mesure reçue sur cette période.</p>';
  return `<article class="card iot-overlay-card"><header class="iot-overlay-head"><div><p class="iot-eyebrow">${number(model.metrics.length)} MESURES · UN AXE DE TEMPS</p><h3>Courbes superposées</h3></div><span class="iot-live-pill${model.live ? ' live' : ''}"><i aria-hidden="true"></i>${model.live ? 'En direct' : 'Historique'}</span></header>
    <div id="iotCombinedReadings" class="iot-overlay-readings">${iotCombinedReadings(model)}</div>
    <div class="iot-overlay-tools"><p>Chaque courbe a son échelle. Le survol affiche les valeurs dans leur unité.</p><label>Axe affiché<select id="iotCombinedAxis">${model.populated.map(metric => `<option value="${e(metric.key)}"${metric.key === model.axis.key ? ' selected' : ''}>${e(metric.label)}${metric.unit ? ` (${e(metric.unit)})` : ''}</option>`).join('')}</select></label>${model.live ? '' : `<label class="iot-range-toggle"><input type="checkbox" id="iotCombinedRanges"${iotState.ranges ? ' checked' : ''}>Min–max</label>`}</div>
    <div class="iot-overlay-plot"><canvas id="iotCombinedChart" tabindex="0" role="img" aria-label="Courbes superposées de ${e(model.metrics.map(metric => metric.label).join(', '))}. Flèches gauche et droite pour consulter les mesures, Échap pour fermer le survol."></canvas><div id="iotCombinedTooltip" class="iot-shared-tooltip" hidden role="status"></div></div>
    <div class="iot-overlay-foot"><span>Survole ou touche le graphique pour comparer les mesures.</span><span id="iotCombinedWindow">${e(iotCombinedDate(model.start))} → ${e(iotCombinedDate(model.end))}</span></div>
    <details class="iot-overlay-data"><summary>Consulter les valeurs détaillées</summary><div id="iotCombinedTables">${iotCombinedTables(model)}</div></details></article>`;
}

function iotClearCombined() {
  if (iotCombined.chart) iotCombined.chart.destroy();
  Object.assign(iotCombined, { chart: null, model: null, hoverTime: null });
}

function iotCombinedScales(model) {
  const steps = [1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000, 10800000, 21600000, 43200000, 86400000, 604800000, 2592000000, 7776000000];
  const scales = { x: { type: 'linear', min: model.start, max: model.end,
    afterBuildTicks(scale) {
      const intervals = scale.chart.width < 600 ? 2 : 6;
      const step = steps.find(value => value >= (model.end - model.start) / intervals) || steps.at(-1);
      const ticks = [];
      for (let time = Math.ceil(model.start / step) * step; time <= model.end; time += step) ticks.push({ value: time });
      scale.ticks = ticks;
    },
    border: { display: false }, grid: { color: '#25405238', tickLength: 0 },
    ticks: { color: '#8198ab', includeBounds: false, maxTicksLimit: 7, maxRotation: 0, padding: 14, font: { size: 11 },
      callback: value => `${model.end - model.start > 86400000 ? new Date(value).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' }) + ' ' : ''}${iotCombinedTime(value, model.live)}` } } };
  for (const metric of model.metrics) scales[metric.axis] = { type: 'linear', position: 'left',
    display: metric.key === model.axis.key, min: metric.low, max: metric.high,
    afterBuildTicks(scale) { scale.options.title.display = scale.chart.width >= 600; },
    border: { display: false }, grid: { color: '#30485c55', tickLength: 0 },
    title: { display: true, text: `${metric.label}${metric.unit ? ` · ${metric.unit}` : ''}`, color: metric.color, font: { size: 11 }, padding: 10 },
    ticks: { color: metric.color, maxTicksLimit: 6, padding: 12, font: { size: 11 }, callback: value => iotValue(value * metric.divisor) } };
  return scales;
}

function iotCombinedDatasets(model) {
  return model.metrics.map(metric => ({ label: metric.label, data: metric.data, yAxisID: metric.axis,
    borderColor: metric.color, borderWidth: context => context.chart.width < 600 ? 1.5 : 2.3, borderCapStyle: 'round', borderJoinStyle: 'round',
    cubicInterpolationMode: 'monotone', tension: .25, pointRadius: 0, pointHoverRadius: 0,
    parsing: false, spanGaps: false, fill: metric.key === model.axis.key ? 'start' : false,
    backgroundColor(context) {
      const area = context.chart.chartArea;
      if (!area) return 'transparent';
      const gradient = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      gradient.addColorStop(0, metric.color + '0b'); gradient.addColorStop(1, metric.color + '00'); return gradient;
    }
  }));
}

function iotPaintCombinedHover() {
  const { chart, model, hoverTime } = iotCombined;
  const tooltip = document.querySelector('#iotCombinedTooltip');
  if (!chart || !tooltip) return;
  if (hoverTime === null) { tooltip.hidden = true; return; }
  tooltip.innerHTML = `<strong>${e(iotCombinedDate(hoverTime))}</strong>${model.metrics.map(metric => {
    const point = iotNearestValue(metric, hoverTime);
    return `<div style="--series:${metric.color}"><i aria-hidden="true"></i><span>${e(metric.label)}${point ? `<small>${e(iotCombinedTime(point.ts))}</small>` : ''}</span><b>${point ? `${e(String(point.value))}<small> ${e(metric.unit)}</small>` : '—'}</b></div>`;
  }).join('')}`;
  tooltip.hidden = false;
  const x = chart.scales.x.getPixelForValue(hoverTime);
  tooltip.style.left = `${Math.max(8, Math.min(x + 16, chart.width - tooltip.offsetWidth - 8))}px`;
  tooltip.style.top = '14px';
}

const iotCombinedPlugin = {
  id: 'iotComparison',
  beforeDatasetDraw(chart, args) { chart.ctx.save(); chart.ctx.shadowColor = iotCombined.model.metrics[args.index].color; chart.ctx.shadowBlur = chart.width < 600 ? 0 : 3; },
  afterDatasetDraw(chart) { chart.ctx.restore(); },
  beforeDatasetsDraw(chart) {
    if (!iotState.ranges) return;
    const { model } = iotCombined; const ctx = chart.ctx;
    ctx.save(); ctx.globalAlpha = .14; ctx.lineWidth = 1;
    for (const metric of model.metrics) {
      ctx.strokeStyle = metric.color; ctx.beginPath();
      for (const point of metric.points) if (Number.isFinite(point.min) && Number.isFinite(point.max)) {
        const x = chart.scales.x.getPixelForValue(point.ts);
        ctx.moveTo(x, chart.scales[metric.axis].getPixelForValue(point.min / metric.divisor));
        ctx.lineTo(x, chart.scales[metric.axis].getPixelForValue(point.max / metric.divisor));
      }
      ctx.stroke();
    }
    ctx.restore();
  },
  afterEvent(chart, args) {
    const event = args.event; const area = chart.chartArea;
    if (event.type === 'mouseout' || event.x < area.left || event.x > area.right || event.y < area.top || event.y > area.bottom) iotCombined.hoverTime = null;
    else iotCombined.hoverTime = chart.scales.x.getValueForPixel(event.x);
    iotPaintCombinedHover(); args.changed = true;
  },
  afterDraw(chart) {
    const { model, hoverTime } = iotCombined;
    if (hoverTime === null || !model) return;
    const ctx = chart.ctx; const x = chart.scales.x.getPixelForValue(hoverTime);
    ctx.save(); ctx.strokeStyle = '#a8c7d888'; ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(x, chart.chartArea.top); ctx.lineTo(x, chart.chartArea.bottom); ctx.stroke(); ctx.setLineDash([]);
    for (const metric of model.metrics) {
      const point = iotNearestValue(metric, hoverTime); if (!point) continue;
      const px = chart.scales.x.getPixelForValue(point.ts); const py = chart.scales[metric.axis].getPixelForValue(point.value / metric.divisor);
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fillStyle = metric.color; ctx.shadowColor = metric.color; ctx.shadowBlur = 12; ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#10202a'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.restore();
  }
};

function iotDrawCombined() {
  const canvas = document.querySelector('#iotCombinedChart');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  if (typeof Chart === 'undefined') {
    canvas.parentElement.innerHTML = '<p class="notice warning">Le moteur de graphiques est indisponible. Les valeurs détaillées restent accessibles.</p>'; return;
  }
  const model = iotCombinedModel(); if (!model.populated.length) return;
  if (iotCombined.chart && iotCombined.chart.canvas !== canvas) iotClearCombined();
  iotCombined.model = model;
  if (iotCombined.hoverTime !== null && (iotCombined.hoverTime < model.start || iotCombined.hoverTime > model.end)) iotCombined.hoverTime = null;
  if (iotCombined.chart) {
    iotCombined.chart.data.datasets = iotCombinedDatasets(model);
    iotCombined.chart.options.scales = iotCombinedScales(model);
    iotCombined.chart.update('none');
    document.querySelector('#iotCombinedReadings').innerHTML = iotCombinedReadings(model);
    document.querySelector('#iotCombinedTables').innerHTML = iotCombinedTables(model);
    document.querySelector('#iotCombinedWindow').textContent = `${iotCombinedDate(model.start)} → ${iotCombinedDate(model.end)}`;
    iotPaintCombinedHover();
  } else iotCombined.chart = new Chart(canvas, {
    type: 'line', data: { datasets: iotCombinedDatasets(model) }, plugins: [iotCombinedPlugin],
    options: { responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      layout: { padding: { top: 16, right: 12 } }, scales: iotCombinedScales(model),
      plugins: { legend: { display: false }, tooltip: { enabled: false } } }
  });
}

document.addEventListener('keydown', event => {
  if (event.target.id !== 'iotCombinedChart' || !iotCombined.chart) return;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
  event.preventDefault();
  const times = [...new Set(iotCombined.model.metrics.flatMap(metric => metric.points.map(point => point.ts)))].sort((a, b) => a - b);
  const current = iotCombined.hoverTime ?? times.at(-1);
  if (event.key === 'Escape') iotCombined.hoverTime = null;
  else if (event.key === 'Home') iotCombined.hoverTime = times[0];
  else if (event.key === 'End') iotCombined.hoverTime = times.at(-1);
  else iotCombined.hoverTime = event.key === 'ArrowLeft' ? times.filter(time => time < current).at(-1) ?? times[0] : times.find(time => time > current) ?? times.at(-1);
  iotPaintCombinedHover(); iotCombined.chart.draw();
});
window.addEventListener('hashchange', () => { if (location.hash !== '#iot') iotClearCombined(); });
