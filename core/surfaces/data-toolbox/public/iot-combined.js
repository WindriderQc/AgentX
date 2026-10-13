'use strict';

const iotCombined = { chart: null, model: null, hoverTime: null };
const iotCombinedTime = (time, seconds = true) => {
  const at = new Date(time);
  return [at.getHours(), at.getMinutes(), ...(seconds ? [at.getSeconds()] : [])].map(value => String(value).padStart(2, '0')).join(':');
};
const iotCombinedDate = time => `${new Date(time).toLocaleDateString()} · ${iotCombinedTime(time)}`;

// Context spans are display zoom floors, never sensor limits. Outliers expand
// the domain; every raw sample keeps its value and remains inside the axis.
function iotCombinedBounds(min, max, key, unit, mode = 'context') {
  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  const spans = { '°c': key === 'cpu_temperature' ? 10 : 2, '°f': key === 'cpu_temperature' ? 20 : 4,
    hpa: 5, mbar: 5, pa: 500, kpa: .5, dbm: 20, v: .5, mv: 500, '%': 10,
    m: key === 'altitude' ? 10 : Math.max(magnitude * .02, .01) };
  const normalizedUnit = String(unit).trim().toLowerCase();
  const contextSpan = (Object.hasOwn(spans, normalizedUnit) ? spans[normalizedUnit] : magnitude * .02) || 1;
  const divisor = Math.max(magnitude, mode === 'detail' ? 0 : contextSpan) || 1;
  const low = min / divisor; const high = max / divisor;
  let lower; let upper; let tickStep;
  if (mode === 'detail') {
    const pad = high === low ? .04 : (high - low) * .12;
    lower = low - pad; upper = high + pad;
  } else {
    const span = Math.max(high - low, contextSpan / divisor);
    const center = low / 2 + high / 2;
    const candidate = span * 1.24 / 5;
    // Choose a round step in the original unit without overflowing a raw span.
    const exponent = Math.floor(Math.log10(candidate) + Math.log10(divisor));
    const power = 10 ** exponent;
    const fraction = candidate * divisor / power;
    const factor = [1, 2, 2.5, 5, 10].find(value => value >= fraction) || 10;
    const rounded = factor * power / divisor;
    const step = Number.isFinite(rounded) && rounded > 0 ? rounded : candidate;
    tickStep = step;
    lower = Math.floor((center - span * .62) / step) * step;
    upper = Math.ceil((center + span * .62) / step) * step;
  }
  const limit = Number.MAX_VALUE / divisor;
  return { divisor, low: Math.max(-limit, Math.min(lower, low)), high: Math.min(limit, Math.max(upper, high)), tickStep };
}

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
      ts: new Date(point.ts).getTime(), value: live ? point.value : iotCentral(point), mean: point.mean, median: point.median,
      min: live ? point.value : point.min, max: live ? point.value : point.max,
      count: live ? 1 : point.count, partial: point.partial === true
    })).filter(point => Number.isFinite(point.ts)).sort((a, b) => a.ts - b.ts);
    const points = raw.filter(point => Number.isFinite(point.value));
    const gaps = points.slice(1).map((point, i) => point.ts - points[i].ts).filter(gap => gap > 0);
    const cadence = live ? gaps.reduce((min, gap) => Math.min(min, gap), 5000) : bucket;
    const gapLimit = live ? Math.max(15000, cadence * 3) : bucket * 1.5;
    // The band belongs to history: it widens the scale to the real extremes so it is never clipped.
    const banded = iotState.ranges && !live;
    let min = Infinity; let max = -Infinity;
    for (const point of points) {
      start = Math.min(start, point.ts); end = Math.max(end, point.ts);
      min = Math.min(min, banded && Number.isFinite(point.min) ? point.min : point.value);
      max = Math.max(max, banded && Number.isFinite(point.max) ? point.max : point.value);
    }
    const style = iotCurveStyle(key); const unit = measure?.unit || known?.unit || '';
    const bounds = points.length ? iotCombinedBounds(min, max, key, unit, style.scale) : { divisor: 1, low: 0, high: 1 };
    const { divisor } = bounds;
    const data = []; let previous = null;
    for (const point of raw) {
      if (previous && point.ts - previous.ts > gapLimit) data.push({ x: previous.ts + (point.ts - previous.ts) / 2, y: null });
      data.push({ x: point.ts, y: Number.isFinite(point.value) ? point.value / divisor : null });
      previous = point;
    }
    return { key, ...visual, style, unit, points, data, gapLimit, banded, ...bounds,
      axis: `iotY${index}`, min, max,
      tolerance: live ? Math.max(7500, cadence * 1.5) : bucket * .51 };
  });
  const from = new Date(series.from).getTime(); const to = new Date(series.to).getTime();
  if (!live && Number.isFinite(from) && Number.isFinite(to) && to > from) { start = from; end = to; }
  const populated = metrics.filter(metric => metric.points.length);
  const axis = populated.find(metric => metric.key === iotState.axis) || populated[0];
  return { metrics, populated, live, axis, start, end: Math.max(end, start + 1000) };
}

