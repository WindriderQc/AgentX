'use strict';

/**
 * The IoT facts written to Data's activity log: transitions only. The last
 * state reported for each device is kept in `activity_state` (key
 * `iot_device:<id>`: unknown, online, offline or stale), so a restart, or the
 * broker replaying its retained messages, reports nothing twice. None of
 * these functions throws.
 */

const { log } = require('../../utils/logger');
const activityLog = require('../activityLog');

const keyOf = (id) => `iot_device:${id}`;
const labelOf = (device) => (device.displayName ? `${device.displayName} (${device.id})` : device.id);
const metaOf = (device) => ({ deviceId: device.id, displayName: device.displayName || null, location: device.location || null });

async function safely(what, work) {
  try { return await work(); }
  catch (error) { log(`[iot activity] ${what} failed: ${error.message}`, 'warn'); return null; }
}

function firstSeen(db, device, now = new Date()) {
  return safely('first seen', async () => {
    // Only a device without any recorded state is new: the insert tells.
    const result = await db.collection(activityLog.STATE).updateOne(
      { _id: keyOf(device.id) },
      { $setOnInsert: { state: 'unknown', since: now } },
      { upsert: true }
    );
    if (!result?.upsertedCount) return null;
    return activityLog.record(db, {
      type: 'iot.device_first_seen',
      message: `IoT device ${labelOf(device)} was seen for the first time.`,
      meta: metaOf(device)
    });
  });
}

/**
 * The availability topic moved to `state`. `retained` means the broker
 * replayed the state it holds: for a device without a reported state that is
 * how things were found, not a change.
 */
function availability(db, device, state, { retained = false } = {}) {
  return safely('availability', async () => {
    const previous = await activityLog.setState(db, keyOf(device.id), state);
    if (previous === state) return null;
    if (retained && (previous === null || previous === 'unknown')) return null;
    const meta = { ...metaOf(device), previous: previous || 'unknown', learnedFromRetained: retained };
    if (state === 'offline') {
      return activityLog.record(db, {
        type: 'iot.device_offline',
        severity: 'warning',
        message: `IoT device ${labelOf(device)} went offline.`,
        meta
      });
    }
    if (previous === 'stale') {
      return activityLog.record(db, {
        type: 'iot.device_recovered',
        message: `IoT device ${labelOf(device)} is reporting again.`,
        meta
      });
    }
    return activityLog.record(db, {
      type: 'iot.device_online',
      message: `IoT device ${labelOf(device)} came online.`,
      meta
    });
  });
}

function stale(db, device, { silentForMs = 0 } = {}) {
  return safely('staleness', async () => {
    const previous = await activityLog.setState(db, keyOf(device.id), 'stale');
    if (previous === 'stale') return null;
    return activityLog.record(db, {
      type: 'iot.device_stale',
      severity: 'warning',
      message: `IoT device ${labelOf(device)} has been silent for ${Math.round(silentForMs / 60000)} minutes without an offline message.`,
      meta: { ...metaOf(device), lastSeenAt: device.lastSeenAt || null, silentForSeconds: Math.round(silentForMs / 1000) }
    });
  });
}

function recovered(db, device) {
  return safely('recovery', async () => {
    const state = device.availability.state === 'online' ? 'online' : 'unknown';
    const previous = await activityLog.setState(db, keyOf(device.id), state);
    if (previous !== 'stale') return null;
    return activityLog.record(db, {
      type: 'iot.device_recovered',
      message: `IoT device ${labelOf(device)} is reporting again.`,
      meta: metaOf(device)
    });
  });
}

/** One event per command: sent, or refused by the broker link. Never the payload beyond the GPIO number. */
function command(db, device, { command: name, gpio = null, topic, error = null }) {
  return safely('command', () => activityLog.record(db, {
    type: error ? 'iot.command_failed' : 'iot.command_sent',
    severity: error ? 'warning' : 'info',
    message: error
      ? `Command ${name}${gpio === null ? '' : ` (GPIO ${gpio})`} to IoT device ${labelOf(device)} was not sent: ${error}`
      : `Command ${name}${gpio === null ? '' : ` (GPIO ${gpio})`} was sent to IoT device ${labelOf(device)}.`,
    meta: { ...metaOf(device), command: name, gpio, topic, error }
  }));
}

module.exports = { keyOf, firstSeen, availability, stale, recovered, command };
