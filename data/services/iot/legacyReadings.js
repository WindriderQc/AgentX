'use strict';

const { payloadText } = require('./topics');

const MAX_PAYLOAD_BYTES = 8192;
// Explicit aliases keep device metadata, timestamps and output configuration
// out of telemetry. Canonical keys win when both forms occur in one message.
const ALIASES = Object.freeze({
  wifi_rssi: ['wifi'], cpu_temperature: ['CPUtemp', 'cpu_temp_c'],
  free_heap: ['heap'], cpu_frequency: ['CPUFreq'], battery_voltage: ['battery'],
  temperature: ['tempBM_280', 'bmx_temp_c'], humidity: ['airHumid'],
  dht_temperature: ['tempDht'], pressure: [], altitude: [], co2: [], smoke: [],
  lpg: [], lux: [], visible: [], ir: [], full: [], soil1: [], soil2: [], soil3: [], soil4: []
});
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Bounded legacy JSON telemetry, or null for malformed/mismatched messages. */
function parseLegacyReadings(device, payload) {
  const raw = payloadText(payload, MAX_PAYLOAD_BYTES);
  if (raw === null) return null;
  let root;
  try { root = JSON.parse(raw); } catch { return null; }
  if (!object(root) || (own(root, 'sender') && root.sender !== device)) return null;
  const values = object(root.payload) ? root.payload : root;
  if (own(values, 'sender') && values.sender !== device) return null;
  const readings = new Map();
  for (const [key, aliases] of Object.entries(ALIASES)) {
    for (const alias of [key, ...aliases]) {
      if (!own(values, alias)) continue;
      const value = values[alias];
      if (typeof value === 'number' && Number.isFinite(value)) readings.set(key, value);
      break;
    }
  }
  return readings;
}

module.exports = { MAX_PAYLOAD_BYTES, parseLegacyReadings };
