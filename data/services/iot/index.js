'use strict';

/**
 * The IoT store: a device registry and a sampled sensor history fed from the
 * MQTT broker.
 *
 * Ingestion listens on the MQTT monitor's broker connection. The monitor
 * already subscribes to `#`, connects whenever MQTT_BROKER_URL is set (with or
 * without background jobs, never in a test process), resubscribes on every
 * reconnection (so the broker replays retained availability and discovery),
 * and owns the only publish path that never queues. The live-feed client is
 * not usable here: it only exists with background jobs, and it drops every
 * subscription at each live-feed configuration reload.
 *
 * Readings are aggregated in memory per device, measure and minute, stamped
 * with Data's own clock at reception. A minute is written five seconds after
 * it ends, and the open minute at shutdown: a crash loses at most the open
 * minute. Heartbeats only refresh "last seen". The readings bundled in
 * `esp32/data/<device>` are ignored: they repeat the `sensors/...` topics
 * under other names, so that message is proof of life only.
 */

const { log } = require('../../utils/logger');
const topics = require('./topics');
const { parseDiscovery } = require('./discovery');
const { createMinuteAggregator, MINUTE_MS } = require('./buckets');
const { createRegistry, MAX_DEVICES, MAX_MEASURES_PER_DEVICE, STALE_AFTER_MS, LIVE_RING_SIZE } = require('./registry');
const store = require('./bucketStore');
const backfill = require('./backfill');
const history = require('./history');
const commands = require('./commands');
const defaultActivity = require('./activity');

