'use strict';

/**
 * Parked hosts (#360, phase 4).
 *
 * A GPU host group runs one declared mode at a time. The endpoints of the
 * other modes are stopped on purpose: they are *parked*, not down. Health
 * checks, the pin reconciler, GPU health, the watchdog and alerts ask
 * `isParkedHost(url)` and stay quiet for them. While a switch runs, every
 * endpoint of its group is parked: the switch owns them until it ends.
 *
 * The intended mode of a group is, in order:
 *   1. the target of a switch in progress (every endpoint parked meanwhile);
 *   2. the mode recorded by the last completed switch, or first observed
 *      active (kept in memory and, when a store is given, persisted);
 *   3. the mode observed active now.
 * Without any of these, nothing is parked: an unknown group keeps its alerts.
 *
 * `isParkedHost` is synchronous and reads only what the last refresh saw.
 * `refresh()` observes the topology (the same description routing uses).
 */

const { hostUrlKey } = require('../../../shared/ollamaHostConfig');

const REFRESH_MS = 30_000;

function key(url) {
  try { return hostUrlKey(url); } catch { return null; }
}

/**
 * Pure: which endpoints are parked, given a description, the intended mode per
 * group and the groups with a switch in progress.
 * @returns {Map<string, {groupId, mode, intendedMode, reason}>} url -> why
 */
function parkedEndpoints(description, intendedModes = new Map(), switching = new Map()) {
  const parked = new Map();
  if (!description?.valid || !description.configured) return parked;
  for (const group of description.groups || []) {
    const inSwitch = switching.get(group.id);
    const declared = new Set((group.modes || []).map(mode => mode.id));
    const wanted = intendedModes.get(group.id);
    const intended = inSwitch ? null
      : (wanted && declared.has(wanted) ? wanted : (group.activeMode || null));
    // An endpoint the intended mode also uses is never parked.
    const kept = new Set((group.modes || []).filter(mode => mode.id === intended)
      .flatMap(mode => (mode.endpoints || []).map(endpoint => key(endpoint.url))));
    for (const mode of group.modes || []) {
      for (const endpoint of mode.endpoints || []) {
        const url = key(endpoint.url);
        if (!url || parked.has(url)) continue;
        if (inSwitch) {
          parked.set(url, { groupId: group.id, mode: mode.id, intendedMode: inSwitch.targetMode || null,
            reason: 'topology_switch_in_progress', switchId: inSwitch.id || null });
        } else if (intended && mode.id !== intended && !kept.has(url)) {
          parked.set(url, { groupId: group.id, mode: mode.id, intendedMode: intended, reason: 'inactive_topology_mode' });
        }
      }
    }
  }
  return parked;
}

function createParking({
  // Lazy: runtimeTopologyService loads hostPreferenceService, which asks us.
  describe = options => require('./runtimeTopologyService').describeTopology(options),
  readRaw = () => process.env.AGENTX_RUNTIME_TOPOLOGY_JSON || '',
  // { load(): Promise<Map>, save(groupId, mode, source), openSwitches(): Promise<Map> }
  store = null,
  now = Date.now,
  logger = null
} = {}) {
  let description = null;
  let observedAt = 0;
  const intended = new Map();
  const switching = new Map(); // seen in the store (any Core process)
  const local = new Map(); // started by this process
  let parked = new Map();
  let loaded = false;
  let timer = null;

  function recompute() {
    parked = parkedEndpoints(description, intended, new Map([...switching, ...local]));
  }

  async function loadIntended() {
    if (loaded || !store) { loaded = true; return; }
    try {
      const saved = await store.load();
      for (const [groupId, mode] of saved || []) if (!intended.has(groupId)) intended.set(groupId, mode);
    } catch (error) {
      logger?.warn?.('[Topology] intended modes unreadable', { error: error.message });
    }
    loaded = true;
  }

  async function remember(groupId, mode, source) {
    intended.set(groupId, mode);
    if (store) {
      try { await store.save(groupId, mode, source); } catch (error) {
        logger?.warn?.('[Topology] intended mode not saved', { groupId, error: error.message });
      }
    }
  }

  async function refresh() {
    await loadIntended();
    const raw = readRaw();
    if (!raw) { description = null; recompute(); return null; }
    try {
      description = await describe({ raw });
      observedAt = now();
    } catch (error) {
      logger?.warn?.('[Topology] parking refresh failed', { error: error.message });
      return description;
    }
    if (store?.openSwitches) {
      try {
        const open = await store.openSwitches();
        switching.clear();
        for (const [groupId, entry] of open || []) switching.set(groupId, entry);
      } catch (error) {
        logger?.warn?.('[Topology] open switches unreadable', { error: error.message });
      }
    }
    for (const group of description?.groups || []) {
      // First sight of a running mode becomes the intended one; a later
      // observation never overrides a recorded intent (a crash is not a switch).
      if (!intended.has(group.id) && group.activeMode && !switching.has(group.id) && !local.has(group.id)) {
        await remember(group.id, group.activeMode, 'observed');
      }
    }
    recompute();
    return description;
  }

  return Object.freeze({
    refresh,
    isParkedHost(url) {
      const k = key(url);
      return Boolean(k && parked.has(k));
    },
    parkedReason(url) {
      const k = key(url);
      return (k && parked.get(k)) || null;
    },
    parkedHosts() {
      return [...parked.entries()].map(([url, why]) => ({ url, ...why }));
    },
    intendedMode(groupId) {
      return intended.get(groupId) || null;
    },
    async setIntendedMode(groupId, mode, source = 'switch') {
      await remember(groupId, mode, source);
      recompute();
    },
    beginSwitch(groupId, entry) {
      local.set(groupId, { id: entry?.id || null, targetMode: entry?.targetMode || null });
      recompute();
    },
    endSwitch(groupId) {
      local.delete(groupId);
      switching.delete(groupId);
      recompute();
    },
    switchInProgress(groupId) {
      return local.get(groupId) || switching.get(groupId) || null;
    },
    lastObservedAt() {
      return observedAt ? new Date(observedAt).toISOString() : null;
    },
    start({ intervalMs = REFRESH_MS } = {}) {
      if (timer || !readRaw()) return;
      refresh().catch(() => {});
      timer = setInterval(() => { refresh().catch(() => {}); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    // Tests only.
    _setDescription(value) { description = value; recompute(); }
  });
}

// Durable intents and open switches, shared by every Core process.
const mongoStore = Object.freeze({
  async load() {
    const rows = await require('../../models/RuntimeTopologyIntent').find({}).lean();
    return new Map(rows.map(row => [row.groupId, row.mode]));
  },
  async save(groupId, mode, source) {
    await require('../../models/RuntimeTopologyIntent').updateOne({ groupId },
      { $set: { mode, source: source === 'switch' ? 'switch' : 'observed' } }, { upsert: true });
  },
  async openSwitches() {
    const Switch = require('../../models/RuntimeTopologySwitch');
    const rows = await Switch.find({ state: { $nin: Switch.TERMINAL_STATES } }).lean();
    return new Map(rows.map(row => [row.groupId, { id: row.requestId, targetMode: row.targetMode }]));
  }
});

const defaultParking = createParking({ store: mongoStore, logger: require('../../config/logger') });

module.exports = {
  REFRESH_MS,
  parkedEndpoints,
  createParking,
  defaultParking,
  mongoStore,
  isParkedHost: url => defaultParking.isParkedHost(url),
  parkedReason: url => defaultParking.parkedReason(url)
};
