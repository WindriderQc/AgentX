'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, candidates, workerFor } = require('../../src/services/images/config');
const { chooseWorker, busyKeys, hasRoom } = require('../../src/services/images/workerSelection');
const { createComfyClient } = require('../../src/services/images/comfyClient');
const { describe: describeWorkshop } = require('../../src/services/images/workshopPresentation');

const klein = { family: 'klein', diffusion: 'klein.safetensors', encoder: 'enc.safetensors', vae: 'vae.safetensors', steps: 4, maxPixels: 1048576 };
const qwen = { family: 'qwen21', diffusion: 'qwen.safetensors', encoder: 'qenc.safetensors', vae: 'qvae.safetensors', steps: 20, maxPixels: 1048576 };
const A = 'http://192.168.50.12:8189', A_OLLAMA = 'http://192.168.50.12:11434';
const B = 'http://192.168.50.99:8188', B_OLLAMA = 'http://192.168.50.99:11434';
const GiB = 1024 ** 3;

let directory, previous;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-workers-')); previous = process.env.LOCAL_IMAGES_CONFIG; });
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  if (previous === undefined) delete process.env.LOCAL_IMAGES_CONFIG; else process.env.LOCAL_IMAGES_CONFIG = previous;
});
function load(manifest) {
  const file = path.join(directory, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(manifest));
  process.env.LOCAL_IMAGES_CONFIG = file;
  return loadConfig();
}
const twoWorkers = (extra = {}) => ({ defaultProfile: 'fast', profiles: { fast: klein, quality: qwen },
  workers: [
    { id: 'desk', url: A, ollamaHosts: [A_OLLAMA], profiles: ['fast'], minFreeVramRatio: 0.6, releasedVramRatio: 0.65, ...extra },
    { id: 'big', url: B, ollamaHosts: [B_OLLAMA] }
  ] });

describe('image manifest', () => {
  test('a legacy single-worker manifest is unchanged and becomes one default worker', () => {
    const config = load({ workerUrl: A, ollamaHosts: [A_OLLAMA], defaultProfile: 'fast', profiles: { fast: klein } });
    expect(config.workerUrl).toBe(A);
    expect(config.ollamaHosts).toEqual([A_OLLAMA]);
    expect(config.workers).toEqual([{ id: 'default', url: A, ollamaHosts: [A_OLLAMA] }]);
    const scoped = workerFor(config, A);
    expect(scoped).toMatchObject({ workerUrl: A, ollamaHosts: [A_OLLAMA], minFreeVramRatio: 0.75, releasedVramRatio: 0.85 });
  });

  test('several workers keep their order, profiles and thresholds', () => {
    const config = load(twoWorkers());
    expect(config.workerUrl).toBeUndefined();
    expect(candidates(config, 'fast').map(w => w.worker.id)).toEqual(['desk', 'big']);
    expect(candidates(config, 'quality').map(w => w.worker.id)).toEqual(['big']);
    expect(workerFor(config, A)).toMatchObject({ workerUrl: A, ollamaHosts: [A_OLLAMA], minFreeVramRatio: 0.6, releasedVramRatio: 0.65 });
    expect(workerFor(config, B)).toMatchObject({ workerUrl: B, ollamaHosts: [B_OLLAMA], minFreeVramRatio: 0.75 });
    expect(workerFor(config, 'http://192.168.50.1:1')).toBeNull();
  });

  test.each([
    ['both shapes', m => ({ ...m, workerUrl: A, ollamaHosts: [A_OLLAMA] })],
    ['duplicate id', m => ({ ...m, workers: [m.workers[0], { ...m.workers[1], id: 'desk' }] })],
    ['duplicate url', m => ({ ...m, workers: [m.workers[0], { ...m.workers[1], url: A }] })],
    ['unknown profile', m => ({ ...m, workers: [{ ...m.workers[0], profiles: ['nope'] }, m.workers[1]] })],
    ['profile with no worker', m => ({ ...m, workers: [m.workers[0]] })],
    ['public url', m => ({ ...m, workers: [{ ...m.workers[0], url: 'http://8.8.8.8:8188' }, m.workers[1]] })],
    ['no Ollama host', m => ({ ...m, workers: [{ ...m.workers[0], ollamaHosts: [] }, m.workers[1]] })],
    ['ratio out of range', m => ({ ...m, workers: [{ ...m.workers[0], releasedVramRatio: 0.99 }, m.workers[1]] })],
    ['empty list', m => ({ ...m, workers: [] })]
  ])('rejects %s', (_label, change) => {
    expect(() => load(change(twoWorkers()))).toThrow();
  });

  test('the workshop lists every worker without its Ollama hosts', () => {
    const config = load(twoWorkers({ presentation: { hostLabel: 'Desk PC', gpuLabel: '16 GB card' } }));
    const view = describeWorkshop(config);
    expect(view.workers.map(w => [w.id, w.label])).toEqual([['desk', 'Desk PC'], ['big', '192.168.50.99']]);
    expect(view.worker.id).toBe('desk');
    expect(JSON.stringify(view)).not.toContain('11434');
  });
});

