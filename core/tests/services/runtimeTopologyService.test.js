'use strict';

jest.mock('../../src/services/hostPreferenceService', () => {
  const actual = jest.requireActual('../../src/services/hostPreferenceService');
  return { ...actual, getAll: jest.fn() };
});

const hostPrefService = require('../../src/services/hostPreferenceService');
const { parseTopology, describeTopology, resolveRole } = require('../../src/services/runtimeTopologyService');

const LANE_A = 'http://gpu-host.example:11437';
const LANE_B = 'http://gpu-host.example:11438';
const POOLED = 'http://gpu-host.example:11434';
const DECLARATION = JSON.stringify({ groups: [{ id: 'dual-gpu', label: 'Dual GPU host', modes: [
  { id: 'lanes', label: 'Two lanes', endpoints: [{ url: LANE_A, role: 'conversation' }, { url: LANE_B, role: 'background' }] },
  { id: 'pooled', label: 'Pooled', endpoints: [{ url: POOLED, role: 'pooled' }] }
] }] });

function pref(hostUrl, model, contextSize) {
  return { hostUrl, hostKey: hostUrl.slice(-5), displayName: `host ${hostUrl.slice(-5)}`, pinnedModels: [{ model, contextSize }] };
}

function fakeFetch(residentByUrl) {
  return jest.fn(async url => {
    const base = url.replace(/\/api\/ps$/, '');
    if (!(base in residentByUrl)) throw new Error('connection refused');
    return { ok: true, json: async () => ({ models: residentByUrl[base].map(([name, ctx]) => ({
      name, context_length: ctx, size: 100, size_vram: 100 })) }) };
  });
}

describe('parseTopology', () => {
  it('treats unset or empty as not configured', () => {
    expect(parseTopology(undefined)).toEqual({ configured: false, groups: [] });
    expect(parseTopology('')).toEqual({ configured: false, groups: [] });
  });

  it('normalizes a valid declaration and defaults labels to ids', () => {
    const parsed = parseTopology(JSON.stringify({ groups: [{ id: 'g', modes: [{ id: 'm', endpoints: [{ url: 'http://h:1/', role: 'pooled' }] }] }] }));
    expect(parsed.configured).toBe(true);
    expect(parsed.groups[0]).toMatchObject({ id: 'g', label: 'g', modes: [{ id: 'm', label: 'm', endpoints: [{ role: 'pooled' }] }] });
  });

  it.each([
    ['not JSON', '{'],
    ['unknown top-level key', JSON.stringify({ groups: [], extra: 1 })],
    ['unknown role', JSON.stringify({ groups: [{ id: 'g', modes: [{ id: 'm', endpoints: [{ url: POOLED, role: 'judge' }] }] }] })],
    ['duplicate role in a mode', JSON.stringify({ groups: [{ id: 'g', modes: [{ id: 'm', endpoints: [{ url: LANE_A, role: 'background' }, { url: LANE_B, role: 'background' }] }] }] })],
    ['endpoint with a path', JSON.stringify({ groups: [{ id: 'g', modes: [{ id: 'm', endpoints: [{ url: 'http://h:1/api', role: 'pooled' }] }] }] })],
    ['endpoint with credentials', JSON.stringify({ groups: [{ id: 'g', modes: [{ id: 'm', endpoints: [{ url: 'http://u:p@h:1', role: 'pooled' }] }] }] })],
    ['empty mode', JSON.stringify({ groups: [{ id: 'g', modes: [{ id: 'm', endpoints: [] }] }] })],
    ['duplicate group id', JSON.stringify({ groups: [{ id: 'g', modes: [{ id: 'm', endpoints: [{ url: LANE_A, role: 'pooled' }] }] }, { id: 'g', modes: [{ id: 'n', endpoints: [{ url: LANE_B, role: 'pooled' }] }] }] })],
    ['endpoint shared by two groups', JSON.stringify({ groups: [{ id: 'g', modes: [{ id: 'm', endpoints: [{ url: LANE_A, role: 'pooled' }] }] }, { id: 'h', modes: [{ id: 'n', endpoints: [{ url: LANE_A, role: 'pooled' }] }] }] })]
  ])('refuses %s without echoing the declaration', (_name, raw) => {
    expect(() => parseTopology(raw)).toThrow(expect.objectContaining({ code: 'runtime_topology_configuration_invalid' }));
    try { parseTopology(raw); } catch (error) { expect(error.message).not.toContain('gpu-host'); }
  });
});

