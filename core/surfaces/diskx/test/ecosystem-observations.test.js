'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectSnapshot, validateConfig, createLiveState } = require('../../../src/services/ecosystemLiveState');
const { createObservationReader, networkRows, nativeRows, validPath } = require('../../../src/services/ecosystemObservations');
const { createPresentationReader } = require('../../../src/services/presentationReadService');
const at = Date.parse('2030-01-02T12:00:00.000Z'), iso = n => new Date(n).toISOString();
const config = () => ({ version: 2, observer: {script: '/opt/app/observe.py', config: '/opt/private/checks.json'}, nodes: [
  {id: 'host', hosts: ['primary']}, {id: 'service', observations: ['process']}, {id: 'spare', unobserved: true}
] });
const snapshot = () => ({ authority: 'agentx-product', readOnly: true, schemaVersion: 2, generatedAt: iso(at),
  cluster: [{hostKey: 'primary', status: 'online', checkedAt: iso(at)}], services: [] });
const definition = { revision: 'a'.repeat(64), checks: [{id: 'process', kind: 'docker', targets: ['synthetic-api']}] };
const native = () => ({ contract: 'agentx.ecosystem-observations/v1', configurationRevision: definition.revision,
  observations: [{id: 'process', source: 'native_process', state: 'online', observedAt: iso(at - 5000), url: 'private', model: 'private'}] });

test('expanded projection preserves source timestamps, explicit gaps and partial failures', async () => {
  const rows = nativeRows(native(), definition);
  const result = projectSnapshot(snapshot(), config(), at, rows);
  assert.equal(result.nodes[1].source, 'native_process');
  assert.equal(result.nodes[1].observedAt, iso(at - 5000));
  assert.deepEqual(result.nodes[2], { id: 'spare', source: 'unobserved', state: 'unknown', observedAt: null, expiresAt: null, freshness: 'unknown' });
  assert.doesNotMatch(JSON.stringify(result), /private|synthetic-api/);
  const reader = createPresentationReader({now: () => at});
  const read = createLiveState({ config, buildSnapshot: async () => {throw Error('unavailable');}, observations: async () => rows, reader, now: () => at });
  const live = await read();
  assert.equal(live.contract, 'agentx.ecosystem-live/v2');
  assert.equal(live.nodes[0].state, 'unknown');
  assert.equal(live.nodes[1].state, 'online');
  assert.deepEqual(reader.read(live.read).nodes, live.nodes.map(n => ({...n, effectiveFreshness:n.freshness})));
  const stale = projectSnapshot(snapshot(), config(), at + 10000, [{...rows[0], observedAt: iso(at - 120000)}]);
  assert.equal(stale.nodes[1].freshness, 'stale');
  assert.equal(stale.nodes[1].observedAt, iso(at - 120000));
});

test('expanded mappings reject duplicate sources, unsafe paths and more than 64 nodes', () => {
  assert.ok(validateConfig(config()));
  for (const script of ['/tmp/a;id', '/tmp/../observe.py', '-option', '/tmp/a\nfile', '/tmp/a//file']) assert.equal(validPath(script), false);
  assert.equal(validPath('/opt/agentx/observe.py'), true);
  for (const mutate of [c => c.nodes.push({...c.nodes[1],id:'other'}), c => c.nodes[1].hosts = ['primary'],
    c => c.observer.script = '/tmp/../bad', c => c.nodes = Array.from({length:65}, (_,i) => ({id:`n-${i}`,unobserved:true}))]) {
    const c = config(); mutate(c); assert.throws(() => validateConfig(c));
  }
});

test('native reader shares in-flight/cache reads and refuses mismatched native revisions', async () => {
  let calls = 0, now = at;
  const runner = async (target, command) => {
    calls++; assert.equal(target, 'observer@fixture'); assert.match(command, /^python3 '\/opt\/app\/observe.py' --config /);
    return {stdout: JSON.stringify(native())};
  };
  const read = createObservationReader({runner, load: () => definition, env: {AGENTX_OPERATIONS_SSH_TARGET:'observer@fixture'}, now: () => now});
  const [a,b] = await Promise.all([read(config()), read(config())]);
  assert.equal(calls, 1); assert.deepEqual(a,b);
  now += 10000; assert.equal((await read(config()))[0].observedAt, iso(at-5000)); assert.equal(calls,1);
  now += 20000; await read(config()); assert.equal(calls,2);
  assert.deepEqual(nativeRows({...native(), configurationRevision:'b'.repeat(64)},definition),[]);
  assert.deepEqual(nativeRows({...native(),observations:[...native().observations,...native().observations]},definition),[]);
  const failed = createObservationReader({load: () => definition,runner: async () => {throw Error('ssh failed');},env:{AGENTX_OPERATIONS_SSH_TARGET:'fixture'}});
  assert.equal((await failed(config()))[0].state,'unknown');
});

test('Data presence binds stable device identity and retains last seen instead of scan/evaluation time', async () => {
  const id = 'a'.repeat(24), c = {checks:[{id:'edge',kind:'network',deviceId:id}]};
  let state = 'online';
  const fetchData = async route => ({response:{ok:true},body:{data:route.endsWith('devices') ? {
    summary:{onlineTtlMs:1800000},devices:[{_id:id,observation:{state,lastSeenAt:iso(at-600000)}},
      {_id:'b'.repeat(24),ip:'same-dhcp-ip',observation:{state:'online',lastSeenAt:iso(at)}}]
  } : {scanners:[{lastScanAt:iso(at-1000)}]}}});
  const row = (await networkRows(c,fetchData,at))[0];
  assert.equal(row.observedAt,iso(at-600000)); assert.equal(row.ttlMs,1800000);
  const projected = projectSnapshot(snapshot(), {...config(),nodes:[{id:'edge',observations:['edge']}]},at,[row]);
  assert.equal(projected.nodes[0].freshness,'current');
  state='historical'; assert.equal((await networkRows(c,fetchData,at))[0].state,'offline');
  const old = await networkRows(c,fetchData,at+1900000); assert.equal(old[0].state,'unknown');
});
