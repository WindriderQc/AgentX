const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '../..');
const liveSource = fs.readFileSync(path.join(root, 'public/js/nerve-center-live.js'), 'utf8');
const modelSource = fs.readFileSync(path.join(root, 'public/js/nerve-center-model.js'), 'utf8');
const routingSource = fs.readFileSync(path.join(root, 'public/js/nerve-center-routing.js'), 'utf8');
const viewSource = fs.readFileSync(path.join(root, 'views/pages/nerve-center.ejs'), 'utf8');

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function sharedStub(fetchJson = async () => ({})) {
  return {
    fetchJson,
    escapeHtml,
    normalizeHostUrl: url => String(url || '').replace(/\/+$/, ''),
    shortModel: value => String(value),
    timeAgo: () => '5s ago',
    motionSafeScrollBehavior: () => 'auto',
    renderSectionLoading(body) { body.innerHTML = 'loading'; },
    renderSectionError(body, message) { body.innerHTML = `error: ${escapeHtml(message)}`; },
    finishSectionLoad() {},
    trackSectionFocus() {},
    restoreSectionFocus() {}
  };
}

function loadLive({ fetchJson, document = { getElementById: () => null } } = {}) {
  const window = { NerveCenterShared: sharedStub(fetchJson) };
  vm.runInNewContext(liveSource, { window, document, console, URL, Map, Set, Date, CSS: { escape: v => v } });
  return window.NerveCenterLive;
}

const BIG = 'http://10.0.0.10';
const SMALL = 'http://10.0.0.20';
const hosts = [
  { id: 'primary', name: 'BigBox', url: `${BIG}:11434`, residency: 'gpu', available: true },
  { id: 'secondary', name: 'SmallBox', url: `${SMALL}:11434`, residency: 'gpu', available: true },
  { id: 'big-cpu', name: 'BigBox CPU', url: `${BIG}:11435`, residency: 'cpu', available: true },
  { id: 'big-lane-a', name: 'BigBox lane a', url: `${BIG}:11437`, residency: 'gpu', available: false },
  { id: 'small-cpu', name: 'SmallBox CPU', url: `${SMALL}:11435`, residency: 'cpu', available: false }
];
const prefs = [
  { hostUrl: `${BIG}:11434`, pinnedModels: [{ model: 'main-model:q8' }, { model: 'embed-model' }],
    live: { runningModels: [{ name: 'embed-model', contextLength: 8192 }] } },
  { hostUrl: `${SMALL}:11434`, pinnedModels: [{ model: 'small-model' }],
    live: { runningModels: [{ name: 'small-model' }, { name: 'extra-model' }] } },
  { hostUrl: `${BIG}:11435`, pinnedModels: [{ model: 'cpu-model' }], live: { runningModels: [{ name: 'cpu-model' }] } }
];
const gpuRows = [
  { hostId: 'primary', gpus: [
    { index: 0, name: 'NVIDIA GeForce RTX 3090', utilization: 37, temperature: 61, powerDraw: 210, vramUsed: 20480, vramTotal: 24576 },
    { index: 1, name: 'NVIDIA GeForce RTX 3090', utilization: 0, temperature: 40, powerDraw: 25, vramUsed: 1024, vramTotal: 24576 }
  ], telemetry: { status: 'fresh', sampledAt: '2026-11-06T22:00:00Z' } },
  { hostId: 'secondary', gpus: [{ index: 0, name: 'GPU X', utilization: 3, vramUsed: 600, vramTotal: 16000 }],
    telemetry: { status: 'stale' } }
];
const topology = {
  configured: true, valid: true, activeMode: null,
  switch: { intendedMode: 'pooled', inProgress: null },
  groups: [{ id: 'big', modes: [
    { id: 'lanes', label: 'Two lanes', status: 'inactive', endpoints: [{ url: `${BIG}:11437` }] },
    { id: 'pooled', label: 'Pooled', status: 'inactive', endpoints: [{ url: `${BIG}:11434` }] }
  ] }]
};

