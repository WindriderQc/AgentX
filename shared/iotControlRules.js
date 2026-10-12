'use strict';

// MQTT and HTTP wire contract: data/README.md, "Profiles and daily output timers".
const { isDeviceId, MAX_GPIO } = require('./iotDeviceRules');
const MAX_CONFIG_BYTES = 3800;
const MAX_PINS = 32;
const MODES = Object.freeze(['IN', 'OUT', 'INPULL', 'INPULLD']);
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a JSON object');
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`Unknown field: ${key.slice(0, 40)}`);
  return value;
}
function text(value, field, limit, empty = false) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) || value.length > limit || (!empty && !value.trim())) fail(`Invalid ${field}`);
  return value.trim();
}
function profileName(value) { return text(value, 'profileName', 64); }
function gpio(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_GPIO) fail(`io must be an integer from 0 to ${MAX_GPIO}`);
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('revision must be a non-negative integer');
  return value;
}
function config(value) {
  if (!Array.isArray(value) || value.length > MAX_PINS) fail(`config must be a list of at most ${MAX_PINS} pins`);
  const seen = new Set();
  const pins = value.map(pin => {
    object(pin, ['io', 'mode', 'lbl', 'isA', 'name']);
    const io = gpio(pin.io);
    if (seen.has(io)) fail('A GPIO cannot occur twice');
    seen.add(io);
    if (!MODES.includes(pin.mode)) fail('Invalid pin mode');
    if (typeof pin.isA !== 'boolean') fail('isA must be a boolean');
    if (pin.isA && pin.mode !== 'IN') fail('Analog pins must be inputs');
    return { io, mode: pin.mode, lbl: text(pin.lbl, 'lbl', 64, true), isA: pin.isA, name: text(pin.name, 'name', 64, true) };
  }).sort((a, b) => a.io - b.io);
  if (Buffer.byteLength(JSON.stringify(pins), 'utf8') > MAX_CONFIG_BYTES) fail('Configuration exceeds the MQTT payload limit');
  return pins;
}
function time(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)) fail('Time must be HH:mm:ss');
  return value;
}
function timer(value) {
  object(value, ['io', 'tStart', 'tStop', 'enabled']);
  if (typeof value.enabled !== 'boolean') fail('enabled must be a boolean');
  const result = { io: gpio(value.io), tStart: time(value.tStart), tStop: time(value.tStop), enabled: value.enabled };
  if (result.tStart === result.tStop) fail('Start and stop times must differ');
  return result;
}
function validateProfile(body) { object(body, ['revision', 'config']); return { revision: revision(body.revision), config: config(body.config) }; }
function validateAssignment(body) {
  object(body, ['revision', 'profileName', 'profileRevision']);
  return { revision: revision(body.revision), profileName: body.profileName === null ? null : profileName(body.profileName), profileRevision: revision(body.profileRevision) };
}
function validateTimer(body) {
  object(body, ['revision', 'io', 'tStart', 'tStop', 'enabled']);
  const { revision: version, ...schedule } = body;
  return { revision: revision(version), ...timer(schedule) };
}
function validateApply(body, profile = false) {
  object(body, ['requestId', 'revision', ...(profile ? ['restoreOnBoot'] : [])]);
  if (typeof body.requestId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.requestId)) fail('requestId must be a UUID');
  if (profile && typeof body.restoreOnBoot !== 'boolean') fail('restoreOnBoot must be a boolean');
  return { requestId: body.requestId.toLowerCase(), revision: revision(body.revision), ...(profile ? { restoreOnBoot: body.restoreOnBoot } : {}) };
}
function timerMessages(id, schedule) {
  if (!isDeviceId(id)) fail('Invalid device id');
  const row = timer(schedule);
  const message = (suffix, payload) => ({ topic: `esp32/${id}/${suffix}`, payload, retain: false });
  return row.enabled ? [message('io/sunrise', `${row.io}:${row.tStart}`), message('io/nightfall', `${row.io}:${row.tStop}`)]
    : [message('io/timer/disable', String(row.io))];
}
function parseState(payload) {
  if (!payload || payload.length > 8192) fail('Invalid control state size');
  let state;
  try { state = JSON.parse(payload.toString('utf8')); } catch { fail('Invalid control state JSON'); }
  object(state, ['version', 'bootId', 'serial', 'config', 'timers', 'outputs', 'clockValid', 'timezone', 'localTime', 'lastError']);
  if (state.version !== 1 || typeof state.clockValid !== 'boolean' || typeof state.bootId !== 'string' || !/^[a-f0-9]{8,32}$/i.test(state.bootId)) fail('Invalid control state version or boot identity');
  if (!Array.isArray(state.timers) || state.timers.length > MAX_PINS || !Array.isArray(state.outputs) || state.outputs.length > MAX_PINS) fail('Invalid control state lists');
  const pins = config(state.config);
  const known = new Map(pins.map(pin => [pin.io, pin]));
  const schedules = new Set(); const outputs = new Set();
  return { version: 1, bootId: state.bootId, serial: revision(state.serial), config: pins, clockValid: state.clockValid,
    lastError: state.lastError === null ? null : text(state.lastError, 'lastError', 180, true),
    timezone: text(state.timezone, 'timezone', 80, true), localTime: text(state.localTime, 'localTime', 32, true),
    timers: state.timers.map(row => {
      object(row, ['io', 'tStart', 'tStop', 'enabled', 'nextStart']);
      const { nextStart, ...fields } = row; const result = timer(fields);
      if (schedules.has(result.io)) fail('Duplicate timer'); schedules.add(result.io);
      if (nextStart !== null && (typeof nextStart !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(nextStart) || !Number.isFinite(Date.parse(nextStart)))) fail('Invalid next start');
      return { ...result, nextStart };
    }),
    outputs: state.outputs.map(row => {
      object(row, ['io', 'active', 'available', 'inverted']); const io = gpio(row.io);
      if (outputs.has(io) || known.get(io)?.mode !== 'OUT' || known.get(io)?.isA || ['active', 'available', 'inverted'].some(field => typeof row[field] !== 'boolean')) fail('Invalid output state');
      outputs.add(io); return { io, active: row.active, available: row.available, inverted: row.inverted };
    }) };
}

module.exports = { MAX_CONFIG_BYTES, MAX_PINS, MODES, fail, object, profileName, gpio, revision, config, time, timer,
  validateProfile, validateAssignment, validateTimer, validateApply, timerMessages, parseState };