function fakeDeps({ down = [], residents = {}, jobs = [], stats = {} } = {}) {
  const calls = { ready: [], running: [], queue: 0 };
  return {
    calls,
    deps: {
      client: url => ({ ready: async () => {
        calls.ready.push(url);
        if (down.includes(url)) throw new Error('unreachable');
        return stats[url] || { devices: [{ vram_total: 16 * GiB, vram_free: 12 * GiB }] };
      } }),
      running: async host => { calls.running.push(host); if (down.includes(host)) throw new Error('down'); return residents[host] || []; },
      queueJobs: async () => { calls.queue += 1; return jobs; },
      now: () => Date.parse('2026-11-07T12:00:00Z')
    }
  };
}

describe('worker choice before any effect', () => {
  test('opportunistic selection uses only its named worker, with strict readiness and no fallback', async () => {
    const config = load(twoWorkers());
    const { deps, calls } = fakeDeps();
    const ready = jest.fn().mockResolvedValue({ devices: [{ vram_total: 100, vram_free: 90 }] });
    deps.client = () => ({ ready });
    expect((await chooseWorker(config, { ...klein, id: 'fast' }, { opportunisticWorkerId: 'desk', deps })).worker.worker.id).toBe('desk');
    expect(ready).toHaveBeenCalledWith({ ...klein, id: 'fast' }, { requireQueueProof: true });
    expect(calls.running).toEqual([A_OLLAMA]);
    ready.mockRejectedValue(new Error('busy'));
    expect((await chooseWorker(config, { ...klein, id: 'fast' }, { opportunisticWorkerId: 'desk', deps })).worker).toBeNull();
    expect(ready).toHaveBeenCalledTimes(2);
    expect((await chooseWorker(config, { ...qwen, id: 'quality' }, { opportunisticWorkerId: 'desk', deps })).worker).toBeNull();
    expect((await chooseWorker(config, { ...klein, id: 'fast' }, { opportunisticWorkerId: 'missing', deps })).worker).toBeNull();
  });

  test.each([
    ['another image', { jobs: [{ kind: 'image', state: 'running', hosts: [A] }] }],
    ['uncertain image', { jobs: [{ kind: 'image', state: 'uncertain', hosts: [A_OLLAMA] }] }],
    ['missing queue evidence', { jobs: null }],
    ['resident', { residents: { [A_OLLAMA]: [{ name: 'agentx-primary', size_vram: 0 }] } }],
    ['no verified memory', { stats: { [A]: {} } }],
    ['insufficient room', { stats: { [A]: { devices: [{ vram_total: 100, vram_free: 10 }] } } }],
    ['Ollama unavailable', { down: [A_OLLAMA] }]
  ])('opportunistic selection drops %s without trying another worker', async (_name, input) => {
    const { deps, calls } = fakeDeps(input);
    const result = await chooseWorker(load(twoWorkers()), { ...klein, id: 'fast' }, { opportunisticWorkerId: 'desk', deps });
    expect(result.worker).toBeNull();
    expect(calls.ready).not.toContain(B);
  });

  test('opportunistic selection refuses missing queue evidence and a pre-reserved request', async () => {
    const { deps, calls } = fakeDeps();
    deps.queueJobs = async () => { throw new Error('unavailable'); };
    expect((await chooseWorker(load(twoWorkers()), { ...klein, id: 'fast' }, { opportunisticWorkerId: 'desk', deps })).worker).toBeNull();
    expect(calls.ready).toEqual([]);
    expect((await chooseWorker(load(twoWorkers()), { ...klein, id: 'fast' }, { opportunisticWorkerId: 'desk', queueHosts: [A_OLLAMA], deps })).worker).toBeNull();
  });

  test('a single worker keeps the original readiness rule and nothing else', async () => {
    const config = load({ workerUrl: A, ollamaHosts: [A_OLLAMA], defaultProfile: 'fast', profiles: { fast: klein } });
    const ok = fakeDeps({ jobs: [{ kind: 'benchmark', state: 'running', hosts: [A_OLLAMA] }] });
    const chosen = await chooseWorker(config, { ...klein, id: 'fast' }, { deps: ok.deps });
    expect(chosen.worker.workerUrl).toBe(A);
    expect(ok.calls.queue).toBe(0); expect(ok.calls.running).toEqual([]);
    const down = fakeDeps({ down: [A] });
    expect((await chooseWorker(config, { ...klein, id: 'fast' }, { deps: down.deps })).worker).toBeNull();
  });

  test('the fast profile goes to the preferred worker; quality goes only where it is declared', async () => {
    const config = load(twoWorkers());
    const { deps, calls } = fakeDeps();
    expect((await chooseWorker(config, { ...klein, id: 'fast' }, { deps })).worker.worker.id).toBe('desk');
    expect(calls.ready).toEqual([A]);
    const quality = await chooseWorker(config, { ...qwen, id: 'quality' }, { deps });
    expect(quality.worker.worker.id).toBe('big');
  });

  test('falls back when the preferred worker is off, its Ollama is down, or its card is too full', async () => {
    const config = load(twoWorkers());
    const profile = { ...klein, id: 'fast' };
    expect((await chooseWorker(config, profile, { deps: fakeDeps({ down: [A] }).deps })).tried)
      .toEqual([{ id: 'desk', reason: 'unavailable' }, { id: 'big', reason: 'chosen' }]);
    expect((await chooseWorker(config, profile, { deps: fakeDeps({ down: [A_OLLAMA] }).deps })).worker.worker.id).toBe('big');
    const full = fakeDeps({ stats: { [A]: { devices: [{ vram_total: 16 * GiB, vram_free: 4 * GiB }] } },
      residents: { [A_OLLAMA]: [{ name: 'small-embedder', size_vram: 1 * GiB }] } });
    expect((await chooseWorker(config, profile, { deps: full.deps })).tried[0]).toEqual({ id: 'desk', reason: 'vram' });
  });

  test('residents the worker unloads count as room', async () => {
    const config = load(twoWorkers());
    const { deps } = fakeDeps({ stats: { [A]: { devices: [{ vram_total: 16 * GiB, vram_free: 4 * GiB }] } },
      residents: { [A_OLLAMA]: [{ name: 'horde-model', size_vram: 8 * GiB }] } });
    expect((await chooseWorker(config, { ...klein, id: 'fast' }, { deps })).worker.worker.id).toBe('desk');
  });

  test('other heavy work on the preferred hosts sends the image elsewhere; another image does not', async () => {
    const config = load(twoWorkers());
    const profile = { ...klein, id: 'fast' };
    const benchmark = fakeDeps({ jobs: [{ kind: 'benchmark', state: 'running', hosts: [A_OLLAMA] }] });
    expect((await chooseWorker(config, profile, { deps: benchmark.deps })).tried[0]).toEqual({ id: 'desk', reason: 'reserved' });
    const image = fakeDeps({ jobs: [{ kind: 'image', state: 'running', hosts: [A, A_OLLAMA] }] });
    expect((await chooseWorker(config, profile, { deps: image.deps })).worker.worker.id).toBe('desk');
  });

  test('when every worker is reachable but busy, the first reachable one is kept', async () => {
    const config = load(twoWorkers());
    const { deps } = fakeDeps({ jobs: [{ kind: 'benchmark', state: 'running', hosts: [A_OLLAMA, B_OLLAMA] }] });
    const chosen = await chooseWorker(config, { ...klein, id: 'fast' }, { deps });
    expect(chosen.worker.worker.id).toBe('desk');
    expect(chosen.tried).toEqual([{ id: 'desk', reason: 'chosen-while-busy' }, { id: 'big', reason: 'reserved' }]);
  });

  test('a request the queue already reserved stays on the worker of those hosts, with no fallback', async () => {
    const config = load(twoWorkers());
    const profile = { ...klein, id: 'fast' };
    const reservedOnB = [B_OLLAMA].map(h => new URL(h).origin);
    const chosen = await chooseWorker(config, profile, { queueHosts: reservedOnB, deps: fakeDeps().deps });
    expect(chosen.worker.worker.id).toBe('big');
    const off = await chooseWorker(config, profile, { queueHosts: reservedOnB, deps: fakeDeps({ down: [B] }).deps });
    expect(off.worker).toBeNull();
  });

  test('busy hosts come from running work and reservations open now', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    const keys = busyKeys([
      { kind: 'benchmark', state: 'reserved', hosts: ['h1'], reservation: { start: '2026-11-07T11:00:00Z', end: '2026-11-07T13:00:00Z' } },
      { kind: 'benchmark', state: 'reserved', hosts: ['h2'], reservation: { start: '2026-11-07T14:00:00Z', end: '2026-11-07T15:00:00Z' } },
      { kind: 'profiler', state: 'uncertain', hosts: ['h3'] },
      { kind: 'profiler', state: 'completed', hosts: ['h4'] }
    ], now);
    expect([...keys].sort()).toEqual(['h1', 'h3']);
    expect(hasRoom({ devices: [{ vram_total: 10, vram_free: 5 }] }, [], 0.75)).toBe(false);
    expect(hasRoom({}, [], 0.75)).toBe(true);
  });
});