describe('Nerve Center live machines', () => {
  test('groups endpoints by machine address and names the machine after its GPU endpoint', () => {
    const live = loadLive();
    const machines = live.groupMachines({ hosts, prefs, gpuRows, topology });

    expect(machines.map(m => m.name)).toEqual(['BigBox', 'SmallBox']);
    const big = machines[0];
    expect(big.gpus).toHaveLength(2);
    expect(big.endpoints.map(e => [e.name, e.state])).toEqual([
      ['BigBox', 'up'], ['BigBox CPU', 'up'], ['BigBox lane a', 'parked']
    ]);
    expect(big.endpoints[0].missingPins).toEqual(['main-model:q8']);
    expect(big.endpoints[0].loaded).toEqual([{ name: 'embed-model', pinned: true, context: 8192 }]);
    expect(big.mode).toEqual({ label: 'Pooled', settled: false, switching: false });

    const small = machines[1];
    expect(small.endpoints.find(e => e.name === 'SmallBox CPU').state).toBe('down');
    expect(small.endpoints[0].loaded.map(m => m.pinned)).toEqual([true, false]);
  });

  test('parks nothing while a topology switch is in progress', () => {
    const live = loadLive();
    expect([...live.parkedUrls(topology)]).toEqual([`${BIG}:11437`]);
    expect([...live.parkedUrls({ ...topology, switch: { intendedMode: 'pooled', inProgress: { id: 'x' } } })]).toEqual([]);
    expect([...live.parkedUrls(null)]).toEqual([]);
  });

  test('lists what to check in plain words, once per cause', () => {
    const live = loadLive();
    const machines = live.groupMachines({ hosts, prefs, gpuRows, topology });
    const summary = live.statusSummary(machines);

    expect(summary.up).toBe(2);
    expect(summary.total).toBe(2);
    expect(summary.tone).toBe('attention');
    expect(summary.issues).toEqual([
      'BigBox: pin not loaded (main-model:q8)',
      'SmallBox: CPU unreachable',
      'SmallBox: GPU readings are stale'
    ]);
    expect(live.endpointLabel('BigBox', 'BigBox', 'gpu')).toBe('GPU engine');
    expect(live.endpointLabel('BigBox lane a', 'BigBox', 'gpu')).toBe('lane a');
  });

  test('places heavy work and Benchmark claims on the machines they hold', () => {
    const live = loadLive();
    const now = Date.parse('2026-11-06T22:50:00Z');
    const machines = live.groupMachines({ hosts, prefs, gpuRows, topology });
    const jobs = [
      { id: 'a', title: 'Open slot', state: 'reserved', hosts: [`${BIG}:11434`],
        reservation: { start: '2026-11-06T22:45:00Z', end: '2026-11-07T01:15:00Z' } },
      { id: 'b', title: 'Later', state: 'reserved', hosts: [`${BIG}:11435`, `${SMALL}:11434`],
        reservation: { start: '2026-11-07T04:35:00Z', end: '2026-11-07T04:45:00Z' } },
      { id: 'c', title: 'Waiting', state: 'requested', hosts: [`${BIG}:11434`] },
      { id: 'd', title: 'Done', state: 'completed', hosts: [`${BIG}:11434`] },
      { id: 'e', title: 'Running', state: 'running', hosts: [`${SMALL}:11434`] }
    ];
    const claims = [{ hostUrl: `${SMALL}:11434`, batchId: 'batch-1' }];

    const big = live.machineWork(machines[0], jobs, claims, now);
    expect(big.current.map(entry => [entry.job.id, entry.phase])).toEqual([['a', 'open']]);
    expect(big.next.job.id).toBe('b');
    expect(big.waiting).toBe(1);
    expect(big.claims).toEqual([]);

    const small = live.machineWork(machines[1], jobs, claims, now);
    expect(small.current.map(entry => [entry.job.id, entry.phase])).toEqual([['e', 'running']]);
    expect(small.claims).toEqual(claims);
    expect(live.jobPhase({ state: 'reserved', reservation: { start: '2026-11-06T20:00:00Z', end: '2026-11-06T21:00:00Z' } }, now)).toBe('expired');
  });

  test('reports pins unloaded under reserved work or a claim as held, not as a problem', () => {
    const live = loadLive();
    const now = Date.parse('2026-11-06T22:50:00Z');
    const withClaims = prefs.map(pref => ({ ...pref, benchmarkClaim: pref.hostUrl === `${SMALL}:11434`
      ? { batchId: null, owner: null } : null }));
    const machines = live.groupMachines({ hosts, prefs: withClaims, gpuRows, topology });
    const claims = [{ hostUrl: `${BIG}:11434`, batchId: 'b-1', owner: 'pilot', claimedAt: '2026-11-06T22:46:00Z', estimatedDurationMs: 3600000 }];
    const works = machines.map(m => live.machineWork(m, [], claims, now));

    expect(works[0].claims).toEqual(claims);
    expect(works[1].claims).toEqual([]);
    const summary = live.statusSummary(machines, works);
    expect(summary.issues).not.toContain('BigBox: pin not loaded (main-model:q8)');
    expect(summary.held).toEqual(['BigBox: reserved work holds it, pins unloaded until it ends']);
    expect(summary.issues.some(issue => issue.startsWith('BigBox'))).toBe(false);
  });

  test('shows GPU memory that another program holds, from fresh readings only', () => {
    const live = loadLive();
    const sized = prefs.map(pref => ({ ...pref, live: { runningModels: pref.live.runningModels
      .map(m => ({ ...m, sizeVram: 1024 * 1024 * 1024 })) } }));
    const [big, small] = live.groupMachines({ hosts, prefs: sized, gpuRows, topology });
    // BigBox: 21 GiB used on the GPUs, 1 GiB held by its GPU endpoint's models.
    expect(Math.round(live.vramOutsideOllamaMiB(big) / 1024)).toBe(20);
    // SmallBox readings are stale.
    expect(live.vramOutsideOllamaMiB(small)).toBe(0);
  });

  test('renders read-only machine cards, the queue and the status line', async () => {
    const responses = {
      '/api/ollama-hosts': { data: { hosts } },
      '/api/nerve-center/host-preferences': { data: prefs },
      '/api/nerve-center/inference/gpu-status': { data: gpuRows },
      '/api/nerve-center/runtime-topology': { status: 'success', data: topology },
      '/api/cluster/schedule/heavy-queue': { data: { available: true, jobs: [
        { id: 'r', title: 'Night <run>', state: 'reserved', hosts: [`${BIG}:11434`],
          reservation: { start: new Date(Date.now() + 3600000).toISOString(), end: new Date(Date.now() + 7200000).toISOString() } }
      ] } },
      '/api/nerve-center/inference-health': { data: { benchmarkClaims: [] } }
    };
    const body = { innerHTML: '', querySelectorAll: () => [] };
    const line = { innerHTML: '', className: '', textContent: '' };
    const document = { hidden: false, getElementById: id => (id === 'sectionLiveBody' ? body : id === 'ncStatusLine' ? line : null) };
    const fetchJson = jest.fn(async url => responses[url]);
    const live = loadLive({ fetchJson, document });

    await live.loadLive();

    expect(body.innerHTML).toContain('BigBox');
    expect(body.innerHTML).toContain('GPU 0');
    expect(body.innerHTML).toContain('37%');
    expect(body.innerHTML).toContain('VRAM 20.0 / 24.0 GiB');
    expect(body.innerHTML).toContain('parked');
    expect(body.innerHTML).toContain('Pin not loaded: main-model:q8');
    expect(body.innerHTML).toContain('Night &lt;run&gt;');
    expect(body.innerHTML).not.toContain('<run>');
    expect(body.innerHTML).toContain('Manage pins');
    expect(body.innerHTML).toContain('href="/automations?view=calendar"');
    expect(body.innerHTML).not.toMatch(/<select|<input/);
    expect(line.className).toBe('nc-status-line attention');
    expect(line.innerHTML).toContain('2/2 machines up');
    expect(fetchJson.mock.calls.every(([, options]) => options === undefined)).toBe(true);
  });

  test('keeps the cards when optional sources fail and says so when the queue is unreadable', async () => {
    const body = { innerHTML: '', querySelectorAll: () => [] };
    const document = { getElementById: id => (id === 'sectionLiveBody' ? body : null) };
    const fetchJson = jest.fn(async url => {
      if (url === '/api/ollama-hosts') return { data: { hosts: hosts.slice(0, 2) } };
      throw new Error('down');
    });
    const live = loadLive({ fetchJson, document });

    await live.loadLive();

    expect(body.innerHTML).toContain('SmallBox');
    expect(body.innerHTML).toContain('No GPU readings');
    expect(body.innerHTML).toContain('The queue could not be read.');
  });
});

