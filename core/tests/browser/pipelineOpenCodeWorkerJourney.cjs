'use strict';
// Actual Core session routes/transport + native host reader/import, synthetic
// request receipts supplied by opencode_worker_bridge_smoke.py. No live Core.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const express = require('express');
const { CodingDispatchControl } = require('../../integrations/runtime-bridges/coding-dispatch-control');
const { registerCodingSessionsRoutes } = require('../../integrations/runtime-bridges/coding-sessions-control');
const execute = promisify(execFile);

async function main() {
  const [configPath, playwrightPath, chromiumPath, artifactRoot] = process.argv.slice(2);
  const { chromium } = require(playwrightPath);
  const input = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const root = path.resolve(__dirname, '../../..');
  const handoffs = [];
  const bindingPath = path.join(input.env.XDG_STATE_HOME, 'agentx/coding-run-requests',
    input.requestId + '.sessions', input.invocationId + '.json');
  const originalBinding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
  const setLocalState = state => {
    fs.writeFileSync(bindingPath + '.browser-tmp', JSON.stringify({ ...originalBinding, state }));
    fs.renameSync(bindingPath + '.browser-tmp', bindingPath);
  };
  let loseFirstHandoff = true;
  const control = new CodingDispatchControl({ executors: [{ id: 'fixture-open', harness: 'opencode', sshTarget: 'fixture@worker.example' }],
    sshRunner: async (target, command) => {
      assert.equal(target, 'fixture@worker.example');
      const prefix = '/usr/bin/python3 /opt/agentx/integrations/coding/coding_sessions_control.py ';
      assert(command.startsWith(prefix));
      const args = command.slice(prefix.length).split(' ');
      const result = await execute('python3', [path.join(root, 'integrations/coding/coding_sessions_control.py'), ...args],
        { env: input.env, timeout: 150_000, maxBuffer: 4 * 1024 * 1024 });
      if (args[0] === 'handoff') {
        handoffs.push(args);
        if (loseFirstHandoff) { loseFirstHandoff = false; throw new Error('Synthetic lost successful host response'); }
      }
      return result;
    } });
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerCodingSessionsRoutes({ router, control });
  app.use('/api/runtime-bridges/coding-dispatch', router);
  app.use(express.static(path.join(root, 'core/public')));
  const partial = fs.readFileSync(path.join(root, 'core/views/partials/pipeline-worker-monitor.ejs'), 'utf8');
  app.get('/', (_req, res) => res.send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body {font:16px system-ui;background:#10141c;color:#e8edf4} button,a,select{font:inherit;padding:8px} [hidden]{display:none!important}
    .pipeline-worker-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}</style>
    <link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/css/pipeline.css"><body><main class="pipeline-page">${partial}</main>
    <script src="/js/pipeline-worker-sessions.js"></script><script>
    window.fixtureRun=${JSON.stringify({ pipelineId: '0001', requestId: input.requestId, executorId: 'fixture-open', harness: 'opencode' })};
    PipelineWorkerSessions.render({$:id=>document.getElementById(id),run:window.fixtureRun});
    </script></body></html>`));
  const server = await new Promise(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath });
  const errors = [];
  try {
    for (const [device, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const page = await browser.newPage({ viewport });
      if (device === 'desktop') setLocalState('running');
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await page.goto(base);
      await page.locator('#pipelineNativeSessionButton').click();
      await page.waitForFunction(() => document.getElementById('pipelineNativeSessionStatus').textContent.includes('message(s) natifs'));
      assert.equal(await page.locator('#pipelineNativeSessionDialog').evaluate(dialog => dialog.open), true);
      assert((await page.locator('#pipelineNativeSessionMessages').innerText()).includes('WORKER_BRIDGE_OK'));
      const tools = await page.locator('#pipelineNativeSessionMessages summary').allTextContents();
      assert(tools.some(value => value.startsWith('read · completed')));
      assert(tools.some(value => value.startsWith('edit · completed')));
      assert(tools.some(value => value.startsWith('bash · completed')));
      assert.equal(await page.evaluate(() => Boolean(window.__nativeFixtureExecuted)), false);
      const button = page.locator('#pipelineNativeSessionHandoff');
      if (device === 'desktop') {
        assert.equal(await button.isDisabled(), true);
        setLocalState('exited');
        // Local child completion must enable a handoff even when native history
        // and its revision are unchanged between the two polls.
        await page.waitForFunction(() => !document.getElementById('pipelineNativeSessionHandoff').disabled);
      }
      await button.click();
      if (device === 'desktop') {
        await page.waitForFunction(() => document.getElementById('pipelineNativeSessionStatus').textContent.includes('Réessayez cette même reprise'));
        await page.waitForFunction(() => !document.getElementById('pipelineNativeSessionHandoff').disabled);
        await button.click();
      }
      await page.locator('#pipelineNativeSessionOpen:not([hidden])').waitFor();
      const link = await page.locator('#pipelineNativeSessionOpen').getAttribute('href');
      assert(link.startsWith('http://127.0.0.1:4096/'));
      assert(link.includes('/session/ses_'));
      assert.equal(await page.locator('#pipelineNativeSessionOpen').getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await page.locator('#pipelineNativeSessionDialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), true);
      await page.locator('#pipelineNativeSessionMessages details').first().evaluate(element => { element.open = true; });
      await page.locator('#pipelineNativeSessionDialog').evaluate(dialog => { dialog.scrollTop = 0; });
      if (artifactRoot) await page.screenshot({ path: path.join(artifactRoot, `core-native-worker-${device}.png`), fullPage: true });
      await page.locator('#pipelineNativeSessionClose').click();
      assert.equal(await page.locator('#pipelineNativeSessionDialog').evaluate(dialog => dialog.open), false);
      // The same source after a browser reload reuses its retained handoff
      // identity, including after the successful first response was lost.
      if (device === 'desktop') {
        await page.reload();
        await page.locator('#pipelineNativeSessionButton').click();
        await page.waitForFunction(() => !document.getElementById('pipelineNativeSessionHandoff').disabled);
        await page.locator('#pipelineNativeSessionHandoff').click();
        await page.locator('#pipelineNativeSessionOpen:not([hidden])').waitFor();
        assert.equal(await page.locator('#pipelineNativeSessionOpen').getAttribute('href'), link);
        assert.deepEqual(handoffs[0], handoffs[1]);
        assert.deepEqual(handoffs[0], handoffs[2]);
      }
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ schema: 'agentx.opencode-worker-browser/v1', passed: true,
      checks: ['desktop and narrow native transcript', 'native tool arguments and results', 'no HTML execution',
        'lost handoff response', 'same handoff after browser reload', 'independent native session link'], liveModelCalls: 0 }));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
