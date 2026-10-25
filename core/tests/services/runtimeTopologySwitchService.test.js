jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const Switch = require('../../models/RuntimeTopologySwitch');
const runtimeTopology = require('../../src/services/runtimeTopologyService');
const { createTopologySwitchService } = require('../../src/services/runtimeTopologySwitchService');

const LANE_A = 'http://gpu:11437';
const LANE_B = 'http://gpu:11438';
const POOLED = 'http://gpu:11434';
const RAW = JSON.stringify({ groups: [{ id: 'dual', modes: [
  { id: 'lanes', endpoints: [{ url: LANE_A, role: 'conversation' }, { url: LANE_B, role: 'background' }] },
  { id: 'pooled', endpoints: [{ url: POOLED, role: 'pooled' }] }
] }] });
const MODES = { lanes: [LANE_A, LANE_B], pooled: [POOLED] };
const PINS = {
  [LANE_A]: [{ model: 'lane-model', contextSize: 98304, keepAlive: -1 }],
  [LANE_B]: [{ model: 'lane-model', contextSize: 98304, keepAlive: -1 }],
  [POOLED]: [{ model: 'pooled-model', contextSize: 196608, keepAlive: -1 }, { model: 'embedder', contextSize: 8192, keepAlive: -1 }]
};

/** A fake GPU host: which mode runs, which endpoints have their pins loaded. */
function makeWorld(overrides = {}) {
  const world = {
    mode: 'pooled',
    loaded: new Set([POOLED]),
    leases: [],
    released: [],
    quarantined: [],
    actuatorCalls: [],
    receipts: {},
    alerts: [],
    cacheClears: 0,
    smokes: [],
    claims: new Set(),
    acquireResults: [],
    ...overrides
  };
  const receipt = (command, requestId, extra) => {
    const value = { schema: 'agentx.runtime-topology-actuation/v1', command, requestId, ...extra };
    world.receipts[requestId] = { ...(world.receipts[requestId] || {}), [command]: value };
    return value;
  };
  const actuator = {
    configured: () => true,
    configurationError: () => null,
    async activate(groupId, mode, requestId) {
      world.actuatorCalls.push(['activate', mode, requestId]);
      if (world.activateResult) return world.activateResult(world, { mode, requestId, receipt });
      const before = world.mode;
      world.mode = mode;
      world.loaded = new Set();
      return { transport: 'ok', outcome: 'activated', receipt: receipt('activate', requestId, { outcome: 'activated', modeBefore: before, modeAfter: mode }) };
    },
    async confirm(groupId, requestId) {
      world.actuatorCalls.push(['confirm', requestId]);
      if (world.confirmResult) return world.confirmResult(world, { requestId, receipt });
      world.confirmedMode = world.mode;
      return { transport: 'ok', outcome: 'confirmed', receipt: receipt('confirm', requestId, { outcome: 'confirmed' }) };
    },
    async rollback(groupId, requestId, reason) {
      world.actuatorCalls.push(['rollback', requestId, reason]);
      if (world.rollbackResult) return world.rollbackResult(world, { requestId, receipt });
      world.mode = world.previousMode || 'pooled';
      world.loaded = new Set();
      return { transport: 'ok', outcome: 'rolled_back', receipt: receipt('rollback', requestId, { outcome: 'rolled_back' }) };
    },
    async status(groupId, requestId) {
      world.actuatorCalls.push(['status', requestId || null]);
      if (world.statusResult) return world.statusResult(world, { requestId });
      return { transport: 'ok', outcome: 'observed', receipt: {
        schema: 'agentx.runtime-topology-actuation/v1', outcome: 'observed', observedMode: world.mode,
        confirmedMode: world.confirmedMode || world.mode, pending: null,
        receipts: requestId ? (world.receipts[requestId] || {}) : undefined } };
    }
  };
  const describe = async () => ({ configured: true, valid: true, groups: [{ id: 'dual',
    activeMode: MODES[world.mode].every(url => world.loaded.has(url)) ? world.mode : null,
    state: MODES[world.mode].every(url => world.loaded.has(url)) ? 'active' : 'transitional',
    modes: Object.keys(MODES).map(id => ({ id, endpoints: MODES[id].map(url => ({ url })) })) }] });
  const hostPrefs = {
    getByHost: async url => ({ hostUrl: url, pinnedModels: PINS[url], claim: world.claims.has(url) }),
    getAll: async () => Object.keys(PINS).map(url => ({ hostUrl: url, pinnedModels: PINS[url] })),
    getPinnedEntries: pref => pref?.pinnedModels || [],
    hasActiveBenchmarkClaim: pref => Boolean(pref?.claim),
    async restorePinnedModels(url, options) {
      expect(options.allowParked).toBe(true);
      options.assertAuthorityActive();
      if (world.failLoad?.has(url)) return { status: 'error', verified: false, error: 'load failed' };
      if (!MODES[world.mode].includes(url)) return { status: 'error', verified: false, error: 'offline' };
      world.loaded.add(url);
      return { status: 'ready', verified: true };
    }
  };
  const verifyResidency = {
    async check(url, entries) {
      const up = world.loaded.has(url) && !world.neverResident?.has(url);
      return { verified: up, gpuVerified: up, statuses: entries.map(entry => ({
        model: entry.model, loaded: up, loadedContextLength: up ? entry.contextSize : null,
        expectedContextLength: entry.contextSize, gpuResidency: { status: up ? 'full' : 'unknown' } })) };
    }
  };
  const coordination = {
    async acquireMaintenance(args) {
      world.leases.push(args);
      const next = world.acquireResults.shift();
      if (next) return next;
      return { acquired: true, leaseId: 'lease-1', generation: 'gen-1', requestId: args.requestId };
    },
    async heartbeat() { return { heartbeat: true }; },
    async release(kind, handle) { world.released.push(handle); return { released: true }; },
    async markMaintenanceUnknown(handle) { world.quarantined.push(handle); return { quarantined: true }; },
    async recoverMaintenanceAfterOperatorReconciliation(args) { world.recovered = args; return { recovered: true, released: true }; },
    async listActive() { return { maintenance: world.quarantined.length ? { leaseId: 'lease-1' } : null }; }
  };
  const parking = {
    begun: [], ended: [], intended: new Map(),
    beginSwitch(groupId, entry) { this.begun.push([groupId, entry]); },
    endSwitch(groupId) { this.ended.push(groupId); },
    async setIntendedMode(groupId, mode) { this.intended.set(groupId, mode); },
    intendedMode(groupId) { return this.intended.get(groupId) || null; },
    switchInProgress() { return null; }
  };
  world.parking = parking;
  const service = createTopologySwitchService({
    topology: { parseTopology: () => runtimeTopology.parseTopology(RAW), describeTopology: describe },
    describe,
    coordination, hostPrefs, actuator, parking,
    verifyResidency: (url, entries) => verifyResidency.check(url, entries),
    contextInfo: async (model, url) => (url === POOLED ? { verifiedMaxContext: 262144 } : (world.laneVerified ? { verifiedMaxContext: world.laneVerified } : {})),
    sessionHolds: { isHostHeld: () => null },
    physical: { resourceTopology: () => ({}), resourcesFor: (_, urls) => urls.map(() => 'gpu-x') },
    alerts: { observeTopologySwitchFailure: async event => { world.alerts.push(event); } },
    clearRoutingCache: () => { world.cacheClears += 1; },
    smoke: async (url, pin) => { world.smokes.push([url, pin.model, pin.contextSize]); return { url, ok: !world.failSmoke?.has(url) }; },
    drift: async () => ({ status: world.driftStatus || 'ok' }),
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))),
    options: { verifyTimeoutMs: 60, verifyPollMs: 1, drainTimeoutMs: 60, drainRetryMs: 1, reconcileDelayMs: 1, heartbeatMs: 60_000 },
    ...(overrides.deps || {})
  });
  world.service = service;
  return world;
}

