'use strict';

const {
  normalizeRoleTarget, createRoleResolver, roleRecommendation, checkLaneContext, checkLaneContract,
  ROLE_ROUTE_SOURCE, ROLE_UNRESOLVED_CODE, LANE_CONTEXT_EXCEEDED
} = require('../../src/services/routing/topologyRoleRouting');

const LANE_A = 'http://gpu-host.example:11437';
const LANE_B = 'http://gpu-host.example:11438';
const POOLED = 'http://gpu-host.example:11434';
const ONE_GROUP = JSON.stringify({ groups: [{ id: 'dual-gpu', modes: [
  { id: 'lanes', endpoints: [{ url: LANE_A, role: 'conversation' }, { url: LANE_B, role: 'background' }] },
  { id: 'pooled', endpoints: [{ url: POOLED, role: 'pooled' }] }
] }] });
const TWO_GROUPS = JSON.stringify({ groups: [
  { id: 'dual-gpu', modes: [{ id: 'pooled', endpoints: [{ url: POOLED, role: 'pooled' }] }] },
  { id: 'other', modes: [{ id: 'solo', endpoints: [{ url: 'http://other.example:11434', role: 'conversation' }] }] }
] });

function endpoint(url, role, pins = [{ model: 'lane-pin', contextSize: 98304 }], hostKey = null) {
  return { url, role, hostKey, pins, ready: true };
}

// A description as describeTopology returns it, with the chosen group state.
function description({ state = 'active', activeMode = 'lanes', lanesPins } = {}) {
  return {
    configured: true, valid: true, groups: [{
      id: 'dual-gpu', state, activeMode: state === 'active' ? activeMode : null,
      modes: [
        { id: 'lanes', status: activeMode === 'lanes' ? 'active' : 'inactive', endpoints: [
          endpoint(LANE_A, 'conversation', lanesPins, 'lane-a'), endpoint(LANE_B, 'background', lanesPins, 'lane-b')
        ] },
        { id: 'pooled', status: activeMode === 'pooled' ? 'active' : 'inactive', endpoints: [
          endpoint(POOLED, 'pooled', [{ model: 'pooled-pin', contextSize: 196608 }], 'pooled-host')
        ] }
      ]
    }]
  };
}

function resolver(options = {}) {
  let clock = 0;
  const describe = jest.fn(async () => options.description || description());
  const instance = createRoleResolver({
    describe: options.describe || describe, now: () => clock, ttlMs: 5000,
    readRaw: () => (options.raw === undefined ? ONE_GROUP : options.raw)
  });
  return { instance, describe: options.describe || describe, advance: ms => { clock += ms; } };
}

describe('route validation: host xor role', () => {
  it('leaves a host route to the host validation', () => {
    expect(normalizeRoleTarget({ model: 'm', host: 'primary' })).toBeNull();
  });

  it.each([
    ['host and role', { host: 'primary', role: 'conversation' }, 'never both'],
    ['a model with a role', { model: 'm', role: 'conversation' }, 'omit model'],
    ['an unknown role', { role: 'judge' }, 'Unknown role'],
    ['a group without a role', { model: 'm', host: 'primary', group: 'dual-gpu' }, 'only valid with role'],
    ['an invalid group', { role: 'pooled', group: 'bad group!' }, 'Invalid topology group']
  ])('refuses %s with 400', (_name, entry, message) => {
    expect(() => normalizeRoleTarget(entry)).toThrow(expect.objectContaining({ statusCode: 400, message: expect.stringContaining(message) }));
  });

  it('accepts a role, with a group when given', () => {
    expect(normalizeRoleTarget({ role: 'conversation' })).toEqual({ role: 'conversation' });
    expect(normalizeRoleTarget({ role: ' pooled ', group: 'dual-gpu', host: '', model: '' })).toEqual({ role: 'pooled', group: 'dual-gpu' });
  });

  it('on save, needs a declared topology, a known group, and a group among several', () => {
    const save = (entry, raw) => () => normalizeRoleTarget(entry, { requireTopology: true, raw });
    expect(save({ role: 'conversation' }, '')).toThrow(expect.objectContaining({ statusCode: 400, message: expect.stringContaining('declared runtime topology') }));
    expect(save({ role: 'conversation' }, '{')).toThrow(expect.objectContaining({ statusCode: 400, message: expect.stringContaining('invalid') }));
    expect(save({ role: 'conversation', group: 'nope' }, ONE_GROUP)).toThrow(expect.objectContaining({ message: expect.stringContaining('Unknown topology group') }));
    expect(save({ role: 'pooled' }, TWO_GROUPS)).toThrow(expect.objectContaining({ message: expect.stringContaining('group is required') }));
    expect(save({ role: 'pooled', group: 'dual-gpu' }, TWO_GROUPS)()).toEqual({ role: 'pooled', group: 'dual-gpu' });
    expect(save({ role: 'background' }, ONE_GROUP)()).toEqual({ role: 'background' });
  });
});

