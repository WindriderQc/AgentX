'use strict';

/**
 * Commands the firmware accepts, on its exact topics:
 *   esp32/<device>/io/on   payload: a GPIO number
 *   esp32/<device>/io/off  payload: a GPIO number
 *   esp32/<device>/reboot  payload ignored by the firmware (sent empty)
 * The device only switches a GPIO configured as a digital output and answers
 * nothing: a published command is not a confirmed action.
 */

const COMMANDS = Object.freeze({
  io_on: { suffix: 'io/on', gpio: true },
  io_off: { suffix: 'io/off', gpio: true },
  reboot: { suffix: 'reboot', gpio: false }
});
const MAX_GPIO = 48; // highest GPIO number of any ESP32 variant

function refuse(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/** Validate a command body. Returns `{ command, gpio }` (gpio null for reboot) or throws statusCode 400. */
function validateCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse('Expected a JSON object with command and, for io_on and io_off, gpio');
  const unknown = Object.keys(body).filter((key) => key !== 'command' && key !== 'gpio');
  if (unknown.length) throw refuse(`Unknown field: ${unknown.slice(0, 5).map((key) => key.slice(0, 40)).join(', ')}`);
  const { command, gpio } = body;
  if (typeof command !== 'string' || !Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
    throw refuse(`command must be one of: ${Object.keys(COMMANDS).join(', ')}`);
  }
  if (!COMMANDS[command].gpio) {
    if (gpio !== undefined) throw refuse(`${command} takes no gpio`);
    return { command, gpio: null };
  }
  if (!Number.isInteger(gpio) || gpio < 0 || gpio > MAX_GPIO) throw refuse(`gpio must be an integer from 0 to ${MAX_GPIO}`);
  return { command, gpio };
}

/** The exact message to publish for a validated command. */
function toPublish(deviceId, { command, gpio }) {
  return {
    topic: `esp32/${deviceId}/${COMMANDS[command].suffix}`,
    payload: gpio === null ? '' : String(gpio),
    retain: false
  };
}

module.exports = { COMMANDS, MAX_GPIO, validateCommand, toPublish };
