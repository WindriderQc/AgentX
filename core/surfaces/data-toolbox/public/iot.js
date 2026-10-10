'use strict';

const IOT_PERIODS = Object.freeze({ live: 'Live', 1: '1 heure', 24: '24 heures', 168: '7 jours', 744: '31 jours', 8760: '1 an' });
const IOT_RESOLUTIONS = Object.freeze({ auto: 'Auto', minute: '1 min', '5min': '5 min', '30min': '30 min', hour: '1 heure', '2hour': '2 heures', day: '1 jour' });
const iotState = { status: null, devices: [], selected: '', period: 'live', resolution: 'auto', view: 'combined', axis: '', ranges: false, keys: [],
  series: null, error: '', loaded: false, generation: 0, pending: false, feedback: '', historyAt: 0, filter: '' };
const iotDevice = () => iotState.devices.find(device => device.id === iotState.selected);
const iotPath = id => `/iot/devices/${encodeURIComponent(id)}`;
const iotSafe = promise => promise.then(data => ({ data, error: '' }), error => ({ data: null, error: error.message }));
const iotValue = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2,
  notation: Math.abs(value) >= 1e9 || (value !== 0 && Math.abs(value) < .0001) ? 'scientific' : 'standard' }) : '—';
const iotAge = at => {
  const ms = at ? Date.now() - new Date(at).getTime() : NaN;
  if (!Number.isFinite(ms)) return 'date inconnue';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `il y a ${seconds} s` : seconds < 3600 ? `il y a ${Math.floor(seconds / 60)} min` : `il y a ${Math.floor(seconds / 3600)} h`;
};
const iotStatusName = status => ({ online: 'En ligne', offline: 'Hors ligne', stale: 'Silencieux', unknown: 'État inconnu' })[status] || 'État inconnu';
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
  if (!consumer) return '<p class="notice warning">État du broker indisponible. Les valeurs ci-dessous sont les dernières connues.</p>';
  const text = consumer.connected ? 'MQTT connecté' : consumer.configured ? 'MQTT déconnecté · dernières valeurs connues' : 'Broker MQTT non configuré';
  return `<span class="iot-connection${consumer.connected ? ' connected' : ''}"><i aria-hidden="true"></i>${e(text)}</span>`;
}

function iotCards() {
  const query = iotState.filter.toLocaleLowerCase();
  const devices = iotState.devices.filter(device => [device.id, device.displayName, device.location].some(value => String(value || '').toLocaleLowerCase().includes(query)));
  if (!devices.length) return `<p class="iot-empty">${iotState.devices.length ? 'Aucun appareil ne correspond au filtre.' : 'Aucun appareil reçu. Les cartes apparaissent dès qu’un ESP32 publie sur le broker.'}</p>`;
  return `<div class="iot-devices">${devices.map(device => `<article class="card iot-device${device.id === iotState.selected ? ' selected' : ''}">
    <div class="iot-card-head"><span class="iot-board">${iotIcon('chip')}</span><div class="iot-identity"><h3>${e(device.displayName || device.info?.name || device.id)}</h3><small class="mono">${e(device.id)}</small>${device.location ? `<span class="iot-location">${e(device.location)}</span>` : ''}</div>${iotBadge(device.status)}</div>
    <div class="iot-measures">${iotCardMeasures(device).map(measure => {
      const visual = iotMetric(measure.key, measure.name);
      return `<div class="iot-measure" data-tone="${visual.tone}"><span class="iot-measure-label">${iotIcon(visual.icon)}${e(visual.label)}</span><strong>${e(iotValue(measure.value))}<small> ${e(measure.unit || '')}</small></strong><small title="${e(date(measure.at))}">${e(iotAge(measure.at))}</small></div>`;
    }).join('') || '<p class="muted">Aucune mesure reçue.</p>'}</div>
    <div class="iot-card-foot"><span title="${e(date(device.lastSeenAt))}">Dernier message : ${e(iotAge(device.lastSeenAt))}</span><button type="button" class="button" data-iot-device="${e(device.id)}" aria-label="Voir les courbes de ${e(device.displayName || device.id)}">${device.id === iotState.selected ? 'Sélectionné' : 'Voir les courbes'}</button></div>
    </article>`).join('')}</div>`;
}