const TICK_MS = 5_000;
const ROLLUP_INTERVAL_MS = 5 * MINUTE_MS;
const MAX_PENDING_BUCKETS = 20_000;

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createIot({ now = () => new Date(), activity = defaultActivity, monitor: defaultMonitor = null } = {}) {
  let db = null;
  let registry = null;
  let loading = null;
  let monitor = defaultMonitor;
  let aggregator = createMinuteAggregator();
  let removeListener = null;
  let timer = null;
  let ticking = false;
  let maintaining = false;
  let stopping = false;
  let consuming = false;
  let startedAt = null;
  let pending = [];           // closed buckets whose write failed, retried at the next tick
  let lastFullPersistMs = 0;
  let lastRollupMs = 0;
  let events = Promise.resolve(); // activity writes, in the order things happened
  let counters;

  function resetCounters() {
    counters = {
      messages: 0, readings: 0, heartbeats: 0, refused: 0, refusedByReason: {},
      bucketsWritten: 0, bucketsDropped: 0, lastReadingAt: null, lastWriteAt: null, lastError: null
    };
  }
  resetCounters();

  function onRegistryEvent(event) {
    const database = db;
    events = events.then(() => {
      if (event.kind === 'first_seen') return activity.firstSeen(database, event.device);
      if (event.kind === 'availability') return activity.availability(database, event.device, event.state, { retained: event.retained });
      if (event.kind === 'stale') return activity.stale(database, event.device, { silentForMs: event.silentForMs });
      if (event.kind === 'recovered') return activity.recovered(database, event.device);
      return null;
    }).catch(() => null);
  }

  /** Load the registry from `database` once; every entry point awaits this. */
  function ready(database) {
    if (!database) return Promise.reject(httpError(503, 'Data has no database connection'));
    if (db === database && loading) return loading;
    db = database;
    registry = createRegistry({ bootAt: now(), emit: onRegistryEvent });
    const mine = registry;
    loading = mine.load(database).then(() => mine, (error) => { loading = null; db = null; throw error; });
    return loading;
  }

  function refuse(reason) {
    counters.refused += 1;
    counters.refusedByReason[reason] = (counters.refusedByReason[reason] || 0) + 1;
    return reason;
  }

  /**
   * One broker message. Synchronous and never throws. Returns '' when the
   * message was used or is none of the store's business, else why it was refused.
   */
  function handleMessage(topic, payload, packet = {}) {
    if (!registry) return '';
    const parsed = topics.parseTopic(topic);
    if (parsed.kind === 'ignored') return '';
    counters.messages += 1;
    if (parsed.kind === 'refused') return refuse(parsed.reason);
    const at = now();
    const retained = packet?.retain === true;

    if (parsed.kind === 'reading') {
      // A retained reading is an old value replayed by the broker, not a measurement taken now.
      if (retained) return refuse('retained_reading');
      const value = topics.parseNumeric(payload);
      if (value === null) return refuse('not_numeric');
      const reason = registry.reading(parsed.device, parsed.measure, value, at);
      if (reason) return refuse(reason);
      const outcome = aggregator.add(parsed.device, parsed.measure, value, at.getTime(), at.getTime());
      if (outcome !== 'ok') return refuse(outcome);
      counters.readings += 1;
      counters.lastReadingAt = at;
      return '';
    }
    if (parsed.kind === 'availability') {
      const state = topics.parseAvailability(payload);
      if (!state) return refuse('availability_value');
      return registry.availability(parsed.device, state, at, { retained }) ? '' : refuse('device_limit');
    }
    if (parsed.kind === 'seen') {
      if (retained) return '';
      if (!registry.seen(parsed.device, at)) return refuse('device_limit');
      if (parsed.what === 'alive') counters.heartbeats += 1;
      return '';
    }
    if (parsed.kind === 'announce') {
      if (retained) return '';
      const id = topics.parseAnnouncedDevice(payload);
      if (!id) return refuse('device_name');
      return registry.announce(id, parsed.what, at) ? '' : refuse('device_limit');
    }
    // discovery; an empty retained payload is Home Assistant's way to remove one.
    if (!payload || !payload.length) return '';
    const described = parseDiscovery(parsed.device, payload);
    if (!described) return refuse('discovery_payload');
    return registry.applyDiscovery(parsed.device, described, at) ? '' : refuse('device_limit');
  }

  async function writeBuckets(buckets) {
    const batch = pending.concat(buckets);
    pending = [];
    if (!batch.length) return 0;
    try {
      await store.writeMinuteBuckets(db, batch);
      counters.bucketsWritten += batch.length;
      counters.lastWriteAt = now();
      counters.lastError = null;
      return batch.length;
    } catch (error) {
      // Kept for the next tick, within a bound: MongoDB being away must not fill memory.
      const kept = batch.slice(-MAX_PENDING_BUCKETS);
      counters.bucketsDropped += batch.length - kept.length;
      pending = kept;
      counters.lastError = String(error.message || error).split('\n')[0].slice(0, 200);
      log(`[iot] ${batch.length} minute bucket(s) not written, kept for retry: ${counters.lastError}`, 'warn');
      return 0;
    }
  }

  /** Backfill once, then roll up closed hours. Never two at a time. */
  async function maintain(at = now()) {
    if (maintaining || !db) return null;
    maintaining = true;
    const result = {};
    try {
      result.backfill = await backfill.run(db, { registry, shouldStop: () => stopping });
      if (!stopping) result.rollup = await store.runRollup(db, at);
      lastRollupMs = at.getTime();
    } catch (error) {
      log(`[iot] maintenance failed: ${error.message}`, 'warn');
    } finally {
      maintaining = false;
    }
    return result;
  }

  /** The periodic work: write closed minutes, notice silences, save the registry. */
  async function tick(at = now()) {
    if (ticking || !registry) return;
    ticking = true;
    try {
      const nowMs = at.getTime();
      await writeBuckets(aggregator.takeClosed(nowMs));
      // Deaf is not silent: staleness is only judged while the broker link is up.
      const link = monitor?.status?.();
      if (consuming && link?.connected) registry.sweepStale(at, link.connectedAt ? new Date(link.connectedAt) : at);
      const all = nowMs - lastFullPersistMs >= MINUTE_MS;
      await registry.persist(db, { all });
      if (all) lastFullPersistMs = nowMs;
      if (timer && nowMs - lastRollupMs >= ROLLUP_INTERVAL_MS) maintain(at);
    } catch (error) {
      log(`[iot] tick failed: ${error.message}`, 'warn');
    } finally {
      ticking = false;
    }
  }

  /**
   * Start the periodic work and, when a broker is configured, the ingestion.
   * Nothing starts in a test process. `mqttMonitor` must not be connected yet,
   * so that the retained messages replayed at its first connection are heard.
   */
  async function start(database, { mqttMonitor, env = process.env } = {}) {
    await ready(database);
    if (mqttMonitor) monitor = mqttMonitor;
    if (env.NODE_ENV === 'test' || timer) return false;
    stopping = false;
    startedAt = now();
    lastRollupMs = startedAt.getTime();
    timer = setInterval(() => { tick(); }, TICK_MS);
    timer.unref?.();
    maintain(startedAt);
    if (env.MQTT_BROKER_URL && monitor?.addListener) {
      removeListener = monitor.addListener(handleMessage);
      consuming = true;
      log('[iot] Ingestion listening on the MQTT monitor connection');
    } else {
      log('[iot] No MQTT_BROKER_URL configured: ingestion is off, history and registry stay readable');
    }
    return true;
  }

  /** Stop listening and write everything held in memory, open minute included. */
  async function stop() {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (removeListener) removeListener();
    removeListener = null;
    consuming = false;
    if (!registry || !db) return;
    await writeBuckets(aggregator.takeAll());
    try { await registry.persist(db, { all: true }); }
    catch (error) { log(`[iot] registry not saved at shutdown: ${error.message}`, 'warn'); }
    await events;
  }

  async function status(database) {
    const devices = await ready(database);
    const link = monitor?.status?.() || {};
    const byStatus = { online: 0, offline: 0, stale: 0, unknown: 0 };
    for (const device of devices.list()) byStatus[devices.statusOf(device)] += 1;
    const [rollup, backfillState] = await Promise.all([store.rollupState(database), backfill.getState(database)]);
    const iso = (date) => (date instanceof Date ? date.toISOString() : null);
    return {
      consumer: {
        running: consuming,
        configured: Boolean(link.configured),
        connected: Boolean(consuming && link.connected),
        broker: link.broker || null,
        connection: 'mqtt-monitor',
        startedAt: iso(startedAt)
      },
      devices: { tracked: devices.size(), limit: MAX_DEVICES, measuresPerDeviceLimit: MAX_MEASURES_PER_DEVICE, ...byStatus },
      messages: { received: counters.messages, heartbeats: counters.heartbeats },
      readings: {
        accepted: counters.readings, refused: counters.refused,
        refusedByReason: { ...counters.refusedByReason }, lastAt: iso(counters.lastReadingAt)
      },
      buckets: {
        written: counters.bucketsWritten, open: aggregator.size(), pendingRetry: pending.length,
        dropped: counters.bucketsDropped, lastWriteAt: iso(counters.lastWriteAt), lastError: counters.lastError
      },
      rollup: rollup
        ? { through: iso(rollup.through), lastRunAt: iso(rollup.lastRunAt), lastHours: rollup.lastHours ?? 0, lastBuckets: rollup.lastBuckets ?? 0, more: rollup.more === true }
        : null,
      backfill: backfillState
        ? {
          state: backfillState.state, points: backfillState.points || 0, buckets: backfillState.buckets || 0,
          skipped: backfillState.skipped || 0, removed: backfillState.removed || 0,
          startedAt: iso(backfillState.startedAt), finishedAt: iso(backfillState.finishedAt)
        }
        : null,
      settings: {
        minuteRetentionDays: store.MINUTE_RETENTION_DAYS, staleAfterSeconds: STALE_AFTER_MS / 1000,
        liveRingSize: LIVE_RING_SIZE
      }
    };
  }

  async function deviceOr404(database, id) {
    const devices = await ready(database);
    const device = topics.isDeviceId(id) ? devices.get(id) : null;
    if (!device) throw httpError(404, `Unknown device '${String(id).slice(0, 64)}'`);
    return { devices, device };
  }

  async function listDevices(database) {
    const devices = await ready(database);
    const at = now();
    return devices.list().map((device) => devices.toPublic(device, at)).sort((a, b) => a.id.localeCompare(b.id));
  }

  async function getDevice(database, id) {
    const { devices, device } = await deviceOr404(database, id);
    return devices.toPublic(device, now());
  }

  async function patchDevice(database, id, body) {
    const { devices } = await deviceOr404(database, id);
    return devices.toPublic(await devices.patch(database, id, body), now());
  }

  async function readHistory(database, id, query) {
    const { device } = await deviceOr404(database, id);
    const at = now();
    return history.read(database, device, history.parseQuery(query, [...device.measures.keys()], at), at);
  }

  async function readLive(database, id, query = {}) {
    const { devices, device } = await deviceOr404(database, id);
    if (query.measure !== undefined && typeof query.measure !== 'string') throw httpError(400, 'measure must be given once');
    const known = [...device.measures.keys()];
    const asked = query.measure ? [...new Set(query.measure.split(',').map((name) => name.trim()).filter(Boolean))] : known;
    const unknown = asked.filter((name) => !known.includes(name));
    if (unknown.length) throw httpError(400, `Unknown measure for this device: ${unknown.slice(0, 5).map((name) => name.slice(0, 48)).join(', ')}`);
    return { device: device.id, status: devices.statusOf(device), ringSize: LIVE_RING_SIZE, measures: devices.live(device, asked) };
  }

  /** Publish one command through the monitor's publish path: QoS 0, not retained, never queued. */
  async function sendCommand(database, id, body) {
    const { devices, device } = await deviceOr404(database, id);
    const command = commands.validateCommand(body);
    const message = commands.toPublish(device.id, command);
    if (!monitor?.publish) throw httpError(503, 'MQTT broker is not configured: set MQTT_BROKER_URL on Data. The command was not sent.');
    let sent;
    try {
      sent = await monitor.publish(message);
    } catch (error) {
      if (error.statusCode !== 400) await activity.command(database, device, { ...command, topic: message.topic, error: error.message });
      throw error;
    }
    await activity.command(database, device, { ...command, topic: message.topic });
    return {
      device: device.id, deviceStatus: devices.statusOf(device), command: command.command, gpio: command.gpio,
      topic: sent.topic, qos: 0, retain: false, publishedAt: sent.publishedAt
    };
  }

  return {
    ready, start, stop, tick, maintain, handleMessage, status,
    listDevices, getDevice, patchDevice, readHistory, readLive, sendCommand,
    isConsuming: () => consuming,
    _reset() { db = null; registry = null; loading = null; aggregator = createMinuteAggregator(); pending = []; resetCounters(); }
  };
}

const iot = createIot({ monitor: require('../mqttMonitor') });

module.exports = { ...iot, createIot, TICK_MS, ROLLUP_INTERVAL_MS };