async function run(world, body) {
  const result = await world.service.request({ groupId: 'dual', principal: 'tester', ...body });
  await world.service.settled();
  const record = await Switch.findOne({ requestId: body.requestId }).lean();
  return { result, record };
}

beforeEach(async () => {
  await Switch.deleteMany({});
});

describe('runtime topology switch', () => {
  it('switches pooled -> lanes: drain, actuate, load, verify, confirm', async () => {
    const world = makeWorld();
    const { result, record } = await run(world, { targetMode: 'lanes', expectedActiveMode: 'pooled', requestId: 'sw-1' });
    expect(result.idempotent).toBe(false);
    expect(record.state).toBe('active');
    expect(record.fromMode).toBe('pooled');
    expect(record.transitions.map(item => item.state)).toEqual(
      ['requested', 'draining', 'actuating', 'loading', 'verifying', 'active']);
    expect(world.leases[0]).toMatchObject({ scope: 'host', purpose: 'topology-switch',
      hosts: expect.arrayContaining([LANE_A, LANE_B, POOLED]) });
    expect(world.actuatorCalls.map(call => call[0])).toEqual(['activate', 'confirm']);
    expect(world.smokes).toEqual([[LANE_A, 'lane-model', 98304], [LANE_B, 'lane-model', 98304]]);
    expect(record.verification.drift.status).toBe('ok');
    expect(record.verification.context).toEqual([
      expect.objectContaining({ url: LANE_A, pinnedContext: 98304, verifiedContext: null, status: 'unverified' }),
      expect.objectContaining({ url: LANE_B, status: 'unverified' })]);
    expect(record.verification.residency.every(item => item.ok)).toBe(true);
    expect(world.released).toHaveLength(1);
    expect(world.parking.intended.get('dual')).toBe('lanes');
    expect(world.parking.ended).toEqual(['dual']);
    expect(record.actuator.activate.outcome).toBe('activated');
    expect(record.actuator.confirm.outcome).toBe('confirmed');
    expect(world.alerts).toEqual([]);
    expect(record.lease.leaseId).toBe('lease-1');
    expect(world.service.present(record).lease).toEqual({ state: 'RELEASED', held: false });
    expect(record.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('switches lanes -> pooled and smokes only the pooled primary pin', async () => {
    const world = makeWorld({ mode: 'lanes', loaded: new Set([LANE_A, LANE_B]) });
    const { record } = await run(world, { targetMode: 'pooled', expectedActiveMode: 'lanes', requestId: 'sw-2' });
    expect(record.state).toBe('active');
    expect(world.smokes).toEqual([[POOLED, 'pooled-model', 196608]]);
    expect(record.verification.context).toEqual([expect.objectContaining({ url: POOLED, verifiedContext: 262144, status: 'verified' })]);
    expect(world.parking.intended.get('dual')).toBe('pooled');
  });

  it('invalidates the role routing cache on every state change', async () => {
    const world = makeWorld();
    await run(world, { targetMode: 'lanes', requestId: 'sw-cache' });
    expect(world.cacheClears).toBeGreaterThanOrEqual(6);
  });

  it('records an already active target without touching the host', async () => {
    const world = makeWorld();
    const { result, record } = await run(world, { targetMode: 'pooled', requestId: 'sw-same' });
    expect(result.alreadyActive).toBe(true);
    expect(record.state).toBe('active');
    expect(record.reason).toBe('already_active');
    expect(world.leases).toHaveLength(0);
    expect(world.actuatorCalls).toHaveLength(0);
  });

  it('refuses when the active mode is not the expected one', async () => {
    const world = makeWorld();
    await expect(world.service.request({ groupId: 'dual', targetMode: 'lanes', expectedActiveMode: 'lanes', requestId: 'sw-x' }))
      .rejects.toMatchObject({ code: 'TOPOLOGY_MODE_CHANGED', statusCode: 409 });
    expect(await Switch.countDocuments()).toBe(0);
  });

  it('refuses unknown groups, modes and malformed ids before anything runs', async () => {
    const world = makeWorld();
    await expect(world.service.request({ groupId: 'other', targetMode: 'lanes', requestId: 'a' }))
      .rejects.toMatchObject({ code: 'TOPOLOGY_GROUP_UNKNOWN' });
    await expect(world.service.request({ groupId: 'dual', targetMode: 'huge', requestId: 'a' }))
      .rejects.toMatchObject({ code: 'TOPOLOGY_MODE_UNKNOWN' });
    await expect(world.service.request({ groupId: 'dual', targetMode: 'lanes', requestId: 'a b' }))
      .rejects.toMatchObject({ code: 'TOPOLOGY_SWITCH_INVALID' });
  });

  it('is idempotent by request id: a lost answer reads back the same switch', async () => {
    const world = makeWorld();
    await run(world, { targetMode: 'lanes', requestId: 'sw-lost' });
    const again = await world.service.request({ groupId: 'dual', targetMode: 'lanes', requestId: 'sw-lost' });
    expect(again.idempotent).toBe(true);
    expect(again.record.state).toBe('active');
    expect(world.actuatorCalls.filter(call => call[0] === 'activate')).toHaveLength(1);
    await expect(world.service.request({ groupId: 'dual', targetMode: 'pooled', requestId: 'sw-lost' }))
      .rejects.toMatchObject({ code: 'TOPOLOGY_SWITCH_ID_CONFLICT' });
    expect((await world.service.get('sw-lost')).state).toBe('active');
  });

  it('refuses a second switch while one is open', async () => {
    const world = makeWorld();
    await Switch.create({ requestId: 'open-1', groupId: 'dual', targetMode: 'lanes', principal: 't', state: 'verifying' });
    await expect(world.service.request({ groupId: 'dual', targetMode: 'lanes', requestId: 'sw-3' }))
      .rejects.toMatchObject({ code: 'TOPOLOGY_SWITCH_IN_PROGRESS', data: { requestId: 'open-1' } });
  });

  it('refuses at once when a workload holds the hosts, and never actuates', async () => {
    const world = makeWorld({ acquireResults: [{ acquired: false, reason: 'busy',
      blockers: [{ kind: 'workload', hosts: [POOLED], owner: 'benchmark' }] }] });
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-busy' });
    expect(record.state).toBe('refused');
    expect(record.reason).toBe('host_busy');
    expect(record.blockers[0]).toMatchObject({ kind: 'workload' });
    expect(world.actuatorCalls).toHaveLength(0);
    expect(world.parking.intended.size).toBe(0);
  });

  it('refuses when a Benchmark claim holds a host', async () => {
    const world = makeWorld();
    world.claims.add(POOLED);
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-claim' });
    expect(record.reason).toBe('benchmark_claim_active');
    expect(world.leases).toHaveLength(0);
  });

  it('waits for inferences to finish, then drains', async () => {
    const busy = { acquired: false, reason: 'busy', blockers: [{ kind: 'inference-interactive', hosts: [POOLED] }] };
    const world = makeWorld({ acquireResults: [busy, busy] });
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-wait' });
    expect(world.leases).toHaveLength(3);
    expect(record.state).toBe('active');
  });

  it('gives up draining after its bound with the blockers it saw', async () => {
    const busy = { acquired: false, reason: 'busy', blockers: [{ kind: 'inference-automated', hosts: [POOLED] }] };
    const world = makeWorld({ acquireResults: Array.from({ length: 500 }, () => busy) });
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-drain-timeout' });
    expect(record.state).toBe('refused');
    expect(record.reason).toBe('drain_timeout');
    expect(world.actuatorCalls).toHaveLength(0);
  });

  it('an actuator failure it restored itself ends rolled back with the previous pins verified', async () => {
    const world = makeWorld({ activateResult: (w, { requestId, receipt }) => {
      w.loaded = new Set(); // the actuator's restore stopped and restarted the pooled unit
      return { transport: 'ok', outcome: 'failed',
        receipt: receipt('activate', requestId, { outcome: 'failed', reason: 'unit_start_failed', restored: true }) };
    } });
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-actfail' });
    expect(record.state).toBe('rolled_back');
    expect(record.reason).toBe('actuator_unit_start_failed');
    expect(record.restore.verification.mode).toBe('pooled');
    expect(world.released).toHaveLength(1);
    expect(world.alerts).toEqual([expect.objectContaining({ state: 'rolled_back', requestId: 'sw-actfail' })]);
    expect(world.parking.intended.size).toBe(0);
  });

  it('an actuator refusal leaves the host untouched and ends refused', async () => {
    const world = makeWorld({ activateResult: (w, { requestId, receipt }) => ({ transport: 'ok', outcome: 'refused',
      receipt: receipt('activate', requestId, { outcome: 'refused', reason: 'activation_pending' }) }) });
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-actref' });
    expect(record.state).toBe('refused');
    expect(record.reason).toBe('actuator_activation_pending');
    expect(world.released).toHaveLength(1);
  });

  it('a verify timeout rolls back through the actuator and restores pooled', async () => {
    const world = makeWorld({ previousMode: 'pooled' });
    world.neverResident = new Set([LANE_B]);
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-verify' });
    expect(record.state).toBe('rolled_back');
    expect(record.reason).toBe('topology_verify_timeout');
    expect(world.actuatorCalls.map(call => call[0])).toEqual(['activate', 'rollback']);
    expect(world.actuatorCalls[1][1]).toBe('sw-verify-rb');
    expect(record.transitions.map(item => item.state)).toContain('rolling_back');
    expect(world.mode).toBe('pooled');
    expect(world.released).toHaveLength(1);
    expect(world.alerts[0]).toMatchObject({ state: 'rolled_back', reason: 'topology_verify_timeout' });
  });

  it('a failed smoke inference rolls back', async () => {
    const world = makeWorld();
    world.failSmoke = new Set([LANE_A]);
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-smoke' });
    expect(record.state).toBe('rolled_back');
    expect(record.reason).toBe('topology_smoke_failed');
  });

  it('pin drift other than ok rolls back', async () => {
    const world = makeWorld({ driftStatus: 'drift' });
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-drift' });
    expect(record.state).toBe('rolled_back');
    expect(record.reason).toBe('topology_pin_drift');
  });

  it('a lost activate answer is reconciled from the actuator by request id', async () => {
    const world = makeWorld({ activateResult: (w, { mode, requestId, receipt }) => {
      w.mode = mode; w.loaded = new Set();
      receipt('activate', requestId, { outcome: 'activated' });
      return { transport: 'timeout', outcome: 'unknown', receipt: null };
    } });
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-timeout' });
    expect(record.state).toBe('active');
    expect(world.actuatorCalls.filter(call => call[0] === 'activate')).toHaveLength(1);
    expect(world.actuatorCalls.some(call => call[0] === 'status' && call[1] === 'sw-timeout')).toBe(true);
  });

  it('an activate that never reached the host ends refused', async () => {
    const world = makeWorld({ activateResult: () => ({ transport: 'unreachable', outcome: 'unknown', receipt: null }) });
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-unreached' });
    expect(record.state).toBe('refused');
    expect(record.reason).toBe('actuator_not_reached');
  });

  it('an outcome nobody can read ends uncertain and quarantines the lease, without retrying', async () => {
    const world = makeWorld({
      activateResult: () => ({ transport: 'timeout', outcome: 'unknown', receipt: null }),
      statusResult: () => ({ transport: 'unreachable', outcome: 'unknown', receipt: null })
    });
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-uncertain' });
    expect(record.state).toBe('uncertain');
    expect(record.reason).toBe('actuator_timeout');
    expect(world.quarantined).toEqual([expect.objectContaining({ id: 'lease-1', generation: 'gen-1' })]);
    expect(world.released).toHaveLength(0);
    expect(world.actuatorCalls.filter(call => call[0] === 'activate')).toHaveLength(1);
    expect(world.alerts[0]).toMatchObject({ state: 'uncertain' });
    await expect(world.service.request({ groupId: 'dual', targetMode: 'lanes', requestId: 'sw-next' }))
      .rejects.toMatchObject({ code: 'TOPOLOGY_SWITCH_UNCERTAIN' });
  });

  it('a lost confirmation ends uncertain rather than active', async () => {
    const world = makeWorld({
      confirmResult: () => ({ transport: 'timeout', outcome: 'unknown', receipt: null }),
      statusResult: () => ({ transport: 'unreachable', outcome: 'unknown', receipt: null })
    });
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-confirm' });
    expect(record.state).toBe('uncertain');
    expect(record.reason).toBe('confirm_unknown');
    expect(world.parking.intended.size).toBe(0);
  });

  it('a failed rollback ends uncertain', async () => {
    const world = makeWorld({ rollbackResult: (w, { requestId, receipt }) => ({ transport: 'ok', outcome: 'failed',
      receipt: receipt('rollback', requestId, { outcome: 'failed' }) }) });
    world.failLoad = new Set([LANE_A]);
    const { record } = await run(world, { targetMode: 'lanes', requestId: 'sw-rbfail' });
    expect(record.state).toBe('uncertain');
    expect(record.reason).toBe('rollback_failed');
    expect(world.quarantined).toHaveLength(1);
  });

  it('recovers a switch whose driver stopped: refused before actuation, uncertain after', async () => {
    const world = makeWorld();
    const old = new Date(Date.now() - 10 * 60_000);
    await Switch.create({ requestId: 'stale-drain', groupId: 'dual', targetMode: 'lanes', principal: 't',
      state: 'draining', driverHeartbeatAt: old, lease: { leaseId: 'l1', generation: 'g1', state: 'ACTIVE' } });
    await Switch.create({ requestId: 'stale-load', groupId: 'dual2', targetMode: 'lanes', principal: 't',
      state: 'loading', driverHeartbeatAt: old, lease: { leaseId: 'l2', generation: 'g2', state: 'ACTIVE' } });
    await Switch.create({ requestId: 'fresh', groupId: 'dual3', targetMode: 'lanes', principal: 't',
      state: 'loading', driverHeartbeatAt: new Date() });
    const recovered = await world.service.recoverInterrupted();
    expect(recovered.sort()).toEqual(['stale-drain', 'stale-load']);
    expect((await Switch.findOne({ requestId: 'stale-drain' }).lean())).toMatchObject({ state: 'refused', reason: 'core_restarted' });
    expect((await Switch.findOne({ requestId: 'stale-load' }).lean())).toMatchObject({ state: 'uncertain', reason: 'core_restarted' });
    expect(world.released).toEqual([expect.objectContaining({ id: 'l1' })]);
    expect(world.quarantined).toEqual([expect.objectContaining({ id: 'l2' })]);
    expect((await Switch.findOne({ requestId: 'fresh' }).lean()).state).toBe('loading');
  });

  it('recovers an uncertain switch only when the actuator reports one settled mode', async () => {
    const world = makeWorld({
      activateResult: () => ({ transport: 'timeout', outcome: 'unknown', receipt: null }),
      statusResult: () => ({ transport: 'unreachable', outcome: 'unknown', receipt: null })
    });
    await run(world, { targetMode: 'lanes', requestId: 'sw-recover' });
    await expect(world.service.recoverUncertain('sw-recover', {}))
      .rejects.toMatchObject({ code: 'TOPOLOGY_RECOVERY_CONFIRMATION_REQUIRED' });
    const confirmation = 'MAINTENANCE_SIDE_EFFECTS_VERIFIED_OR_ROLLED_BACK';
    await expect(world.service.recoverUncertain('sw-recover', { confirmation }))
      .rejects.toMatchObject({ code: 'TOPOLOGY_HOST_NOT_SETTLED' });
    world.statusResult = (w) => ({ transport: 'ok', outcome: 'observed', receipt: {
      schema: 'agentx.runtime-topology-actuation/v1', outcome: 'observed', observedMode: 'lanes', confirmedMode: 'pooled', pending: null } });
    await expect(world.service.recoverUncertain('sw-recover', { confirmation }))
      .rejects.toMatchObject({ code: 'TOPOLOGY_HOST_NOT_SETTLED' });
    world.statusResult = null;
    world.mode = 'pooled'; world.confirmedMode = 'pooled';
    const { record } = await world.service.recoverUncertain('sw-recover', { confirmation, operator: 'operator' });
    expect(world.recovered).toMatchObject({ id: 'lease-1', generation: 'gen-1',
      principal: 'core-topology-switch', receipt: { confirmation } });
    expect(record.recovery).toMatchObject({ mode: 'pooled', operator: 'operator' });
    expect(record.lease.state).toBe('RECOVERED');
    expect(world.parking.intended.get('dual')).toBe('pooled');
    expect((await world.service.recoverUncertain('sw-recover', { confirmation })).idempotent).toBe(true);
    await expect(world.service.request({ groupId: 'dual', targetMode: 'lanes', requestId: 'sw-after' })).resolves.toBeTruthy();
  });

  it('refuses when an endpoint lacks a pin or a GPU map entry', async () => {
    const world = makeWorld({ deps: {
      physical: { resourceTopology: () => ({}), resourcesFor: (_, urls) => (urls[0] === LANE_B ? [] : ['gpu']) }
    } });
    await expect(world.service.request({ groupId: 'dual', targetMode: 'lanes', requestId: 'sw-pre' }))
      .rejects.toMatchObject({ code: 'TOPOLOGY_PREREQUISITE_MISSING',
        data: { missing: [{ url: LANE_B, reason: 'not_in_gpu_map' }] } });
  });
});