/** Unbroken stretches of buckets that carry a min and a max: one band shape each, never across a gap. */
function iotBandRuns(metric) {
  const runs = []; let run = [];
  for (const point of metric.points) {
    if (!Number.isFinite(point.min) || !Number.isFinite(point.max)) continue;
    if (run.length && point.ts - run.at(-1).ts > metric.gapLimit) { runs.push(run); run = []; }
    run.push(point);
  }
  if (run.length) runs.push(run);
  return runs;
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
    return `<div class="iot-overlay-reading" style="--series:${metric.color}"><span><i aria-hidden="true"></i>${e(metric.label)}</span><strong>${e(iotValue(last?.value))}<small>${e(metric.unit)}</small></strong><small>${last ? e(iotAge(last.ts)) : 'No reading'}</small></div>`;
  }).join('');
}

function iotCombinedTables(model) {
  return model.metrics.map(metric => `<details class="iot-data"><summary>${e(metric.label)} · ${number(metric.points.length)} points${model.live ? '' : ' · median, mean and min–max'}</summary>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Values of ${e(metric.label)}"><table><thead><tr><th scope="col">Time</th><th scope="col">${model.live ? 'Value' : 'Median'}</th>${model.live ? '' : '<th scope="col">Mean</th><th scope="col">Min</th><th scope="col">Max</th><th scope="col">Readings</th>'}</tr></thead><tbody>${metric.points.map(point => `<tr><th scope="row">${e(date(point.ts))}${point.partial ? ' (in progress)' : ''}</th><td>${model.live ? e(String(point.value)) : Number.isFinite(point.median) ? e(String(point.median)) : '—'} ${e(metric.unit)}</td>${model.live ? '' : `<td>${Number.isFinite(point.mean) ? e(String(point.mean)) : '—'}</td><td>${Number.isFinite(point.min) ? e(String(point.min)) : '—'}</td><td>${Number.isFinite(point.max) ? e(String(point.max)) : '—'}</td><td>${number(point.count)}</td>`}</tr>`).join('')}</tbody></table></div></details>`).join('');
}

