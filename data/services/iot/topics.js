'use strict';

/**
 * What an MQTT message means to the IoT store. Pure functions: no connection,
 * no database.
 *
 * The contract for readings is `sensors/<device>/<measure>` with a plain
 * numeric payload, and `sensors/<device>/availability` with `online` or
 * `offline`. Legacy JSON telemetry is parsed separately, and Home
 * Assistant discovery is optional enrichment. No list of measures is kept
 * here: a new measure or a new device needs no change.
 */

const MAX_TOPIC_BYTES = 200;
const MAX_NUMERIC_BYTES = 32;
const MAX_DISCOVERY_BYTES = 32 * 1024;
const { isDeviceId } = require('../../../shared/iotDeviceRules');
const MEASURE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d{1,3})?$/;
// Names an object key must never take, whatever the pattern allows.
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

const isMeasure = (value) => typeof value === 'string' && MEASURE.test(value) && !RESERVED.has(value);

const refused = (reason) => ({ kind: 'refused', reason });
const IGNORED = Object.freeze({ kind: 'ignored' });

/**
 * Classify a topic:
 *   reading       sensors/<device>/<measure>
 *   availability  sensors/<device>/availability
 *   seen          esp32/alive/<device>, esp32/data/<device> (legacy JSON)
 *   announce      esp32/register, esp32/config (the payload is the device id)
 *   discovery     homeassistant/device/<device>/config
 *   ignored       a topic that is none of the IoT store's business
 *   refused       a topic in a namespace above that does not have its shape
 */
function parseTopic(topic) {
  if (typeof topic !== 'string' || !topic.length) return IGNORED;
  const [root] = topic.split('/', 1);
  if (root !== 'sensors' && root !== 'esp32' && root !== 'homeassistant') return IGNORED;
  if (Buffer.byteLength(topic, 'utf8') > MAX_TOPIC_BYTES) return refused('topic_too_long');
  const levels = topic.split('/');

  if (root === 'sensors') {
    if (levels.length !== 3) return refused('topic_shape');
    if (!isDeviceId(levels[1])) return refused('device_name');
    if (levels[2] === 'availability') return { kind: 'availability', device: levels[1] };
    if (!isMeasure(levels[2])) return refused('measure_name');
    return { kind: 'reading', device: levels[1], measure: levels[2] };
  }

  if (root === 'esp32') {
    if (levels.length === 2 && (levels[1] === 'register' || levels[1] === 'config')) {
      return { kind: 'announce', what: levels[1] };
    }
    if (levels.length === 3 && (levels[1] === 'alive' || levels[1] === 'data')) {
      if (!isDeviceId(levels[2])) return refused('device_name');
      return { kind: 'seen', device: levels[2], what: levels[1] };
    }
    // esp32/<device>/... are commands sent to a device, not the device talking.
    return IGNORED;
  }

  if (levels.length === 4 && levels[1] === 'device' && levels[3] === 'config') {
    if (!isDeviceId(levels[2])) return refused('device_name');
    return { kind: 'discovery', device: levels[2] };
  }
  return IGNORED;
}

function payloadText(payload, maxBytes) {
  if (Buffer.isBuffer(payload)) return payload.length > maxBytes ? null : payload.toString('utf8');
  if (typeof payload !== 'string') return null;
  return Buffer.byteLength(payload, 'utf8') > maxBytes ? null : payload;
}

/** The finite number a reading payload holds, or null: no JSON, no NaN, no hex, no text. */
function parseNumeric(payload) {
  const text = payloadText(payload, MAX_NUMERIC_BYTES);
  if (text === null) return null;
  const trimmed = text.trim();
  if (!NUMERIC.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** `online`, `offline`, or null for anything else. */
function parseAvailability(payload) {
  const text = payloadText(payload, 16);
  if (text === null) return null;
  const state = text.trim().toLowerCase();
  return state === 'online' || state === 'offline' ? state : null;
}

/** The device id carried as the whole payload of esp32/register and esp32/config. */
function parseAnnouncedDevice(payload) {
  const text = payloadText(payload, 80);
  if (text === null) return null;
  const id = text.trim();
  return isDeviceId(id) ? id : null;
}

module.exports = {
  MAX_TOPIC_BYTES,
  MAX_NUMERIC_BYTES,
  MAX_DISCOVERY_BYTES,
  isDeviceId,
  isMeasure,
  parseTopic,
  parseNumeric,
  parseAvailability,
  parseAnnouncedDevice,
  payloadText
};
