'use strict';

/**
 * Raises one `network_new_device` alert per unknown device that joins the LAN.
 *
 * The native network collector feeds Data; Core polls the Data inventory and
 * keeps its own record of observed MACs (NetworkDeviceWatch). The first run
 * records the current inventory as the baseline without alerting. Later, a
 * MAC Core has never observed, with no alias and not marked known, emits one
 * event to the alert engine; the `network-new-device` rule decides delivery.
 * Devices without a MAC cannot be followed reliably and are ignored.
 *
 * The alert carries a guess of what the device is, written by the `ops_watch`
 * task's model from the vendor, hostname and address. It is a hint for naming
 * the device, never applied by itself; without an answer the alert says so.
 *
 * Opt-in: NETWORK_DEVICE_WATCH_MS sets the poll interval (minimum 60000). The
 * first check runs one minute after startup.
 */

const logger = require('../../config/logger');

const METRIC = 'network_new_device';
const MIN_INTERVAL_MS = 60 * 1000;
const FIRST_DELAY_MS = 60 * 1000;
const MAC_PATTERN = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
const GUESS_TIMEOUT_MS = 3 * 60 * 1000;
const NO_GUESS = 'No guess of what it is.';
const GUESS_SYSTEM = 'You help name devices on a home network. From the vendor, hostname and address, say what kind of device this most likely is and suggest a short name. Reply with JSON only: {"kind": "<a few words>", "name": "<short-name>"}. If the clues are too weak, use "unknown" for kind.';

function watchIntervalMs(env = process.env) {
  const value = Number(env.NETWORK_DEVICE_WATCH_MS);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(MIN_INTERVAL_MS, Math.floor(value));
}

function normalizeMac(value) {
  const mac = String(value || '').trim().toUpperCase().replace(/-/g, ':');
  return MAC_PATTERN.test(mac) ? mac : '';
}

function isKnown(device) {
  return Boolean(String(device?.alias || '').trim() || device?.knownAt);
}

function text(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

/** One sentence for the alert from the model's JSON answer, or the no-guess sentence. */
function guessSentence(answer) {
  try {
    const match = String(answer || '').match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : '');
    const kind = text(parsed.kind, 60);
    const name = text(parsed.name, 40);
    if (!kind || /^unknown$/i.test(kind)) return NO_GUESS;
    return name ? `Probably ${kind}; suggested name: ${name}.` : `Probably ${kind}.`;
  } catch {
    return NO_GUESS;
  }
}

function buildEvent(device, mac, guess = NO_GUESS) {
  return {
    component: 'network',
    metric: METRIC,
    value: 1,
    threshold: 0,
    source: 'network-device-watch',
    additionalData: {
      detector: METRIC,
      incidentKey: `mac:${mac}`,
      mac,
      ip: text(device.ip, 64),
      hostname: text(device.hostname) || 'no hostname',
      vendor: text(device.vendor) || 'unknown vendor',
      guess,
      firstSeen: device.firstSeen ? new Date(device.firstSeen).toISOString() : null,
    },
  };
}

function createNetworkDeviceWatch(deps = {}) {
  const loadDevices = deps.loadDevices || (async () => {
    const { fetchData } = require('./dataServiceClient');
    const { response, body } = await fetchData('/api/v1/network/devices');
    if (!response.ok) throw new Error(`Data inventory answered ${response.status}`);
    return Array.isArray(body?.data?.devices) ? body.data.devices : [];
  });
  const Watch = deps.Watch || require('../../models/NetworkDeviceWatch');
  const evaluateEvent = deps.evaluateEvent
    || ((event) => require('./alertService').evaluateEvent(event));
  const now = deps.now || (() => new Date());
  // The guess is optional: any failure or a busy host leaves the plain alert.
  const guessFor = deps.guessFor || (async (device) => {
    const result = await require('./inferenceService').executeInference({
      callerDetail: 'network-device-guess', taskType: 'ops_watch', stream: false, think: false,
      system: GUESS_SYSTEM,
      prompt: JSON.stringify({ vendor: text(device.vendor), hostname: text(device.hostname), ip: text(device.ip, 64) }),
      options: { temperature: 0, num_predict: 80 }
    }, { timeoutMs: GUESS_TIMEOUT_MS });
    return result?.ok ? (result.body?.response || result.body?.message?.content || '') : '';
  });

  async function check() {
    const byMac = new Map();
    for (const device of await loadDevices()) {
      const mac = normalizeMac(device?.mac);
      if (mac && !byMac.has(mac)) byMac.set(mac, device);
    }
    const baseline = (await Watch.countDocuments({})) === 0;
    const seen = new Set((await Watch.find({ mac: { $in: [...byMac.keys()] } }, { mac: 1 }).lean())
      .map((row) => row.mac));
    const fresh = [...byMac.keys()].filter((mac) => !seen.has(mac));
    if (fresh.length) {
      const at = now();
      try {
        await Watch.insertMany(fresh.map((mac) => ({
          mac, firstObservedAt: at, baseline, settledAt: baseline ? at : null,
        })), { ordered: false });
      } catch (err) {
        // A concurrent run may have recorded some of them; duplicates are harmless.
        if (err?.code !== 11000 && !err?.writeErrors) throw err;
      }
    }
    if (baseline) return { baseline: true, recorded: fresh.length, alerted: 0 };

    // Unsettled rows include a device whose alert failed on an earlier run.
    const pending = await Watch.find({ mac: { $in: [...byMac.keys()] }, settledAt: null }, { mac: 1 }).lean();
    let alerted = 0;
    for (const { mac } of pending) {
      const device = byMac.get(mac);
      const known = isKnown(device);
      const claimed = await Watch.findOneAndUpdate(
        { mac, settledAt: null }, { $set: { settledAt: now(), alerted: !known } }, { new: true });
      if (!claimed || known) continue;
      try {
        const guess = guessSentence(await guessFor(device).catch(() => ''));
        await evaluateEvent(buildEvent(device, mac, guess));
      } catch (err) {
        // Release the claim so the next run raises it instead of losing it.
        await Watch.updateOne({ mac }, { $set: { settledAt: null, alerted: false } });
        throw err;
      }
      alerted += 1;
    }
    return { baseline: false, recorded: fresh.length, alerted };
  }

  let timer = null;
  let running = false;
  async function tick() {
    if (running) return null;
    running = true;
    try {
      const result = await check();
      if (result.recorded) logger.info('[NetworkDeviceWatch] inventory checked', result);
      return result;
    } catch (err) {
      logger.warn('[NetworkDeviceWatch] check failed (non-fatal)', { error: err.message });
      return null;
    } finally {
      running = false;
    }
  }

  // The first check waits: Core and Data are often recreated together, and a
  // check at Core startup would only meet a Data service still booting.
  function start(intervalMs = watchIntervalMs(), { firstDelayMs = FIRST_DELAY_MS } = {}) {
    if (!intervalMs || timer) return false;
    timer = setTimeout(() => {
      tick();
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    }, Math.min(firstDelayMs, intervalMs));
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (timer) { clearTimeout(timer); clearInterval(timer); }
    timer = null;
  }

  return { check, tick, start, stop };
}

module.exports = { METRIC, NO_GUESS, createNetworkDeviceWatch, watchIntervalMs, normalizeMac, isKnown, buildEvent, guessSentence };