function iotCombinedHtml() {
  const model = iotCombinedModel();
  if (!model.populated.length) return '<p class="iot-empty">No reading received in this period.</p>';
  return `<article class="card iot-overlay-card"><header class="iot-overlay-head"><div><p class="iot-eyebrow">${number(model.metrics.length)} READINGS · ONE TIME AXIS</p><h3>Overlaid charts</h3></div><span class="iot-live-pill${model.live ? ' live' : ''}"><i aria-hidden="true"></i>${model.live ? 'Live' : 'History'}</span></header>
    <div id="iotCombinedReadings" class="iot-overlay-readings">${iotCombinedReadings(model)}</div>
    <div class="iot-overlay-tools"><p>Each curve has its own scale. Hovering shows values in their unit.</p><label>Axis shown<select id="iotCombinedAxis">${model.populated.map(metric => `<option value="${e(metric.key)}"${metric.key === model.axis.key ? ' selected' : ''}>${e(metric.label)}${metric.unit ? ` (${e(metric.unit)})` : ''}</option>`).join('')}</select></label>${model.live ? '' : iotReadingControls()}</div>
    ${model.live ? '' : `<p class="iot-reading-hint"><span id="iotReadingHint">${e(iotReadingHint())}</span> <span id="iotResolutionUsed">${e(iotResolutionUsed())}</span></p>`}
    ${iotAppearanceHtml(model.metrics)}
    <div class="iot-overlay-plot"><canvas id="iotCombinedChart" tabindex="0" role="img" aria-label="Overlaid charts of ${e(model.metrics.map(metric => metric.label).join(', '))}. Left and right arrows browse the readings, Escape closes the hover."></canvas><div id="iotCombinedTooltip" class="iot-shared-tooltip" hidden role="status"></div></div>
    <div class="iot-overlay-foot"><span>Hover or touch the chart to compare readings.</span><span id="iotCombinedWindow">${e(iotCombinedDate(model.start))} → ${e(iotCombinedDate(model.end))}</span></div>
    <details class="iot-overlay-data"><summary>Show detailed values</summary><div id="iotCombinedTables">${iotCombinedTables(model)}</div></details></article>`;
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
    border: { display: false }, grid: { color: '#25405222', tickLength: 0 },
    ticks: { color: '#8198ab', includeBounds: false, maxTicksLimit: 7, maxRotation: 0, padding: 14, font: { size: 11 },
      callback: value => `${model.end - model.start > 86400000 ? new Date(value).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' }) + ' ' : ''}${iotCombinedTime(value, model.live)}` } } };
  for (const metric of model.metrics) scales[metric.axis] = { type: 'linear', position: 'left',
    display: metric.key === model.axis.key, min: metric.low, max: metric.high,
    afterBuildTicks(scale) {
      scale.options.title.display = scale.chart.width >= 600;
      if (!metric.tickStep) return;
      const ticks = [];
      for (let index = 0; index < 12; index++) {
        const value = metric.low + index * metric.tickStep;
        if (value > metric.high + metric.tickStep * 1e-9) break;
        ticks.push({ value: Math.min(value, metric.high) });
      }
      scale.ticks = ticks;
    },
    border: { display: false }, grid: { color: '#30485c38', tickLength: 0 },
    title: { display: true, text: `${metric.label}${metric.unit ? ` · ${metric.unit}` : ''}`, color: metric.color, font: { size: 11 }, padding: 10 },
    ticks: { color: metric.color, maxTicksLimit: 6, padding: 12, font: { size: 11 }, callback: value => iotValue(value * metric.divisor) } };
  return scales;
}