function iotControls() {
  const device = iotDevice();
  if (!device) return '';
  const options = (values, selected) => Object.entries(values).map(([value, text]) => `<option value="${e(value)}"${value === selected ? ' selected' : ''}>${e(text)}</option>`).join('');
  const short = { live: 'Live', 1: '1 h', 24: '24 h', 168: '7 jours', 744: '1 mois', 8760: '1 an' };
  return `<div class="iot-controls"><label>Appareil<select id="iotDevice">${iotState.devices.map(item => `<option value="${e(item.id)}"${item.id === device.id ? ' selected' : ''}>${e(item.displayName || item.id)}</option>`).join('')}</select></label>
    <div class="iot-periods"><span>Période</span><div class="iot-ranges" role="group" aria-label="Période des courbes">${['live', '1', '24', '168', '744', '8760'].map(value => `<button type="button" data-iot-period="${value}" aria-pressed="${value === iotState.period}" aria-label="${e(IOT_PERIODS[value])}">${short[value]}</button>`).join('')}</div></div>
    <label>Résolution<select id="iotResolution"${iotState.period === 'live' ? ' disabled' : ''}>${options(IOT_RESOLUTIONS, iotState.resolution)}</select></label></div>
    <div class="iot-view-modes" role="group" aria-label="Disposition des courbes"><button type="button" data-iot-view="combined" aria-pressed="${iotState.view === 'combined'}">Superposées</button><button type="button" data-iot-view="individual" aria-pressed="${iotState.view === 'individual'}">Par mesure</button></div>
    <fieldset class="iot-measure-picker"><legend>Mesures</legend>${array(device.measures).map(measure => { const visual = iotMetric(measure.key, measure.name); return `<label data-tone="${visual.tone}" style="--accent:${visual.color}"><input type="checkbox" data-iot-measure="${e(measure.key)}"${iotState.keys.includes(measure.key) ? ' checked' : ''}>${e(visual.label)}</label>`; }).join('')}</fieldset>`;
}

function iotSeriesHtml() {
  if (iotState.error) return `<p class="notice warning" role="alert">${e(iotState.error)}</p>`;
  if (!iotState.keys.length) return '<p class="iot-empty">Choisis les mesures à afficher.</p>';
  if (!iotState.series) return '<p class="muted" role="status">Lecture des courbes…</p>';
  const series = iotState.series;
  const live = iotState.period === 'live';
  if (iotState.view === 'combined') return iotCombinedHtml();
  return `<p class="muted iot-source">${live ? 'Live : dernières mesures brutes reçues par Data. Le tampon repart à zéro au redémarrage.' : `Historique : ${e(IOT_RESOLUTIONS[series.bucket] || series.bucket)} · ${e(date(series.from))} → ${e(date(series.to))}. Les intervalles sans données restent vides.`}</p>
    <div class="iot-charts">${iotState.keys.map(key => {
      const measure = series.measures?.[key];
      const known = array(iotDevice()?.measures).find(item => item.key === key);
      const visual = iotMetric(key, known?.name || measure?.name);
      const name = visual.label;
      const unit = measure?.unit || known?.unit || '';
      const points = array(measure?.points).filter(point => Number.isFinite(live ? point.value : point.mean));
      const last = points.at(-1);
      return `<article class="card iot-chart-card" data-tone="${visual.tone}" style="--accent:${visual.color}"><div class="iot-chart-head"><h3><span class="iot-metric-icon">${iotIcon(visual.icon)}</span>${e(name)}</h3><span class="iot-mode">${live ? 'En direct' : 'Historique'}</span></div>
        <div class="iot-reading"><strong>${e(iotValue(last ? live ? last.value : last.mean : null))}<small>${e(unit)}</small></strong><span>${last ? e(iotAge(last.ts)) : 'En attente de mesures'}</span></div>
        ${iotChart(measure?.points, { name, unit, key, live, bucketSeconds: series.bucketSeconds })}</article>`;
    }).join('')}</div>`;
}

