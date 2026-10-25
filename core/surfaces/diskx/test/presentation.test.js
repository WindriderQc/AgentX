'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const fs = require('node:fs');
const vm = require('node:vm');
const diskx = require('../index');
const { readJanitorReportView } = require('../../../src/services/janitorReportView');
const { createPresentationReader, presentationReader } = require('../../../src/services/presentationReadService');
const { presentationEvidence } = require('../../household/screen-context');
const { screenDestinations } = require('../../../../shared/screenDestinations');
const pages = require('../../../public/js/screen-pages');

const DATE = '2026-01-02T12:00:00.000Z', NEXT = '2026-01-02T13:00:00.000Z', SHA = 'a'.repeat(64);
const report = { generatedAt: DATE, status: 'ready_for_review', policy: { duplicateSurvivor: 'newest' },
  evidence: { verifiedDuplicateGroups: 1, verifiedDuplicateFiles: 2, provenSavingsBytes: 100 } };
const reply = body => ({ response: { ok: true, status: 200 }, body: { data: body } });
const fetchData = (date = DATE) => async route => route.endsWith('/groups')
  ? reply({ report: { id: 'report-a', generatedAt: date }, groups: [{ sha256: SHA, count: 2, provenSavingsBytes: 100 }] })
  : reply({ report });

test('a named group cannot be combined with a different or unverifiable report', async () => {
  for (const date of [NEXT, null]) {
    await assert.rejects(readJanitorReportView({ group: SHA }, { fetchData: fetchData(date) }), { code: 'JANITOR_REPORT_CHANGED' });
  }
  await assert.rejects(readJanitorReportView({}, { fetchData: fetchData(), expectedReport: NEXT }), { code: 'JANITOR_REPORT_CHANGED' });
  const result = await readJanitorReportView({ group: SHA }, { fetchData: fetchData(), env: {} });
  assert.equal(result.group.copies, 2);
  assert.equal(new URL(result.link, 'https://core.example').searchParams.get('report'), DATE);
  assert.equal(result.screenPage, `diskx group=${SHA} report=${DATE}`);
});

test('the real screen catalogue opens the requested group with parameters DiskX accepts', () => {
  const catalog = pages.createCatalog(screenDestinations({ agentxProfile: 'full', publicUrls: { core: 'https://core.example' } }));
  const target = catalog.parse(`diskx group=${SHA} report=${DATE}`);
  const url = new URL(catalog.url(target), 'https://core.example');
  assert.equal(catalog.mode(target), 'frame');
  assert.equal(url.searchParams.get('janitor'), 'latest');
  assert.equal(url.searchParams.get('from'), 'nestor');
  assert.equal(diskx.checkQuery(Object.fromEntries(url.searchParams), ['/data']).report, DATE);
  assert.equal(diskx.checkQuery(Object.fromEntries(url.searchParams), ['/data']).group, SHA);
  for (const query of [{ from: 'other' }, { view: 'admin' }, { report: 'https://other.example' }]) assert.throws(() => diskx.checkQuery(query), /must be/);
  const demo = screenDestinations({ agentxProfile: 'demo' });
  assert.equal(demo.some(row => row.id === 'diskx'), false);
});

