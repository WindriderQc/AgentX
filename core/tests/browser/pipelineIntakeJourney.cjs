'use strict';
// Real Core HTTP/storage, disposable MongoDB, no native runner or model calls.
process.env.NODE_ENV = 'test';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const express = require('express'), ejs = require('ejs'), mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const core = path.resolve(__dirname, '../..'), tree = path.dirname(core);
const report = process.env.PIPELINE_REPORT_DIR;
if (!report || path.resolve(report).startsWith(tree + path.sep)) throw Error('Set PIPELINE_REPORT_DIR outside the checkout');
fs.mkdirSync(report, { recursive: true });
let mongo, server, browser;
const errors = [], effects = [], checks = [];
(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('synthetic_work_intake'));
  const Task = require('../../models/PipelineTask');
  await Task.createIndexes();
  const app = express().use(express.json());
  app.use(express.static(path.join(core, 'public')));
  for (const name of ['pipeline-worker-outcome', 'code-step-summary', 'code-step-graph-summary', 'pipeline-report-selection']) {
    const source = { 'pipeline-worker-outcome': 'pipelineWorkerOutcome', 'code-step-summary': 'codeStepSummary',
      'code-step-graph-summary': 'codeStepGraphSummary', 'pipeline-report-selection': 'pipelineReportSelection' }[name];
    app.get('/js/' + name + '.js', (_q, r) => r.sendFile(path.join(tree, 'shared', source + '.js')));
  }
  app.use((q, _r, next) => { if (q.method === 'POST' && !q.path.endsWith('/intake') && !q.path.endsWith('/relationships') && q.path !== '/api/pipeline/tasks') effects.push(q.path); next(); });
  app.use('/api/pipeline', require('../../routes/pipeline'));
  app.use('/api', (_q, r) => r.json({ ok: true, data: { contractVersion: 2, available: false,
    candidates: [], items: [], tasks: [], enabled: false, busy: false } }));
  const html = await ejs.renderFile(path.join(core, 'views/pages/pipeline.ejs'));
  const scripts = ['pipeline-report-selection', 'pipeline-launch', 'pipeline-worker-outcome', 'code-step-summary',
    'code-step-graph-summary', 'pipeline-code-steps', 'pipeline-code-step-graph', 'pipeline-worker-monitor',
    'pipeline-delivery', 'pipeline-board', 'pipeline-attempt-dossier', 'pipeline-deliverables', 'pipeline-editor',
    'pipeline-intake', 'pipeline-work-links', 'pipeline-eligibility', 'pipeline-attention', 'pipeline-report-resume', 'pipeline-dossier-activity', 'pipeline-drawer', 'pipeline'];
  const styles = ['/styles.css', ...['pipeline', 'pipeline-diagnostics', 'pipeline-attention', 'pipeline-evidence-references',
    'pipeline-phase-durations', 'pipeline-plan', 'pipeline-stall-diagnosis', 'pipeline-editor', 'pipeline-deliverables',
    'pipeline-resume', 'pipeline-code-steps', 'cockpit-help', 'pipeline-work-links', 'pipeline-screen'].map(name => `/css/${name}.css`)];
  app.get('/', (_q, r) => r.send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map(href => `<link rel="stylesheet" href="${href}">`).join('')}<body>${html}${scripts.map(name => `<script src="/js/${name}.js"></script>`).join('')}</body></html>`));
  server = await new Promise(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (const [device, viewport] of [['desktop', { width: 1440, height: 1050 }], ['mobile', { width: 390, height: 844 }]]) {
    await Task.deleteMany({});
    const task = await require('../../src/services/pipelineTaskService').createTaskInMongo({ title: 'Synthetic request to review', spec: 'A bounded synthetic outcome.', service: 'core' });
    await require('../../src/services/pipelineWorkAdmission').admit({ reference: { kind: 'github_issue', repository: 'example/project', number: 42 },
      scopeKey: 'separate-validation', task: { title: 'Separate synthetic validation task', spec: 'Validate the synthetic result independently.', service: 'core' },
      by: 'fixture-operator', reason: 'Inspected and separated the synthetic validation scope.', requestId: require('node:crypto').randomUUID(), confirm: true });
    const page = await browser.newPage({ viewport }); page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const decisions = [];
    await page.route('**/api/pipeline/tasks/*/intake', route => {
      decisions.push(route.request().postDataJSON());
      return device === 'desktop' && decisions.length === 1 ? route.abort('failed') : route.continue();
    });
    const links = [];
    await page.route('**/api/pipeline/tasks/*/relationships', route => {
      if (route.request().method() !== 'POST') return route.continue();
      links.push(route.request().postDataJSON());
      return device === 'desktop' && links.length === 1 ? route.abort('failed') : route.continue();
    });
    await page.goto(base + '/?task=' + task.pipelineId);
    const form = page.locator('form[data-intake-decision]');
    await form.waitFor();
    assert.equal(await page.locator('[aria-label="Acteurs et autorité"]').count(), 1);
    assert.equal(await page.locator('[data-drawer-action="give-to-team"]').count(), 0);
    assert((await page.locator('#pipelineDrawerBody').innerText()).includes('Proposition à trier'));
    await form.locator('[name=state]').selectOption('accepted');
    await form.locator('[name=reason]').fill('Synthetic scope reviewed in the browser.');
    await form.locator('[name=by]').fill('fixture-operator');
    await form.locator('button[type=submit]').click();
    if (device === 'desktop') {
      await page.waitForFunction(() => document.querySelector('[data-intake-status]')?.textContent.includes('Votre justification est conservée'));
      await form.evaluate(element => { element.dataset.fixtureOriginalForm = 'true'; });
      await page.evaluate(pipelineId => window.dispatchEvent(new CustomEvent('pipeline:task-changed', { detail: { pipelineId } })), task.pipelineId);
      await page.waitForFunction(() => {
        const current = document.querySelector('form[data-intake-decision]');
        return current && !current.dataset.fixtureOriginalForm;
      });
      assert.equal(await form.locator('[name=reason]').inputValue(), 'Synthetic scope reviewed in the browser.');
      await form.locator('button[type=submit]').click();
    }
    await page.locator('[data-drawer-action="give-to-team"]').waitFor();
    if (device === 'desktop') assert.deepEqual(decisions[1], decisions[0]);
    assert.equal((await Task.findOne({ pipelineId: task.pipelineId })).intake.state, 'accepted');
    assert.equal((await Task.findOne({ pipelineId: task.pipelineId })).status, 'queued');
    await page.locator('form[data-intake-decision] [name=state]').selectOption('deferred');
    await page.locator('form[data-intake-decision] [name=reason]').fill('Synthetic owner deliberately defers this work.');
    await page.locator('form[data-intake-decision] [name=by]').fill('fixture-operator');
    await page.locator('form[data-intake-decision] button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#pipelineDrawerBody')?.innerText.includes('Demande reportée'));
    await page.locator('[data-drawer-action="give-to-team"]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-drawer-action="give-to-team"]').count(), 0);
    const saved = await Task.findOne({ pipelineId: task.pipelineId }).lean();
    assert.equal(saved.intake.history.length, 3); assert.equal(saved.automationAttemptCount, 0);
    assert.equal(saved.assignee, null); assert.equal(saved.status, 'queued');
    const panel = page.locator('[data-drawer-disclosure="work-links"]');
    await panel.locator('summary').click();
    assert((await page.locator('[aria-label="Acteurs et autorité"]').innerText()).includes('aucune identité humaine authentifiée'));
    await page.locator('[aria-label="Acteurs et autorité"]').screenshot({ path: path.join(report, `${device}-authority.png`) });
    const linkForm = panel.locator('form[data-work-links]');
    await linkForm.locator('[name=workOperation]').selectOption('add');
    await linkForm.locator('[name=workRepository]').fill('example/project');
    await linkForm.locator('[name=workNumber]').fill('42');
    await linkForm.locator('[name=workReason]').fill('Inspected this synthetic source before linking it.');
    await linkForm.locator('[name=workBy]').fill('fixture-operator');
    await linkForm.locator('[data-work-lookup]').click();
    await page.waitForFunction(() => document.querySelector('[data-work-matches]')?.textContent.includes('1 tâche(s)'));
    await linkForm.locator('button[type=submit]').click();
    if (device === 'desktop') {
      await page.waitForFunction(() => document.querySelector('[data-work-status]')?.textContent.includes('Votre justification est conservée'));
      await linkForm.evaluate(element => { element.dataset.fixtureOriginalForm = 'true'; });
      await page.evaluate(pipelineId => window.dispatchEvent(new CustomEvent('pipeline:task-changed', { detail: { pipelineId } })), task.pipelineId);
      await page.waitForFunction(() => {
        const current = document.querySelector('form[data-work-links]');
        return current && !current.dataset.fixtureOriginalForm;
      });
      assert.equal(await linkForm.locator('[name=workReason]').inputValue(), 'Inspected this synthetic source before linking it.');
      await linkForm.locator('button[type=submit]').click();
    }
    await page.waitForFunction(() => document.querySelector('form[data-work-links]')?.dataset.revision === '1');
    if (device === 'desktop') assert.deepEqual(links[1], links[0]);
    if (!(await panel.evaluate(element => element.open))) await panel.locator('summary').click();
    await panel.locator('[data-work-fill]').click();
    await linkForm.locator('[data-work-lookup]').click();
    await page.waitForFunction(() => document.querySelector('[data-work-matches]')?.textContent.includes('2 tâche(s)'));
    assert((await panel.innerText()).includes('Separate synthetic validation task'));
    await Task.updateOne({ pipelineId: task.pipelineId }, { $set: { spec: 'Amended synthetic requested outcome.' } });
    await page.evaluate(pipelineId => window.dispatchEvent(new CustomEvent('pipeline:task-changed', { detail: { pipelineId } })), task.pipelineId);
    await page.waitForFunction(() => document.querySelector('[data-drawer-disclosure="work-links"]')?.textContent.includes('périmètre à relire'));
    assert.equal(await linkForm.locator('[name=workOperation]').inputValue(), '');
    await panel.locator('[data-work-fill]').click();
    await linkForm.locator('[name=workReason]').fill('Reviewed the link against the amended synthetic outcome.');
    await linkForm.locator('[name=workBy]').fill('fixture-operator');
    await linkForm.locator('button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('form[data-work-links]')?.dataset.revision === '2');
    if (!(await panel.evaluate(element => element.open))) await panel.locator('summary').click();
    await linkForm.locator('[name=workOperation]').selectOption('add');
    await linkForm.locator('[name=workKind]').selectOption('conversation');
    await linkForm.locator('[name=workRuntime]').selectOption('codex');
    await linkForm.locator('[name=workNamespace]').fill('synthetic-workstation');
    await linkForm.locator('[name=workConversationId]').fill('synthetic-session');
    await linkForm.locator('[name=workReason]').fill('Retain the originating synthetic conversation reference.');
    await linkForm.locator('[name=workBy]').fill('fixture-operator');
    await linkForm.locator('button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('form[data-work-links]')?.dataset.revision === '3');
    const linked = await Task.findOne({ pipelineId: task.pipelineId }).lean();
    assert.equal(linked.workLinks.history.length, 3); assert.equal(linked.workLinks.entries.length, 2);
    assert.equal(linked.workLinks.entries[1].reference.namespace, 'synthetic-workstation'); assert.equal(linked.intake.state, 'deferred');
    assert.equal(linked.status, 'queued'); assert.equal(linked.automationAttemptCount, 0);
    if (!(await panel.evaluate(element => element.open))) await panel.locator('summary').click();
    await panel.scrollIntoViewIfNeeded();
    assert(await page.locator('#pipelineDrawerBody').evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.screenshot({ path: path.join(report, `${device}-intake.png`) });
    checks.push(`${device}: proposal, scoped acceptance, launch controls, deferral, retained history and no execution`);
    checks.push(`${device}: exact report lookup, shared source across tasks, link decision, amended scope and explicit review without execution`);
    checks.push(`${device}: conversation reference includes its originating runtime and account/instance namespace`);
    if (device === 'desktop') checks.push('network failure and dossier refresh retain the exact decision identity and rationale');
    await page.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(effects, []);
  fs.writeFileSync(path.join(report, 'intake-journey.json'), JSON.stringify({ passed: true, checks, errors, nativeEffects: effects.length }, null, 2));
  console.log('PASS: real Core intake, relationships, exact retries and desktop/mobile dossier; zero native effects.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  require('../../src/helpers/httpAgent').destroyAgents();
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});