function iotActionsHtml() {
  const device = iotDevice();
  if (!device) return '';
  const disabled = iotState.pending || !iotState.status?.consumer?.connected ? ' disabled' : '';
  return `<div class="iot-actions-grid"><details class="card"><summary>Nom, emplacement et notes</summary><form id="iotRecord" data-device="${e(device.id)}">
    <label>Nom affiché<input name="displayName" maxlength="80" value="${e(device.displayName || '')}"></label>
    <label>Emplacement<input name="location" maxlength="80" value="${e(device.location || '')}"></label>
    <label>Notes<textarea name="notes" maxlength="1000">${e(device.notes || '')}</textarea></label><button class="button" type="submit"${iotState.pending ? ' disabled' : ''}>Enregistrer</button></form></details>
    <details class="card"><summary>Commandes de ${e(device.displayName || device.id)}</summary><p class="muted">Les commandes atteignent l’appareil réel. Un message publié ne confirme pas l’action du matériel.</p>
    <form id="iotCommand" data-device="${e(device.id)}"><label>Commande<select name="command" id="iotCommandKind"><option value="io_on">GPIO ON</option><option value="io_off">GPIO OFF</option><option value="reboot">Redémarrer</option></select></label>
    <label id="iotGpioLabel">GPIO<input type="number" name="gpio" id="iotGpio" min="0" max="48" step="1" placeholder="Numéro GPIO" required></label><button class="button" type="submit"${disabled}>Envoyer à cet appareil</button></form></details></div>`;
}

