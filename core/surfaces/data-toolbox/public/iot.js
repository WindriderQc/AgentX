'use strict';

const IOT_PERIODS = Object.freeze({ live: 'Live', 1: '1 hour', 24: '24 hours', 168: '7 days', 744: '31 days', 8760: '1 year', all: 'Full history' });
const IOT_RESOLUTIONS = Object.freeze({ auto: 'Auto', minute: '1 min', '5min': '5 min', '30min': '30 min', hour: '1 hour', '2hour': '2 hours', day: '1 day' });
const iotReadingAtLoad = iotReadReading();
const iotState = { status: null, devices: [], selected: '', period: 'live', resolution: 'auto', view: 'combined', axis: '',
  central: iotReadingAtLoad.central, ranges: iotReadingAtLoad.band, keys: [],
  series: null, error: '', loaded: false, generation: 0, pending: false, feedback: '', historyAt: 0, filter: '' };
const iotDevice = () => iotState.devices.find(device => device.id === iotState.selected);
const iotPath = id => `/iot/devices/${encodeURIComponent(id)}`;
const iotSafe = promise => promise.then(data => ({ data, error: '' }), error => ({ data: null, error: error.message }));
const iotValue = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2,
  notation: Math.abs(value) >= 1e9 || (value !== 0 && Math.abs(value) < .0001) ? 'scientific' : 'standard' }) : '—';
