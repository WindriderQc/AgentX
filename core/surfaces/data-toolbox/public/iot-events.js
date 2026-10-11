'use strict';

// The selected device's own lines of Data's activity log, read through the
// Toolbox events relay. The log has no device filter: the tab reads the most
// recent IoT events and keeps those whose meta.deviceId is the selected device.

const IOT_EVENTS_READ = 100;
const IOT_EVENTS_SHOWN = 8;
const IOT_EVENTS_EVERY_MS = 30000;
const IOT_EVENT_NAMES = Object.freeze({
  'iot.device_first_seen': 'Vu pour la première fois', 'iot.device_online': 'En ligne', 'iot.device_offline': 'Hors ligne',
  'iot.device_stale': 'Silencieux', 'iot.device_recovered': 'De retour', 'iot.command_sent': 'Commande envoyée', 'iot.command_failed': 'Commande échouée'
});
const iotEvents = { device: '', rows: null, total: 0, read: 0, error: '', at: 0, generation: 0 };

function iotEventDetail(event) {
  const meta = event.meta && typeof event.meta === 'object' ? event.meta : {};
  if (String(event.type).startsWith('iot.command_')) {
    const gpio = Number.isInteger(meta.gpio) ? ` GPIO ${meta.gpio}` : '';
    return `${meta.command || 'commande'}${gpio}${meta.topic ? ` → ${meta.topic}` : ''}${meta.error ? ` · ${meta.error}` : ''}`;
  }
  if (event.type === 'iot.device_stale' && Number.isFinite(meta.silentForSeconds)) return `silencieux depuis ${Math.round(meta.silentForSeconds / 60)} min`;
  if (meta.previous) return `état précédent : ${iotStatusName(meta.previous).toLowerCase()}${meta.learnedFromRetained ? ' · appris d’un message retenu' : ''}`;
  return '';
}

function iotEventsHtml() {
  const device = iotDevice();
  if (!device) return '';
  const link = '<a href="#activity" data-iot-activity>Ouvrir l’onglet Activity filtré sur l’IoT</a>';
  const head = `<div class="iot-section-title"><div><p class="iot-eyebrow">JOURNAL</p><h3>Événements de ${e(device.displayName || device.id)}</h3></div><span class="iot-section-hint">${link}</span></div>`;
  if (iotEvents.device !== device.id || (!iotEvents.rows && !iotEvents.error)) return `${head}<p class="muted" role="status">Lecture du journal…</p>`;
  if (iotEvents.error && !iotEvents.rows) return `${head}<p class="notice warning" role="alert">Journal indisponible : ${e(iotEvents.error)}</p>`;
  const rows = iotEvents.rows.slice(0, IOT_EVENTS_SHOWN);
  const scope = `${iotEvents.read > 1 ? `Lecture des ${number(iotEvents.read)} événements IoT les plus récents${iotEvents.total > iotEvents.read ? ` sur ${number(iotEvents.total)}` : ''}` : iotEvents.read === 1 ? 'Le journal ne contient qu’un événement IoT' : 'Le journal ne contient aucun événement IoT'} ; Data garde 30 jours.`;
  return `${head}${iotEvents.error ? `<p class="notice warning">Dernière lecture du journal échouée : ${e(iotEvents.error)}</p>` : ''}
    ${rows.length ? `<ol class="card iot-events">${rows.map(event => `<li data-severity="${e(event.severity || 'info')}"><i aria-hidden="true"></i><strong>${e(Object.hasOwn(IOT_EVENT_NAMES, event.type) ? IOT_EVENT_NAMES[event.type] : event.type)}</strong>
      <span class="iot-event-detail">${e(iotEventDetail(event))}</span><time title="${e(event.message || '')}">${e(date(event.at))} <span class="muted">${e(iotAge(event.at))}</span></time></li>`).join('')}</ol>` : '<p class="iot-empty">Aucun événement récent pour cet appareil.</p>'}
    <p class="iot-legend">${iotEvents.rows.length > rows.length ? `${number(rows.length)} affichés sur ${number(iotEvents.rows.length)} pour cet appareil. ` : ''}${scope}</p>`;
}

async function iotReadEvents(id) {
  const data = await api(`/events?${new URLSearchParams({ type: 'iot.', limit: String(IOT_EVENTS_READ) })}`);
  const events = array(data?.events);
  return { rows: events.filter(event => event?.meta?.deviceId === id), read: events.length, total: Number(data?.pagination?.total) || events.length };
}

function iotApplyEvents(id, result) {
  if (id !== iotState.selected) return;
  Object.assign(iotEvents, { device: id, at: Date.now(), error: result.error || '', ...(result.data || (iotEvents.device === id ? {} : { rows: null })) });
}

/** Reads the journal of the selected device now and paints it; an older answer is dropped. */
async function iotLoadEvents(keep = false) {
  const id = iotState.selected; const generation = ++iotEvents.generation; const seq = state.renderSeq;
  if (!id) return;
  if (!keep || iotEvents.device !== id) { Object.assign(iotEvents, { device: id, rows: null, error: '' }); iotPaint('#iotEvents', iotEventsHtml()); }
  const result = await iotSafe(iotReadEvents(id));
  if (generation !== iotEvents.generation || seq !== state.renderSeq || state.tab !== 'iot') return;
  iotApplyEvents(id, result);
  iotPaint('#iotEvents', iotEventsHtml());
}

document.addEventListener('click', event => {
  if (state.tab !== 'iot' || !event.target.closest('[data-iot-activity]')) return;
  // The Activity tab keeps its filters in memory: set the family before the hash changes.
  if (typeof activityState === 'object') Object.assign(activityState, { family: 'iot', severity: '', windowKey: 'all', page: 1 });
});
