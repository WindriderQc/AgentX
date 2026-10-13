'use strict';

const IOT_APPEARANCE_STORAGE = 'agentx.iot.curve-styles.v1';
const IOT_CURVE_PRESETS = Object.freeze({
  signature: { label: 'Signature', width: 1.5, line: 'solid', curve: 'smooth', fill: 'gradient', opacity: 24, points: false, glow: false },
  clean: { label: 'Clean', width: 1.5, line: 'solid', curve: 'smooth', fill: 'none', opacity: 18, points: false, glow: false },
  areas: { label: 'Areas', width: 1.5, line: 'solid', curve: 'smooth', fill: 'gradient', opacity: 18, points: false, glow: false },
  technical: { label: 'Technical', width: 1, line: 'solid', curve: 'linear', fill: 'none', opacity: 18, points: true, glow: false }
});
const IOT_SIGNATURE_CURVES = Object.freeze({
  temperature: { fill: 'gradient', opacity: 24 },
  pressure: { width: .75, line: 'dotted' },
  battery_voltage: { width: 1, line: 'dashed' },
  wifi_rssi: { width: 1, curve: 'step' },
  cpu_temperature: { fill: 'gradient', opacity: 14 }
});
const iotAppearance = { devices: new Map(), selected: '' };

// How a history bucket is read: which central value the line follows and
// whether the min–max band is drawn. One choice for the whole tab, kept under
// its own key so the per-curve styles saved under v1 stay exactly as they are.
const IOT_READING_STORAGE = 'agentx.iot.reading.v1';
const IOT_READING_DEFAULT = Object.freeze({ central: 'median', band: true });
function iotCleanReading(value) {
  return { central: value?.central === 'mean' ? 'mean' : IOT_READING_DEFAULT.central,
    band: typeof value?.band === 'boolean' ? value.band : IOT_READING_DEFAULT.band };
}
function iotReadReading() {
  try {
    const saved = JSON.parse(localStorage.getItem(IOT_READING_STORAGE));
    return iotCleanReading(saved?.version === 1 ? saved : null);
  } catch { return iotCleanReading(null); }
}
function iotStoreReading() {
  try { localStorage.setItem(IOT_READING_STORAGE, JSON.stringify({ version: 1, ...iotCleanReading({ central: iotState.central, band: iotState.ranges }) })); }
  catch { /* The choice stays active for the session when storage is unavailable. */ }
}
/** The central value of a history bucket; the other one stands in when the chosen one is absent. */
function iotCentral(point, central = iotState.central) {
  const [first, second] = central === 'mean' ? [point.mean, point.median] : [point.median, point.mean];
  return Number.isFinite(first) ? first : second;
}
/** The reading controls of a history view, shared by both chart layouts. */
function iotReadingControls() {
  return `<label>Central value<select id="iotCentral"><option value="median"${iotState.central === 'median' ? ' selected' : ''}>Median</option><option value="mean"${iotState.central === 'mean' ? ' selected' : ''}>Mean</option></select></label><label class="iot-range-toggle"><input type="checkbox" id="iotCombinedRanges"${iotState.ranges ? ' checked' : ''}>Min–max band</label>`;
}
const iotReadingHint = (combined = iotState.view === 'combined') => `The line follows the ${iotState.central === 'mean' ? 'mean' : 'median'} of each time bucket${iotState.ranges ? `; the shaded band spans the minimum to the maximum measured in the bucket${combined ? ' (stronger for the reading on the axis shown)' : ''}` : ''}.`;

function iotCleanCurveStyle(value = {}) {
  const base = IOT_CURVE_PRESETS.clean;
  const oneOf = (key, choices) => choices.includes(value?.[key]) ? value[key] : base[key];
  return { width: oneOf('width', [.75, 1, 1.5, 2, 3, 4]), line: oneOf('line', ['solid', 'dashed', 'dotted']),
    curve: oneOf('curve', ['smooth', 'linear', 'step']), fill: oneOf('fill', ['none', 'gradient', 'solid']),
    opacity: Number.isFinite(value?.opacity) ? Math.max(0, Math.min(40, value.opacity)) : base.opacity,
    points: value?.points === true, glow: value?.glow === true, scale: value?.scale === 'detail' ? 'detail' : 'context' };
}

