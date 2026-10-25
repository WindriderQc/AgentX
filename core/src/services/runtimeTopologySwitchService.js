'use strict';

/**
 * Runtime topology switch (#360, phase 4).
 *
 * Moves a GPU host group from its active mode to another declared mode, as a
 * Core-owned workload with a durable record:
 *
 *   requested -> draining -> actuating -> loading -> verifying -> active
 *
 * - draining: a host-scoped maintenance lease over every endpoint of the group
 *   (both modes). It is granted only once no inference, workload or other
 *   lease holds those hosts; Benchmark claims and workloads refuse at once,
 *   inferences are waited for. Inference refused meanwhile names
 *   `topology_switch_in_progress`.
 * - actuating: the host actuator stops the other mode, starts the target and
 *   arms its safety timer (`integrations/topology-actuator/`).
 * - loading: the target endpoints' pins are warmed through the pin service.
 * - verifying: the target mode is the one observed active, every pin is fully
 *   on GPU at its pinned context, one tiny inference answers on each endpoint
 *   and pin drift is ok.
 * - active: the actuator is confirmed (its safety timer is cancelled), the
 *   group's intended mode changes, the lease is released.
 *
 * A failure after actuation rolls back (actuator rollback, previous pins
 * restored and verified) and ends `rolled_back`. An outcome Core cannot
 * establish ends `uncertain`: the lease is quarantined through the existing
 * maintenance recovery path and an alert is raised. Nothing is retried
 * blindly; a lost answer is reconciled by reading the same request id.
 */

const crypto = require('crypto');
const logger = require('../../config/logger');
const Switch = require('../../models/RuntimeTopologySwitch');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
const { withContextRefusal } = require('./routing/contextIntegrityPolicy');

const { TERMINAL_STATES } = Switch;
const PRINCIPAL = 'core-topology-switch';
const LEASE_PURPOSE = 'topology-switch';
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/;
// Blockers a switch waits for (they end on their own); anything else refuses.
const WAITABLE_BLOCKERS = /^(inference|watchdog-probe)/;

const DEFAULTS = Object.freeze({
  drainTimeoutMs: 5 * 60_000,
  drainRetryMs: 2_000,
  leaseTtlMs: 120_000,
  heartbeatMs: 30_000,
  loadTimeoutMs: 8 * 60_000,
  verifyTimeoutMs: 4 * 60_000,
  verifyPollMs: 10_000,
  smokeTimeoutMs: 120_000,
  reconcileAttempts: 4,
  reconcileDelayMs: 20_000,
  staleDriverMs: 2 * 60_000
});

function typed(code, message, statusCode = 409, data = undefined) {
  return Object.assign(new Error(message), { code, statusCode, ...(data ? { data } : {}) });
}

function iso(date) {
  return date ? new Date(date).toISOString() : null;
}

/** Public view of a record: no lease capability (id, generation). */
function present(record) {
  if (!record) return null;
  const { _id, __v, lease, ...rest } = record;
  return { ...rest, lease: lease ? { state: lease.state || null, held: Boolean(lease.leaseId) && lease.state === 'ACTIVE' } : null };
}

