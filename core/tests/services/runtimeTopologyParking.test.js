const { parkedEndpoints, createParking } = require('../../src/services/runtimeTopologyParking');

const RAW = JSON.stringify({ groups: [{ id: 'dual', modes: [
  { id: 'lanes', endpoints: [{ url: 'http://gpu:11437', role: 'conversation' }, { url: 'http://gpu:11438', role: 'background' }] },
  { id: 'pooled', endpoints: [{ url: 'http://gpu:11434', role: 'pooled' }] }
] }] });

function description(activeMode) {
  const mode = (id, urls) => ({ id, status: id === activeMode ? 'active' : 'inactive',
    endpoints: urls.map(url => ({ url })) });
  return { configured: true, valid: true, groups: [{ id: 'dual', activeMode,
    state: activeMode ? 'active' : 'none_active',
    modes: [mode('lanes', ['http://gpu:11437', 'http://gpu:11438']), mode('pooled', ['http://gpu:11434'])] }] };
}

describe('parked hosts', () => {
  it('parks the endpoints of the inactive mode only', () => {
    const parked = parkedEndpoints(description('pooled'));
    expect([...parked.keys()].sort()).toEqual(['http://gpu:11437', 'http://gpu:11438']);
    expect(parked.get('http://gpu:11437')).toMatchObject({ mode: 'lanes', intendedMode: 'pooled', reason: 'inactive_topology_mode' });
  });

  it('keeps the intended mode when it crashes, so its alerts still fire', () => {
    const parked = parkedEndpoints(description(null), new Map([['dual', 'pooled']]));
    expect(parked.has('http://gpu:11434')).toBe(false);
    expect(parked.has('http://gpu:11437')).toBe(true);
  });

  it('parks nothing for a group with no running and no recorded mode', () => {
    expect(parkedEndpoints(description(null)).size).toBe(0);
  });

  it('parks every endpoint of a group while it switches', () => {
    const parked = parkedEndpoints(description('pooled'), new Map([['dual', 'pooled']]),
      new Map([['dual', { id: 'sw-1', targetMode: 'lanes' }]]));
    expect(parked.size).toBe(3);
    expect(parked.get('http://gpu:11434')).toMatchObject({ reason: 'topology_switch_in_progress', switchId: 'sw-1' });
  });

  it('never parks an endpoint the intended mode also uses', () => {
    const shared = description('pooled');
    shared.groups[0].modes[0].endpoints.push({ url: 'http://gpu:11434' });
    expect(parkedEndpoints(shared).has('http://gpu:11434')).toBe(false);
  });

  it('parks nothing without a valid declaration', () => {
    expect(parkedEndpoints({ configured: true, valid: false, groups: [] }).size).toBe(0);
    expect(parkedEndpoints(null).size).toBe(0);
  });

  it('records the first observed mode and never lets a crash override it', async () => {
    const saved = [];
    let current = description('pooled');
    const parking = createParking({
      readRaw: () => RAW,
      describe: async () => current,
      store: { load: async () => new Map(), save: async (...args) => { saved.push(args); } }
    });
    await parking.refresh();
    expect(parking.intendedMode('dual')).toBe('pooled');
    expect(saved).toEqual([['dual', 'pooled', 'observed']]);
    current = description(null);
    await parking.refresh();
    expect(parking.isParkedHost('http://gpu:11434')).toBe(false);
    expect(parking.isParkedHost('http://gpu:11437/')).toBe(true);
  });

  it('loads a persisted intent and follows switches', async () => {
    const parking = createParking({
      readRaw: () => RAW,
      describe: async () => description('lanes'),
      store: { load: async () => new Map([['dual', 'lanes']]), save: async () => {} }
    });
    await parking.refresh();
    expect(parking.isParkedHost('http://gpu:11434')).toBe(true);
    parking.beginSwitch('dual', { id: 'sw-2', targetMode: 'pooled' });
    expect(parking.isParkedHost('http://gpu:11437')).toBe(true);
    expect(parking.parkedReason('http://gpu:11437').reason).toBe('topology_switch_in_progress');
    await parking.setIntendedMode('dual', 'pooled');
    parking.endSwitch('dual');
    expect(parking.isParkedHost('http://gpu:11434')).toBe(false);
    expect(parking.isParkedHost('http://gpu:11438')).toBe(true);
  });

  it('parks nothing when no topology is declared', async () => {
    const parking = createParking({ readRaw: () => '', describe: async () => { throw new Error('never'); } });
    await parking.refresh();
    expect(parking.parkedHosts()).toEqual([]);
  });
});
