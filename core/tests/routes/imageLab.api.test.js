'use strict';
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { createRouter, occupancy, lotGroups, liveFleet } = require('../../routes/image-lab');

let dir, code;
const put = (root, name, text) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
const write = (name, text) => put(dir, name, text);
const hosts = () => [{ url: 'http://10.0.0.1:11434', name: 'Bench' }, { url: 'http://10.0.0.1:11435', name: 'Bench CPU' }, { url: 'http://10.0.0.2:11434', name: 'Desk' }];
const idle = async () => ({ maintenance: null, workloads: [], inferences: [] });
const gpus = async () => new Map();
function app(sources = () => ({ listActive: idle, hosts, gpus }), data = () => dir) {
  const instance = express(); instance.use('/images/labo', createRouter({ code, data, lots: () => path.join(dir, 'lots'), sources })); return instance;
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-lab-')); code = fs.mkdtempSync(path.join(os.tmpdir(), 'image-lab-code-'));
  put(code, 'index.html', '<h1>lab</h1>'); put(code, 'campaign.html', 'cockpit'); put(code, 'campaign/archive.html', 'journal');
  write('api/lab.json', JSON.stringify({ groups: [1], core: { stale: true }, servedAt: 'old' })); write('api/health.json', '{"ok":true}');
  write('docs/report.md', '# report'); write('.secret', 'no'); write('lab-resources/ui/lab.js', 'x');
});
afterEach(() => { for (const root of [dir, code]) fs.rmSync(root, { recursive: true, force: true }); });