describe('Nerve Center page layout', () => {
  test('opens on the live machines and the principal model, before attention, settings and diagnostics', () => {
    const order = ['ncStatusLine', 'sectionLive', 'sectionModel', 'ncGroupAttention', 'sectionOpsWatch', 'sectionHealth',
      'ncGroupSettings', 'sectionCluster', 'sectionHosts', 'ncGroupDiagnostics', 'widgetHostsOnline', 'sectionRouting']
      .map(id => viewSource.indexOf(`id="${id}"`));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(viewSource).not.toMatch(/<div class="nc-section [^"]*nc-detail-only" id="sectionModel"/);
  });

  test('loads the principal model and topology cards in their own section, not in routing', async () => {
    expect(routingSource).not.toContain('/api/nerve-center/principal-model');
    expect(routingSource).not.toContain('principalCard.build');

    const body = { innerHTML: '' };
    const principal = { build: jest.fn(() => '<div id="ncPrincipalCard"></div>'), attach: jest.fn() };
    const topologyCard = { build: jest.fn(() => '<div id="ncTopologyCard"></div>'), attach: jest.fn() };
    const responses = {
      '/api/nerve-center/principal-model': { status: 'success', data: { selected: 'standard' } },
      '/api/nerve-center/runtime-topology': { status: 'success', data: { configured: true } }
    };
    const window = {
      NerveCenterShared: sharedStub(async url => responses[url]),
      NerveCenterPrincipalModel: principal,
      NerveCenterRuntimeTopology: topologyCard,
      NerveCenterLive: { loadLive: jest.fn() }
    };
    const document = { getElementById: id => (id === 'sectionModelBody' ? body : null) };
    vm.runInNewContext(modelSource, { window, document, console });

    await window.NerveCenterModel.loadModel();

    expect(body.innerHTML).toContain('ncPrincipalCard');
    expect(body.innerHTML).toContain('ncTopologyCard');
    expect(principal.attach).toHaveBeenCalledWith({ selected: 'standard' }, expect.any(Function));
    const reload = principal.attach.mock.calls[0][1];
    await reload();
    expect(window.NerveCenterLive.loadLive).toHaveBeenCalledWith({ quiet: true });
  });
});
