'use strict';
// Synthetic native supervisor behind the actual Core bridge/router and rendered UI.
// Never reads personal sessions or launches a workstation process.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const tree = path.resolve(__dirname, '../../..'), core = path.join(tree, 'core');
const report = process.env.OPERATIONS_REPORT_DIR;
if (!report || path.resolve(report).startsWith(tree + path.sep)) throw Error('Set OPERATIONS_REPORT_DIR outside Git');
fs.mkdirSync(report, {recursive: true});
const req = createRequire(core + '/package.json');
const express = req('express'), {chromium} = require('playwright');
const {createOperationsService} = req('./src/services/operationsJobsService');
const {mount} = req('./routes/operations-jobs');
const {buildProductNavigation} = require(tree + '/shared/productNavigation');
const kinds = ['codex-usage', 'memory-review-submit', 'offhost-backup', 'archive-mirror', 'bundle-delivery'];
const names = ['Activité Codex', 'Collecte mémoire', 'Copies de secours', 'Archives', 'Paquets publiés'];
const ids = ['usage', 'memory', 'backups', 'archive', 'delivery'];
const startedAt = new Date(Date.now() - 60000).toISOString(), finishedAt = new Date(Date.now() - 45000).toISOString();
let nativeRevision = 1, offline = false, loseReply = false;
const effects = [], edits = [], runs = [];
const jobs = kinds.map((kind, index) => ({id: ids[index], name: names[index], description: ['Les compteurs de vos sessions, disponibles dans AgentX.', 'Les échanges locaux alimentent la revue quotidienne, avec leurs filtres conservés.', 'Une copie des sauvegardes terminées sur le disque de secours.', 'Un miroir vérifié des nouveaux snapshots d’archives.', 'Le nouveau paquet est livré dans le workspace local.'][index], kind, enabled: true,
  state: 'completed', hostLabel: 'Workstation', supervisorLabel: 'Operations server', schedule: index === 1 ? {type: 'daily', at: '03:15', timezone: 'America/Toronto'} : {type: 'interval', minutes: 15, timezone: 'America/Toronto'},
  gateType: index === 2 ? 'core-backup' : index === 3 ? 'snapshot' : index === 4 ? 'file' : null,
  source: {ready: true, sourceAt: finishedAt}, nextRunAt: new Date(Date.now() + 600000).toISOString(), lastSuccessAt: finishedAt,
  lastRun: {requestId: `12345678-1234-4234-8234-12345678900${index}`, jobId: ids[index], state: 'completed', trigger: 'scheduled', createdAt: startedAt, startedAt, finishedAt, exitCode: 0, metrics: {files: index + 2, verified: index > 1}}}));
runs.push(...jobs.map(job => job.lastRun));
function snapshot() {return {contract: 'agentx.operations/v1', available: true, revision: nativeRevision, observedAt: new Date().toISOString(),
  supervisor: {label: 'Operations server', lastTickAt: new Date().toISOString()}, jobs, history: [...runs].reverse(), historyTotal: runs.length,
  inventory: {observedAt: new Date().toISOString(), unavailable: [], rows: [
    {name: 'Previous usage task', enabled: false, state: 'Disabled', category: 'migrated', assessment: 'server-managed', jobId: 'usage', hostLabel: 'Workstation', lastResult: 0, triggers: [{type: 'MSFT_TaskTimeTrigger', interval: 'PT15M'}]},
    {name: '<img src=x onerror=alert(1)>', enabled: true, state: 'Ready', category: 'provider', assessment: 'missing-executable', hostLabel: 'Workstation', lastResult: 2, triggers: [{type: 'MSFT_TaskLogonTrigger'}]}
  ]}, legacy: []};}