describe('describeTopology', () => {
  beforeEach(() => {
    hostPrefService.getAll.mockResolvedValue([
      pref(POOLED, 'main-q8:latest', 196608), pref(LANE_A, 'main-q4:latest', 112640), pref(LANE_B, 'main-q4:latest', 112640)
    ]);
  });

  it('reports not configured without reading hosts', async () => {
    const fetchImpl = jest.fn();
    await expect(describeTopology({ raw: '', fetchImpl })).resolves.toMatchObject({ configured: false, valid: true, groups: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports an invalid declaration as data, not as an exception', async () => {
    const data = await describeTopology({ raw: '{', fetchImpl: jest.fn() });
    expect(data).toMatchObject({ configured: true, valid: false, code: 'runtime_topology_configuration_invalid' });
  });

  it('finds the pooled mode active when only the pooled endpoint runs its pin', async () => {
    const data = await describeTopology({ raw: DECLARATION, fetchImpl: fakeFetch({ [POOLED]: [['main-q8:latest', 196608]] }) });
    const [group] = data.groups;
    expect(group).toMatchObject({ activeMode: 'pooled', state: 'active' });
    expect(group.modes.find(mode => mode.id === 'pooled')).toMatchObject({ status: 'active' });
    const lanes = group.modes.find(mode => mode.id === 'lanes');
    expect(lanes.status).toBe('inactive');
    expect(lanes.endpoints.map(endpoint => endpoint.reason)).toEqual(['offline', 'offline']);
    expect(resolveRole(data, 'dual-gpu', 'pooled')).toEqual({ url: POOLED, mode: 'pooled', reason: null });
    expect(resolveRole(data, 'dual-gpu', 'conversation')).toEqual({ url: null, mode: 'pooled', reason: 'role_not_in_active_mode' });
  });

  it('finds the lanes mode active and resolves each role to its lane', async () => {
    const data = await describeTopology({ raw: DECLARATION, fetchImpl: fakeFetch({
      [LANE_A]: [['main-q4:latest', 112640]], [LANE_B]: [['main-q4:latest', 112640]] }) });
    expect(data.groups[0]).toMatchObject({ activeMode: 'lanes', state: 'active' });
    expect(resolveRole(data, 'dual-gpu', 'conversation').url).toBe(LANE_A);
    expect(resolveRole(data, 'dual-gpu', 'background').url).toBe(LANE_B);
  });

  it('calls a half-started mode transitional and resolves no role', async () => {
    const data = await describeTopology({ raw: DECLARATION, fetchImpl: fakeFetch({
      [LANE_A]: [['main-q4:latest', 112640]], [LANE_B]: [] }) });
    const [group] = data.groups;
    expect(group).toMatchObject({ activeMode: null, state: 'transitional' });
    expect(group.modes.find(mode => mode.id === 'lanes').endpoints[1].reason).toBe('pins_not_resident');
    expect(resolveRole(data, 'dual-gpu', 'conversation')).toEqual({ url: null, mode: null, reason: 'transitional' });
  });

  it('flags an endpoint missing from the host registry', async () => {
    hostPrefService.getAll.mockResolvedValue([pref(POOLED, 'main-q8:latest', 196608)]);
    const data = await describeTopology({ raw: DECLARATION, fetchImpl: fakeFetch({ [POOLED]: [['main-q8:latest', 196608]], [LANE_A]: [] }) });
    const lanes = data.groups[0].modes.find(mode => mode.id === 'lanes');
    expect(lanes.endpoints[0]).toMatchObject({ registered: false, reason: 'not_registered', ready: false });
  });

  it('rejects unknown roles and groups in resolution', () => {
    expect(resolveRole({ groups: [] }, 'dual-gpu', 'judge').reason).toBe('unknown_role');
    expect(resolveRole({ groups: [] }, 'dual-gpu', 'pooled').reason).toBe('unknown_group');
  });
});
