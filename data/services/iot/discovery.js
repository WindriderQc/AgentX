'use strict';

/**
 * Optional enrichment of a device from its retained Home Assistant discovery
 * message (`homeassistant/device/<device>/config`): friendly names, units and
 * device classes of its measures, and its maker, model and versions.
 *
 * The payload comes from the network: it is size-bounded before parsing, only
 * named fields are read, every text is cut and cleaned, and a component only
 * counts when its state topic is one of that same device's reading topics.
 * Nothing here is required: a device without discovery gets default units by
 * measure name.
 */

const { MAX_DISCOVERY_BYTES, parseTopic, payloadText } = require('./topics');

const MAX_COMPONENTS = 64;
const MAX_NAME_CHARS = 80;
const MAX_UNIT_CHARS = 16;
const MAX_CLASS_CHARS = 40;
const MAX_INFO_CHARS = 80;

// Used when discovery gives no unit for a measure with one of these names.
const DEFAULT_UNITS = Object.freeze({
  temperature: '°C',
  cpu_temperature: '°C',
  pressure: 'hPa',
  altitude: 'm',
  humidity: '%',
  battery_voltage: 'V',
  wifi_rssi: 'dBm'
});

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => (Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);

function text(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const clean = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

/** The first of `keys` that `object` owns: Home Assistant accepts short and long names. */
function pick(object, keys, max) {
  for (const key of keys) {
    const value = text(own(object, key), max);
    if (value !== null) return value;
  }
  return null;
}

/** `battery_voltage` -> `Battery voltage`. */
function defaultName(measure) {
  const words = measure.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : measure;
}

function defaultsFor(measure) {
  return { name: defaultName(measure), unit: own(DEFAULT_UNITS, measure) ?? null, deviceClass: null, source: 'default' };
}

function resolveTopic(component, root) {
  const topic = own(component, 'state_topic') ?? own(component, 'stat_t');
  if (typeof topic !== 'string' || topic.length > 300) return null;
  const base = own(component, '~') ?? own(root, '~');
  if (typeof base !== 'string' || base.length > 200) return topic;
  if (topic.startsWith('~')) return base + topic.slice(1);
  if (topic.endsWith('~')) return topic.slice(0, -1) + base;
  return topic;
}

/**
 * Parse a discovery payload for `device`. Returns
 * `{ info, measures: Map<measure, { name, unit, deviceClass }> }`, or null when
 * the payload is empty, too large, not a JSON object, or describes nothing.
 */
function parseDiscovery(device, payload) {
  const raw = payloadText(payload, MAX_DISCOVERY_BYTES);
  if (!raw || !raw.trim()) return null;
  let root;
  try { root = JSON.parse(raw); } catch { return null; }
  if (!isPlain(root)) return null;

  const dev = own(root, 'device') ?? own(root, 'dev');
  const origin = own(root, 'origin') ?? own(root, 'o');
  const info = {};
  if (isPlain(dev)) {
    info.name = pick(dev, ['name'], MAX_INFO_CHARS);
    info.manufacturer = pick(dev, ['manufacturer', 'mf'], MAX_INFO_CHARS);
    info.model = pick(dev, ['model', 'mdl'], MAX_INFO_CHARS);
    info.swVersion = pick(dev, ['sw_version', 'sw'], MAX_INFO_CHARS);
    info.hwVersion = pick(dev, ['hw_version', 'hw'], MAX_INFO_CHARS);
  }
  if (isPlain(origin)) {
    info.origin = pick(origin, ['name'], MAX_INFO_CHARS);
    if (!info.swVersion) info.swVersion = pick(origin, ['sw_version', 'sw'], MAX_INFO_CHARS);
  }
  for (const key of Object.keys(info)) if (info[key] === null || info[key] === undefined) delete info[key];

  const measures = new Map();
  const components = own(root, 'components') ?? own(root, 'cmps');
  if (isPlain(components)) {
    for (const key of Object.keys(components).slice(0, MAX_COMPONENTS)) {
      const component = own(components, key);
      if (!isPlain(component)) continue;
      const parsed = parseTopic(resolveTopic(component, root));
      // Only this device's own reading topics: a payload cannot describe another device.
      if (parsed.kind !== 'reading' || parsed.device !== device || measures.has(parsed.measure)) continue;
      measures.set(parsed.measure, {
        name: pick(component, ['name'], MAX_NAME_CHARS),
        unit: pick(component, ['unit_of_measurement', 'unit_of_meas'], MAX_UNIT_CHARS),
        deviceClass: pick(component, ['device_class', 'dev_cla'], MAX_CLASS_CHARS)
      });
    }
  }

  if (!Object.keys(info).length && !measures.size) return null;
  return { info, measures };
}

module.exports = { DEFAULT_UNITS, MAX_COMPONENTS, defaultsFor, defaultName, parseDiscovery };
