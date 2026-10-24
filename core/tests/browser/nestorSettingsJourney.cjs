'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const core = path.resolve(__dirname, '../..');
const publicDir = path.join(core, 'surfaces/household/public');
const source = fs.readFileSync(path.join(publicDir, 'conversation-page.js'), 'utf8');
const template = source.match(/app.innerHTML = (`[\s\S]*?`);\n  const el/)[1];
const markup = new Function('family', 'personas', 'agents', 'runtime', 'esc', `return ${template}`)(false, [], [], { hermesConfigured: true }, String);
const begin = source.includes('// Settings disclosure') ? source.indexOf('// Settings disclosure') : source.indexOf('const settingsPanel =');
const init = source.slice(begin, source.indexOf('wake.onchange =', begin));
let browser, server;
(async () => {
  const app = express();
  app.use('/assets', express.static(publicDir));
  app.get('/', (_req, res) => res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/assets/conversation-experience.css">
    <body class="household-product"><header style="height:300px">Navigation and space introduction</header><main id="app">${markup}</main>
    ${fs.existsSync(path.join(publicDir, 'conversation-settings.js')) ? '<script src="/assets/conversation-settings.js"></script>' : ''}
    <script>const el=id=>document.getElementById(id), backendPicker=el('conversationBackend');
    window.newCount=0;el('conversationNew').onclick=()=>{window.newCount++;};${init}</script>`));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  browser = await chromium.launch({ headless: true });
  for (const width of [390, 320, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: width === 320 ? 568 : 844 }, hasTouch: true });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const toggle = page.locator('#conversationSettingsToggle'), panel = page.locator('#conversationSettings');
    await toggle.tap();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    const engineRect = await page.locator('#conversationBackend').evaluate(el => {
      const rect = el.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: innerHeight };
    });
    assert.equal(engineRect.top >= 0 && engineRect.bottom <= engineRect.height, true,
      `engine must be in view after opening settings at ${width}px: ${JSON.stringify(engineRect)}`);
    await page.locator('#conversationBackend').tap(); await page.keyboard.press('Escape');
    await toggle.tap(); assert.equal(await panel.isVisible(), false);
    await toggle.tap(); await page.locator('#conversationBackend').focus(); await page.keyboard.press('Escape');
    assert.equal(await panel.isVisible(), false); assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
    await toggle.tap();
    await page.evaluate(() => { document.getElementById('conversationLocked').hidden = false; document.getElementById('conversationLockedNew').hidden = false; });
    await page.locator('#conversationLockedNew').tap();
    assert.equal(await page.evaluate(() => window.newCount), 1);
    assert.equal(await panel.isVisible(), true);
    assert.equal(await page.locator('#conversationBackend').evaluate(el => el === document.activeElement), true);
    await page.close();
  }
  console.log(JSON.stringify({ settingsWidthsReceived: [390, 320, 1280], modelCalls: 0 }));
})().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