function parameter(command, name) {const match = command.match(new RegExp(`'--${name}' '([^']*)'`)); return match?.[1];}
async function runner(_host, command) {
  if (offline) throw Error('Synthetic native server unavailable');
  if (command.includes(' status')) return {stdout: JSON.stringify({status: 'success', data: snapshot()})};
  const id = parameter(command, 'job'), job = jobs.find(row => row.id === id);
  let data;
  if (command.includes(' patch')) {
    if (Number(parameter(command, 'revision')) !== nativeRevision) return {stdout: JSON.stringify({status: 'error', error: {code: 'REVISION_CONFLICT', message: 'Refresh', status: 409}})};
    const changes = JSON.parse(Buffer.from(parameter(command, 'changes'), 'base64').toString());
    Object.assign(job, changes); nativeRevision++; edits.push(changes); data = {jobId: id, revision: nativeRevision};
  } else if (command.includes(' run')) {
    const requestId = parameter(command, 'request');
    data = runs.find(row => row.requestId === requestId);
    if (!data) {
      data = {requestId, jobId: id, state: loseReply ? 'unknown' : 'completed', trigger: 'manual', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: loseReply ? null : new Date().toISOString(), exitCode: loseReply ? null : 0, metrics: {files: 1, verified: true}};
      effects.push(requestId); runs.push(data); job.lastRun = data; job.state = data.state;
    }
    if (loseReply) {loseReply = false; throw Error('Synthetic answer lost after acceptance');}
  } else if (command.includes(' reconcile')) {
    const requestId = parameter(command, 'request'); data = runs.find(row => row.requestId === requestId);
    Object.assign(data, {state: 'completed', finishedAt: new Date().toISOString(), exitCode: 0});
    jobs.find(row => row.id === data.jobId).state = 'completed';
  } else throw Error('Unexpected native command');
  return {stdout: JSON.stringify({status: 'success', data})};
}
let server, browser;
(async () => {
  const app = express();
  app.set('view engine', 'ejs'); app.set('views', core + '/views'); app.locals.buildProductNavigation = buildProductNavigation;
  app.use('/vendor/fontawesome/6.4.0', express.static(core + '/node_modules/@fortawesome/fontawesome-free'));
  app.use(express.static(core + '/public'));
  const service = createOperationsService({env: {AGENTX_OPERATIONS_SSH_TARGET: 'operator@synthetic'}, runner, mirror: async () => {}});
  mount(app, {service});
  app.get('/api/health', (_r, res) => res.json({status: 'ok'}));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  app.locals.publicUrls = {core: base, benchmark: base + '/benchmark', rag: base + '/rag'};
  browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, timezoneId: 'America/Toronto'});
  const page = await context.newPage(); const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.goto(base + '/operations-jobs');
  await page.waitForFunction(() => document.querySelector('#metricActive').textContent === '5');
  assert.equal(await page.locator('.oj-job').count(), 5);
  await page.screenshot({path: report + '/desktop.png', fullPage: true});
  await page.locator('[data-action=toggle][data-job=usage]').click();
  await page.waitForFunction(() => document.querySelector('#metricActive').textContent === '4');
  assert.equal(effects.length, 0);
  await page.locator('[data-action=toggle][data-job=usage]').click();
  await page.waitForFunction(() => document.querySelector('#metricActive').textContent === '5');
  await page.locator('[data-action=settings][data-job=usage]').click();
  await page.locator('#operationsSettings [name=minutes]').selectOption('60');
  await page.locator('#operationsSettings button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#operationsSettings').open);
  assert.equal(jobs[0].schedule.minutes, 60); assert.equal(effects.length, 0);
  await page.locator('[data-action=settings][data-job=usage]').click(); nativeRevision++;
  await page.locator('#operationsSettings button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#settingsError').textContent.includes('changé'));
  assert.equal(await page.locator('#operationsSettings').evaluate(el => el.open), true);
  await page.locator('#settingsCancel').click(); await page.locator('#operationsRefresh').click();
  await page.locator('[data-action=run][data-job=usage]').dblclick();
  await page.waitForFunction(() => document.querySelector('#operationsNotice').textContent.includes('Demande reçue'));
  assert.equal(effects.length, 1);
  loseReply = true;
  await page.locator('[data-action=run][data-job=memory]').click();
  await page.waitForFunction(() => document.querySelector('[data-action=run][data-job=memory]').disabled);
  assert.equal(effects.length, 2);
  await page.reload(); await page.locator('[data-action=reconcile][data-job=memory]').waitFor();
  assert.equal(await page.locator('[data-action=run][data-job=memory]').isDisabled(), true);
  assert.equal(effects.length, 2);
  await page.locator('[data-action=reconcile][data-job=memory]').click();
  await page.waitForFunction(() => !document.querySelector('[data-action=reconcile][data-job=memory]'));
  assert.equal(effects.length, 2);
  await page.locator('#historyTab').click(); assert.ok(await page.locator('#operationsHistory tr').count() >= 7);
  await page.locator('#inventoryTab').click(); assert.equal(await page.locator('#operationsInventory img').count(), 0);
  await page.locator('#inventoryFilter').selectOption('review'); assert.equal(await page.locator('#operationsInventory tr').count(), 1);
  await page.locator('#jobsTab').click();
  offline = true; await page.locator('#operationsRefresh').click();
  await page.waitForFunction(() => document.querySelector('#operationsSupervisor').textContent.includes('indisponible'));
  assert.equal(await page.locator('[data-action=run]:enabled').count(), 0);
  offline = false; await page.locator('#operationsRefresh').click();
  await page.waitForFunction(() => document.querySelector('#operationsSupervisor').textContent.includes('Piloté'));
  assert.equal(await page.locator('#operationsNotice').isVisible(), false);
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: report + '/mobile.png', fullPage: true});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('[data-action=settings][data-job=backups]').click();
  await page.screenshot({path: report + '/mobile-settings.png'});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(pageErrors, []);
  service.stopObserver();
  fs.writeFileSync(report + '/journey.json', JSON.stringify({passed: true, effects: effects.length, edits: edits.length,
    checks: ['pause/resume does not execute', 'cadence is revision-fenced', 'double-click executes once', 'lost reply retains identity', 'refresh does not redispatch', 'native reconciliation resolves original request', 'inventory escapes names', 'offline disables controls', 'desktop/mobile without overflow'], pageErrors}, null, 2));
  console.log('Operations browser journey passed: desktop/mobile, native controls and lost-response recovery.');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(async () => {if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve));});