test('pages, extensionless addresses and frozen API answers come from the mirror', async () => {
  expect((await request(app()).get('/images/labo/').expect(200)).text).toBe('<h1>lab</h1>');
  expect((await request(app()).get('/images/labo/campaign').expect(200)).text).toBe('cockpit');
  expect((await request(app()).get('/images/labo/campaign/archive').expect(200)).text).toBe('journal');
  expect((await request(app()).get('/images/labo/api/health').expect(200)).body).toEqual({ ok: true });
  const doc = await request(app()).get('/images/labo/docs/report.md').expect(200);
  expect(doc.headers['content-type']).toContain('text/plain'); expect(doc.headers['cache-control']).toBe('no-store');
});
test('the lab is read-only and cannot reach outside its folder', async () => {
  await request(app()).get('/images/labo/.secret').expect(404);
  await request(app()).get('/images/labo/%2e%2e/%2e%2e/etc/passwd').expect(404);
  await request(app()).get('/images/labo/missing.png').expect(404);
  await request(app()).post('/images/labo/api/lab').expect(404);
  await request(app()).put('/images/labo/index.html').expect(404);
  expect(fs.readFileSync(path.join(code, 'index.html'), 'utf8')).toBe('<h1>lab</h1>');
});
test('host occupancy is live while the rest of the answer stays the mirrored one', async () => {
  const busy = async () => ({ maintenance: null, workloads: [{ hosts: ['http://10.0.0.1:11435'] }], inferences: [{ host: 'http://10.0.0.2:11434' }] });
  const { body } = await request(app(() => ({ listActive: busy, hosts }))).get('/images/labo/api/lab').expect(200);
  expect(body.groups).toEqual([1]); expect(body.servedAt).not.toBe('old');
  expect(body.core.byHost).toEqual({ Bench: { workloads: 1, inferences: 0, blocked: true }, Desk: { workloads: 0, inferences: 1, blocked: true } });
  expect((await occupancy({ listActive: idle, hosts })).byHost.Bench.blocked).toBe(false);
  expect((await occupancy({ listActive: async () => ({ maintenance: { active: true }, workloads: [], inferences: [] }), hosts })).byHost.Desk.blocked).toBe(true);
});
test('an unreadable coordination state is reported, never guessed as free', async () => {
  const { body } = await request(app(() => ({ listActive: async () => { throw new Error('down'); }, hosts }))).get('/images/labo/api/lab').expect(200);
  expect(body.core).toMatchObject({ available: false }); expect(body.core.byHost).toBeUndefined();
});
test('without the shared drive the pages still load and the data answers plainly', async () => {
  await request(app(undefined, () => null)).get('/images/labo/').expect(200);
  await request(app(undefined, () => null)).get('/images/labo/docs/report.md').expect(404);
  await request(app(undefined, () => null)).get('/images/labo/api/lab').expect(503);
});
test('a lot deposited on the shared drive becomes a comparison without any edit', async () => {
  const record = { schema: 'agentx-image-lot-record-v1', title: 'Trial lot.', scope: 'One seed.', trialTitles: { P3: 'Consistency' },
    humanReceptions: [{ userWords: ['the jar is good'] }],
    images: [{ trial: 'P3', case: 'E01', arm: 'with', pass: 1, recipe: 'With adapter', file: 'a.png', dimensions: [1216, 896], sha256: 'aa', seed: 7,
      generationSeconds: 55.3, brief: 'Change the jar.', references: ['references/start.png'], measurements: { outsidePercentPixelsOver8: 12.1 } },
    { trial: 'P3', case: 'E01', arm: 'without', pass: 1, recipe: 'Without', file: 'b.png', dimensions: [1216, 896], sha256: 'bb', seed: 7 },
    { trial: 'P2', case: 'M01', arm: 'oom', pass: 1, recipe: 'Never rendered', state: 'failed' }] };
  write('lots/2026-10-08-trial/lot.json', JSON.stringify(record)); write('lots/2026-10-08-trial/a.png', 'png'); write('lots/2026-10-08-trial/.hidden', 'no');
  write('lots/not-a-lot/readme.txt', 'x'); write('lots/broken/lot.json', '{');
  const { body } = await request(app()).get('/images/labo/api/lab').expect(200);
  expect(body.groups).toHaveLength(2); expect(body.revision).toMatch(/-1$/);
  const group = body.groups[1];
  expect(group).toMatchObject({ id: 'lot-2026-10-08-trial-p3-e01', title: 'Consistency · E01', category: 'edition', brief: 'Change the jar.', defaultPair: [0, 1] });
  expect(group.items.map(i => i.title)).toEqual(['With adapter', 'Without']);
  expect(group.items[0]).toMatchObject({ original: '/images/labo/lots/2026-10-08-trial/a.png', width: 1216, previewWidth: 960, previewHeight: 707, seconds: 55.3 });
  expect(group.items[0].note).toContain('12,1 %'); expect(group.scope).toContain('the jar is good');
  expect(group.reference.original).toBe('/images/labo/lots/2026-10-08-trial/references/start.png');
  expect((await request(app()).get('/images/labo/lots/2026-10-08-trial/a.png').expect(200)).body.toString()).toBe('png');
  await request(app()).get('/images/labo/lots/2026-10-08-trial/.hidden').expect(404);
  await request(app()).get('/images/labo/lots/..%2Fapi%2Flab.json').expect(404);
  expect(lotGroups(null)).toEqual([]);
});
test('fresh GPU readings replace mirrored ones; stale or absent collectors keep the mirrored reading and its date', async () => {
  const named = () => [{ id: 'a', url: 'u1', name: 'Bench' }, { id: 'b', url: 'u2', name: 'Desk' }, { id: 'c', url: 'u3', name: 'Shelf' }];
  const mirrored = [{ name: 'Bench', observedAt: 'then', gpu: [{ index: '0', 'memory.used [MiB]': '1' }], disks: { '/d': {} } },
    { name: 'Desk', observedAt: 'then', gpu: [{ index: '0', 'memory.used [MiB]': '2' }] }, { name: 'Shelf', observedAt: 'then', gpu: [] }];
  const readings = async () => new Map([
    ['a', { telemetry: { status: 'fresh', sampledAt: 'now' }, gpus: [{ index: 0, name: 'Card', vramTotal: 24576, vramUsed: 100, utilization: 3, temperature: 41 }] }],
    ['b', { telemetry: { status: 'stale', sampledAt: 'old' }, gpus: [{ index: 0, vramUsed: 9 }] }], ['c', { telemetry: { status: 'no_collector_host' }, gpus: [] }]]);
  const [bench, desk, shelf] = await liveFleet(mirrored, { hosts: named, gpus: readings });
  expect(bench).toMatchObject({ gpuObservedAt: 'now', observedAt: 'then', disks: { '/d': {} },
    gpu: [{ index: '0', name: 'Card', 'memory.total [MiB]': '24576', 'memory.used [MiB]': '100', 'utilization.gpu [%]': '3', 'temperature.gpu': '41' }] });
  expect(desk).toBe(mirrored[1]); expect(shelf).toBe(mirrored[2]);
  expect(await liveFleet(mirrored, { hosts: named, gpus: async () => { throw new Error('down'); } })).toBe(mirrored);
  write('api/lab.json', JSON.stringify({ groups: [], revision: 'r', fleet: mirrored }));
  const { body } = await request(app(() => ({ listActive: idle, hosts: named, gpus: readings }))).get('/images/labo/api/lab').expect(200);
  expect(body.fleet[0].gpuObservedAt).toBe('now'); expect(body.fleet[1].gpuObservedAt).toBeUndefined();
});
test('the drawing of the production path is fed by the configured worker and recipes, and survives their absence', async () => {
  const workshop = () => ({ worker: { label: 'Bench', gpu: 'Card', vramGiB: 24 }, profiles: [{ id: 'quality', steps: 25, diffusion: 'private.safetensors' }] });
  const { body } = await request(app(() => ({ listActive: idle, hosts, gpus, workshop }))).get('/images/labo/api/lab').expect(200);
  expect(body.imageWorker).toEqual({ label: 'Bench', gpu: 'Card', vramGiB: 24 }); expect(body.imageRecipes).toEqual([{ id: 'quality', steps: 25 }]);
  const failing = await request(app(() => ({ listActive: idle, hosts, gpus, workshop: () => { throw new Error('no manifest'); } }))).get('/images/labo/api/lab').expect(200);
  expect(failing.body.imageWorker).toBeUndefined(); expect(failing.body.groups).toEqual([1]);
  const page = fs.readFileSync(path.join(__dirname, '../../public/image-lab/lab-resources/ui/lab.js'), 'utf8');
  expect(page.slice(page.indexOf('function productionPath'), page.indexOf('function machines'))).not.toMatch(/UGFrank|UGAlien|RTX|qwen|klein/);
});
