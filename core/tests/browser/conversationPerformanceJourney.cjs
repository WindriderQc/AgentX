'use strict';
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { catalogFor, defaultsFor } = require('../../src/services/conversationPreferences/catalog');
const root = path.resolve(__dirname, '../..');
const env = { PERSONAL_CONVERSATION_WORK_MODE: 'native', PERSONAL_CONVERSATION_WORK_AGENT_ID: 'synthetic-worker',
  PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID: 'synthetic-guardian', PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-private-work-binding-token',
  PERSONAL_CONVERSATION_CLOUD_BOSS_MODEL: 'synthetic-cloud/deep-model', PERSONAL_CONVERSATION_CLOUD_GUARDIAN_MODEL: 'synthetic-cloud/fast-model' };
const state = { revision: 0, overrides: {} }, saves = [], errors = [];
const view = surface => ({ surface, revision: state.revision, overrides: surface === 'nestor' ? state.overrides : {},
  defaults: defaultsFor(surface, env), values: { ...defaultsFor(surface, env), ...(surface === 'nestor' ? state.overrides : {}) }, catalog: catalogFor(surface, env) });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/conversation-preferences.css"><button id="personal">Nestor</button><button id="family">Family</button><script src="/js/conversation-preferences.js"></script><script>const api=async(url,options)=>{const response=await fetch(url,{...options,headers:{"Content-Type":"application/json"}});const result=await response.json();if(!response.ok)throw Error(result.message);return result;};ConversationPreferences.mount({button:document.querySelector("#personal"),api,endpoint:"/preferences"});ConversationPreferences.mount({button:document.querySelector("#family"),api,endpoint:"/preferences?family=1"});</script>');
  }
  if (url.pathname === '/preferences') {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'PUT') {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
      if (body.revision !== state.revision) { res.statusCode = 409; return res.end(JSON.stringify({ message: 'Settings changed. Reload before saving.' })); }
      saves.push(body); state.revision++; state.overrides = body.values;
    }
    return res.end(JSON.stringify(view(url.searchParams.has('family') ? 'family' : 'nestor')));
  }
  const files = { '/js/conversation-preferences.js': ['public/js/conversation-preferences.js', 'text/javascript'],
    '/css/conversation-preferences.css': ['public/css/conversation-preferences.css', 'text/css'] };
  const file = files[url.pathname];
  if (!file) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', file[1]); res.end(fs.readFileSync(path.join(root, file[0])));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#personal').click();
    const dialog = page.locator('dialog:visible'), choice = dialog.locator('[name="inferenceProfile"]');
    await choice.waitFor(); assert.equal(await choice.inputValue(), 'local');
    await choice.selectOption('boss_cloud');
    await dialog.locator('[data-light]').click();
    assert.equal(await choice.inputValue(), 'boss_cloud', 'Light changes optional context, never the selected inference profile');
    await dialog.locator('[type="submit"]').click();
    await dialog.locator('[data-status]').filter({ hasText: 'Settings saved.' }).waitFor();
    assert.equal(saves[0].values.inferenceProfile, 'boss_cloud');
    assert.ok(Object.entries(saves[0].values).filter(([key]) => key !== 'inferenceProfile').every(([, value]) => value === false));
    await choice.selectOption('full_cloud'); await dialog.locator('[data-cancel]').click();
    await page.locator('#personal').click(); await choice.waitFor();
    assert.equal(await choice.inputValue(), 'boss_cloud', 'Cancel keeps the previously saved profile');
    await choice.selectOption('full_cloud'); state.revision++;
    await dialog.locator('[type="submit"]').click();
    await dialog.locator('[data-status]').filter({ hasText: 'Settings changed.' }).waitFor();
    assert.equal(saves.length, 1, 'A stale save cannot overwrite another editor');
    await dialog.locator('[data-reload]').click(); await choice.waitFor();
    assert.equal(await choice.inputValue(), 'boss_cloud');
    await choice.selectOption('full_cloud'); await dialog.locator('[type="submit"]').click();
    await dialog.locator('[data-status]').filter({ hasText: 'Settings saved.' }).waitFor();
    assert.equal(state.overrides.inferenceProfile, 'full_cloud');
    for (const width of [320, 390, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth + 1), false, `Preferences fit ${width}px`);
    }
    await dialog.locator('[data-cancel]').click(); await page.locator('#family').click();
    await page.locator('dialog:visible [data-scope]').filter({ hasText: 'Family' }).waitFor();
    assert.equal(await page.locator('dialog:visible [name="inferenceProfile"]').count(), 0, 'Family never receives personal cloud selection');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, checks: 8, savedProfiles: saves.map(save => save.values.inferenceProfile), pageErrors: errors }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