test('memory release accepts the worker threshold for a desktop card', async () => {
  const responses = { '/queue': { queue_running: [], queue_pending: [] }, '/free': {},
    '/system_stats': { devices: [{ vram_total: 100, vram_free: 72, torch_vram_total: 0, torch_vram_free: 0 }] } };
  const fetchImpl = async url => ({ ok: true, text: async () => JSON.stringify(responses[new URL(url).pathname]) });
  const client = createComfyClient('http://127.0.0.1:8189', fetchImpl);
  await expect(client.free(async () => {}, true, 0.7)).resolves.toBeTruthy();
}, 10000);

test.each([undefined, null, {}, { queue_running: null, queue_pending: null },
  { queue_running: [], queue_pending: null }, { queue_running: {}, queue_pending: [] }])(
  'opportunistic selection and release reject malformed native queue %j', async queue => {
    const calls = [];
    const responses = { '/queue': queue, '/system_stats': { devices: [{ vram_total: 100, vram_free: 90 }] },
      '/object_info': { UNETLoader: { input: { required: { unet_name: [[klein.diffusion]] } } },
        CLIPLoader: { input: { required: { clip_name: [[klein.encoder]] } } },
        VAELoader: { input: { required: { vae_name: [[klein.vae]] } } } } };
    const fetchImpl = async url => {
      calls.push(url); return { ok: true, text: async () => JSON.stringify(responses[new URL(url).pathname]) };
    };
    const client = createComfyClient(A, fetchImpl);
    const { deps } = fakeDeps(); deps.client = () => client;
    expect((await chooseWorker(load(twoWorkers()), { ...klein, id: 'fast' }, { opportunisticWorkerId: 'desk', deps })).worker).toBeNull();
    await expect(client.free(async () => {}, false)).rejects.toThrow('queue state is unavailable');
    expect(calls.some(url => url.startsWith(B) || new URL(url).pathname === '/free')).toBe(false);
  }
);

