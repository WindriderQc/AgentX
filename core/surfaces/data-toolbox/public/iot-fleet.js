'use strict';

// Fleet-level pieces of the IoT tab: the Wi-Fi signal gauge and model line of a
// device card, the "Enregistré / dernière activité" table, the consumer status
// card and the note about what the former pages offered and is not back yet.
// Read-only: everything here is drawn from /iot/devices and /iot/status.

// RSSI bands in dBm, strongest first. The arc spans the same -100…-40 dBm as
// the former gauge; a value outside it stays exact in the text and pins the needle.
const IOT_SIGNAL_RANGE = Object.freeze({ min: -100, max: -40 });
const IOT_SIGNAL_LEVELS = Object.freeze([
  { id: 'excellent', word: 'Excellent', from: -55, color: '#59dbe8' },
  { id: 'bon', word: 'Bon', from: -70, color: '#62dbac' },
  { id: 'moyen', word: 'Moyen', from: -80, color: '#f4cf75' },
  { id: 'faible', word: 'Faible', from: -Infinity, color: '#ff8f8f' }
]);
const IOT_SIGNAL_LEGEND = 'Excellent : −55 dBm ou mieux · Bon : de −70 à −56 dBm · Moyen : de −80 à −71 dBm · Faible : sous −80 dBm';

function iotSignalQuality(dbm) {
  if (typeof dbm !== 'number' || !Number.isFinite(dbm)) return { id: 'inconnu', word: 'Inconnu', color: '#8198ab' };
  return IOT_SIGNAL_LEVELS.find(level => dbm >= level.from);
}

function iotSignalPoint(dbm, radius) {
  const { min, max } = IOT_SIGNAL_RANGE;
  const share = (Math.max(min, Math.min(max, dbm)) - min) / (max - min);
  const angle = Math.PI * (1 - share);
  return `${(40 + radius * Math.cos(angle)).toFixed(2)} ${(42 - radius * Math.sin(angle)).toFixed(2)}`;
}

/** A half-circle gauge as inline SVG. The words beside it carry the same reading as text. */
function iotSignalGauge(dbm) {
  const quality = iotSignalQuality(dbm);
  const known = quality.id !== 'inconnu';
  const edges = [IOT_SIGNAL_RANGE.max, ...IOT_SIGNAL_LEVELS.slice(0, -1).map(level => level.from), IOT_SIGNAL_RANGE.min];
  const arcs = IOT_SIGNAL_LEVELS.map((level, index) => {
    // A half-degree gap keeps the four bands distinct without a border.
    const high = edges[index] - (index ? .5 : 0); const low = edges[index + 1] + .5;
    return `<path d="M${iotSignalPoint(low, 34)}A34 34 0 0 1 ${iotSignalPoint(high, 34)}" stroke="${level.color}" opacity="${level.id === quality.id ? 1 : .4}"/>`;
  }).join('');
  const label = known ? `Signal Wi-Fi ${iotValue(dbm)} dBm : ${quality.word}` : 'Signal Wi-Fi inconnu';
  return `<svg class="iot-gauge" viewBox="0 0 80 48" role="img" aria-label="${e(label)}"><title>${e(label)}. ${e(IOT_SIGNAL_LEGEND)}</title>
    <g fill="none" stroke-width="6">${arcs}</g>${known ? `<path d="M40 42L${iotSignalPoint(dbm, 25)}" stroke="${quality.color}" stroke-width="2.4" stroke-linecap="round"/>` : ''}<circle cx="40" cy="42" r="3.4" fill="${quality.color}"/></svg>`;
}

/** The Wi-Fi tile of a device card: gauge, exact dBm, quality word and age. */
function iotSignalTile(measure, visual) {
  const quality = iotSignalQuality(measure.value);
  return `<div class="iot-measure iot-signal" data-tone="${visual.tone}" data-quality="${quality.id}" title="${e(IOT_SIGNAL_LEGEND)}"><span class="iot-measure-label">${iotIcon(visual.icon)}${e(visual.label)}</span>
    <div class="iot-signal-body">${iotSignalGauge(measure.value)}<div><strong>${e(iotValue(measure.value))}<small> dBm</small></strong><em style="color:${quality.color}">${quality.word}</em></div></div>
    <small title="${e(date(measure.at))}">${e(iotAge(measure.at))}</small></div>`;
}

const iotIsSignal = measure => measure.key === 'wifi_rssi' && (!measure.unit || String(measure.unit).trim().toLowerCase() === 'dbm');

/** Maker, model and versions, only the ones the registry holds. */
function iotModelLine(device) {
  const info = device.info || {};
  const text = value => typeof value === 'string' && value.trim() ? value.trim() : '';
  const parts = [text(info.manufacturer), text(info.model),
    text(info.swVersion) && `micrologiciel ${text(info.swVersion)}`, text(info.hwVersion) && `matériel ${text(info.hwVersion)}`].filter(Boolean);
  return parts.length ? `<span class="iot-model" title="Fabricant, modèle et versions annoncés par l’appareil">${e(parts.join(' · '))}</span>` : '';
}

const iotMoment = at => {
  const known = at && Number.isFinite(new Date(at).getTime());
  return known ? `${e(date(at))} <span class="muted">${e(iotAge(at))}</span>` : '<span class="muted">jamais</span>';
};

