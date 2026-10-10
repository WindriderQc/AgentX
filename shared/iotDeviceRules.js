'use strict';

// Wire rules shared by Data (the owner) and Core's browser relay.
const OWNER_FIELDS = Object.freeze({ displayName: 80, location: 80, notes: 1000 });
const COMMANDS = Object.freeze({
  io_on: { suffix: 'io/on', gpio: true },
  io_off: { suffix: 'io/off', gpio: true },
  reboot: { suffix: 'reboot', gpio: false }
});
const MAX_GPIO = 48;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const isDeviceId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) && !RESERVED.has(value);
function refuse(message) { return Object.assign(new Error(message), { statusCode: 400 }); }

function validateCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse('Expected a JSON object with command and, for io_on and io_off, gpio');
  const unknown = Object.keys(body).filter(key => key !== 'command' && key !== 'gpio');
  if (unknown.length) throw refuse(`Unknown field: ${unknown.slice(0, 5).map(key => key.slice(0, 40)).join(', ')}`);
  const { command, gpio } = body;
  if (typeof command !== 'string' || !Object.prototype.hasOwnProperty.call(COMMANDS, command)) throw refuse(`command must be one of: ${Object.keys(COMMANDS).join(', ')}`);
  if (!COMMANDS[command].gpio) {
    if (gpio !== undefined) throw refuse(`${command} takes no gpio`);
    return { command, gpio: null };
  }
  if (!Number.isInteger(gpio) || gpio < 0 || gpio > MAX_GPIO) throw refuse(`gpio must be an integer from 0 to ${MAX_GPIO}`);
  return { command, gpio };
}

function validatePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse('Expected a JSON object with displayName, location or notes');
  const keys = Object.keys(body);
  const unknown = keys.filter(key => !Object.prototype.hasOwnProperty.call(OWNER_FIELDS, key));
  if (unknown.length) throw refuse(`Unknown field: ${unknown.slice(0, 5).map(key => key.slice(0, 40)).join(', ')}`);
  if (!keys.length) throw refuse('Nothing to change: give displayName, location or notes');
  const changes = {};
  for (const key of keys) {
    const value = body[key];
    if (value === null) { changes[key] = null; continue; }
    if (typeof value !== 'string') throw refuse(`${key} must be a string or null`);
    const clean = (key === 'notes' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') : value.replace(/[\u0000-\u001f\u007f]+/g, ' ')).trim();
    if (clean.length > OWNER_FIELDS[key]) throw refuse(`${key} must be at most ${OWNER_FIELDS[key]} characters`);
    changes[key] = clean || null;
  }
  return changes;
}

module.exports = { OWNER_FIELDS, COMMANDS, MAX_GPIO, isDeviceId, validateCommand, validatePatch };
