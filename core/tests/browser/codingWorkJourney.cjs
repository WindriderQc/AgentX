'use strict';
// Real Core routes and disposable Mongo; no model, runner or production data.
process.env.NODE_ENV = 'test';
process.env.MONGOMS_VERSION ||= '7.0.24';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const express = require('express'), mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const core = path.resolve(__dirname, '../..');
let mongo, server, browser;
(async () => {
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } }); await mongoose.connect(mongo.getUri('synthetic_studio_work'));
  const Task = require('../../models/PipelineTask'); await Task.createIndexes();
  const create = require('../../src/services/pipelineTaskService').createTaskInMongo;
  const selected = await create({ title: 'Synthetic <img src=x onerror=alert(1)>', service: 'core',
    spec: 'Long synthetic acceptance criterion 🙂 '.repeat(800) + 'END-CRITERION' });
  await Task.updateOne({ pipelineId: selected.pipelineId }, { $set: { status: 'review',
    feedback: [{ by: 'fixture-worker', text: 'Synthetic work completed. <script>window.injected=true</script>\nhttps://example.org/pull/42\nNo fresh model test.' }] } });
  for (let i = 0; i < 31; i++) await create({ title: 'Other synthetic work ' + i, service: 'core' });
  await create({ title: 'Private errand must stay outside this view', service: 'personal' });
  const before = await Task.find().sort({ pipelineId: 1 }).lean();
  const app = express().use(express.json());
  app.set('view engine', 'ejs'); app.set('views', path.join(core, 'views'));
  app.use(express.static(path.join(core, 'public')));
  const effects = [], errors = [];
  app.use((req, _res, next) => { if (!['GET', 'HEAD'].includes(req.method)) effects.push(req.path); next(); });
  app.use('/api/pipeline', require('../../routes/pipeline'));
  require('../../routes/pipeline-page')(app);
  server = await new Promise(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--disable-gpu'] });
  const checks = [];
  for (const width of [1440, 412]) {
    const page = await browser.newPage({ viewport: { width, height: 960 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await page.goto(base + '/pipeline?view=studio');
    await page.getByText('30 dossier(s) affiché(s) sur 32', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Afficher la suite' }).click();
    await page.getByText('32 dossier(s) affiché(s) sur 32', { exact: false }).waitFor();
    assert.equal(await page.locator('.work-card').count(), 32);
    assert.equal(await page.getByText('Private errand must stay outside this view').count(), 0);
    await page.getByRole('searchbox').fill(String(Number(selected.pipelineId)));
    await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
    await page.getByText('1 dossier(s) affiché(s) sur 1', { exact: false }).waitFor();
    await page.locator(`[data-task="${selected.pipelineId}"]`).click();
    await page.getByRole('heading', { name: 'Livrables enregistrés' }).waitFor();
    const text = await page.locator('#workDossier').innerText();
    assert.ok(text.includes('END-CRITERION'));
    assert.ok(text.includes('Synthetic work completed.'));
    assert.ok(text.includes('No fresh model test.'));
    assert.ok(text.includes('Le registre est vide.'));
    assert.equal(await page.locator('#workDossier a[href="https://example.org/pull/42"]').count(), 1);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator('#workDossier img, #workDossier script').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.CODING_WORK_REPORT_DIR) {
      await fs.mkdir(process.env.CODING_WORK_REPORT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.CODING_WORK_REPORT_DIR, `studio-work-${width}.png`), fullPage: true });
    }
    checks.push({ width, paginated: true, completeSpec: true, feedbackWithoutArtifacts: true, noOverflow: true });
    await page.close();
  }
  assert.deepEqual(effects, []); assert.deepEqual(errors, []);
  assert.deepEqual(await Task.find().sort({ pipelineId: 1 }).lean(), before);
  console.log(JSON.stringify({ checks, writes: effects.length, pageErrors: errors, modelCalls: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect(); await mongo?.stop();
});