async function iotReadSeries() {
  const id = iotState.selected;
  if (!id || !iotState.keys.length) return { measures: {} };
  const query = new URLSearchParams({ measure: iotState.keys.join(',') });
  if (iotState.period === 'live') return api(`${iotPath(id)}/live?${query}`);
  const to = Date.now();
  const from = to - Number(iotState.period) * 3600000;
  // Data bounds each history call to twelve measures. Every selected measure
  // is read; larger devices use small independent groups with the same range.
  const groups = [];
  for (let offset = 0; offset < iotState.keys.length; offset += 12) groups.push(iotState.keys.slice(offset, offset + 12));
  const answers = await Promise.all(groups.map(keys => api(`${iotPath(id)}/history?${new URLSearchParams({
    measure: keys.join(','), from: new Date(from).toISOString(), to: new Date(to).toISOString(), resolution: iotState.resolution
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
  iotPaint('#iotFeedback', '');
  iotPaint('#iotCards', iotCards());
  iotPaint('#iotControls', iotControls());
  iotPaint('#iotActions', iotActionsHtml());
  return iotLoadSeries();
}

async function iotSnapshot() {
  const [status, devices] = await Promise.all([iotSafe(api('/iot/status')), iotSafe(api('/iot/devices'))]);
  return { status, devices };
}

async function iotTab() {
  const seq = state.renderSeq;
  const snapshot = await iotSnapshot();
  if (seq !== state.renderSeq || state.tab !== 'iot') return;
  iotState.status = snapshot.status.data;
  if (snapshot.devices.error) throw new Error(snapshot.devices.error);
  iotState.devices = array(snapshot.devices.data?.devices);
  iotState.loaded = true;
  content.innerHTML = `<div id="iotDashboard"><header class="iot-hero"><div><p class="iot-eyebrow">ESP32 & CAPTEURS</p><h2>Appareils IoT<span class="iot-count" id="iotCount">${number(iotState.devices.length)}</span></h2><p>Un coup d’œil sur tes appareils et tout ce qu’ils mesurent.</p></div>
    <div class="iot-hero-status"><div id="iotBroker">${iotBroker()}</div><p id="iotRefresh" class="refresh-stamp"></p></div></header>
    <div class="iot-fleet-head"><h3>Mes appareils</h3><label class="iot-search">${iotIcon('search')}<span class="iot-sr">Rechercher un appareil</span><input id="iotFilter" type="search" value="${e(iotState.filter)}" placeholder="Rechercher un appareil…"></label><button class="button iot-refresh-button" data-action="refresh" aria-label="Actualiser">${iotIcon('refresh')}</button></div>
    <section id="iotCards" aria-label="Cartes des appareils">${iotCards()}</section>
    <div class="iot-section-title"><div><p class="iot-eyebrow">TÉLÉMÉTRIE</p><h3>Évolution des mesures</h3></div><span class="iot-section-hint">Toutes les mesures sur le même axe de temps.</span></div>
    <section id="iotControls"></section><section id="iotSeries" aria-label="Courbes des mesures"></section>
    <p id="iotFeedback" class="iot-feedback" role="status"></p><section id="iotActions"></section></div>`;
  const selected = iotState.devices.some(device => device.id === iotState.selected) ? iotState.selected : iotState.devices[0]?.id;
  if (selected) {
    if (selected !== iotState.selected || !iotState.keys.length) await iotSelect(selected);
    else {
      iotPaint('#iotControls', iotControls()); iotPaint('#iotActions', iotActionsHtml()); await iotLoadSeries();
    }
  } else iotPaint('#iotSeries', '<p class="iot-empty">Les courbes apparaîtront avec les premières mesures.</p>');
  if (seq !== state.renderSeq || state.tab !== 'iot') return;
  iotRefresher.opened();
  return snapshot.status.error || iotState.error;
}

const iotRefresher = tabRefresher({ tab: 'iot', everyMs: 2000, stamp: 'iotRefresh', holds: true,
  ready: () => iotState.loaded, blocked: () => iotState.pending ? 'une action est en cours' : '',
  async read() {
    const generation = iotState.generation;
    const snapshot = await iotSnapshot();
    const series = iotState.selected && (iotState.period === 'live' || Date.now() - iotState.historyAt >= 60000)
      ? await iotSafe(iotReadSeries()) : null;
    return { ...snapshot, series, generation };
  },
  apply(answer) {
    if (answer.generation !== iotState.generation) return { warning: 'Sélection des courbes modifiée.' };
    const previousMeasures = array(iotDevice()?.measures).map(measure => measure.key);
    iotState.status = answer.status.data;
    if (!answer.devices.error) iotState.devices = array(answer.devices.data?.devices);
    if (answer.series) {
      iotState.series = answer.series.data; iotState.error = answer.series.error; iotState.historyAt = Date.now();
      iotPaint('#iotSeries', iotSeriesHtml());
    }
    iotPaint('#iotBroker', iotBroker());
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

iotRefresher.stampText = () => iotRefresher.error ? `Actualisation interrompue : ${iotRefresher.error}`
  : iotRefresher.held ? 'Actualisation en pause pendant la consultation ou une action.'
    : `Actualisé à ${new Date(iotRefresher.readAt || Date.now()).toLocaleTimeString()} · toutes les 2 s`;

async function iotSubmit(form) {
  if (iotState.pending || state.tab !== 'iot') return;
  const id = form.dataset.device;
  if (id !== iotState.selected) return;
  const fields = Object.fromEntries(new FormData(form));
  const command = form.id === 'iotCommand';
  const payload = command ? { command: fields.command, ...(fields.command === 'reboot' ? {} : { gpio: Number(fields.gpio) }) } : fields;
  if (command && (!iotState.status?.consumer?.connected || (fields.command !== 'reboot' && (!String(fields.gpio).trim() || !Number.isInteger(payload.gpio) || payload.gpio < 0 || payload.gpio > 48)))) {
    iotPaint('#iotFeedback', 'Commande refusée : vérifie la connexion et le GPIO (0 à 48).'); return;
  }
  const seq = state.renderSeq;
  iotState.pending = true;
  const submit = form.querySelector('[type="submit"]'); if (submit) submit.disabled = true;
  iotPaint('#iotFeedback', command ? 'Envoi de la commande…' : 'Enregistrement…');
  try {
    const result = await api(iotPath(id) + (command ? '/commands' : ''), { method: command ? 'POST' : 'PATCH', payload });
    if (seq !== state.renderSeq || state.tab !== 'iot' || id !== iotState.selected) return;
    if (!command) iotState.devices = iotState.devices.map(device => device.id === id ? result : device);
    iotState.feedback = command ? `Message ${fields.command} publié pour ${id}. Action matérielle non confirmée.` : 'Nom, emplacement et notes enregistrés.';
    iotPaint('#iotCards', iotCards());
  } catch (error) {
    if (seq !== state.renderSeq || state.tab !== 'iot' || id !== iotState.selected) return;
    iotState.feedback = command ? `${error.message} Aucun nouvel envoi automatique.` : error.message;
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
    const resolution = document.querySelector('#iotResolution'); if (resolution) resolution.disabled = period === 'live';
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
  if (target.id === 'iotCombinedRanges') { iotState.ranges = target.checked; iotDrawCombined(); return; }
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
  const resolution = document.querySelector('#iotResolution'); if (resolution) resolution.disabled = iotState.period === 'live';
  iotLoadSeries();
});
document.addEventListener('submit', event => {
  if (['iotRecord', 'iotCommand'].includes(event.target.id)) { event.preventDefault(); iotSubmit(event.target); }
});
