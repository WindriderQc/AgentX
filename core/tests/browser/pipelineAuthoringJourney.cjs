'use strict';
// Synthetic HTTP fixtures only: this journey never calls Core or a model.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { chromium } = require('playwright');
const core = path.resolve(__dirname, '../..');
const req = createRequire(path.join(core, 'package.json'));
const express = req('express');
const ejs = req('ejs');
const reportDir = process.env.PIPELINE_REPORT_DIR;
if (!reportDir || path.resolve(reportDir) === path.resolve(core, '..') || path.resolve(reportDir).startsWith(path.resolve(core, '..') + path.sep)) {
  throw new Error('Set PIPELINE_REPORT_DIR to a directory outside the checkout.');
}
fs.mkdirSync(reportDir, { recursive: true });
const oldTask = { pipelineId: '0042', title: 'Synthetic existing task', spec: 'Keep the existing scope.',
  service: 'aiOPs', epic: 'Historical group', priority: 2, status: 'in_progress', assignee: 'fixture-worker',
  dependsOn: [], planningItemIds: ['111111111111111111111111'], dueAt: null, notBefore: null };
const suggestions = [{ service: 'aiOps', epic: 'aiOps', status: 'queued' },
  { service: 'custom-component', epic: 'Current group', status: 'queued' },
  { service: 'AgentX-Ecosystem', epic: 'MCP Inbox', status: 'queued' }];