describe('role resolution through the cache', () => {
  it('resolves the role to its endpoint and first pin, naming the routing host key', async () => {
    const { instance } = resolver();
    const resolved = await instance.resolve({ role: 'conversation' }, { hosts: { primary: 'http://other:11434', laneA: `${LANE_A}/` } });
    expect(resolved).toEqual({
      ok: true, role: 'conversation', group: 'dual-gpu', mode: 'lanes', reason: null,
      url: LANE_A, host: 'laneA', model: 'lane-pin', laneContext: 98304
    });
    expect(instance.peek({ role: 'conversation' })).toEqual(resolved);
  });

  it('shares one observation within the TTL, including concurrent callers', async () => {
    const { instance, describe, advance } = resolver();
    await Promise.all([instance.resolve({ role: 'conversation' }), instance.resolve({ role: 'background' })]);
    await instance.resolve({ role: 'conversation' });
    expect(describe).toHaveBeenCalledTimes(1);
    advance(4999);
    await instance.resolve({ role: 'background' });
    expect(describe).toHaveBeenCalledTimes(1);
    advance(1);
    await instance.resolve({ role: 'background' });
    expect(describe).toHaveBeenCalledTimes(2);
  });

  it('observes again when the declaration changes', async () => {
    let raw = ONE_GROUP;
    const describe = jest.fn(async () => description());
    const instance = createRoleResolver({ describe, now: () => 0, readRaw: () => raw });
    await instance.resolve({ role: 'conversation' });
    raw = ONE_GROUP.replace('"id":"dual-gpu"', '"id":"dual-gpu","label":"Renamed"');
    await instance.resolve({ role: 'conversation' });
    expect(describe).toHaveBeenCalledTimes(2);
  });

  it('follows the active mode: the same role moves only when the mode changes', async () => {
    const { instance } = resolver({ description: description({ activeMode: 'pooled' }) });
    await expect(instance.resolve({ role: 'pooled' })).resolves.toMatchObject({ ok: true, url: POOLED, model: 'pooled-pin', laneContext: 196608 });
  });
});

describe('refusal shapes for each unresolved reason', () => {
  const cases = [
    ['topology_not_declared', { raw: '' }, { role: 'conversation' }],
    ['topology_invalid', { raw: '{' }, { role: 'conversation' }],
    ['group_required', { raw: TWO_GROUPS }, { role: 'pooled' }],
    ['unknown_group', {}, { role: 'pooled', group: 'missing' }],
    ['transitional', { description: description({ state: 'transitional' }) }, { role: 'conversation' }],
    ['none_active', { description: description({ state: 'none_active' }) }, { role: 'conversation' }],
    ['conflict', { description: description({ state: 'conflict' }) }, { role: 'conversation' }],
    ['role_not_in_active_mode', { description: description({ activeMode: 'pooled' }) }, { role: 'conversation' }],
    ['endpoint_has_no_pin', { description: description({ lanesPins: [] }) }, { role: 'background' }],
    ['topology_unavailable', { describe: jest.fn(async () => { throw new Error('mongo down'); }) }, { role: 'conversation' }]
  ];

  it.each(cases)('%s is refused with a typed reason and no target', async (reason, options, route) => {
    const { instance } = resolver(options);
    const resolution = await instance.resolve(route);
    expect(resolution).toMatchObject({ ok: false, role: route.role, reason });
    const recommendation = roleRecommendation(resolution);
    expect(recommendation).toMatchObject({
      model: null, host: null, url: null, source: 'topology_role_unresolved',
      topology: { role: route.role },
      refusal: {
        status: 503, code: ROLE_UNRESOLVED_CODE, reason,
        data: { role: route.role, reason }
      }
    });
    expect(recommendation.refusal.message).toContain(reason);
  });

  it('names the mode when the role is missing from the active mode', async () => {
    const { instance } = resolver({ description: description({ activeMode: 'pooled' }) });
    const { refusal } = roleRecommendation(await instance.resolve({ role: 'background' }));
    expect(refusal.data).toEqual({ role: 'background', group: 'dual-gpu', mode: 'pooled', reason: 'role_not_in_active_mode' });
  });

  it('a resolved role recommends its endpoint pin without a refusal', async () => {
    const { instance } = resolver();
    const recommendation = roleRecommendation(await instance.resolve({ role: 'background' }));
    expect(recommendation).toMatchObject({ model: 'lane-pin', url: LANE_B, source: ROLE_ROUTE_SOURCE,
      topology: { role: 'background', group: 'dual-gpu', mode: 'lanes', laneContext: 98304 } });
    expect(recommendation).not.toHaveProperty('refusal');
  });
});

