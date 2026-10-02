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
 * Opt-in: NETWORK_DEVICE_WATCH_MS sets the poll interval (minimum 60000). The
 * first check runs one minute after startup.
 */

const logger = require('../../config/logger');

const METRIC = 'network_new_device';
const MIN_INTERVAL_MS = 60 * 1000;
const FIRST_DELAY_MS = 60 * 1000;
const MAC_PATTERN = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

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

function buildEvent(device, mac) {
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
        await evaluateEvent(buildEvent(device, mac));
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

module.exports = { METRIC, createNetworkDeviceWatch, watchIntervalMs, normalizeMac, isKnown, buildEvent };
