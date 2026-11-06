'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateComposition, loadComposition, compositionView } = require('../../../src/services/ecosystemComposition');
const { createPresentationReader } = require('../../../src/services/presentationReadService');
const { renderPage } = require('../index');
const NOW = Date.parse('2030-01-02T12:00:00.000Z');
const fixture = () => ({ version: 1, reviewedAt: '2030-01-02', source: 'Synthetic reviewed instance', nodes: [
  { id: 'host-a', name: 'Host A', subtitle: 'Compute', kind: 'host', status: 'installed', roles: ['Shared inference'], evidence: 'Synthetic receipt' },
  { id: 'service-a', name: 'Service A', subtitle: 'Shared service', kind: 'service', status: 'installed', host: 'host-a' }
], links: [{ from: 'host-a', to: 'service-a', kind: 'compute' }], workflows: [{ id: 'voice', title: 'Voice', stops: [
  { node: 'host-a', label: 'Intake' }, { node: 'service-a', label: 'Result' }
] }], placements: { 'host-a': { x: 0, z: 0, width: 2, height: 4, depth: 2 }, 'service-a': { x: 4, z: 0, width: 2, height: 1, depth: 2 } } });
function instance(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecosystem-composition-'));
  t.after(() => fs.rmSync(root, { recursive: true })); fs.mkdirSync(path.join(root, 'config'));
  const file = path.join(root, 'config/ecosystem-composition.json');
  return { file, env: { AGENTX_INSTANCE_ROOT: root }, write: value => fs.writeFileSync(file, JSON.stringify(value)) };
}
function display(read, changes = {}) {
  return { application: 'ecosystem', presentationId: 'fixture', instance: '11111111-1111-4111-8111-111111111111',
    version: 'a'.repeat(64), snapshot: '2030-01-02', documentRevision: 1, sequence: 1,
    mountedAt: new Date(NOW - 1000).toISOString(), observedAt: new Date(NOW).toISOString(),
    tour: { script: 'overview', index: 0, count: 1, kind: 'node', label: 'Host A', title: 'Host A', adhoc: 'node-host-a', playing: false },
    focus: [{ id: 'host-a', label: 'Host A' }], selection: { id: 'host-a', label: 'Host A', description: 'Browser observation only.' },
    narration: 'Displayed composition.', narrationComplete: true, composition: read, ...changes };
}
test('composition is optional; an invalid configured inventory never falls back to history', t => {
  const inst = instance(t); assert.equal(loadComposition(inst.env), null);
  fs.writeFileSync(inst.file, '{'); assert.throws(() => loadComposition(inst.env), { code: 'ECOSYSTEM_COMPOSITION_INVALID' });
  inst.write(fixture()); const first = loadComposition(inst.env), second = loadComposition(inst.env);
  assert.equal(first.contentRevision, second.contentRevision); assert.deepEqual(first.data, fixture());
  const changed = fixture(); changed.nodes[0].roles.push('New reviewed role'); inst.write(changed);
  assert.notEqual(loadComposition(inst.env).contentRevision, first.contentRevision);
});
test('strict graph validation refuses duplicate, dangling, cyclic hosting and executable/unknown fields', () => {
  const mutations = [v => v.nodes.push(v.nodes[0]), v => v.nodes[1].host = 'missing', v => v.nodes[0].host = 'host-a',
    v => v.nodes[0].url = 'https://example.invalid', v => v.links[0].to = 'missing', v => v.links.push(v.links[0]),
    v => v.workflows[0].stops[0].node = 'missing', v => v.placements['host-a'].x = Infinity,
    v => v.placements['host-a'].y = NaN, v => v.nodes[0].status = 'healthy', v => v.reviewedAt = '2030-02-30',
    v => v.nodes[0].specs = ['x'.repeat(241)], v => v.nodes[0].status = 'attention', v => v.secret = 'fixture'];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => validateComposition(value)); }
});
test('the rendered private composition reference resolves to Core data, and refresh keeps content identity', t => {
  const inst = instance(t); inst.write(fixture()); let now = NOW;
  const reader = createPresentationReader({ now: () => now });
  const first = compositionView({ ...inst, reader, now: () => now });
  const data = reader.read(first.read); assert.equal(data.source, 'core.ecosystem.composition');
  assert.deepEqual(data.nodes, fixture().nodes); assert.equal(data.compositionSource, fixture().source);
  const shown = reader.observeEcosystem(display({ contentRevision: first.contentRevision, read: first.read }), 'fixture');
  assert.equal(shown.composition.status, 'available'); assert.deepEqual(shown.composition.data.selection, fixture().nodes[0]);
  now += 10000; const next = compositionView({ ...inst, reader, now: () => now });
  assert.equal(next.contentRevision, first.contentRevision); assert.notEqual(next.read.id, first.read.id);
  now += 300000; assert.equal(reader.read(first.read).status, 'unavailable');
});
test('forged composition identity, wrong date and browser labels do not become canonical evidence', t => {
  const inst = instance(t); inst.write(fixture());
  const reader = createPresentationReader({ now: () => NOW }); const view = compositionView({ ...inst, reader, now: () => NOW });
  for (const [claim, changes] of [
    [{ contentRevision: 'f'.repeat(64), read: view.read }, {}],
    [{ contentRevision: view.contentRevision, read: view.read }, { snapshot: '2030-01-01' }],
    [{ contentRevision: view.contentRevision, read: view.read }, { focus: [{ id: 'host-a', label: 'Forged' }], selection: { id: 'host-a', label: 'Forged', description: 'Forged' } }]
  ]) {
    const local = createPresentationReader({ now: () => NOW });
    compositionView({ ...inst, reader: local, now: () => NOW });
    // A real retained read is required in the same reader, not just a syntactically valid claim.
    const value = local.observeEcosystem(display(claim, changes), 'fixture');
    assert.equal(value.composition.status, 'unavailable');
  }
});
test('HTML safely carries data without introducing script or attributes', t => {
  const inst = instance(t), value = fixture(); value.nodes[0].name = '\"><script>bad()</script>';
  inst.write(value); const view = compositionView({ ...inst, reader: createPresentationReader({ now: () => NOW }), now: () => NOW });
  const html = renderPage({ roots: [], attributes: { app: 'ecosystem' }, composition: view });
  assert.match(html, / composition="\{&quot;/); assert.doesNotMatch(html, /<script>bad/);
  assert.doesNotMatch(renderPage({ roots: [], attributes: { app: 'ecosystem' } }), / composition=/);
});
module.exports = { fixture };
test('owner pages carry the reviewed composition while a Family device never receives it, including on invalid configuration', async t => {
  const inst = instance(t); inst.write(fixture());
  const express = require('express'), request = require('supertest');
  const app = express();
  app.use((req, _res, next) => { if (req.get('x-fixture-family')) req.familyDevice = { unlockedUntil: null }; next(); });
  require('../index').register({ app, express, env: { ...inst.env, DISKX_MODULE_URL: 'https://assets.example/embed/diskx.js' } });
  const owner = await request(app).get('/diskx?app=ecosystem').expect(200);
  assert.match(owner.text, / composition=/); assert.match(owner.text, /Synthetic reviewed instance/);
  const family = await request(app).get('/diskx?app=ecosystem').set('x-fixture-family', '1').expect(200);
  assert.doesNotMatch(family.text, / composition=|Synthetic reviewed instance/);
  fs.writeFileSync(inst.file, '{invalid');
  await request(app).get('/diskx?app=ecosystem').expect(503);
  const safe = await request(app).get('/diskx?app=ecosystem').set('x-fixture-family', '1').expect(200);
  assert.doesNotMatch(safe.text, / composition=/);
});
test('a retained display does not extend the bound composition reference lifetime', t => {
  const inst = instance(t); inst.write(fixture()); let now = NOW;
  const reader = createPresentationReader({ now: () => now });
  const view = compositionView({ ...inst, reader, now: () => now });
  now += 299999;
  const shown = reader.observeEcosystem(display({ contentRevision: view.contentRevision, read: view.read }, {
    observedAt: new Date(now).toISOString() }), 'fixture');
  assert.equal(shown.composition.status, 'available');
  now += 2; const later = reader.read(shown);
  assert.equal(later.status, 'available'); assert.equal(later.composition.status, 'unavailable');
});
