'use strict';

// The selected device's own lines of Data's activity log, read through the
// Toolbox events relay. The log has no device filter: the tab reads the most
// recent IoT events and keeps those whose meta.deviceId is the selected device.

const IOT_EVENTS_READ = 100;
const IOT_EVENTS_SHOWN = 8;
const IOT_EVENTS_EVERY_MS = 30000;
const IOT_EVENT_NAMES = Object.freeze({
  'iot.device_first_seen': 'First seen', 'iot.device_online': 'Online', 'iot.device_offline': 'Offline',
  'iot.device_stale': 'Silent', 'iot.device_recovered': 'Back', 'iot.command_sent': 'Command sent', 'iot.command_failed': 'Command failed',
  'iot.profile_saved': 'Profile saved', 'iot.profile_assigned': 'Profile assigned', 'iot.timer_saved': 'Timers saved',
  'iot.control_published': 'Configuration published', 'iot.control_not_sent': 'Configuration not sent',
  'iot.control_uncertain': 'Delivery to check', 'iot.control_acknowledged': 'Configuration reported applied',
  'iot.control_resolved': 'Attempt checked', 'iot.control_receive_failed': 'Configuration report failed'
});
const iotEvents = { device: '', rows: null, total: 0, read: 0, error: '', at: 0, generation: 0 };

function iotEventDetail(event) {
  const meta = event.meta && typeof event.meta === 'object' ? event.meta : {};
  if (meta.requestId) return `${meta.kind === 'timer' ? `minuterie GPIO ${meta.io}` : 'profil'} · tentative ${meta.requestId}`;
  if (event.type === 'iot.profile_assigned') return meta.profileName || 'Affectation retirée';
  if (event.type === 'iot.timer_saved') return `GPIO ${meta.io} · ${meta.enabled ? 'activée' : 'désactivée'}`;
  if (String(event.type).startsWith('iot.command_')) {
    const gpio = Number.isInteger(meta.gpio) ? ` GPIO ${meta.gpio}` : '';
    return `${meta.command || 'command'}${gpio}${meta.topic ? ` → ${meta.topic}` : ''}${meta.error ? ` · ${meta.error}` : ''}`;
  }
  if (event.type === 'iot.device_stale' && Number.isFinite(meta.silentForSeconds)) return `silent for ${Math.round(meta.silentForSeconds / 60)} min`;
  if (meta.previous) return `previous state: ${iotStatusName(meta.previous).toLowerCase()}${meta.learnedFromRetained ? ' · learned from a retained message' : ''}`;
  return '';
}

function iotEventsHtml() {
  const device = iotDevice();
  if (!device) return '';
  const link = '<a href="#activity" data-iot-activity>Open the Activity tab filtered on IoT</a>';
  const head = `<div class="iot-section-title"><div><p class="iot-eyebrow">LOG</p><h3>Events for ${e(device.displayName || device.id)}</h3></div><span class="iot-section-hint">${link}</span></div>`;
  if (iotEvents.device !== device.id || (!iotEvents.rows && !iotEvents.error)) return `${head}<p class="muted" role="status">Reading the log…</p>`;
  if (iotEvents.error && !iotEvents.rows) return `${head}<p class="notice warning" role="alert">Log unavailable: ${e(iotEvents.error)}</p>`;
  const rows = iotEvents.rows.slice(0, IOT_EVENTS_SHOWN);
  const scope = `${iotEvents.read > 1 ? `Read the ${number(iotEvents.read)} most recent IoT events${iotEvents.total > iotEvents.read ? ` of ${number(iotEvents.total)}` : ''}` : iotEvents.read === 1 ? 'The log holds only one IoT event' : 'The log holds no IoT events'}; Data keeps 30 days.`;
  return `${head}${iotEvents.error ? `<p class="notice warning">Last log read failed: ${e(iotEvents.error)}</p>` : ''}
    ${rows.length ? `<ol class="card iot-events">${rows.map(event => `<li data-severity="${e(event.severity || 'info')}"><i aria-hidden="true"></i><strong>${e(Object.hasOwn(IOT_EVENT_NAMES, event.type) ? IOT_EVENT_NAMES[event.type] : event.type)}</strong>
      <span class="iot-event-detail">${e(iotEventDetail(event))}</span><time title="${e(event.message || '')}">${e(date(event.at))} <span class="muted">${e(iotAge(event.at))}</span></time></li>`).join('')}</ol>` : '<p class="iot-empty">No recent events for this device.</p>'}
    <p class="iot-legend">${iotEvents.rows.length > rows.length ? `${number(rows.length)} of ${number(iotEvents.rows.length)} shown for this device. ` : ''}${scope}</p>`;
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
