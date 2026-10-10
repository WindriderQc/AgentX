'use strict';

// SVG charts use the actual timestamps. Missing intervals break the line.
// Values and their timestamps remain available as a table beside each chart.
function iotChart(points, { name, unit = '', live = false, bucketSeconds = 60 } = {}) {
  const values = array(points).map(point => ({
    ts: new Date(point.ts).getTime(), value: live ? point.value : point.mean,
    min: live ? point.value : point.min, max: live ? point.value : point.max,
    count: live ? 1 : point.count, partial: point.partial === true
  })).filter(point => Number.isFinite(point.ts) && Number.isFinite(point.value))
    .sort((a, b) => a.ts - b.ts);
  if (!values.length) return '<p class="iot-empty">Aucune mesure reçue sur cette période.</p>';
  const min = Math.min(...values.map(point => Number.isFinite(point.min) ? point.min : point.value));
  const max = Math.max(...values.map(point => Number.isFinite(point.max) ? point.max : point.value));
  const scale = Math.max(Math.abs(min), Math.abs(max), 1);
  const minScaled = min / scale; const maxScaled = max / scale;
  const pad = max === min ? .05 : (maxScaled - minScaled) * .08;
  const low = minScaled - pad; const high = maxScaled + pad;
  const start = values[0].ts; const end = values.at(-1).ts;
  const x = time => 56 + (time - start) / Math.max(end - start, 1000) * 630;
  const y = value => 178 - (value / scale - low) / (high - low) * 148;
  const fmt = value => value.toLocaleString(undefined, { maximumFractionDigits: 3,
    notation: Math.abs(value) >= 1e9 || (value !== 0 && Math.abs(value) < .0001) ? 'scientific' : 'standard' });
  const observedGaps = values.slice(1).map((point, i) => point.ts - values[i].ts).filter(gap => gap > 0).sort((a, b) => a - b);
  // The shortest observed cadence never lets a long outage become the normal gap.
  const cadence = live ? (observedGaps[0] || 5000) : bucketSeconds * 1000;
  const gapLimit = Math.max(live ? 15000 : cadence * 1.5, cadence * 3);
  const segments = [];
  let segment = [];
  for (const point of values) {
    if (segment.length && point.ts - segment.at(-1).ts > gapLimit) { segments.push(segment); segment = []; }
    segment.push(point);
  }
  if (segment.length) segments.push(segment);
  const line = segments.map(group => `<polyline points="${group.map(point => `${x(point.ts).toFixed(2)},${y(point.value).toFixed(2)}`).join(' ')}"/>`).join('');
  const dots = values.map(point => `<circle cx="${x(point.ts).toFixed(2)}" cy="${y(point.value).toFixed(2)}" r="${values.length < 100 ? 2.7 : 1}"><title>${e(date(point.ts))} · ${e(fmt(point.value))} ${e(unit)}${point.partial ? ' · période en cours' : ''}</title></circle>`).join('');
  const range = live ? '' : values.filter(point => Number.isFinite(point.min) && Number.isFinite(point.max)).map(point =>
    `<line class="iot-range" x1="${x(point.ts).toFixed(2)}" x2="${x(point.ts).toFixed(2)}" y1="${y(point.min).toFixed(2)}" y2="${y(point.max).toFixed(2)}"/>`).join('');
  const title = `${name}: ${values.length} points, minimum ${fmt(min)}, maximum ${fmt(max)} ${unit}`;
  const grid = [...new Set([min, min / 2 + max / 2, max])].map(value => `<line class="iot-grid-line" x1="56" x2="690" y1="${y(value).toFixed(2)}" y2="${y(value).toFixed(2)}"/><text x="50" y="${(y(value) + 4).toFixed(2)}" text-anchor="end">${e(fmt(value))}</text>`).join('');
  return `<svg class="iot-chart" viewBox="0 0 720 216" role="img" aria-label="${e(title)}"><title>${e(title)}</title>${grid}
    <g class="iot-plot">${range}${line}${dots}</g>
    <text x="56" y="205">${e(new Date(start).toLocaleString())}</text>
    <text x="690" y="205" text-anchor="end">${e(new Date(end).toLocaleString())}</text></svg>
    <p class="iot-chart-summary">Min ${e(fmt(min))} · max ${e(fmt(max))} ${e(unit)} · ${number(values.length)} points${live ? '' : ' · moyenne et étendue min–max'}${values.some(point => point.partial) ? ' · dernière période en cours' : ''}</p>
    <details class="iot-data"><summary>Voir les valeurs (${number(values.length)})</summary><div class="table-wrap" tabindex="0" role="region" aria-label="Valeurs de ${e(name)}"><table><thead><tr><th scope="col">Heure</th><th scope="col">${live ? 'Valeur' : 'Moyenne'}</th>${live ? '' : '<th scope="col">Min</th><th scope="col">Max</th><th scope="col">Mesures</th>'}</tr></thead><tbody>${values.map(point => `<tr><th scope="row">${date(point.ts)}${point.partial ? ' (en cours)' : ''}</th><td>${e(fmt(point.value))} ${e(unit)}</td>${live ? '' : `<td>${e(fmt(point.min))}</td><td>${e(fmt(point.max))}</td><td>${number(point.count)}</td>`}</tr>`).join('')}</tbody></table></div></details>`;
}
