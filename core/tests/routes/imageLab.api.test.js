'use strict';
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { createRouter, occupancy } = require('../../routes/image-lab');

let dir, code;
const put = (root, name, text) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
const write = (name, text) => put(dir, name, text);
const hosts = () => [{ url: 'http://10.0.0.1:11434', name: 'Bench' }, { url: 'http://10.0.0.1:11435', name: 'Bench CPU' }, { url: 'http://10.0.0.2:11434', name: 'Desk' }];
const idle = async () => ({ maintenance: null, workloads: [], inferences: [] });
function app(sources = () => ({ listActive: idle, hosts }), data = () => dir) {
  const instance = express(); instance.use('/images/labo', createRouter({ code, data, sources })); return instance;
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