function iotSignatureCurveStyle(key) {
  return iotCleanCurveStyle({ ...IOT_CURVE_PRESETS.clean,
    ...(Object.hasOwn(IOT_SIGNATURE_CURVES, key) ? IOT_SIGNATURE_CURVES[key] : {}) });
}

function iotReadAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(IOT_APPEARANCE_STORAGE));
    if (saved?.version !== 1 || !Array.isArray(saved.devices)) return;
    for (const device of saved.devices.slice(-32)) {
      if (typeof device?.id !== 'string' || device.id.length > 128 || !Array.isArray(device.curves)) continue;
      const curves = new Map();
      for (const curve of device.curves.slice(-64)) if (typeof curve?.key === 'string' && curve.key.length <= 128) curves.set(curve.key, iotCleanCurveStyle(curve));
      iotAppearance.devices.set(device.id, curves);
    }
  } catch { /* Unavailable or old browser storage leaves the default style usable. */ }
}
iotReadAppearance();

function iotCurveStyle(key) {
  const saved = iotAppearance.devices.get(iotState.selected)?.get(key);
  return saved ? iotCleanCurveStyle(saved) : iotSignatureCurveStyle(key);
}

function iotStoreCurveStyle(keys, style) {
  const id = iotState.selected;
  if (!id) return;
  const curves = iotAppearance.devices.get(id) || new Map();
  for (const key of keys) curves.set(key, iotCleanCurveStyle(typeof style === 'function' ? style(key) : style));
  iotAppearance.devices.delete(id); iotAppearance.devices.set(id, new Map([...curves].slice(-64)));
  if (iotAppearance.devices.size > 32) iotAppearance.devices.delete(iotAppearance.devices.keys().next().value);
  try {
    localStorage.setItem(IOT_APPEARANCE_STORAGE, JSON.stringify({ version: 1,
      devices: [...iotAppearance.devices].map(([deviceId, styles]) => ({ id: deviceId, curves: [...styles].map(([key, settings]) => ({ key, ...settings })) })) }));
  } catch { /* Settings remain active for the session when storage is unavailable. */ }
}

function iotStylePreview(style, color = '#59dbe8') {
  const dash = style.line === 'dashed' ? '7 5' : style.line === 'dotted' ? '1 4' : '';
  const path = style.curve === 'step' ? 'M2 23H18V16H34V20H50V8H70' : style.curve === 'linear' ? 'M2 23L18 16L34 20L50 8L70 12' : 'M2 23C12 23 12 12 24 16S38 25 48 13S60 8 70 12';
  return `<svg class="iot-style-preview" viewBox="0 0 72 30" aria-hidden="true">${style.fill === 'none' ? '' : `<path d="${path}V30H2Z" fill="${color}" opacity="${style.opacity / 100}"/>`}<path d="${path}" fill="none" stroke="${color}" stroke-width="${style.width}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/></svg>`;
}

function iotAppearanceKey(metrics = iotCombined.model?.metrics || []) {
  return metrics.find(metric => metric.key === iotAppearance.selected)?.key || metrics[0]?.key || '';
}

function iotAppearanceEditor(metrics) {
  const key = iotAppearanceKey(metrics); const style = iotCurveStyle(key);
  const options = (values, selected) => (Array.isArray(values) ? values : Object.entries(values)).map(([value, label]) => `<option value="${value}"${String(selected) === String(value) ? ' selected' : ''}>${label}</option>`).join('');
  return `<div class="iot-style-controls">
    <label>Thickness<select data-iot-style="width">${options([[.75, 'Very thin · 0.75 px'], [1, 'Thin · 1 px'], [1.5, 'Light · 1.5 px'], [2, 'Medium · 2 px'], [3, 'Bold · 3 px'], [4, 'Thick · 4 px']], style.width)}</select></label>
    <label>Stroke<select data-iot-style="line">${options({ solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted' }, style.line)}</select></label>
    <label>Curve<select data-iot-style="curve">${options({ smooth: 'Smooth', linear: 'Straight', step: 'Steps' }, style.curve)}</select></label>
    <label>Fill<select data-iot-style="fill">${options({ none: 'None', gradient: 'Gradient', solid: 'Solid' }, style.fill)}</select></label>
    <label>Vertical zoom<select data-iot-style="scale">${options({ context: 'Context', detail: 'Detail' }, style.scale)}</select></label>
    <label class="iot-style-opacity">Area opacity <output id="iotStyleOpacity">${style.opacity} %</output><input type="range" data-iot-style="opacity" min="0" max="40" step="1" value="${style.opacity}"${style.fill === 'none' ? ' disabled' : ''}></label>
    <div class="iot-style-checks"><label><input type="checkbox" data-iot-style="points"${style.points ? ' checked' : ''}>Points</label><label><input type="checkbox" data-iot-style="glow"${style.glow ? ' checked' : ''}>Glow</label></div>
    <button type="button" class="iot-style-copy" data-iot-style-copy>Apply to all</button></div><p class="iot-style-scale-hint">Context keeps a steadier scale. Detail magnifies small variations.</p>`;
}

