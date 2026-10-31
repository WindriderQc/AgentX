'use strict';

const { readLiveWorld } = require('../../src/services/island/islandLiveWorld');
const { islandWorlds } = require('../../src/services/island/islandWorlds');
const { loadBrowserModule } = require('../helpers/browserModule');

const mesa = { id: 'remote-mesa', label: 'Île Mesa', live: 'https://world.lan:18794', liveWorld: 'mesa-island' };
const living = { id: 'remote-living', label: 'Île vivante', live: mesa.live, liveWorld: 'living-island' };
const env = { AGENTX_ISLAND_GRAPHYSX_URL: 'https://viewer.lan/', AGENTX_ISLAND_WORLDS: JSON.stringify([mesa, living]) };
const health = world => async () => ({ ok: true, json: async () => ({ ok: true, world, tick: 10 }) });

it('names the living world when Mesa was selected on the same service; reading never switches worlds', async () => {
  const fetchImpl = jest.fn(health('living-island'));
  const data = await readLiveWorld(mesa.id, { env, fetchImpl });
  expect(data).toMatchObject({ available: true, selectedId: mesa.id, selectedActive: false,
    activeWorld: { id: 'living-island', label: living.label } });
  expect(new URL(data.liveUrl).searchParams.get('source')).toBe(mesa.live);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledWith(`${mesa.live}/healthz`, expect.objectContaining({ method: 'GET', redirect: 'error' }));
  expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('body');
  expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});

it('recognizes a world switch, and does not use a label from another service', async () => {
  expect(await readLiveWorld(mesa.id, { env, fetchImpl: health('mesa-island') }))
    .toMatchObject({ selectedActive: true, activeWorld: { label: mesa.label } });
  const other = { ...living, live: 'https://other-world.lan' };
  const separate = { ...env, AGENTX_ISLAND_WORLDS: JSON.stringify([mesa, other]) };
  expect(await readLiveWorld(mesa.id, { env: separate, fetchImpl: health('living-island') }))
    .toMatchObject({ selectedActive: false, activeWorld: { label: 'living-island' } });
});

it('defaults the expected service world to the terrain id for existing configurations', async () => {
  const same = { ...mesa, id: 'mesa-island' };
  delete same.liveWorld;
  expect(await readLiveWorld(same.id, { env: { ...env, AGENTX_ISLAND_WORLDS: JSON.stringify([same]) }, fetchImpl: health(same.id) }))
    .toMatchObject({ selectedActive: true, activeWorld: { label: mesa.label } });
});

it.each([
  async () => { throw new Error('offline'); },
  async () => ({ ok: false, status: 503 }),
  async () => ({ ok: true, json: async () => { throw new Error('not JSON'); } }),
  async () => ({ ok: true, json: async () => ({ ok: false, world: 'mesa-island' }) }),
  async () => ({ ok: true, json: async () => ({ ok: true }) }),
  health('<script>'),
  health('x'.repeat(65))
])('never advertises the selected terrain if the active identity is unreadable (%#)', async fetchImpl => {
  expect(await readLiveWorld(mesa.id, { env, fetchImpl })).toEqual({
    selectedId: mesa.id, available: false, activeWorld: null, selectedActive: null, liveUrl: null
  });
});

it('only probes configured worlds with an available viewer', async () => {
  const fetchImpl = jest.fn();
  await expect(readLiveWorld('https://elsewhere.example', { env, fetchImpl })).rejects.toMatchObject({ statusCode: 404 });
  expect(await readLiveWorld(mesa.id, { env: { ...env, AGENTX_ISLAND_GRAPHYSX_URL: '' }, fetchImpl }))
    .toMatchObject({ available: false });
  expect(await readLiveWorld('mesa-island', { env: {}, fetchImpl })).toMatchObject({ available: false });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('validates the service identity mapping without changing legacy catalogue entries', () => {
  expect(islandWorlds(env).worlds).toEqual([mesa, living]);
  for (const liveWorld of ['', null, '../x', 42]) {
    expect(islandWorlds({ AGENTX_ISLAND_WORLDS: JSON.stringify([{ ...mesa, liveWorld }]) }).error).toMatch(/liveWorld/);
  }
  expect(islandWorlds({ AGENTX_ISLAND_WORLDS: JSON.stringify([{ ...mesa, live: null }]) }).error).toMatch(/liveWorld/);
});

it('presents the actual world instead of falsely labelling it Mesa, and fails closed', () => {
  const page = loadBrowserModule('island/index.js', 'liveWorldPresentation');
  const live = { available: true, selectedActive: false, activeWorld: { label: living.label }, liveUrl: 'https://viewer.lan/' };
  const shown = page.liveWorldPresentation(mesa, live);
  expect(shown.label).toBe('Île vivante');
  expect(shown.note).toContain('« Île Mesa » n’est pas actif');
  expect(shown.note).toContain('prochaine partie');
  expect(page.liveWorldPresentation(living, { ...live, selectedActive: true }).note).toBe('Monde actif : Île vivante.');
  expect(page.liveWorldPresentation(mesa, null)).toMatchObject({ available: false, label: 'le monde actif' });
});

it('ignores a late Mesa probe after selecting another terrain and rechecks before opening', async () => {
  const nodes = {};
  const node = id => nodes[id] ||= { hidden: false, disabled: false, textContent: '', scrollIntoView() {} };
  node('island-world').value = mesa.id;
  const replies = [];
  const apiFetch = jest.fn(() => new Promise(resolve => replies.push(resolve)));
  const page = loadBrowserModule('island/index.js', 'refreshLiveWorld, refreshDisplayedWorld, setWorlds: value => { worlds = value; }', {
    apiFetch, document: { getElementById: id => id === 'island-runs' ? null : node(id) },
    clearInterval() {}, location: { protocol: 'https:' }
  });
  const worlds = [mesa, living].map(world => ({ ...world, liveUrl: 'https://viewer.lan/?source=world' }));
  page.setWorlds(worlds);
  const stale = page.refreshLiveWorld();
  node('island-world').value = living.id;
  const latest = page.refreshLiveWorld();
  const live = { available: true, selectedActive: true, activeWorld: { label: living.label }, liveUrl: worlds[0].liveUrl };
  replies[1]({ data: live });
  await latest;
  replies[0]({ data: { ...live, activeWorld: { label: mesa.label } } });
  await stale;
  expect(node('island-watch-label').textContent).toBe(living.label);
  expect(node('island-watch').disabled).toBe(false);
  const opening = page.refreshLiveWorld(true);
  expect(node('island-watch').disabled).toBe(true);
  // The service changed back to Mesa between the earlier probe and this click.
  replies[2]({ data: { ...live, selectedActive: false, activeWorld: { label: mesa.label } } });
  await opening;
  expect(node('island-watch-label').textContent).toBe(mesa.label);
  expect(node('island-frame').src).toBe(worlds[0].liveUrl);
  expect(node('island-viewer-world').textContent).toBe('Monde en direct : Île Mesa');
  expect(apiFetch).toHaveBeenCalledTimes(3);
  node('island-world').value = 'local-world';
  const updating = page.refreshDisplayedWorld();
  replies[3]({ data: live });
  await updating;
  expect(node('island-viewer-world').textContent).toBe('Monde en direct : Île vivante');
});