const iotAge = at => {
  const ms = at ? Date.now() - new Date(at).getTime() : NaN;
  if (!Number.isFinite(ms)) return 'unknown date';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago`
    : seconds < 172800 ? `${Math.floor(seconds / 3600)} h ago` : `${Math.floor(seconds / 86400)} d ago`;
};
const iotStatusName = status => ({ online: 'Online', offline: 'Offline', stale: 'Silent', unknown: 'Unknown state' })[status] || 'Unknown state';
const iotBadge = status => `<span class="iot-status" data-status="${e(status || 'unknown')}"><i aria-hidden="true"></i>${e(iotStatusName(status))}</span>`;
function iotPaint(selector, html) {
  if (state.tab !== 'iot') return;
  const target = document.querySelector(selector); if (!target) return;
  if (selector === '#iotSeries') {
    // Preserve the canvas, pointer and chart instance during ordinary live reads.
    if (iotState.view === 'combined' && iotState.series && !iotState.error && iotState.keys.length
      && typeof target.querySelector === 'function' && target.querySelector('#iotCombinedChart')
      && iotCombinedModel().populated.length) { iotDrawCombined(); return; }
    iotClearCombined();
  }
  target.innerHTML = html;
  if (selector === '#iotSeries') iotDrawCombined();
}

function iotBroker() {
  const consumer = iotState.status?.consumer;
  if (!consumer) return '<p class="notice warning">Broker state unavailable. The values below are the last known ones.</p>';
  const text = consumer.connected ? 'MQTT connected' : consumer.configured ? 'MQTT disconnected · last known values' : 'MQTT broker not configured';
  return `<span class="iot-connection${consumer.connected ? ' connected' : ''}"><i aria-hidden="true"></i>${e(text)}</span>`;
}

function iotCards() {
  const query = iotState.filter.toLocaleLowerCase();
  const devices = iotState.devices.filter(device => [device.id, device.displayName, device.location].some(value => String(value || '').toLocaleLowerCase().includes(query)));
  if (!devices.length) return `<p class="iot-empty">${iotState.devices.length ? 'No device matches the filter.' : 'No device received yet. Cards appear as soon as an ESP32 publishes to the broker.'}</p>`;
  return `<div class="iot-devices">${devices.map(device => `<article class="card iot-device${device.id === iotState.selected ? ' selected' : ''}">
    <div class="iot-card-head"><span class="iot-board">${iotIcon('chip')}</span><div class="iot-identity"><h3>${e(device.displayName || device.info?.name || device.id)}</h3><small class="mono">${e(device.id)}</small>${iotModelLine(device)}${device.location ? `<span class="iot-location">${e(device.location)}</span>` : ''}</div>${iotBadge(device.status)}</div>
    <div class="iot-measures">${iotCardMeasures(device).map(measure => {
      const visual = iotMetric(measure.key, measure.name);
      if (iotIsSignal(measure)) return iotSignalTile(measure, visual);
      return `<div class="iot-measure" data-tone="${visual.tone}"><span class="iot-measure-label">${iotIcon(visual.icon)}${e(visual.label)}</span><strong>${e(iotValue(measure.value))}<small> ${e(measure.unit || '')}</small></strong><small title="${e(date(measure.at))}">${e(iotAge(measure.at))}</small></div>`;
    }).join('') || '<p class="muted">No reading received.</p>'}</div>
    <div class="iot-card-foot"><span title="${e(date(device.lastSeenAt))}">Last message: ${e(iotAge(device.lastSeenAt))}</span><button type="button" class="button" data-iot-device="${e(device.id)}" aria-label="Show charts for ${e(device.displayName || device.id)}">${device.id === iotState.selected ? 'Selected' : 'Show charts'}</button></div>
    </article>`).join('')}</div>`;
}

// Live has no buckets; "All" always lets Data choose the bucket size.
const iotFixedResolution = () => iotState.period === 'live' || iotState.period === 'all';
/** The bucket size Data actually used for the history on screen, in words. */
function iotResolutionUsed(series = iotState.series) {
  if (!series?.bucket) return '';
  const size = IOT_RESOLUTIONS[series.bucket] || series.bucket;
  const chosen = iotState.period === 'all' || iotState.resolution === 'auto' ? ' (chosen by Data)' : '';
  const tier = series.source === 'hour' ? ' · from hourly buckets' : series.source === 'minute' ? ' · from one-minute buckets' : '';
  return `Resolution used: ${size}${chosen}${tier}`;
}

function iotControls() {
  const device = iotDevice();
  if (!device) return '';
  const options = (values, selected) => Object.entries(values).map(([value, text]) => `<option value="${e(value)}"${value === selected ? ' selected' : ''}>${e(text)}</option>`).join('');
  const short = { live: 'Live', 1: '1 h', 24: '24 h', 168: '7 days', 744: '1 month', 8760: '1 year', all: 'All' };
  return `<div class="iot-controls"><label>Device<select id="iotDevice">${iotState.devices.map(item => `<option value="${e(item.id)}"${item.id === device.id ? ' selected' : ''}>${e(item.displayName || item.id)}</option>`).join('')}</select></label>
    <div class="iot-periods"><span>Period</span><div class="iot-ranges" role="group" aria-label="Chart period">${['live', '1', '24', '168', '744', '8760', 'all'].map(value => `<button type="button" data-iot-period="${value}" aria-pressed="${value === iotState.period}" aria-label="${e(IOT_PERIODS[value])}">${short[value]}</button>`).join('')}</div></div>
    <label>Resolution<select id="iotResolution"${iotFixedResolution() ? ' disabled' : ''}>${options(IOT_RESOLUTIONS, iotState.period === 'all' ? 'auto' : iotState.resolution)}</select></label></div>
    <div class="iot-view-modes" role="group" aria-label="Chart layout"><button type="button" data-iot-view="combined" aria-pressed="${iotState.view === 'combined'}">Overlaid</button><button type="button" data-iot-view="individual" aria-pressed="${iotState.view === 'individual'}">Per reading</button></div>
    <fieldset class="iot-measure-picker"><legend>Readings</legend>${array(device.measures).map(measure => { const visual = iotMetric(measure.key, measure.name); return `<label data-tone="${visual.tone}" style="--accent:${visual.color}"><input type="checkbox" data-iot-measure="${e(measure.key)}"${iotState.keys.includes(measure.key) ? ' checked' : ''}>${e(visual.label)}</label>`; }).join('')}</fieldset>`;
}

function iotSeriesHtml() {
  if (iotState.error) return `<p class="notice warning" role="alert">${e(iotState.error)}</p>`;
  if (!iotState.keys.length) return '<p class="iot-empty">Choose the readings to show.</p>';
  if (!iotState.series) return '<p class="muted" role="status">Reading charts…</p>';
  const series = iotState.series;
  const live = iotState.period === 'live';
  if (iotState.view === 'combined') return iotCombinedHtml();
  return `<p class="muted iot-source">${live ? 'Live: latest raw readings received by Data. The buffer resets on restart.' : `History: ${e(IOT_RESOLUTIONS[series.bucket] || series.bucket)} · ${e(date(series.from))} → ${e(date(series.to))}. Intervals without data stay empty.`}</p>
    ${live ? '' : `<div class="iot-overlay-tools iot-reading-tools"><p><span id="iotReadingHint">${e(iotReadingHint())}</span> <span id="iotResolutionUsed">${e(iotResolutionUsed())}</span></p>${iotReadingControls()}</div>`}
    <div class="iot-charts">${iotState.keys.map(key => {
      const measure = series.measures?.[key];
      const known = array(iotDevice()?.measures).find(item => item.key === key);
      const visual = iotMetric(key, known?.name || measure?.name);
      const name = visual.label;
      const unit = measure?.unit || known?.unit || '';
      const points = array(measure?.points).filter(point => Number.isFinite(live ? point.value : iotCentral(point)));
      const last = points.at(-1);
      return `<article class="card iot-chart-card" data-tone="${visual.tone}" style="--accent:${visual.color}"><div class="iot-chart-head"><h3><span class="iot-metric-icon">${iotIcon(visual.icon)}</span>${e(name)}</h3><span class="iot-mode">${live ? 'Live' : 'History'}</span></div>
        <div class="iot-reading"><strong>${e(iotValue(last ? live ? last.value : iotCentral(last) : null))}<small>${e(unit)}</small></strong><span>${last ? e(iotAge(last.ts)) : 'Waiting for readings'}</span></div>
        ${iotChart(measure?.points, { name, unit, key, live, bucketSeconds: series.bucketSeconds })}</article>`;
    }).join('')}</div>`;
}

function iotActionsHtml() {
  const device = iotDevice();
  if (!device) return '';
  return `<div class="iot-actions-grid"><details class="card"><summary>Name, location and notes</summary><form id="iotRecord" data-device="${e(device.id)}">
    <label>Display name<input name="displayName" maxlength="80" value="${e(device.displayName || '')}"></label>
    <label>Location<input name="location" maxlength="80" value="${e(device.location || '')}"></label>
    <label>Notes<textarea name="notes" maxlength="1000">${e(device.notes || '')}</textarea></label><button class="button" type="submit"${iotState.pending ? ' disabled' : ''}>Save</button></form></details>
    ${iotCommandHtml(device)}</div>`;
}

async function iotReadSeries() {
  const id = iotState.selected;
  if (!id || !iotState.keys.length) return { measures: {} };
  const query = new URLSearchParams({ measure: iotState.keys.join(',') });
  if (iotState.period === 'live') return api(`${iotPath(id)}/live?${query}`);
  const to = Date.now();
  // "All" starts at the device's first message; Data picks hourly or daily buckets beyond the minute tier.
  const first = iotDevice()?.firstSeenAt ? new Date(iotDevice().firstSeenAt).getTime() : NaN;
  const all = iotState.period === 'all';
  const from = all ? (Number.isFinite(first) && first < to ? first : to - 8760 * 3600000) : to - Number(iotState.period) * 3600000;
  // Data bounds each history call to twelve measures. Every selected measure
  // is read; larger devices use small independent groups with the same range.
  const groups = [];
  for (let offset = 0; offset < iotState.keys.length; offset += 12) groups.push(iotState.keys.slice(offset, offset + 12));
  const answers = await Promise.all(groups.map(keys => api(`${iotPath(id)}/history?${new URLSearchParams({
    measure: keys.join(','), from: new Date(from).toISOString(), to: new Date(to).toISOString(), resolution: all ? 'auto' : iotState.resolution
  })}`)));
  return { ...answers[0], measures: Object.assign({}, ...answers.map(answer => answer.measures)) };
}

async function iotLoadSeries() {
  const generation = ++iotState.generation; const seq = state.renderSeq;
  iotState.series = null; iotState.error = '';
  iotPaint('#iotSeries', iotSeriesHtml());
  const result = await iotSafe(iotReadSeries());
  if (generation !== iotState.generation || seq !== state.renderSeq || state.tab !== 'iot') return;
  iotState.series = result.data; iotState.error = result.error; iotState.historyAt = Date.now();
  iotPaint('#iotSeries', iotSeriesHtml());
  if (result.error) shellRead(result.error);
}

function iotSelect(id) {
  if (!iotState.devices.some(device => device.id === id)) return;
  iotState.selected = id;
  iotState.keys = array(iotDevice()?.measures).slice(0, 6).map(measure => measure.key);
  iotState.feedback = '';
  iotCommandDisarm(); iotCommand.outcome = null;
  if (typeof iotConfigurationReset === 'function') { iotConfigurationReset(); iotConfigurationLoad(); }
  iotPaint('#iotFeedback', '');
  iotPaint('#iotCards', iotCards());
  iotPaint('#iotRegistry', iotRegistryHtml());
  iotLoadEvents();
  iotPaint('#iotControls', iotControls());
  iotPaint('#iotActions', iotActionsHtml());
  return iotLoadSeries();
}

async function iotSnapshot() {
  const [status, devices] = await Promise.all([iotSafe(api('/iot/status')), iotSafe(api('/iot/devices'))]);
  return { status, devices };
}

async function iotTab() {
  if (typeof iotConfigDisarm === 'function') iotConfigDisarm();
  const seq = state.renderSeq;
  const snapshot = await iotSnapshot();
  if (seq !== state.renderSeq || state.tab !== 'iot') return;
  iotState.status = snapshot.status.data;
  if (snapshot.devices.error) throw new Error(snapshot.devices.error);
  iotState.devices = array(snapshot.devices.data?.devices);
  iotState.loaded = true;
  content.innerHTML = `<div id="iotDashboard"><header class="iot-hero"><div><p class="iot-eyebrow">ESP32 & SENSORS</p><h2>IoT devices<span class="iot-count" id="iotCount">${number(iotState.devices.length)}</span></h2><p>A glance at your devices and everything they measure.</p></div>
    <div class="iot-hero-status"><div id="iotBroker">${iotBroker()}</div><p id="iotRefresh" class="refresh-stamp"></p></div></header>
    <div class="iot-fleet-head"><h3>My devices</h3><label class="iot-search">${iotIcon('search')}<span class="iot-sr">Search devices</span><input id="iotFilter" type="search" value="${e(iotState.filter)}" placeholder="Search devices…"></label><button class="button iot-refresh-button" data-action="refresh" aria-label="Refresh">${iotIcon('refresh')}</button></div>
    <section id="iotCards" aria-label="Device cards">${iotCards()}</section>
    <section id="iotRegistry">${iotRegistryHtml()}</section>
    <div class="iot-section-title"><div><p class="iot-eyebrow">TELEMETRY</p><h3>Readings over time</h3></div><span class="iot-section-hint">All readings on the same time axis.</span></div>
    <section id="iotControls"></section><section id="iotSeries" aria-label="Reading charts"></section>
    <p id="iotFeedback" class="iot-feedback" role="status"></p><section id="iotActions"></section>
    <section id="iotConfiguration" aria-label="Profiles and timers"></section>
    <section id="iotEvents" aria-label="Device events"></section>
    <section id="iotConsumer">${iotConsumerHtml()}</section><section id="iotMissing">${iotMissingHtml()}</section></div>`;
  const selected = iotState.devices.some(device => device.id === iotState.selected) ? iotState.selected : iotState.devices[0]?.id;
  if (selected) {
    if (selected !== iotState.selected || !iotState.keys.length) await iotSelect(selected);
    else {
      iotPaint('#iotControls', iotControls()); iotPaint('#iotActions', iotActionsHtml()); iotLoadEvents(); await iotLoadSeries();
      if (typeof iotConfigurationLoad === 'function') await iotConfigurationLoad();
    }
  } else iotPaint('#iotSeries', '<p class="iot-empty">Charts will appear with the first readings.</p>');
  if (seq !== state.renderSeq || state.tab !== 'iot') return;
  iotRefresher.opened();
  return snapshot.status.error || iotState.error;
}

const iotRefresher = tabRefresher({ tab: 'iot', everyMs: 2000, stamp: 'iotRefresh', holds: true,
  ready: () => iotState.loaded, blocked: () => iotState.pending ? 'an action is in progress' : iotCommand.armed ? 'a command is awaiting confirmation'
    : typeof iotConfiguration !== 'undefined' && iotConfiguration.armed ? 'a configuration is awaiting confirmation' : '',
  async read() {
    const generation = iotState.generation;
    const snapshot = await iotSnapshot();
    const series = iotState.selected && (iotState.period === 'live' || Date.now() - iotState.historyAt >= 60000)
      ? await iotSafe(iotReadSeries()) : null;
    const selected = iotState.selected;
    const events = selected && Date.now() - iotEvents.at >= IOT_EVENTS_EVERY_MS ? await iotSafe(iotReadEvents(selected)) : null;
    const configuration = selected && typeof iotConfiguration !== 'undefined' ? await iotSafe(api(`${iotPath(selected)}/controls`)) : null;
    return { ...snapshot, series, generation, events, selected, configuration };
  },
  apply(answer) {
    if (answer.generation !== iotState.generation) return { warning: 'Chart selection changed.' };
    const previousMeasures = array(iotDevice()?.measures).map(measure => measure.key);
    iotState.status = answer.status.data;
    if (!answer.devices.error) iotState.devices = array(answer.devices.data?.devices);
    if (answer.series) {
      iotState.series = answer.series.data; iotState.error = answer.series.error; iotState.historyAt = Date.now();
      iotPaint('#iotSeries', iotSeriesHtml());
    }
    iotPaint('#iotBroker', iotBroker());
    iotPaint('#iotConsumer', iotConsumerHtml());
    if (!answer.devices.error) iotPaint('#iotRegistry', iotRegistryHtml());
    if (answer.events) { iotApplyEvents(answer.selected, answer.events); iotPaint('#iotEvents', iotEventsHtml()); }
    if (answer.configuration && answer.selected === iotState.selected && !answer.configuration.error) {
      iotConfiguration.data = answer.configuration.data; iotPaint('#iotConfiguration', iotConfigurationHtml());
    }
    if (!answer.devices.error) iotPaint('#iotCount', number(iotState.devices.length));
    iotPaint('#iotCards', answer.devices.error ? `<p class="notice warning">${e(answer.devices.error)}</p>` : iotCards());
    if (!iotDevice() && iotState.devices.length && !answer.devices.error) iotSelect(iotState.devices[0].id);
    else if (!answer.devices.error) {
      const measures = array(iotDevice()?.measures).map(measure => measure.key);
      if (measures.join(',') !== previousMeasures.join(',')) {
        if (!previousMeasures.length && measures.length) iotSelect(iotState.selected);
        else {
          iotState.keys = iotState.keys.filter(key => measures.includes(key));
          iotPaint('#iotControls', iotControls());
        }
      }
    }
    // Keep open forms and their input. The shared refresher holds while editing.
    iotPaint('#iotActions', iotActionsHtml());
    return answer.status.error || answer.devices.error || answer.series?.error || '';
  }
});

iotRefresher.stampText = () => iotRefresher.error ? `Refresh interrupted: ${iotRefresher.error}`
  : iotRefresher.held ? 'Refresh paused while you browse or act.'
    : `Refreshed at ${new Date(iotRefresher.readAt || Date.now()).toLocaleTimeString()} · every 2 s`;

async function iotSubmit(form) {
  if (iotState.pending || state.tab !== 'iot') return;
  const id = form.dataset.device;
  if (id !== iotState.selected) return;
  const fields = Object.fromEntries(new FormData(form));
  if (form.id === 'iotCommand') {
    // First step only: nothing is sent before the explicit confirmation.
    const refusal = iotCommandArm(id, fields);
    iotCommand.note = refusal; iotPaintCommand(); return;
  }
  const seq = state.renderSeq;
  iotState.pending = true;
  const submit = form.querySelector('[type="submit"]'); if (submit) submit.disabled = true;
  iotPaint('#iotFeedback', 'Saving…');
  try {
    const result = await api(iotPath(id), { method: 'PATCH', payload: fields });
    if (seq !== state.renderSeq || state.tab !== 'iot' || id !== iotState.selected) return;
    iotState.devices = iotState.devices.map(device => device.id === id ? result : device);
    iotState.feedback = 'Name, location and notes saved.';
    iotPaint('#iotCards', iotCards()); iotPaint('#iotRegistry', iotRegistryHtml());
  } catch (error) {
    if (seq !== state.renderSeq || state.tab !== 'iot' || id !== iotState.selected) return;
    iotState.feedback = error.message;
  } finally {
    iotState.pending = false;
    if (seq === state.renderSeq && state.tab === 'iot' && id === iotState.selected) {
      const target = document.querySelector('#iotFeedback'); if (target) target.textContent = iotState.feedback;
      if (submit) submit.disabled = false;
    }
  }
}

document.addEventListener('click', event => {
  const view = event.target.closest('[data-iot-view]')?.dataset.iotView;
  if (state.tab === 'iot' && ['combined', 'individual'].includes(view)) {
    iotState.view = view;
    document.querySelectorAll('[data-iot-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.iotView === view)));
    iotPaint('#iotSeries', iotSeriesHtml()); return;
  }
  const period = event.target.closest('[data-iot-period]')?.dataset.iotPeriod;
  if (period && state.tab === 'iot' && Object.hasOwn(IOT_PERIODS, period)) {
    iotState.period = period;
    document.querySelectorAll('[data-iot-period]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.iotPeriod === period)));
    const resolution = document.querySelector('#iotResolution'); if (resolution) { resolution.disabled = iotFixedResolution(); resolution.value = period === 'all' ? 'auto' : iotState.resolution; }
    iotLoadSeries();
  }
  const id = event.target.closest('[data-iot-device]')?.dataset.iotDevice;
  if (id && state.tab === 'iot') iotSelect(id);
});
document.addEventListener('input', event => {
  if (event.target.id === 'iotFilter' && state.tab === 'iot') { iotState.filter = event.target.value; iotPaint('#iotCards', iotCards()); }
});
document.addEventListener('change', event => {
  if (state.tab !== 'iot') return;
  const target = event.target;
  if (target.id === 'iotCombinedAxis') { iotState.axis = target.value; iotDrawCombined(); return; }
  if (target.id === 'iotCombinedRanges' || target.id === 'iotCentral') {
    if (target.id === 'iotCentral') iotState.central = target.value === 'mean' ? 'mean' : 'median'; else iotState.ranges = target.checked;
    iotStoreReading();
    // The individual charts are rebuilt; the combined chart redraws in place and keeps its cursor.
    if (iotState.view === 'combined') { iotDrawCombined(); const hint = document.querySelector('#iotReadingHint'); if (hint) hint.textContent = iotReadingHint(); }
    else iotPaint('#iotSeries', iotSeriesHtml());
    return;
  }
  if (target.id === 'iotDevice') { iotSelect(target.value); return; }
  if (target.id === 'iotCommandKind') {
    const reboot = target.value === 'reboot'; const gpio = document.querySelector('#iotGpio');
    document.querySelector('#iotGpioLabel').hidden = reboot; gpio.disabled = reboot; gpio.required = !reboot; return;
  }
  if (target.id === 'iotResolution' && Object.hasOwn(IOT_RESOLUTIONS, target.value)) iotState.resolution = target.value;
  else if (target.dataset.iotMeasure) {
    const key = target.dataset.iotMeasure;
    iotState.keys = target.checked ? [...new Set([...iotState.keys, key])] : iotState.keys.filter(item => item !== key);
  } else return;
  // Native controls keep the focus: update only the resolution state and charts.
  const resolution = document.querySelector('#iotResolution'); if (resolution) resolution.disabled = iotFixedResolution();
  iotLoadSeries();
});
document.addEventListener('submit', event => {
  if (['iotRecord', 'iotCommand'].includes(event.target.id)) { event.preventDefault(); iotSubmit(event.target); }
});