function iotCombinedDatasets(model) {
  return model.metrics.map(metric => ({ label: metric.label, data: metric.data, yAxisID: metric.axis,
    borderColor: metric.color, borderWidth: metric.style.width, borderCapStyle: 'round', borderJoinStyle: 'round',
    borderDash: metric.style.line === 'dashed' ? [7, 5] : metric.style.line === 'dotted' ? [1, 4] : [],
    cubicInterpolationMode: metric.style.curve === 'smooth' ? 'monotone' : 'default',
    tension: metric.style.curve === 'smooth' ? .25 : 0, stepped: metric.style.curve === 'step', pointHoverRadius: 0,
    pointBackgroundColor: metric.color, pointBorderColor: '#10202a', pointBorderWidth: 1,
    pointRadius(context) {
      const data = context.dataset.data; const index = context.dataIndex;
      if (!Number.isFinite(data[index]?.y)) return 0;
      const isolated = !Number.isFinite(data[index - 1]?.y) && !Number.isFinite(data[index + 1]?.y);
      return isolated ? 2.5 : metric.style.points ? 1.8 : index === data.length - 1 ? 1.5 : 0;
    },
    parsing: false, spanGaps: false, fill: metric.style.fill === 'none' ? false : 'start',
    backgroundColor(context) {
      const area = context.chart.chartArea;
      if (!area) return 'transparent';
      const alpha = Math.round(metric.style.opacity / 100 * 255).toString(16).padStart(2, '0');
      if (metric.style.fill === 'solid') return metric.color + alpha;
      const gradient = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      gradient.addColorStop(0, metric.color + alpha); gradient.addColorStop(1, metric.color + '00'); return gradient;
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
    return `<div style="--series:${metric.color}"><i aria-hidden="true"></i><span>${e(metric.label)}${point ? `<small>${e(iotCombinedTime(point.ts))}</small>` : ''}</span><b>${point ? `${e(String(point.value))}<small> ${e(metric.unit)}</small>${metric.banded && Number.isFinite(point.min) && Number.isFinite(point.max) && point.max > point.min ? `<small class="iot-tip-range">${e(String(point.min))} – ${e(String(point.max))}</small>` : ''}` : '—'}</b></div>`;
  }).join('')}`;
  tooltip.hidden = false;
  const x = chart.scales.x.getPixelForValue(hoverTime);
  tooltip.style.left = `${Math.max(8, Math.min(x + 16, chart.width - tooltip.offsetWidth - 8))}px`;
  tooltip.style.top = '14px';
}

const iotCombinedPlugin = {
  id: 'iotComparison',
  beforeDatasetDraw(chart, args) {
    const metric = iotCombined.model.metrics[args.index];
    chart.ctx.save(); chart.ctx.shadowColor = metric.color; chart.ctx.shadowBlur = metric.style.glow && chart.width >= 600 ? 4 : 0;
  },
  afterDatasetDraw(chart) { chart.ctx.restore(); },
  beforeDatasetsDraw(chart) {
    const { model } = iotCombined; const ctx = chart.ctx; const area = chart.chartArea;
    if (!model || !area) return;
    ctx.save(); ctx.beginPath(); ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top); ctx.clip();
    for (const metric of model.metrics) {
      if (!metric.banded) continue;
      // The displayed axis' band reads first; the others stay a faint envelope.
      ctx.fillStyle = metric.color; ctx.strokeStyle = metric.color; ctx.lineWidth = 1;
      ctx.globalAlpha = metric.key === model.axis.key ? .24 : .05;
      const scale = chart.scales[metric.axis];
      for (const run of iotBandRuns(metric)) {
        const px = point => chart.scales.x.getPixelForValue(point.ts);
        ctx.beginPath();
        if (run.length === 1) { ctx.moveTo(px(run[0]), scale.getPixelForValue(run[0].min / metric.divisor)); ctx.lineTo(px(run[0]), scale.getPixelForValue(run[0].max / metric.divisor)); ctx.stroke(); continue; }
        run.forEach((point, index) => ctx[index ? 'lineTo' : 'moveTo'](px(point), scale.getPixelForValue(point.max / metric.divisor)));
        for (let index = run.length - 1; index >= 0; index--) ctx.lineTo(px(run[index]), scale.getPixelForValue(run[index].min / metric.divisor));
        ctx.closePath(); ctx.fill();
      }
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
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fillStyle = metric.color; ctx.shadowColor = metric.color; ctx.shadowBlur = metric.style.glow ? 8 : 0; ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#10202a'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.restore();
  }
};

function iotDrawCombined() {
  const canvas = document.querySelector('#iotCombinedChart');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  if (typeof Chart === 'undefined') {
    canvas.parentElement.innerHTML = '<p class="notice warning">The chart engine is unavailable. Detailed values remain available.</p>'; return;
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
    const used = document.querySelector('#iotResolutionUsed'); if (used) used.textContent = iotResolutionUsed();
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