describe('residents kept by immediate images and the illustrated mode (#1304)', () => {
  const embed = 'qllama/bge-m3:f16';
  test('a worker may name residents an immediate image leaves loaded', () => {
    const config = load(twoWorkers({ keepResidents: [embed, embed] }));
    expect(config.workers[0].keepResidents).toEqual([embed]);
    expect(workerFor(config, A).worker.keepResidents).toEqual([embed]);
    expect(config.workers[1].keepResidents).toBeUndefined();
  });
  test.each([['not a list', embed], ['a bad name', ['bad name']], ['too many', Array.from({ length: 9 }, (_, i) => 'm' + i)]])(
    'keepResidents refuses %s', (_name, keepResidents) => {
      expect(() => load(twoWorkers({ keepResidents }))).toThrow(/keepResidents/);
    });
  test('the illustrated mode names one worker, a quick profile and a qualified size', () => {
    expect(load(twoWorkers()).illustrated).toBeUndefined();
    expect(load({ ...twoWorkers(), illustrated: { worker: 'desk', profile: 'fast' } }).illustrated)
      .toEqual({ worker: 'desk', profile: 'fast', width: 768, height: 768, intervalSeconds: 60 });
    expect(load({ ...twoWorkers(), illustrated: { worker: 'desk', profile: 'fast', width: 512, height: 640, intervalSeconds: 90 } }).illustrated)
      .toEqual({ worker: 'desk', profile: 'fast', width: 512, height: 640, intervalSeconds: 90 });
  });
  test.each([
    ['unknown worker', { worker: 'nope', profile: 'fast' }],
    ['slow profile family', { worker: 'big', profile: 'quality' }],
    ['profile the worker refuses', { worker: 'desk', profile: 'quality' }],
    ['unqualified size', { worker: 'desk', profile: 'fast', width: 770 }],
    ['oversized picture', { worker: 'desk', profile: 'fast', width: 2048, height: 2048 }],
    ['too short an interval', { worker: 'desk', profile: 'fast', intervalSeconds: 5 }],
    ['not an object', 'desk']
  ])('the illustrated mode refuses %s', (_name, illustrated) => {
    expect(() => load({ ...twoWorkers(), illustrated })).toThrow(/illustrated/i);
  });
  test('an immediate image accepts only declared residents on its worker', async () => {
    const config = load(twoWorkers({ keepResidents: [embed] }));
    const kept = fakeDeps({ residents: { [A_OLLAMA]: [{ name: embed, size_vram: GiB }] } });
    expect((await chooseWorker(config, { ...klein, id: 'fast' }, { opportunisticWorkerId: 'desk', deps: kept.deps })).worker.worker.id).toBe('desk');
    const other = fakeDeps({ residents: { [A_OLLAMA]: [{ name: embed, size_vram: GiB }, { name: 'horde-model', size_vram: 10 * GiB }] } });
    const refused = await chooseWorker(config, { ...klein, id: 'fast' }, { opportunisticWorkerId: 'desk', deps: other.deps });
    expect(refused.worker).toBeNull();
    expect(refused.tried).toEqual([{ id: 'desk', reason: 'resident' }]);
    expect(other.calls.ready).not.toContain(B);
  });
});