test('only the DiskX document permits WASM while preserving the existing policy', async () => {
  const app = express(), policy = "default-src 'self'; script-src 'self'; frame-ancestors 'self'; object-src 'none'";
  app.use((_req, res, next) => { res.set('Content-Security-Policy', policy); next(); });
  diskx.register({ app, express, env: { DISKX_ROOTS: '/data' } });
  app.get('/other', (_req, res) => res.send('other'));
  const page = await request(app).get('/diskx').expect(200);
  const directives = value => value.split(';').map(part => part.trim());
  assert.deepEqual(directives(page.headers['content-security-policy']),
    directives(policy.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'")));
  assert.equal((await request(app).get('/other')).headers['content-security-policy'], policy);
  assert.doesNotMatch(page.headers['content-security-policy'], /(?:^|\s)'unsafe-eval'/);
});

test('the same-origin presentation read rejects changed reports and arbitrary destinations', async () => {
  const app = express();
  diskx.register({ app, express, fetchData: fetchData(), env: { DISKX_ROOTS: '/data' } });
  const query = new URLSearchParams({ report: DATE, group: SHA });
  const answer = await request(app).get('/api/diskx/presentation?' + query).expect(200);
  assert.equal(answer.headers['cache-control'], 'private, no-store');
  const read = presentationReader.read(answer.body.data.read);
  assert.equal(read.source, 'janitor.report'); assert.equal(read.group.copies, 2);
  await request(app).get('/api/diskx/presentation?' + new URLSearchParams({ report: NEXT })).expect(409);
  for (const query of ['report=' + DATE + '&url=https://other.example', 'group=' + SHA, 'report=invalid']) {
    await request(app).get('/api/diskx/presentation?' + query).expect(400);
  }
});

test('only matching report and group observations receive bounded Core data', async () => {
  const view = await readJanitorReportView({ group: SHA }, { fetchData: fetchData(), env: {} });
  const reader = createPresentationReader();
  const ref = reader.publishJanitor({ ...view, privatePath: '/private/path', counts: { ...view.counts, privatePath: '/private/path' } });
  const snapshot = reader.read(ref);
  assert.doesNotMatch(JSON.stringify(snapshot), /privatePath|\/private\/path/);
  assert.equal(snapshot.bytesKind, 'logical'); assert.equal(snapshot.reportStatus, report.status);
  const sharedRef = presentationReader.publishJanitor(view);
  const catalog = pages.createCatalog([{ id: 'diskx', label: 'DiskX', href: '/diskx', mode: 'frame' }]);
  const observation = { contract: 'agentx.presentation/v1', kind: 'page', page: view.screenPage, status: 'visible',
    read: sharedRef, filters: { report: DATE, group: SHA } };
  assert.equal(presentationEvidence([observation], catalog).read.group.copies, 2);
  assert.equal(presentationEvidence([{ ...observation, filters: { report: NEXT, group: SHA } }], catalog).read.status, 'unavailable');
  assert.equal(presentationEvidence([{ ...observation, filters: { report: DATE, group: 'b'.repeat(64) } }], catalog).read.status, 'unavailable');
  assert.equal(presentationEvidence([{ ...observation, status: 'loading' }], catalog).read, undefined);
  const other = 'b'.repeat(64);
  const selectedRef = presentationReader.publishJanitor({ ...view, group: { ...view.group, sha256: other } });
  assert.equal(presentationEvidence([{ ...observation, read: selectedRef, filters: { report: DATE, group: other } }], catalog).read.group.sha256,
    other, 'a later manual selection replaces the originally requested group');
});

test('late browser reads never restore a superseded or failed presentation', async () => {
  const events = {}, pending = [];
  const status = { classList: { toggle() {} } };
  const city = { getAttribute: () => null, addEventListener: (name, fn) => { events[name] = fn; } };
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/diskx-page.js'), 'utf8'), {
    window, document: { getElementById: () => status, querySelector: () => city }, URLSearchParams, setTimeout() {},
    fetch: url => new Promise(resolve => pending.push({ url, resolve }))
  });
  events['diskx-report-read']({ detail: { reportGeneratedAt: DATE } });
  events['diskx-group-shown']({ detail: { reportGeneratedAt: DATE, sha256: SHA, outside: 1 } });
  const answer = pending => pending.resolve({ ok: true, json: async () => ({ ok: true, data: { read: { id: pending.url }, filters: {} } }) });
  answer(pending[1]); await new Promise(setImmediate);
  const current = window.AgentXPresentedContent.read.id;
  answer(pending[0]); await new Promise(setImmediate);
  assert.equal(window.AgentXPresentedContent.read.id, current);
  assert.equal(window.AgentXPresentedContent.selection.outside, 1);
  events['diskx-group-shown']({ detail: { reportGeneratedAt: DATE, sha256: SHA } });
  events['diskx-error']({ detail: { message: 'changed report' } });
  answer(pending[2]); await new Promise(setImmediate);
  assert.equal(window.AgentXPresentedContent.state, 'unavailable');
});

test('the animation list rides the real screen catalogue; the step on screen reaches Nestor as an observation', async () => {
  const catalog = pages.createCatalog(screenDestinations({ agentxProfile: 'full', publicUrls: { core: 'https://core.example' } }));
  const view = await readJanitorReportView({ play: 'duplicates,tour-3' }, { fetchData: fetchData(), env: {} });
  const target = catalog.parse(view.screenPage);
  const url = new URL(catalog.url(target), 'https://core.example');
  assert.equal(diskx.checkQuery(Object.fromEntries(url.searchParams), ['/data']).play, 'duplicates,tour-3');

  const ref = presentationReader.publishJanitor(view);
  const observation = { contract: 'agentx.presentation/v1', kind: 'page', page: view.screenPage, status: 'visible', read: ref,
    filters: { report: DATE, group: null }, selection: { scene: { kind: 'pairs', index: 2, count: 5, playing: true } } };
  assert.deepEqual(presentationEvidence([observation], catalog).scene, { kind: 'pairs', index: 2, count: 5, playing: true });
  for (const scene of [{ kind: 'delete', index: 0, count: 1 }, { kind: 'pairs', index: 5, count: 5 }, { kind: 'pairs', index: 0, count: 500 }]) {
    assert.equal(presentationEvidence([{ ...observation, selection: { scene } }], catalog).scene, undefined, JSON.stringify(scene));
  }
});

test('the page keeps the step on screen with the presented report; a refused list changes nothing', async () => {
  const events = {}, pending = [];
  const status = { classList: { toggle() {} } };
  const city = { getAttribute: () => null, addEventListener: (name, fn) => { events[name] = fn; } };
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/diskx-page.js'), 'utf8'), {
    window, document: { getElementById: () => status, querySelector: () => city }, URLSearchParams, setTimeout() {},
    fetch: url => new Promise(resolve => pending.push({ url, resolve }))
  });
  events['diskx-scene-changed']({ detail: { kind: 'overview', index: 0, count: 5, playing: false } });
  events['diskx-report-read']({ detail: { reportGeneratedAt: DATE } });
  pending[0].resolve({ ok: true, json: async () => ({ ok: true, data: { read: { id: 'r' }, filters: {} } }) });
  await new Promise(setImmediate);
  assert.equal(window.AgentXPresentedContent.selection.scene.kind, 'overview');
  events['diskx-scene-changed']({ detail: { kind: 'duplicates', index: 1, count: 5, playing: true } });
  assert.equal(JSON.stringify(window.AgentXPresentedContent.selection.scene), JSON.stringify({ kind: 'duplicates', index: 1, count: 5, playing: true }));
  events['diskx-error']({ detail: { stage: 'play', message: 'unknown play step: delete' } });
  assert.equal(window.AgentXPresentedContent.state, 'ready');
});