let browser, server;
const writes = [], checks = [], errors = [];
(async () => {
  const editor = await ejs.renderFile(path.join(core, 'views/partials/pipeline-editor.ejs'));
  const app = express();
  app.use(express.json());
  app.use('/vendor/fontawesome', express.static(path.join(core, 'node_modules/@fortawesome/fontawesome-free')));
  app.use(express.static(path.join(core, 'public')));
  app.get('/', (_request, response) => response.send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task authoring fixture</title><link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css"><link rel="stylesheet" href="/css/pipeline.css"><link rel="stylesheet" href="/css/pipeline-editor.css"><body style="background:#0b1220;color:#e2e8f0;font-family:system-ui"><h1>Pipeline</h1>${editor}<script src="/js/pipeline-editor.js"></script></body></html>`));
  app.get('/api/planning/items', (_request, response) => response.json({ ok: true, data: { items: [] } }));
  app.get('/api/pipeline/tasks/0042', (_request, response) => response.json({ ok: true, data: { task: oldTask, editToken: 'fixture-token' } }));
  app.post('/api/pipeline/tasks', (request, response) => {
    writes.push({ method: 'POST', body: request.body });
    response.status(201).json({ ok: true, data: { task: { pipelineId: '0043' } } });
  });
  app.patch('/api/pipeline/tasks/0042', (request, response) => {
    writes.push({ method: 'PATCH', body: request.body });
    response.json({ ok: true, data: { task: { pipelineId: '0042' } } });
  });
  app.use('/api', (request, response) => { errors.push(`Unexpected API: ${request.method} ${request.path}`); response.sendStatus(404); });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  browser = await chromium.launch({ headless: true });
  for (const [device, viewport] of [['desktop', { width: 1366, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, timezoneId: 'America/Toronto' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(tasks => window.PipelineTaskEditor.open(null, tasks), suggestions);
    assert.equal(await page.locator('#pipelineEditTitle').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('#pipelineEditorDetails').evaluate(el => el.open), false);
    assert.equal(await page.locator('#pipelineEditService').inputValue(), '');
    assert.equal(await page.locator('#pipelineEditEpic').inputValue(), '');
    assert.match(await page.locator('#pipelineSavePreview').textContent(), /Service : non précisé · Groupe : sans groupe · Priorité : P3/);
    assert.match(await page.locator('#pipelineSavePreview').textContent(), /ne lance pas un agent/);
    assert.deepEqual(await page.locator('#pipelineServiceChoices option').evaluateAll(nodes => nodes.map(node => node.value)), ['core', 'benchmark', 'rag', 'data', 'ecosystem']);
    assert.deepEqual(await page.locator('#pipelineEpicChoices option').evaluateAll(nodes => nodes.map(node => node.value)), ['Current group']);
    const before = writes.length;
    await page.locator('#pipelineEditorSave').click();
    assert.equal(writes.length, before, 'A title is required before saving.');
    await page.locator('#pipelineEditTitle').fill('Synthetic title-only task');
    await page.screenshot({ path: path.join(reportDir, `${device}-new-task.png`) });
    await page.locator('#pipelineEditorSave').click();
    await page.waitForFunction(() => !document.getElementById('pipelineTaskEditor').open);
    assert.equal(writes.length, before + 1);
    assert.deepEqual({ ...writes.at(-1).body, sourceKey: 'generated' }, { title: 'Synthetic title-only task', spec: '',
      service: '', epic: '', priority: 3, dependsOn: [], dueAt: null, notBefore: null,
      planningItemIds: [], source: 'pipeline-ui', sourceKey: 'generated' });
    checks.push(`${device}: title-only creation, empty classification, and current suggestions.`);

    await page.evaluate(() => window.PipelineTaskEditor.open());
    await page.locator('#pipelineEditorDetails > summary').click();
    await page.locator('#pipelineEditService').fill('core');
    assert.match(await page.locator('#pipelineServiceHelp').textContent(), /Interfaces AgentX/);
    await page.locator('#pipelineEditService').fill('personal');
    assert.match(await page.locator('#pipelineSavePreview').textContent(), /suivi personnel ou familial/);
    await page.locator('#pipelineEditService').fill('custom-component');
    assert.match(await page.locator('#pipelineServiceHelp').textContent(), /personnalisée/);
    await page.locator('#pipelineEditEpic').fill('Current group');
    await page.locator('#pipelineEditDependencies').fill('0040, 0041, 0040');
    await page.locator('#pipelineEditNotBefore').fill('2030-10-20T09:30');
    await page.locator('#pipelineEditDue').fill('2030-10-21T16:00');
    assert.match(await page.locator('#pipelineSavePreview').textContent(), /Groupe : Current group/);
    assert.match(await page.locator('#pipelineSavePreview').textContent(), /après la fin de 2 tâche\(s\) liée\(s\)/);
    assert.match(await page.locator('#pipelineSavePreview').textContent(), /Disponible au plus tôt le/);
    assert.match(await page.locator('#pipelineSavePreview').textContent(), /Échéance souhaitée/);
    await page.locator('#pipelineEditTitle').fill('Synthetic scheduled task');
    await page.locator('#pipelineEditEpic').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(reportDir, `${device}-classification.png`) });
    assert.equal(await page.locator('#pipelineTaskEditor').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.locator('#pipelineEditorSave').click();
    await page.waitForFunction(() => !document.getElementById('pipelineTaskEditor').open);
    assert.deepEqual(writes.at(-1).body.dependsOn, ['0040', '0041']);
    assert.equal(writes.at(-1).body.notBefore, '2030-10-20T13:30:00.000Z');
    checks.push(`${device}: live service guidance, custom classification, dependencies, and local dates.`);

    await page.evaluate(() => window.PipelineTaskEditor.open('0042'));
    assert.equal(await page.locator('#pipelineEditorDetails').evaluate(el => el.open), true);
    assert.equal(await page.locator('#pipelineEditService').inputValue(), 'aiOPs');
    assert.match(await page.locator('#pipelineServiceHelp').textContent(), /archivé/);
    assert.match(await page.locator('#pipelineSavePreview').textContent(), /responsable et l’historique actuels sont conservés/);
    await page.locator('#pipelineEditTitle').fill('Synthetic clarified task');
    await page.locator('#pipelineEditorSave').click();
    await page.waitForFunction(() => !document.getElementById('pipelineTaskEditor').open);
    assert.deepEqual(writes.at(-1), { method: 'PATCH', body: { changes: { title: 'Synthetic clarified task' }, editToken: 'fixture-token', by: 'operator' } });
    checks.push(`${device}: existing historical labels and Planning links survive unrelated edits.`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify({ checks, writes: writes.length, errors }, null, 2));
  console.log(JSON.stringify({ checks, writes: writes.length, errors }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