describe('during a topology switch (#360 phase 4)', () => {
  it('refuses with topology_switch_in_progress and never reads the topology', async () => {
    const describe = jest.fn(async () => description());
    let switching = { id: 'sw-1', targetMode: 'pooled' };
    const instance = createRoleResolver({ describe, now: () => 0, readRaw: () => ONE_GROUP,
      switchInProgress: () => switching });
    const refused = await instance.resolve({ role: 'conversation' });
    expect(refused).toMatchObject({ ok: false, reason: 'topology_switch_in_progress', mode: 'pooled' });
    expect(roleRecommendation(refused).refusal).toMatchObject({ status: 503, code: ROLE_UNRESOLVED_CODE,
      reason: 'topology_switch_in_progress' });
    expect(describe).not.toHaveBeenCalled();
    switching = null;
    expect(await instance.resolve({ role: 'conversation' })).toMatchObject({ ok: true, url: LANE_A });
  });

  it('a cleared cache observes the new mode at once', async () => {
    let current = description({ activeMode: 'pooled' });
    const instance = createRoleResolver({ describe: async () => current, now: () => 0, readRaw: () => ONE_GROUP,
      switchInProgress: () => null });
    expect(await instance.resolve({ role: 'pooled' })).toMatchObject({ ok: true, url: POOLED });
    current = description({ activeMode: 'lanes' });
    expect(await instance.resolve({ role: 'pooled' })).toMatchObject({ ok: true, url: POOLED });
    instance.clear();
    expect(await instance.resolve({ role: 'pooled' })).toMatchObject({ ok: false, reason: 'role_not_in_active_mode' });
  });
});

describe('LANE_CONTEXT_EXCEEDED boundary', () => {
  const lane = { laneContext: 98304, role: 'conversation', mode: 'lanes', group: 'dual-gpu' };

  it('admits a request that fits exactly', () => {
    expect(checkLaneContext({ ...lane, estimatedInputTokens: 90112, outputBudget: 8192 })).toBeNull();
  });

  it('refuses one token over, with the sizes and a suggestion, never truncating', () => {
    const refusal = checkLaneContext({ ...lane, estimatedInputTokens: 90113, outputBudget: 8192 });
    expect(refusal).toMatchObject({
      status: 413, code: LANE_CONTEXT_EXCEEDED, suggestion: 'queue_for_pooled',
      data: { estimatedInputTokens: 90113, outputBudget: 8192, laneContext: 98304, role: 'conversation', mode: 'lanes', suggestion: 'queue_for_pooled' }
    });
    expect(refusal.message).toContain('nothing was truncated');
  });

  it('suggests reducing the input when the pooled lane itself is too small', () => {
    expect(checkLaneContext({ ...lane, role: 'pooled', estimatedInputTokens: 98304, outputBudget: 1 }).suggestion).toBe('reduce_input');
  });

  it('cannot judge without an estimate, a budget or a lane context', () => {
    expect(checkLaneContext({ ...lane, estimatedInputTokens: null, outputBudget: 1 })).toBeNull();
    expect(checkLaneContext({ ...lane, laneContext: null, estimatedInputTokens: 1e9, outputBudget: 1 })).toBeNull();
  });

  it('reads the inference contract budget for role routes only', () => {
    const contract = { contextBudget: { input: { estimatedTokens: 98000 }, output: { reservedTokens: 305 } } };
    expect(checkLaneContract({ ...lane }, contract)).toMatchObject({ code: LANE_CONTEXT_EXCEEDED });
    expect(checkLaneContract({ ...lane, laneContext: 98305 }, contract)).toBeNull();
    expect(checkLaneContract(null, contract)).toBeNull();
  });
});
