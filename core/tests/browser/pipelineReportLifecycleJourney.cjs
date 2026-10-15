'use strict';
// Real Core storage/HTTP + native Python runner, with disposable source, model and systemd fixtures.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const { chromium } = require('playwright');
const express = require('express'), ejs = require('ejs'), mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const run = promisify(execFile), core = path.resolve(__dirname, '../..'), tree = path.dirname(core);
const reportDir = process.env.PIPELINE_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(tree + path.sep)) throw new Error('Set PIPELINE_REPORT_DIR outside the source checkout');
fs.mkdirSync(reportDir, { recursive: true });
const Task = require('../../models/PipelineTask'), Report = require('../../models/PipelineReportRun'), File = require('../../models/PipelineTaskDeliverable');
const reports = require('../../src/services/pipelineReportService'), inference = require('../../src/services/pipelineReportInference');
const config = require('../../src/services/modelRouterConfig');
const { CodingDispatchControl, registerCodingDispatchControlRoutes } = require('../../integrations/runtime-bridges/coding-dispatch-control');
const { CodingTaskPreparation } = require('../../integrations/runtime-bridges/coding-task-preparation');
let mongo, server, browser;
let lostResult = false, syntheticCalls = 0;
const nativeCommands = [], errors = [], results = [], fixtureRoots = [];
(async () => {
  process.env.NODE_ENV = 'test';
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri('pipeline_report_lifecycle_fixture');
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([Report.createIndexes(), File.createIndexes()]);
  config.ensureTaskModelOverridesLoaded = async () => {};
  config.getModelForTask = () => ({ model: 'fixture-local-model', url: 'http://ollama.invalid:11434' });
  const app = express().use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(core, 'public')));
  require('../../routes/pipeline-page')(app);
  app.get('/js/pipeline-worker-outcome.js', (_q, r) => r.sendFile(path.join(tree, 'shared/pipelineWorkerOutcome.js')));
  app.get('/api/router/config', (_q, r) => r.json({ data: { taskModels: { code_generation: { model: 'fixture-local-model' } } } }));
  app.post('/fixture/inference', async (q, r) => {
    const receipt = await inference.prepare({ 'x-agentx-report-request': q.body.requestId, 'x-agentx-report-task': q.body.pipelineId,
      'x-agentx-coding-call': require('node:crypto').randomUUID() }, 'fixture-local-model');
    await receipt.finish('completed'); syntheticCalls++;
    r.json({ data: { simulated: true } });
  });
  // Lose one acknowledgement after the exact successful report was durably committed.
  app.post('/api/pipeline/tasks/:id/reports/:key/result', async (q, r, next) => {
    if (lostResult) return next();
    await reports.submit(q.params.id, q.params.key, q.body); lostResult = true;
    return r.status(503).json({ code: 'FIXTURE_LOST_ACK', message: 'Synthetic lost result acknowledgement' });
  });
  app.use('/api/pipeline', require('../../routes/pipeline-deliverables'));
  app.use('/api/pipeline', require('../../routes/pipeline'));
  let base, fixtureRoot;
  const control = new CodingDispatchControl({ sshTarget: 'fixture', sshRunner: async (_target, command) => {
    nativeCommands.push(command);
    const args = command.split(' ').slice(2);
    const result = await run('python3', [path.join(tree, 'integrations/coding/tests/report_lifecycle_fixture.py'), ...args], {
      env: { ...process.env, AGENTX_CORE_URL: base, AGENTX_REPORT_LIFECYCLE_FIXTURE: '1',
        AGENTX_REPORT_FIXTURE_ROOT: fixtureRoot, XDG_STATE_HOME: path.join(fixtureRoot, 'state'), AGENTX_CODING_MODEL: 'auto' },
      timeout: 25000, maxBuffer: 1024 * 1024,
    });
    return result;
  } });
  const preparation = new CodingTaskPreparation({ pipeline: require('../../src/services/pipelineTaskPreparationService') });
  app.use('/api/runtime-bridges/coding-dispatch', registerCodingDispatchControlRoutes({ express, control, preparation }));
  // Read-only auxiliary panels are not under test here.
  app.use('/api', (_q, r) => r.json({ ok: true, data: { items: [], tasks: [], counts: {}, enabled: false } }));
  const html = await ejs.renderFile(path.join(core, 'views/pages/pipeline.ejs'));
  const scripts = ['pipeline-report-selection', 'pipeline-launch', 'pipeline-worker-outcome', 'pipeline-worker-monitor', 'pipeline-delivery',
    'pipeline-board', 'pipeline-attempt-dossier', 'pipeline-deliverables', 'pipeline-drawer', 'pipeline'];
  app.get('/', (_q, r) => r.send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/css/pipeline.css"><body>${html}${scripts.map(name => `<script src="/js/${name}.js"></script>`).join('')}</body></html>`));
  server = await new Promise(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
  for (const [device, viewport, pipelineId] of [['desktop', { width: 1440, height: 1050 }, '0100'], ['mobile', { width: 390, height: 844 }, '0101']]) {
    await Promise.all([Task.deleteMany({}), Report.deleteMany({}), File.deleteMany({})]);
    fixtureRoot = fs.mkdtempSync(path.join(reportDir, device + '-')); fixtureRoots.push(fixtureRoot);
    const workspace = path.join(fixtureRoot, 'workspaces/task-' + pipelineId);
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Fixture\n'); fs.writeFileSync(path.join(workspace, 'OPERATIONS.md'), '# Fixture operations\n');
    await run('git', ['init', '--quiet', workspace]); await run('git', ['-C', workspace, 'add', '.']);
    await run('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'Fixture source']);
    const source = (await run('git', ['-C', workspace, 'rev-parse', 'HEAD'])).stdout.trim();
    await Task.create({ pipelineId, title: 'Synthetic documentation review', spec: 'Review README.md and OPERATIONS.md against this frozen source.', status: 'queued', service: 'agentx-coding' });
    lostResult = false; const before = syntheticCalls;
    const page = await browser.newPage({ viewport }); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('#pipelineTeamLaunchTask').selectOption(pipelineId);
    await page.locator('#pipelineTeamLaunchForm [name=reportName]').selectOption('REVIEW.md');
    await page.locator('#pipelineTeamLaunchConfirm').check();
    await page.locator('#pipelineTeamLaunchButton').click();
    await page.waitForFunction(() => document.getElementById('pipelineCountBlocked').textContent === '1');
    let owner = await Task.findOne({ pipelineId }).lean();
    assert.equal(owner.status, 'blocked'); assert.equal(await File.countDocuments({}), 1);
    const first = owner.feedback.find(row => row.reportOutcome)?.reportOutcome;
    assert.ok(first.partial?.deliverableId);
    await page.locator(`#pipelineProgression [data-pipeline-task="${pipelineId}"]`).click();
    const resume = page.locator('[data-drawer-action="reply-resume"]');
    await resume.waitFor();
    await page.waitForFunction(() => document.getElementById('pipelineDrawerBody').textContent.includes('Partial draft'));
    assert.equal(await resume.locator('[name=resumeReport]').isChecked(), true);
    await resume.locator('[name=answer]').fill('Continue the saved checkpoint and finish the remaining operations document.');
    await resume.locator('[name=modelCallLimit]').selectOption('256');
    await resume.locator('button[type=submit]').click();
    await page.waitForFunction(() => { const button = document.getElementById('pipelineTeamLaunchReconcile'); return button && !button.hidden && !button.disabled; });
    const current = await Report.findOne({ _id: { $ne: first.requestId } }).lean();
    assert.equal(current.parentRequestId, first.requestId); assert.equal(current.parentSha256, first.partial.sha256);
    assert.equal(current.modelCallLimit, 256); assert.equal(current.state, 'review');
    const callsBeforeReconcile = syntheticCalls;
    await page.locator('[data-drawer-action="reconcile-report"]').click();
    await page.waitForFunction(() => document.getElementById('pipelineTeamLaunchReconcile').hidden);
    assert.equal(syntheticCalls, callsBeforeReconcile);
    const accept = page.locator('[data-drawer-action="confirm-done"]'); await accept.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-deliverables-view="files"]')?.textContent.includes('Report candidate'));
    assert.equal(await page.locator('[data-deliverables-view="files"] [data-download-deliverable]').count(), 2);
    await accept.locator('[name=by]').fill('fixture-reviewer');
    assert.equal(await accept.locator('[name=reportScopeComplete]').isChecked(), false);
    await accept.locator('[name=reportScopeComplete]').check();
    await page.screenshot({ path: path.join(reportDir, device + '-report-review.png') });
    assert.equal(await page.locator('#pipelineDrawerBody').evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
    await accept.locator('button[type=submit]').click();
    await page.waitForFunction(() => document.getElementById('pipelineCountDone').textContent === '1');
    owner = await Task.findOne({ pipelineId }).lean();
    assert.equal(owner.status, 'done'); assert.equal(owner.feedback.at(-1).reportAcceptance.requestId, current._id);
    assert.equal(await File.countDocuments({}), 2); assert.equal(syntheticCalls - before, 2);
    assert.equal((await run('git', ['-C', workspace, 'rev-parse', 'HEAD'])).stdout.trim(), source);
    assert.equal((await run('git', ['-C', workspace, 'status', '--porcelain'])).stdout, '');
    assert.equal((await reports.status(pipelineId, current._id)).cumulativeUsage.modelCalls, 2);
    results.push({ device, partialArchived: true, checkpointRestored: true, lostResultReconciled: true, independentReview: true, sourceUnchanged: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(reportDir, 'lifecycle-browser.json'), JSON.stringify({ results, nativeCommands, errors, simulatedInferenceCalls: syntheticCalls, liveModelCalls: 0 }, null, 2));
  console.log(JSON.stringify({ results, errors, liveModelCalls: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  for (const root of fixtureRoots) {
    try { const { pid } = JSON.parse(fs.readFileSync(path.join(root, 'native-active'), 'utf8')); if (Number.isSafeInteger(pid)) process.kill(-pid, 'SIGKILL'); } catch { /* An exited disposable fixture needs no cleanup. */ }
  }
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect(); await mongo?.stop();
});