/** Every device Data knows, with when it first spoke, when it last spoke and since when its state holds. */
function iotRegistryHtml() {
  if (!iotState.devices.length) return '';
  const since = device => {
    const state = device.status === 'stale' ? { name: 'Silencieux', at: device.staleSince } : { name: iotStatusName(device.availability?.state), at: device.availability?.since };
    return state.at && Number.isFinite(new Date(state.at).getTime()) ? `${e(state.name)} depuis ${e(date(state.at))}` : '<span class="muted">non annoncée</span>';
  };
  return `<div class="iot-section-title"><div><p class="iot-eyebrow">REGISTRE</p><h3>Enregistré / dernière activité</h3></div><span class="iot-section-hint">Tous les appareils connus de Data.</span></div>
    <div class="table-wrap iot-registry" tabindex="0" role="region" aria-label="Appareils enregistrés et dernière activité"><table><thead><tr><th scope="col">Appareil</th><th scope="col">Identifiant</th><th scope="col">État</th><th scope="col">Enregistré</th><th scope="col">Dernière activité</th><th scope="col">Disponibilité</th></tr></thead>
    <tbody>${iotState.devices.map(device => `<tr${device.id === iotState.selected ? ' class="selected"' : ''}><th scope="row">${e(device.displayName || device.info?.name || device.id)}</th><td class="mono">${e(device.id)}</td><td>${iotBadge(device.status)}</td>
      <td>${iotMoment(device.firstSeenAt)}</td><td>${iotMoment(device.lastSeenAt)}</td><td>${since(device)}</td></tr>`).join('')}</tbody></table></div>
    <p class="iot-legend">« Enregistré » est le premier message reçu par Data. Signal Wi-Fi — ${e(IOT_SIGNAL_LEGEND)}.</p>`;
}

const IOT_REFUSALS = Object.freeze({ not_numeric: 'valeur non numérique', topic_too_long: 'sujet trop long', topic_shape: 'forme du sujet',
  device_name: 'nom d’appareil invalide', measure_name: 'nom de mesure invalide', device_limit: 'limite d’appareils atteinte',
  measure_limit: 'limite de mesures atteinte', availability_value: 'disponibilité invalide', retained_reading: 'mesure retenue par le broker',
  discovery_payload: 'annonce de découverte invalide', legacy_payload: 'ancien format illisible', late: 'mesure trop ancienne' });

/** What Data's MQTT consumer says about itself, from GET /iot/status. */
function iotConsumerHtml() {
  const status = iotState.status;
  if (!status) return '<section class="card iot-consumer"><h3>État du consommateur MQTT</h3><p class="notice warning">Data n’a pas répondu sur son état. Rien n’est affiché plutôt qu’une valeur devinée.</p></section>';
  const consumer = status.consumer || {}; const readings = status.readings || {}; const buckets = status.buckets || {};
  const devices = status.devices || {}; const rollup = status.rollup || {}; const settings = status.settings || {};
  const count = value => Number.isFinite(value) ? number(value) : '—';
  const link = consumer.connected ? 'Connecté' : consumer.configured ? 'Déconnecté' : 'Non configuré';
  const reasons = Object.entries(readings.refusedByReason || {}).filter(([, total]) => total > 0)
    .map(([reason, total]) => `${e(Object.hasOwn(IOT_REFUSALS, reason) ? IOT_REFUSALS[reason] : reason)} : ${count(total)}`).join(' · ');
  const states = [['online', 'en ligne'], ['stale', 'silencieux'], ['offline', 'hors ligne'], ['unknown', 'état inconnu']]
    .filter(([key]) => devices[key] > 0).map(([key, name]) => `${count(devices[key])} ${name}`).join(' · ');
  const cell = (name, value, detail = '') => `<div><dt>${name}</dt><dd>${value}</dd>${detail ? `<small>${detail}</small>` : ''}</div>`;
  return `<section class="card iot-consumer" aria-label="État du consommateur MQTT de Data"><h3>État du consommateur MQTT</h3><dl>
    ${cell('Lien broker', `<span class="iot-connection${consumer.connected ? ' connected' : ''}"><i aria-hidden="true"></i>${link}</span>`, consumer.broker ? `${e(consumer.broker)}${consumer.startedAt ? ` · démarré ${e(iotAge(consumer.startedAt))}` : ''}` : '')}
    ${cell('Appareils suivis', `${count(devices.tracked)}${Number.isFinite(devices.limit) ? ` <span class="muted">/ ${count(devices.limit)}</span>` : ''}`, states)}
    ${cell('Mesures reçues', count(readings.accepted), readings.lastAt ? `dernière ${e(iotAge(readings.lastAt))}` : '')}
    ${cell('Mesures refusées', count(readings.refused), reasons || (readings.refused > 0 ? 'raisons non détaillées' : 'aucun refus'))}
    ${cell('Dernière minute écrite', buckets.lastWriteAt ? e(date(buckets.lastWriteAt)) : '—', `${count(buckets.written)} tranches écrites${buckets.pendingRetry > 0 ? ` · ${count(buckets.pendingRetry)} en attente` : ''}${buckets.dropped > 0 ? ` · ${count(buckets.dropped)} perdues` : ''}${buckets.lastError ? ` · erreur : ${e(String(buckets.lastError).slice(0, 160))}` : ''}`)}
    ${cell('Dernier regroupement horaire', rollup.lastRunAt ? e(date(rollup.lastRunAt)) : '—', rollup.through ? `heures closes jusqu’à ${e(date(rollup.through))}` : '')}
    ${cell('Rétention des minutes', Number.isFinite(settings.minuteRetentionDays) ? `${count(settings.minuteRetentionDays)} jours` : '—', 'les tranches horaires sont gardées sans limite')}
    </dl></section>`;
}

/** What the former IoT pages offered and has no backend today. Text only: no control. */
function iotMissingHtml() {
  return `<details class="card iot-missing"><summary>Pas encore revenu des anciennes pages</summary><ul>
    <li><strong>Caméras</strong> — côté serveur : Data ne reçoit, ne conserve et ne relaie aucune image ni aucun flux.</li>
    </ul></details>`;
}