function iotAppearanceHtml(metrics) {
  const key = iotAppearanceKey(metrics); const style = iotCurveStyle(key);
  return `<details class="iot-appearance"><summary><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14"/><path d="M7 3v4M13 8v4M8 13v4" stroke-width="3"/></svg>Curve style<span>Strokes · areas · points</span></summary>
    <div class="iot-style-panel"><div class="iot-style-presets" role="group" aria-label="Curve presets">${Object.entries(IOT_CURVE_PRESETS).map(([id, preset]) => `<button type="button" data-iot-style-preset="${id}">${iotStylePreview(preset)}<span>${preset.label}</span></button>`).join('')}</div>
    <div class="iot-style-target"><label>Customize<select id="iotStyleMetric">${metrics.map(metric => `<option value="${e(metric.key)}"${metric.key === key ? ' selected' : ''}>${e(metric.label)}</option>`).join('')}</select></label><div id="iotStylePreview">${iotStylePreview(style, metrics.find(metric => metric.key === key)?.color)}</div><span>Settings are kept in this browser.</span></div>
    <div id="iotStyleEditor">${iotAppearanceEditor(metrics)}</div></div></details>`;
}

function iotSyncAppearance() {
  const metrics = iotCombined.model?.metrics || [];
  const editor = document.querySelector('#iotStyleEditor');
  if (editor) editor.innerHTML = iotAppearanceEditor(metrics);
  iotUpdateStylePreview();
}

function iotUpdateStylePreview() {
  const key = iotAppearanceKey(); const style = iotCurveStyle(key);
  const preview = document.querySelector('#iotStylePreview');
  if (preview) preview.innerHTML = iotStylePreview(style, iotCombined.model?.metrics.find(metric => metric.key === key)?.color);
  const output = document.querySelector('#iotStyleOpacity'); if (output) output.textContent = `${style.opacity} %`;
  const opacity = document.querySelector('[data-iot-style="opacity"]'); if (opacity) opacity.disabled = style.fill === 'none';
}

document.addEventListener('click', event => {
  if (state.tab !== 'iot') return;
  const preset = event.target.closest('[data-iot-style-preset]')?.dataset.iotStylePreset;
  const copy = event.target.closest('[data-iot-style-copy]');
  if (!Object.hasOwn(IOT_CURVE_PRESETS, preset) && !copy) return;
  const keys = array(iotDevice()?.measures).map(measure => measure.key);
  iotStoreCurveStyle(keys, copy ? iotCurveStyle(iotAppearanceKey()) : preset === 'signature' ? iotSignatureCurveStyle : IOT_CURVE_PRESETS[preset]);
  iotSyncAppearance(); iotDrawCombined();
});

function iotChangeAppearance(event) {
  if (state.tab !== 'iot') return;
  const target = event.target;
  if (target.id === 'iotStyleMetric' && event.type === 'change') { iotAppearance.selected = target.value; iotSyncAppearance(); return; }
  const field = target.dataset.iotStyle;
  if (!['width', 'line', 'curve', 'fill', 'opacity', 'points', 'glow', 'scale'].includes(field)) return;
  // Sliders redraw while dragging; other native controls redraw on commitment.
  if (event.type === 'input' && field !== 'opacity') return;
  const key = iotAppearanceKey(); const style = iotCurveStyle(key);
  style[field] = ['points', 'glow'].includes(field) ? target.checked : ['width', 'opacity'].includes(field) ? Number(target.value) : target.value;
  iotStoreCurveStyle([key], style); iotUpdateStylePreview(); iotDrawCombined();
}
document.addEventListener('change', iotChangeAppearance);
document.addEventListener('input', iotChangeAppearance);