function defaultSmoke({ fetchImpl = fetch } = {}) {
  return async function smoke(url, pin, { signal, timeoutMs }) {
    const started = Date.now();
    const options = { num_predict: 8 };
    if (Number(pin.contextSize) > 0) options.num_ctx = Number(pin.contextSize);
    if (Number(pin.numThread) > 0) options.num_thread = Number(pin.numThread);
    const body = withContextRefusal({
      model: pin.model, prompt: 'Reply with the single word OK.', stream: false, think: false,
      keep_alive: pin.keepAlive ?? -1, options
    });
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(`${url}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error'
    });
    const payload = await response.json().catch(() => null);
    return {
      url, model: pin.model, ok: response.ok && payload?.done === true,
      httpStatus: response.status, durationMs: Date.now() - started,
      evalCount: Number(payload?.eval_count) || 0
    };
  };
}

function defaultDrift() {
  return async function drift() {
    // Lazy: the drift check lives with the runtime bridges.
    const { checkPinDrift } = require('../../integrations/runtime-bridges/pin-drift');
    const { createTrustedRuntimeServices } = require('../extensions/trustedRuntimeServices');
    const result = await checkPinDrift({ runtimeServices: createTrustedRuntimeServices() });
    return { status: result?.status || 'error', checkedAt: result?.checkedAt || null,
      unpinnedRoutes: (result?.unpinnedRoutes || []).length, unpinnedExportLanes: (result?.unpinnedExportLanes || []).length,
      openclaw: result?.openclaw?.status || null };
  };
}

function createTopologySwitchService(deps = {}) {
  const options = { ...DEFAULTS, ...(deps.options || {}) };
  const topology = deps.topology || require('./runtimeTopologyService');
  const coordination = deps.coordination || require('./runtimeCoordinationService');
  const hostPrefs = deps.hostPrefs || require('./hostPreferenceService');
  // hostPreferenceService uses this check but does not export it.
  const verifyResidency = deps.verifyResidency || require('./hostPinPrimitives').verifyPinnedEntriesLoaded;
  const sessionHolds = deps.sessionHolds || require('./hostSessionHoldService');
  const physical = deps.physical || require('./runtimePhysicalResources');
  const actuator = deps.actuator || require('./runtimeTopologyActuator').createActuatorClient();
  const parking = deps.parking || require('./runtimeTopologyParking').defaultParking;
  const alerts = deps.alerts || require('./laneObservabilityService');
  const clearRoutingCache = deps.clearRoutingCache
    || (() => require('./routing/topologyRoleRouting').clearRoleRouteCache());
  const smoke = deps.smoke || defaultSmoke();
  const drift = deps.drift || defaultDrift();
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now || (() => new Date());
  const describe = deps.describe || (() => topology.describeTopology());
  const running = new Map(); // requestId -> driver promise (this process)

  // ---------------------------------------------------------------- records

  async function save(record, set, transition = null) {
    const update = { $set: { ...set, driverHeartbeatAt: now() } };
    if (transition) update.$push = { transitions: { state: transition.state, at: now(), detail: transition.detail || null } };
    const saved = await Switch.findOneAndUpdate({ requestId: record.requestId }, update, { new: true }).lean();
    Object.assign(record, saved);
    clearRoutingCache();
    return record;
  }

  async function move(record, state, detail = null, extra = {}) {
    logger.info('[Topology] switch state', { requestId: record.requestId, groupId: record.groupId, state, detail });
    return save(record, { state, ...extra }, { state, detail });
  }

  function timing(record, key, startedAt) {
    record.timings = { ...(record.timings || {}), [key]: Date.now() - startedAt };
    return record.timings;
  }

  // ---------------------------------------------------------------- request

  function groupEndpoints(group) {
    return [...new Set(group.modes.flatMap(mode => mode.endpoints.map(endpoint => endpoint.url)))];
  }

  async function prerequisites(group) {
    const missing = [];
    let resources = null;
    try { resources = physical.resourceTopology(); } catch { resources = null; }
    for (const url of groupEndpoints(group)) {
      const pref = await hostPrefs.getByHost(url) || (await hostPrefs.getAll())
        .find(item => hostUrlKey(item.hostUrl) === url);
      if (!pref) missing.push({ url, reason: 'not_registered' });
      else if (!hostPrefs.getPinnedEntries(pref).length) missing.push({ url, reason: 'no_pins' });
      if (!resources || !physical.resourcesFor(resources, [url]).length) missing.push({ url, reason: 'not_in_gpu_map' });
    }
    return missing;
  }

  async function request({ groupId, targetMode, expectedActiveMode = null, requestId, principal = 'operator', source = 'api' } = {}) {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      throw typed('TOPOLOGY_SWITCH_INVALID', 'requestId must match [A-Za-z0-9][A-Za-z0-9._:-]{0,99}', 400);
    }
    if (typeof groupId !== 'string' || !ID.test(groupId) || typeof targetMode !== 'string' || !ID.test(targetMode)) {
      throw typed('TOPOLOGY_SWITCH_INVALID', 'groupId and targetMode are required', 400);
    }
    const existing = await Switch.findOne({ requestId }).lean();
    if (existing) {
      if (existing.groupId !== groupId || existing.targetMode !== targetMode) {
        throw typed('TOPOLOGY_SWITCH_ID_CONFLICT', 'This requestId already names another switch', 409);
      }
      return { record: existing, idempotent: true };
    }
    let declared;
    try { declared = topology.parseTopology(); } catch {
      throw typed('TOPOLOGY_INVALID', 'The runtime topology declaration is invalid', 409);
    }
    const group = declared.groups.find(item => item.id === groupId);
    if (!group) throw typed('TOPOLOGY_GROUP_UNKNOWN', `No topology group ${groupId} is declared`, 404);
    if (!group.modes.some(mode => mode.id === targetMode)) {
      throw typed('TOPOLOGY_MODE_UNKNOWN', `Group ${groupId} declares no mode ${targetMode}`, 400);
    }
    if (!actuator.configured(groupId)) {
      throw typed('TOPOLOGY_ACTUATOR_NOT_CONFIGURED', `No host actuator is configured for ${groupId}`
        + ` (${actuator.configurationError(groupId) || 'topology_actuator_not_configured'})`, 409);
    }
    const open = await Switch.findOne({ groupId, state: { $nin: TERMINAL_STATES } }).lean();
    if (open) {
      throw typed('TOPOLOGY_SWITCH_IN_PROGRESS', `Switch ${open.requestId} is ${open.state}`, 409,
        { requestId: open.requestId, state: open.state });
    }
    const last = await Switch.findOne({ groupId }).sort({ createdAt: -1 }).lean();
    if (last?.state === 'uncertain' && !last.recovery?.recoveredAt && await leaseStillHeld(last)) {
      throw typed('TOPOLOGY_SWITCH_UNCERTAIN', `Switch ${last.requestId} ended uncertain; recover its maintenance lease first`, 409,
        { requestId: last.requestId });
    }
    const missing = await prerequisites(group);
    if (missing.length) {
      throw typed('TOPOLOGY_PREREQUISITE_MISSING', 'Every endpoint of the group must be a registered host with a pin and a GPU map entry', 409,
        { missing });
    }
    const observed = (await describe()).groups?.find(item => item.id === groupId);
    if (!observed || observed.state !== 'active') {
      throw typed('TOPOLOGY_GROUP_NOT_STABLE', `Group ${groupId} has no single active mode (${observed?.state || 'unknown'})`, 409,
        { state: observed?.state || null });
    }
    if (expectedActiveMode !== null && expectedActiveMode !== undefined && observed.activeMode !== expectedActiveMode) {
      throw typed('TOPOLOGY_MODE_CHANGED', `The active mode is ${observed.activeMode}, not ${expectedActiveMode}`, 409,
        { activeMode: observed.activeMode });
    }
    const base = {
      requestId, groupId, targetMode, expectedActiveMode: expectedActiveMode ?? null, fromMode: observed.activeMode,
      principal: String(principal).slice(0, 200), source: String(source).slice(0, 40), hosts: groupEndpoints(group)
    };
    if (observed.activeMode === targetMode) {
      const at = now();
      const record = await Switch.create({ ...base, state: 'active', reason: 'already_active',
        transitions: [{ state: 'requested', at }, { state: 'active', at, detail: 'already_active' }], finishedAt: at });
      return { record: record.toObject(), idempotent: false, alreadyActive: true };
    }
    let record;
    try {
      record = (await Switch.create({ ...base, state: 'requested', transitions: [{ state: 'requested', at: now() }],
        driverHeartbeatAt: now() })).toObject();
    } catch (error) {
      if (error?.code === 11000) return { record: await Switch.findOne({ requestId }).lean(), idempotent: true };
      throw error;
    }
    const driver = drive(record).catch(error => {
      logger.error('[Topology] switch driver failed', { requestId, error: error.message });
    }).finally(() => running.delete(requestId));
    running.set(requestId, driver);
    return { record, idempotent: false };
  }

  async function leaseStillHeld(record) {
    if (!record?.lease?.leaseId) return false;
    try {
      const active = await coordination.listActive();
      return active?.maintenance?.leaseId === record.lease.leaseId;
    } catch {
      return true;
    }
  }

  // ----------------------------------------------------------------- driver

  function leaseHandle(record) {
    const lease = record.lease || {};
    return { id: lease.leaseId, generation: lease.generation, principal: PRINCIPAL };
  }

  function startHeartbeat(record, ctx) {
    ctx.heartbeat = setInterval(async () => {
      try {
        const result = await coordination.heartbeat('maintenance', { ...leaseHandle(record), ttl: options.leaseTtlMs });
        if (!result?.heartbeat) {
          ctx.leaseLost = true;
          ctx.controller.abort();
        }
        await Switch.updateOne({ requestId: record.requestId }, { $set: { driverHeartbeatAt: now() } });
      } catch (error) {
        logger.warn('[Topology] switch heartbeat failed', { requestId: record.requestId, error: error.message });
      }
    }, options.heartbeatMs);
    ctx.heartbeat.unref?.();
  }

  function assertLease(ctx) {
    if (ctx.leaseLost) throw typed('TOPOLOGY_LEASE_LOST', 'The switch lost its maintenance lease', 409);
  }

  async function drain(record, ctx) {
    const started = Date.now();
    const deadline = started + options.drainTimeoutMs;
    let blockers = [];
    for (;;) {
      for (const url of record.hosts) {
        const pref = await hostPrefs.getByHost(url);
        if (pref && hostPrefs.hasActiveBenchmarkClaim(pref)) {
          return { ok: false, reason: 'benchmark_claim_active', blockers: [{ kind: 'benchmark-claim', hosts: [url] }] };
        }
      }
      const held = record.hosts.find(url => sessionHolds.isHostHeld?.(url));
      const result = held ? { acquired: false, blockers: [{ kind: 'inference-session-hold', hosts: [held] }] }
        : await coordination.acquireMaintenance({
          principal: PRINCIPAL, requestId: `topology-switch:${record.requestId}`, scope: 'host',
          hosts: record.hosts, ttl: options.leaseTtlMs, purpose: LEASE_PURPOSE
        });
      if (result?.acquired) {
        await save(record, { lease: { leaseId: result.leaseId, generation: result.generation,
          requestId: result.requestId, state: 'ACTIVE' }, timings: timing(record, 'drainMs', started) });
        startHeartbeat(record, ctx);
        return { ok: true };
      }
      if (result?.recoveryRequired) return { ok: false, reason: 'maintenance_recovery_required', blockers: result.blockers || [] };
      if (result?.failure?.cause) return { ok: false, reason: result.failure.cause, blockers: [] };
      blockers = (result?.blockers || []).map(item => ({
        kind: item.kind || null, hosts: item.hosts || [], owner: item.owner || null, since: item.start || null
      }));
      const hard = blockers.filter(item => !WAITABLE_BLOCKERS.test(String(item.kind || '')));
      if (hard.length) return { ok: false, reason: 'host_busy', blockers };
      if (Date.now() >= deadline) return { ok: false, reason: 'drain_timeout', blockers };
      await save(record, { blockers });
      await sleep(options.drainRetryMs);
    }
  }

  async function releaseLease(record) {
    if (!record.lease?.leaseId || record.lease.state !== 'ACTIVE') return true;
    try {
      const result = await coordination.release('maintenance', leaseHandle(record));
      await save(record, { 'lease.state': result?.released ? 'RELEASED' : (record.lease.state || 'ACTIVE') });
      return Boolean(result?.released);
    } catch (error) {
      logger.warn('[Topology] lease release failed', { requestId: record.requestId, error: error.message });
      return false;
    }
  }

  async function reconcileCommand(record, command) {
    for (let attempt = 0; attempt < options.reconcileAttempts; attempt += 1) {
      const status = await actuator.status(record.groupId, record.requestId);
      if (status.transport === 'ok') {
        await save(record, { 'actuator.status': status.receipt });
        const found = status.receipt?.receipts?.[command];
        if (found) return { known: true, receipt: found, status: status.receipt };
        const pending = status.receipt?.pending;
        if (command === 'activate' && pending?.requestId === record.requestId) {
          // Still running on the host, or interrupted: wait, then read again.
          if (attempt < options.reconcileAttempts - 1) { await sleep(options.reconcileDelayMs); continue; }
          return { known: false, status: status.receipt };
        }
        return { known: true, receipt: null, status: status.receipt };
      }
      if (attempt < options.reconcileAttempts - 1) await sleep(options.reconcileDelayMs);
    }
    return { known: false };
  }

  /** @returns {{kind: 'activated'|'refused'|'failed_restored'|'unknown', reason?}} */
  async function actuate(record) {
    const started = Date.now();
    const result = await actuator.activate(record.groupId, record.targetMode, record.requestId);
    let receipt = result.receipt;
    await save(record, { 'actuator.activate': receipt || { transport: result.transport, exitCode: result.exitCode } });
    if (result.transport === 'not_configured') return { kind: 'refused', reason: 'actuator_not_configured' };
    if (result.transport !== 'ok') {
      const reconciled = await reconcileCommand(record, 'activate');
      if (!reconciled.known) return { kind: 'unknown', reason: `actuator_${result.transport}` };
      if (!reconciled.receipt) return { kind: 'refused', reason: 'actuator_not_reached' };
      receipt = reconciled.receipt;
      await save(record, { 'actuator.activate': receipt });
    }
    timing(record, 'actuateMs', started);
    switch (receipt?.outcome) {
      case 'activated':
      case 'already_active':
        return { kind: 'activated' };
      case 'refused':
        return { kind: 'refused', reason: `actuator_${receipt.reason || 'refused'}` };
      case 'failed':
        return receipt.restored ? { kind: 'failed_restored', reason: `actuator_${receipt.reason || 'failed'}` }
          : { kind: 'unknown', reason: 'actuator_restore_failed' };
      default:
        return { kind: 'unknown', reason: `actuator_${receipt?.outcome || 'unknown'}` };
    }
  }

  function modeOf(record, modeId) {
    const declared = topology.parseTopology();
    const group = declared.groups.find(item => item.id === record.groupId);
    return group?.modes.find(mode => mode.id === modeId) || null;
  }

  async function loadPins(record, modeId, ctx) {
    const started = Date.now();
    const mode = modeOf(record, modeId);
    if (!mode) throw typed('TOPOLOGY_MODE_UNKNOWN', `Mode ${modeId} is no longer declared`);
    const deadline = AbortSignal.timeout(options.loadTimeoutMs);
    const signal = AbortSignal.any([ctx.controller.signal, deadline]);
    const results = [];
    for (const endpoint of mode.endpoints) {
      assertLease(ctx);
      const restored = await hostPrefs.restorePinnedModels(endpoint.url, {
        signal, allowParked: true, assertAuthorityActive: () => assertLease(ctx)
      });
      results.push({ url: endpoint.url, status: restored?.status || 'error', verified: restored?.verified === true });
      if (restored?.verified !== true) {
        throw typed('TOPOLOGY_PIN_LOAD_FAILED', `Pins did not load on ${endpoint.url}: ${restored?.error || restored?.status}`, 409,
          { results });
      }
    }
    timing(record, `${modeId === record.targetMode ? 'load' : 'restoreLoad'}Ms`, started);
    return results;
  }

  async function residencyOf(url) {
    const pref = await hostPrefs.getByHost(url);
    const entries = hostPrefs.getPinnedEntries(pref);
    const checked = await verifyResidency(url, entries, 15_000);
    const statuses = (checked?.statuses || []).map(status => ({
      model: status.model, loaded: Boolean(status.loaded), gpu: status.gpuResidency?.status || null,
      contextLength: status.loadedContextLength ?? null, expectedContext: status.expectedContextLength ?? null
    }));
    const contextExact = entries.every(entry => {
      if (!(Number(entry.contextSize) > 0)) return true;
      const found = statuses.find(status => status.model === entry.model);
      return found && Number(found.contextLength) === Number(entry.contextSize);
    });
    return { url, entries, ok: checked?.verified === true && checked?.gpuVerified === true && contextExact, statuses };
  }

  async function verify(record, modeId, ctx, { withDrift = true } = {}) {
    const started = Date.now();
    const mode = modeOf(record, modeId);
    const deadline = Date.now() + options.verifyTimeoutMs;
    let last = null;
    for (;;) {
      assertLease(ctx);
      const observed = (await describe()).groups?.find(item => item.id === record.groupId);
      const residency = [];
      for (const endpoint of mode.endpoints) residency.push(await residencyOf(endpoint.url));
      const modeActive = observed?.activeMode === modeId && observed?.state === 'active';
      last = { mode: modeId, observedMode: observed?.activeMode || null, groupState: observed?.state || null,
        residency: residency.map(({ entries, ...rest }) => rest) };
      if (modeActive && residency.every(item => item.ok)) {
        const smokes = [];
        for (const item of residency) {
          const pin = item.entries[0];
          let result;
          try {
            result = await smoke(item.url, pin, { signal: ctx.controller.signal, timeoutMs: options.smokeTimeoutMs });
          } catch (error) {
            result = { url: item.url, model: pin.model, ok: false, error: String(error.message).slice(0, 200) };
          }
          smokes.push(result);
        }
        last.smoke = smokes;
        if (!smokes.every(item => item.ok)) {
          throw typed('TOPOLOGY_SMOKE_FAILED', 'A smoke inference did not answer', 409, last);
        }
        if (withDrift) {
          last.drift = await drift();
          if (!['ok', 'partial'].includes(last.drift.status)) {
            throw typed('TOPOLOGY_PIN_DRIFT', `Pin drift is ${last.drift.status}`, 409, last);
          }
        }
        timing(record, modeId === record.targetMode ? 'verifyMs' : 'restoreVerifyMs', started);
        return last;
      }
      if (Date.now() >= deadline) throw typed('TOPOLOGY_VERIFY_TIMEOUT', `Mode ${modeId} did not verify in time`, 409, last);
      await save(record, { verification: last });
      await sleep(options.verifyPollMs);
    }
  }

  async function confirm(record) {
    const result = await actuator.confirm(record.groupId, record.requestId);
    if (result.transport === 'ok') {
      await save(record, { 'actuator.confirm': result.receipt });
      return result.outcome === 'confirmed';
    }
    const reconciled = await reconcileCommand(record, 'confirm');
    if (reconciled.receipt) {
      await save(record, { 'actuator.confirm': reconciled.receipt });
      return reconciled.receipt.outcome === 'confirmed';
    }
    return null; // unknown
  }

  async function finish(record, state, reason, message = null, extra = {}) {
    await move(record, state, reason, { reason, message: message ? String(message).slice(0, 1000) : null,
      finishedAt: now(), ...extra });
    if (state === 'rolled_back' || state === 'uncertain') {
      await alerts.observeTopologySwitchFailure?.({ groupId: record.groupId, requestId: record.requestId, state,
        reason, fromMode: record.fromMode, targetMode: record.targetMode, step: extra.step || null });
    }
    return record;
  }

  async function quarantine(record, reason, message) {
    if (record.lease?.leaseId && record.lease.state === 'ACTIVE') {
      try {
        await coordination.markMaintenanceUnknown({ ...leaseHandle(record), reason: `topology switch ${reason}` });
        await save(record, { 'lease.state': 'UNKNOWN' });
      } catch (error) {
        logger.error('[Topology] lease quarantine failed', { requestId: record.requestId, error: error.message });
      }
    }
    return finish(record, 'uncertain', reason, message, { step: record.state });
  }

  async function rollback(record, ctx, reason, error) {
    const step = record.state;
    await move(record, 'rolling_back', reason, { message: error?.message ? String(error.message).slice(0, 1000) : null,
      verification: error?.data || record.verification || null });
    const result = await actuator.rollback(record.groupId, `${record.requestId}-rb`, 'core_rollback');
    let receipt = result.receipt;
    if (result.transport !== 'ok') {
      const status = await actuator.status(record.groupId);
      receipt = status.transport === 'ok' ? status.receipt : null;
      await save(record, { 'actuator.status': receipt });
      const back = receipt && !receipt.pending && receipt.observedMode === record.fromMode
        && receipt.confirmedMode === record.fromMode;
      if (!back) return quarantine(record, 'rollback_unknown', 'The actuator rollback outcome is unknown');
    } else {
      await save(record, { 'actuator.rollback': receipt });
      if (!['rolled_back', 'already_active'].includes(receipt?.outcome)) {
        return quarantine(record, 'rollback_failed', `Actuator rollback ended ${receipt?.outcome}`);
      }
    }
    return restorePrevious(record, ctx, reason, step);
  }

  async function restorePrevious(record, ctx, reason, step) {
    try {
      const load = await loadPins(record, record.fromMode, ctx);
      const check = await verify(record, record.fromMode, ctx, { withDrift: false });
      await save(record, { restore: { load, verification: check } });
    } catch (error) {
      await save(record, { restore: { error: error.code || 'restore_failed', detail: error.data || null } });
      return quarantine(record, 'restore_unverified', `The previous mode did not verify: ${error.message}`);
    }
    await releaseLease(record);
    return finish(record, 'rolled_back', reason, record.message, { step });
  }

  async function drive(record) {
    const ctx = { controller: new AbortController(), leaseLost: false, heartbeat: null };
    const started = Date.now();
    parking.beginSwitch(record.groupId, { id: record.requestId, targetMode: record.targetMode });
    try {
      await move(record, 'draining');
      const drained = await drain(record, ctx);
      if (!drained.ok) return await finish(record, 'refused', drained.reason, null, { blockers: drained.blockers || [] });

      await move(record, 'actuating');
      const actuated = await actuate(record);
      if (actuated.kind === 'refused') {
        await releaseLease(record);
        return await finish(record, 'refused', actuated.reason);
      }
      if (actuated.kind === 'unknown') return await quarantine(record, actuated.reason, 'The actuator outcome is unknown');
      if (actuated.kind === 'failed_restored') {
        // The actuator put the previous mode back itself; restore its pins.
        await move(record, 'rolling_back', actuated.reason);
        return await restorePrevious(record, ctx, actuated.reason, 'actuating');
      }

      try {
        await move(record, 'loading');
        await loadPins(record, record.targetMode, ctx);
        await move(record, 'verifying');
        const verification = await verify(record, record.targetMode, ctx);
        await save(record, { verification });
      } catch (error) {
        if (ctx.leaseLost) return await quarantine(record, 'lease_lost', error.message);
        if (error.code === 'RUNTIME_MUTATION_OUTCOME_UNKNOWN') return await quarantine(record, 'pin_load_unknown', error.message);
        return await rollback(record, ctx, String(error.code || 'verify_failed').toLowerCase(), error);
      }

      const confirmed = await confirm(record);
      if (confirmed === null) return await quarantine(record, 'confirm_unknown', 'The actuator confirmation outcome is unknown');
      if (!confirmed) return await rollback(record, ctx, 'confirm_refused', null);
      await parking.setIntendedMode(record.groupId, record.targetMode, 'switch');
      await releaseLease(record);
      timing(record, 'totalMs', started);
      return await finish(record, 'active', null, null, { timings: record.timings, blockers: [] });
    } catch (error) {
      logger.error('[Topology] switch failed unexpectedly', { requestId: record.requestId, error: error.message });
      if (['requested', 'draining'].includes(record.state) && !record.lease?.leaseId) {
        return finish(record, 'refused', 'internal_error', error.message);
      }
      return quarantine(record, 'internal_error', error.message);
    } finally {
      if (ctx.heartbeat) clearInterval(ctx.heartbeat);
      parking.endSwitch(record.groupId);
      clearRoutingCache();
    }
  }

  // --------------------------------------------------------------- recovery

  /**
   * A switch whose driver stopped (Core restarted mid-switch). Before the
   * actuator was called it is refused and its lease released; after, it is
   * uncertain and quarantined. Never resumed.
   */
  async function recoverInterrupted() {
    const stale = new Date(now().getTime() - options.staleDriverMs);
    const open = await Switch.find({ state: { $nin: TERMINAL_STATES },
      $or: [{ driverHeartbeatAt: { $lt: stale } }, { driverHeartbeatAt: null }] }).lean();
    const recovered = [];
    for (const record of open) {
      if (running.has(record.requestId)) continue;
      if (['requested', 'draining'].includes(record.state)) {
        await releaseLease(record);
        await finish(record, 'refused', 'core_restarted');
      } else {
        await quarantine(record, 'core_restarted', 'Core stopped while the switch was running');
      }
      parking.endSwitch(record.groupId);
      recovered.push(record.requestId);
    }
    return recovered;
  }

  /**
   * Operator recovery of an uncertain switch. The actuator must report one
   * declared mode running, confirmed, with nothing pending; the operator
   * attests that the side effects were verified or rolled back. Core then
   * recovers the quarantined lease through the native maintenance recovery,
   * as its owner, and records the mode the host runs as the intended one.
   */
  async function recoverUncertain(requestId, { confirmation, operator = 'operator' } = {}) {
    if (confirmation !== 'MAINTENANCE_SIDE_EFFECTS_VERIFIED_OR_ROLLED_BACK') {
      throw typed('TOPOLOGY_RECOVERY_CONFIRMATION_REQUIRED',
        'confirmation must be MAINTENANCE_SIDE_EFFECTS_VERIFIED_OR_ROLLED_BACK', 400);
    }
    const record = await Switch.findOne({ requestId }).lean();
    if (!record) throw typed('TOPOLOGY_SWITCH_NOT_FOUND', 'No such switch', 404);
    if (record.state !== 'uncertain') throw typed('TOPOLOGY_SWITCH_NOT_UNCERTAIN', `Switch ${requestId} is ${record.state}`, 409);
    if (record.recovery?.recoveredAt) return { record: present(record), idempotent: true };
    const status = await actuator.status(record.groupId);
    const receipt = status.receipt;
    const declared = topology.parseTopology().groups.find(item => item.id === record.groupId);
    const known = status.transport === 'ok' && receipt && !receipt.pending
      && receipt.observedMode === receipt.confirmedMode
      && declared?.modes.some(mode => mode.id === receipt.observedMode);
    if (!known) {
      throw typed('TOPOLOGY_HOST_NOT_SETTLED', 'The actuator does not report one confirmed mode with nothing pending', 409,
        { transport: status.transport, observedMode: receipt?.observedMode || null,
          confirmedMode: receipt?.confirmedMode || null, pending: Boolean(receipt?.pending) });
    }
    let recovered = { recovered: true, skipped: 'no_quarantined_lease' };
    if (record.lease?.leaseId && record.lease.state === 'UNKNOWN') {
      recovered = await coordination.recoverMaintenanceAfterOperatorReconciliation({
        ...leaseHandle(record),
        receipt: { contract: 'agentx.maintenance-recovery/v1', maintenanceReconciled: true,
          confirmation, reconciledAt: now().toISOString() }
      });
      if (!recovered?.recovered) {
        throw typed('TOPOLOGY_LEASE_RECOVERY_REFUSED', recovered?.reason || 'The maintenance lease was not recovered', 409);
      }
    }
    await parking.setIntendedMode(record.groupId, receipt.observedMode, 'switch');
    const updated = await Switch.findOneAndUpdate({ requestId }, { $set: {
      'lease.state': record.lease?.leaseId ? 'RECOVERED' : record.lease?.state || null,
      recovery: { recoveredAt: now(), operator: String(operator).slice(0, 200), mode: receipt.observedMode,
        actuatorStatus: receipt, lease: recovered }
    } }, { new: true }).lean();
    clearRoutingCache();
    return { record: present(updated), idempotent: false };
  }

  // ------------------------------------------------------------------ reads

  async function get(requestId) {
    return present(await Switch.findOne({ requestId }).lean());
  }

  async function recent(groupId, limit = 5) {
    const filter = groupId ? { groupId } : {};
    const rows = await Switch.find(filter).sort({ createdAt: -1 }).limit(Math.min(Math.max(Number(limit) || 5, 1), 50)).lean();
    return rows.map(present);
  }

  async function openSwitches() {
    const rows = await Switch.find({ state: { $nin: TERMINAL_STATES } }).lean();
    return new Map(rows.map(row => [row.groupId, { id: row.requestId, targetMode: row.targetMode }]));
  }

  return Object.freeze({
    request, get, recent, openSwitches, recoverInterrupted, recoverUncertain,
    present, PRINCIPAL, LEASE_PURPOSE,
    // Tests: wait for this process's drivers.
    async settled() { await Promise.all([...running.values()]); }
  });
}

let defaultService = null;
function getTopologySwitchService() {
  if (!defaultService) defaultService = createTopologySwitchService();
  return defaultService;
}

module.exports = {
  DEFAULTS,
  PRINCIPAL,
  LEASE_PURPOSE,
  createTopologySwitchService,
  getTopologySwitchService,
  newRequestId: () => `topo-${crypto.randomUUID()}`
};
