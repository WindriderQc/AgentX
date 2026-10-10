'use strict';

/**
 * The device registry: one entry per device, held in memory and written to
 * `iot_devices` (one document per device, `_id` = device id).
 *
 * Memory is the working copy because a device speaks every second: "last
 * seen" and the latest values are written to MongoDB once a minute, while a
 * new device, a change of availability, a discovery message or a staleness
 * change is written at the next tick. The owner's fields (display name,
 * location, notes) are written by `patch` only and never by the periodic write.
 *
 * The registry reports what changed through `emit`; it writes no activity
 * event itself.
 */

const { defaultsFor } = require('./discovery');

const COLLECTION = 'iot_devices';
const MAX_DEVICES = 100;
const MAX_MEASURES_PER_DEVICE = 32;
const LIVE_RING_SIZE = 60;
// Silence after which a device the broker does not report offline is stale.
const STALE_AFTER_MS = 5 * 60 * 1000;
const OWNER_FIELDS = Object.freeze({ displayName: 80, location: 80, notes: 1000 });

const iso = (date) => (date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null);
const asDate = (value) => {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
};

function refuse(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function fromDoc(doc) {
  const measures = new Map();
  for (const measure of Array.isArray(doc.measures) ? doc.measures.slice(0, MAX_MEASURES_PER_DEVICE) : []) {
    if (!measure || typeof measure.key !== 'string') continue;
    measures.set(measure.key, {
      key: measure.key, name: measure.name ?? null, unit: measure.unit ?? null,
      deviceClass: measure.deviceClass ?? null, source: measure.source || 'default',
      firstSeenAt: asDate(measure.firstSeenAt),
      value: typeof measure.value === 'number' ? measure.value : null, at: asDate(measure.at)
    });
  }
  const state = doc.availability?.state;
  return {
    id: String(doc._id),
    firstSeenAt: asDate(doc.firstSeenAt), lastSeenAt: asDate(doc.lastSeenAt),
    availability: { state: state === 'online' || state === 'offline' ? state : 'unknown', since: asDate(doc.availability?.since) },
    stale: doc.stale === true, staleSince: asDate(doc.staleSince),
    registeredAt: asDate(doc.registeredAt), discoveryAt: asDate(doc.discoveryAt),
    info: doc.info && typeof doc.info === 'object' ? { ...doc.info } : {},
    measures, rings: new Map(),
    displayName: doc.displayName ?? null, location: doc.location ?? null, notes: doc.notes ?? null,
    dirty: false, urgent: false
  };
}

function machineFields(device) {
  return {
    firstSeenAt: device.firstSeenAt, lastSeenAt: device.lastSeenAt,
    availability: { ...device.availability },
    stale: device.stale, staleSince: device.staleSince,
    registeredAt: device.registeredAt, discoveryAt: device.discoveryAt,
    info: { ...device.info },
    measures: [...device.measures.values()].map((measure) => ({ ...measure }))
  };
}

function createRegistry({ bootAt = new Date(), emit = () => {}, staleAfterMs = STALE_AFTER_MS } = {}) {
  const devices = new Map();
  const boot = bootAt.getTime();

  async function load(db) {
    const docs = await db.collection(COLLECTION).find({}).sort({ lastSeenAt: -1 }).limit(MAX_DEVICES).toArray();
    devices.clear();
    for (const doc of docs) devices.set(String(doc._id), fromDoc(doc));
    return devices.size;
  }

  const mark = (device, urgent = false) => { device.dirty = true; if (urgent) device.urgent = true; };
  const get = (id) => devices.get(id) || null;

  /** The device, created when new. Null when the registry is full. */
  function ensure(id, now, { announce = true } = {}) {
    let device = devices.get(id);
    if (device) return device;
    if (devices.size >= MAX_DEVICES) return null;
    device = fromDoc({ _id: id, firstSeenAt: now });
    devices.set(id, device);
    mark(device, true);
    if (announce) emit({ kind: 'first_seen', device });
    return device;
  }

  /** The device itself spoke: refresh "last seen" and end a staleness. */
  function touch(device, now) {
    device.lastSeenAt = now;
    if (device.stale) {
      device.stale = false;
      device.staleSince = null;
      mark(device, true);
      emit({ kind: 'recovered', device });
    } else {
      mark(device);
    }
  }

  function seen(id, now) {
    const device = ensure(id, now);
    if (!device) return null;
    touch(device, now);
    return device;
  }

  function measureOf(device, key, now) {
    let measure = device.measures.get(key);
    if (measure) return measure;
    if (device.measures.size >= MAX_MEASURES_PER_DEVICE) return null;
    measure = { key, ...defaultsFor(key), firstSeenAt: now, value: null, at: null };
    device.measures.set(key, measure);
    mark(device, true);
    return measure;
  }

  /** Record a reading. Returns '' or the reason it was refused. */
  function reading(id, key, value, now) {
    const device = ensure(id, now);
    if (!device) return 'device_limit';
    const measure = measureOf(device, key, now);
    if (!measure) { touch(device, now); return 'measure_limit'; }
    touch(device, now);
    measure.value = value;
    measure.at = now;
    let ring = device.rings.get(key);
    if (!ring) { ring = []; device.rings.set(key, ring); }
    ring.push([now.getTime(), value]);
    if (ring.length > LIVE_RING_SIZE) ring.splice(0, ring.length - LIVE_RING_SIZE);
    return '';
  }

  /**
   * The availability topic changed or was replayed. A retained message is the
   * state the broker holds, not the device speaking, and `offline` is the
   * broker's last-will: neither refreshes "last seen".
   */
  function availability(id, state, now, { retained = false } = {}) {
    const device = ensure(id, now);
    if (!device) return null;
    if (state === 'online' && !retained) touch(device, now);
    const previous = device.availability.state;
    if (previous === state) return device;
    device.availability = { state, since: now };
    if (state === 'offline' && device.stale) { device.stale = false; device.staleSince = null; }
    mark(device, true);
    emit({ kind: 'availability', device, state, previous, retained });
    return device;
  }

  /** esp32/register and esp32/config: the device announces itself at boot. */
  function announce(id, what, now) {
    const device = seen(id, now);
    if (!device) return null;
    if (what === 'register') { device.registeredAt = now; mark(device, true); }
    return device;
  }

  function applyDiscovery(id, parsed, now) {
    const device = ensure(id, now);
    if (!device) return null;
    device.info = { ...parsed.info };
    device.discoveryAt = now;
    for (const [key, described] of parsed.measures) {
      const measure = measureOf(device, key, now);
      if (!measure) break;
      const fallback = defaultsFor(key);
      measure.name = described.name || fallback.name;
      measure.unit = described.unit ?? fallback.unit;
      measure.deviceClass = described.deviceClass;
      measure.source = 'discovery';
    }
    mark(device, true);
    return device;
  }

  /** A device and measure found in history written before the registry existed. */
  function historical(id, key, first, last) {
    const device = ensure(id, first, { announce: false });
    if (!device) return false;
    if (!device.firstSeenAt || first < device.firstSeenAt) device.firstSeenAt = first;
    if (!device.lastSeenAt || last > device.lastSeenAt) device.lastSeenAt = last;
    const measure = measureOf(device, key, first);
    if (measure && (!measure.firstSeenAt || first < measure.firstSeenAt)) measure.firstSeenAt = first;
    mark(device, true);
    return true;
  }

  /**
   * Flag devices gone silent without an `offline`; announce those that had
   * spoken. Data cannot have heard anyone before it started listening:
   * silence counts from the later of the last message and `listeningSince`.
   */
  function sweepStale(now, listeningSince = bootAt) {
    const nowMs = now.getTime();
    const floor = Math.max(boot, listeningSince.getTime());
    let flagged = 0;
    for (const device of devices.values()) {
      if (device.stale || device.availability.state === 'offline') continue;
      if (nowMs - Math.max(device.lastSeenAt ? device.lastSeenAt.getTime() : 0, floor) <= staleAfterMs) continue;
      device.stale = true;
      device.staleSince = now;
      mark(device, true);
      flagged += 1;
      if (device.lastSeenAt) emit({ kind: 'stale', device, silentForMs: nowMs - device.lastSeenAt.getTime() });
    }
    return flagged;
  }

  function statusOf(device) {
    if (device.availability.state === 'offline') return 'offline';
    if (device.stale) return 'stale';
    return device.availability.state;
  }

  function toPublic(device, now = new Date()) {
    const nowMs = now.getTime();
    const age = (date) => (date ? Math.max(0, nowMs - date.getTime()) : null);
    return {
      id: device.id,
      displayName: device.displayName, location: device.location, notes: device.notes,
      status: statusOf(device),
      availability: { state: device.availability.state, since: iso(device.availability.since) },
      staleSince: iso(device.staleSince),
      firstSeenAt: iso(device.firstSeenAt),
      lastSeenAt: iso(device.lastSeenAt), lastSeenAgeMs: age(device.lastSeenAt),
      registeredAt: iso(device.registeredAt), discoveryAt: iso(device.discoveryAt),
      info: {
        name: device.info.name ?? null, manufacturer: device.info.manufacturer ?? null,
        model: device.info.model ?? null, swVersion: device.info.swVersion ?? null,
        hwVersion: device.info.hwVersion ?? null, origin: device.info.origin ?? null
      },
      measures: [...device.measures.values()].map((measure) => ({
        key: measure.key, name: measure.name, unit: measure.unit, deviceClass: measure.deviceClass,
        source: measure.source, firstSeenAt: iso(measure.firstSeenAt),
        value: measure.value, at: iso(measure.at), ageMs: age(measure.at)
      }))
    };
  }

  /** The last raw readings kept in memory, oldest first, for the asked measures. */
  function live(device, keys) {
    const measures = {};
    for (const key of keys) {
      const measure = device.measures.get(key);
      if (!measure) continue;
      measures[key] = {
        name: measure.name, unit: measure.unit,
        points: (device.rings.get(key) || []).map(([ts, value]) => ({ ts: new Date(ts).toISOString(), value }))
      };
    }
    return measures;
  }

  /** Write changed devices. `all` also writes those that only moved "last seen" and values. */
  async function persist(db, { all = false } = {}) {
    const pending = [...devices.values()].filter((device) => device.dirty && (all || device.urgent));
    if (!pending.length) return 0;
    const operations = pending.map((device) => {
      device.dirty = false;
      device.urgent = false;
      return {
        updateOne: {
          filter: { _id: device.id },
          update: { $set: machineFields(device), $setOnInsert: { displayName: null, location: null, notes: null } },
          upsert: true
        }
      };
    });
    try {
      await db.collection(COLLECTION).bulkWrite(operations, { ordered: false });
    } catch (error) {
      for (const device of pending) mark(device, true);
      throw error;
    }
    return pending.length;
  }

  /** Validate the owner's fields: only these three, strings or null, bounded. */
  function validatePatch(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse(400, 'Expected a JSON object with displayName, location or notes');
    const keys = Object.keys(body);
    const unknown = keys.filter((key) => !Object.prototype.hasOwnProperty.call(OWNER_FIELDS, key));
    if (unknown.length) throw refuse(400, `Unknown field: ${unknown.slice(0, 5).map((key) => key.slice(0, 40)).join(', ')}`);
    if (!keys.length) throw refuse(400, 'Nothing to change: give displayName, location or notes');
    const changes = {};
    for (const key of keys) {
      const value = body[key];
      if (value === null) { changes[key] = null; continue; }
      if (typeof value !== 'string') throw refuse(400, `${key} must be a string or null`);
      const clean = (key === 'notes' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') : value.replace(/[\u0000-\u001f\u007f]+/g, ' ')).trim();
      if (clean.length > OWNER_FIELDS[key]) throw refuse(400, `${key} must be at most ${OWNER_FIELDS[key]} characters`);
      changes[key] = clean || null;
    }
    return changes;
  }

  async function patch(db, id, body) {
    const device = devices.get(id);
    if (!device) throw refuse(404, `Unknown device '${String(id).slice(0, 64)}'`);
    const changes = validatePatch(body);
    await db.collection(COLLECTION).updateOne(
      { _id: id },
      { $set: { ...changes, updatedAt: new Date() }, $setOnInsert: machineFields(device) },
      { upsert: true }
    );
    Object.assign(device, changes);
    return device;
  }

  return {
    load, get, ensure, seen, reading, availability, announce, applyDiscovery, historical,
    sweepStale, statusOf, toPublic, live, persist, patch, validatePatch,
    list: () => [...devices.values()],
    size: () => devices.size
  };
}

module.exports = {
  COLLECTION, MAX_DEVICES, MAX_MEASURES_PER_DEVICE, LIVE_RING_SIZE, STALE_AFTER_MS, OWNER_FIELDS,
  createRegistry
};
