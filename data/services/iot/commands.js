'use strict';

/**
 * Commands the firmware accepts, on its exact topics:
 *   esp32/<device>/io/on   payload: a GPIO number
 *   esp32/<device>/io/off  payload: a GPIO number
 *   esp32/<device>/reboot  payload ignored by the firmware (sent empty)
 * The device only switches a GPIO configured as a digital output and answers
 * nothing: a published command is not a confirmed action.
 */

const { COMMANDS, MAX_GPIO, validateCommand } = require('../../../shared/iotDeviceRules');

/** The exact message to publish for a validated command. */
function toPublish(deviceId, { command, gpio }) {
  return {
    topic: `esp32/${deviceId}/${COMMANDS[command].suffix}`,
    payload: gpio === null ? '' : String(gpio),
    retain: false
  };
}

module.exports = { COMMANDS, MAX_GPIO, validateCommand, toPublish };
