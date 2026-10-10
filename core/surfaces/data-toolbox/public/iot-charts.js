'use strict';

// Lines and shaded areas follow actual timestamps and break across missing data.
function iotChart(points, { name, unit = '', key = 'measure', live = false, bucketSeconds = 60 } = {}) {
  const values = array(points).map(point => ({
    ts: new Date(point.ts).getTime(), value: live ? point.value : point.mean,
    min: live ? point.value : point.min, max: live ? point.value : point.max,
    count: live ? 1 : point.count, partial: point.partial === true
  })).filter(point => Number.isFinite(point.ts) && Number.isFinite(point.value)).sort((a, b) => a.ts - b.ts);
  if (!values.length) return '<p class="iot-empty">Aucune mesure reçue sur cette période.</p>';
  const min = Math.min(...values.map(point => Number.isFinite(point.min) ? point.min : point.value));
  const max = Math.max(...values.map(point => Number.isFinite(point.max) ? point.max : point.value));
  const scale = Math.max(Math.abs(min), Math.abs(max), 1);
  const minScaled = min / scale; const maxScaled = max / scale;
  const pad = max === min ? .05 : (maxScaled - minScaled) * .12;
  const low = minScaled - pad; const high = maxScaled + pad;
  const start = values[0].ts; const end = values.at(-1).ts;
  const x = time => 44 + (time - start) / Math.max(end - start, 1000) * 420;
  const y = value => 158 - (value / scale - low) / (high - low) * 138;
  const fmt = value => value.toLocaleString(undefined, { maximumFractionDigits: 2,
    notation: Math.abs(value) >= 1e6 || (value !== 0 && Math.abs(value) < .0001) ? 'scientific' : 'standard' });
  const observedGaps = values.slice(1).map((point, i) => point.ts - values[i].ts).filter(gap => gap > 0).sort((a, b) => a - b);
  const cadence = live ? (observedGaps[0] || 5000) : bucketSeconds * 1000;
  const gapLimit = Math.max(live ? 15000 : cadence * 1.5, cadence * 3);
  const segments = []; let segment = [];
  for (const point of values) {
    if (segment.length && point.ts - segment.at(-1).ts > gapLimit) { segments.push(segment); segment = []; }
    segment.push(point);
  }
  if (segment.length) segments.push(segment);
  const coordinates = group => group.map(point => `${x(point.ts).toFixed(2)},${y(point.value).toFixed(2)}`).join(' ');
  const gradient = `iot-fill-${String(key).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const area = segments.map(group => `<polygon class="iot-area" fill="url(#${gradient})" points="${x(group[0].ts).toFixed(2)},158 ${coordinates(group)} ${x(group.at(-1).ts).toFixed(2)},158"/>`).join('');
  const line = segments.map(group => `<polyline points="${coordinates(group)}"/>`).join('');
  const dots = values.map((point, index) => `<circle data-iot-point data-ts="${point.ts}" data-value="${point.value}" cx="${x(point.ts).toFixed(2)}" cy="${y(point.value).toFixed(2)}" r="${index === values.length - 1 ? 3 : values.length < 100 ? 1.5 : .6}"><title>${e(date(point.ts))} · ${e(String(point.value))} ${e(unit)}</title></circle>`).join('');
  const range = live ? '' : values.filter(point => Number.isFinite(point.min) && Number.isFinite(point.max)).map(point =>
    `<line class="iot-range" x1="${x(point.ts).toFixed(2)}" x2="${x(point.ts).toFixed(2)}" y1="${y(point.min).toFixed(2)}" y2="${y(point.max).toFixed(2)}"/>`).join('');
  const title = `${name}: ${values.length} points, minimum ${fmt(min)}, maximum ${fmt(max)} ${unit}`;
  const grid = [...new Set([min, min / 2 + max / 2, max])].map(value => `<line class="iot-grid-line" x1="44" x2="464" y1="${y(value).toFixed(2)}" y2="${y(value).toFixed(2)}"/><text x="37" y="${(y(value) + 4).toFixed(2)}" text-anchor="end">${e(fmt(value))}</text>`).join('');
  const time = ts => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', ...(live ? { second: '2-digit' } : {}) });
  const timestamp = ts => live ? time(ts) : `${new Date(ts).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })} ${time(ts)}`;
  return `<div class="iot-chart-wrap"><svg class="iot-chart" viewBox="0 0 480 192" role="img" aria-label="${e(title)}" data-unit="${e(unit)}"><title>${e(title)}</title>
    <defs><linearGradient id="${gradient}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".18"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>${grid}
    <g class="iot-plot">${area}${range}${line}${dots}</g><line class="iot-cursor" x1="44" x2="44" y1="15" y2="162" visibility="hidden"/>
    <text x="44" y="184">${e(timestamp(start))}</text><text x="464" y="184" text-anchor="end">${e(timestamp(end))}</text></svg>
    <div class="iot-chart-hover" hidden role="status"></div></div>
    <p class="iot-chart-summary"><span>Min <strong>${e(fmt(min))}</strong></span><span>Max <strong>${e(fmt(max))}</strong></span><span>${number(values.length)} points</span>${values.some(point => point.partial) ? '<span>dernière période en cours</span>' : ''}</p>
    <details class="iot-data"><summary>Voir les valeurs (${number(values.length)})${live ? '' : ' · moyenne et min–max'}</summary><div class="table-wrap" tabindex="0" role="region" aria-label="Valeurs de ${e(name)}"><table><thead><tr><th scope="col">Heure</th><th scope="col">${live ? 'Valeur' : 'Moyenne'}</th>${live ? '' : '<th scope="col">Min</th><th scope="col">Max</th><th scope="col">Mesures</th>'}</tr></thead><tbody>${values.map(point => `<tr><th scope="row">${date(point.ts)}${point.partial ? ' (en cours)' : ''}</th><td>${e(String(point.value))} ${e(unit)}</td>${live ? '' : `<td>${e(String(point.min))}</td><td>${e(String(point.max))}</td><td>${number(point.count)}</td>`}</tr>`).join('')}</tbody></table></div></details>`;
}

document.addEventListener('pointermove', event => {
  const chart = event.target.closest?.('.iot-chart');
  if (!chart) return;
  const points = chart.querySelectorAll('[data-iot-point]');
  if (!points.length) return;
  const rect = chart.getBoundingClientRect();
  const target = (event.clientX - rect.left) / rect.width * 480;
  // Time-ordered points: binary search keeps dense history cheap to inspect.
  let low = 0; let high = points.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (Number(points[middle].getAttribute('cx')) < target) low = middle + 1; else high = middle;
  }
  const prior = Math.max(0, low - 1);
  const point = Math.abs(Number(points[prior].getAttribute('cx')) - target) < Math.abs(Number(points[low].getAttribute('cx')) - target) ? points[prior] : points[low];
  const cursor = chart.querySelector('.iot-cursor');
  cursor.setAttribute('x1', point.getAttribute('cx')); cursor.setAttribute('x2', point.getAttribute('cx')); cursor.setAttribute('visibility', 'visible');
  const tooltip = chart.parentElement.querySelector('.iot-chart-hover');
  tooltip.textContent = `${new Date(Number(point.dataset.ts)).toLocaleString()} · ${point.dataset.value} ${chart.dataset.unit}`;
  tooltip.hidden = false;
});
document.addEventListener('pointerout', event => {
  const chart = event.target.closest?.('.iot-chart');
  if (!chart || chart.contains(event.relatedTarget)) return;
  chart.querySelector('.iot-cursor')?.setAttribute('visibility', 'hidden');
  const tooltip = chart.parentElement.querySelector('.iot-chart-hover'); if (tooltip) tooltip.hidden = true;
});
