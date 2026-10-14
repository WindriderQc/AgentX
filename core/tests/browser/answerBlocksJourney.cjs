'use strict';
// Synthetic read-only fixtures through production history/render modules; no model or native instance calls.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const report = process.env.ANSWER_BLOCKS_REPORT_DIR;
if (!report || path.resolve(report) === root || path.resolve(report).startsWith(root + path.sep)) {
  throw new Error('Set ANSWER_BLOCKS_REPORT_DIR to a directory outside the checkout.');
}
const req = createRequire(path.join(root, 'core/package.json'));
const express = req('express');
const { chromium } = require('playwright');
const contract = require(path.join(root, 'shared/answerBlocks.js'));
const canonical = contract.normalizeMessage({ role: 'assistant', content: 'These are fixture observations. The last estimate remains uncertain.',
  answerBlocks: { schema: contract.SCHEMA, blocks: [
    { kind: 'table', title: 'Selected capabilities <script>window.tableAttack=1</script>',
      columns: ['Capability', 'State', 'Boundary', 'Result', 'Owner', 'Evidence', 'Note', 'Long value'],
      rows: [['Context', 'Installed', '<img src="https://invalid.example/trap" onerror="window.tableAttack=2">', 'Fixture only', 'Core', 'CPU', 'Uncertain', 'x'.repeat(500)],
        ['GenUI', 'Bounded', '``` </script> <svg onload="window.tableAttack=3">', 'No calls', 'Studio', 'Fixture', 'a | b', 'tail']] },
    { kind: 'table', title: 'Empty results', columns: ['Item'], rows: [] }
  ] } });
const saved = { _id: '111111111111111111111111', model: 'fixture-model', messages: [
  { _id: '222222222222222222222222', role: 'user', content: 'Show the fixture observations.' },
  { _id: '333333333333333333333333', ...canonical },
  { _id: '444444444444444444444444', role: 'assistant', content: 'Unsupported historical block: retain every word.', answerBlocks: { schema: 'future/version', blocks: [] } },
  { _id: '555555555555555555555555', role: 'assistant', content: 'Malformed historical table: retain every word.', answerBlocks: { schema: contract.SCHEMA, blocks: [{ kind: 'table', title: 'Invalid', columns: ['One'], rows: [['a', 'b']] }] } }
] };
const app = express();
app.set('view engine', 'ejs'); app.set('views', root + '/core/views');
app.locals.buildProductNavigation = req('../shared/productNavigation').buildProductNavigation;
req('../shared/localStyleVendorAssets').registerLocalStyleVendorAssets(app, path.join(root, 'core/node_modules'));
app.use('/vendor/marked/18.0.11', express.static(path.join(root, 'core/node_modules/marked/lib')));
app.use('/vendor/dompurify/3.4.16', express.static(path.join(root, 'core/node_modules/dompurify/dist')));
app.use(express.static(root + '/core/public'));
const source = fs.readFileSync(root + '/core/src/app.js', 'utf8');
let pageHandler;
vm.runInNewContext(source.match(/app.get\('\/playground',[\s\S]*?\n\}\);/)[0], {
  app: { get: (_route, handler) => { pageHandler = handler; } }, isDemoProfile: () => false, agentxProfile: 'full'
});
app.get('/playground', (request, response) => {
  const render = response.render.bind(response);
  response.render = (view, options) => render(view, { ...options,
    footerJs: options.footerJs.replace('<script type="module" src="/js/chat/chat-main.js"></script>', '<script type="module" src="/fixture-entry.js"></script>') });
  pageHandler(request, response);
});
app.get('/fixture-entry.js', (_request, response) => response.type('application/javascript').send(`
import { loadConversation } from '/js/chat/chat-history.js';
import { appendMessage } from '/js/chat/chat-messaging.js';
const elements = Object.fromEntries(['chatWindow','statMessages','modelSelect','sendBtn'].map(id => [id, document.getElementById(id)]));
const state = { history: [], stats: { messages: 0, replies: 0 }, showStats: false };
const helpers = { updateConversationStats() {}, appendMessage: (message, options) => appendMessage(message, options, state, elements) };
state._helpers = helpers;
window.fixture = { state, load: () => loadConversation('111111111111111111111111', state, elements, helpers, true) };
window.fixture.loaded = await window.fixture.load();
`));
const api = [], external = [], errors = [];
app.get('/api/history/111111111111111111111111', (_request, response) => { api.push('GET history'); response.json({ status: 'success', data: saved }); });
const readOnlyPageApis = ['/prompts/catalog', '/nerve-center/ecosystem', '/ollama-hosts'];
app.get(readOnlyPageApis.map(value => '/api' + value), (request, response) => {
  api.push('GET ' + request.path.slice(4));
  response.json({ status: 'success', data: request.path.endsWith('/catalog') ? [] : { hosts: [], services: [] } });
});
app.use('/api', (request, response) => { api.push(request.method + ' ' + request.path); response.status(400).json({ status: 'error', message: 'Unexpected fixture API' }); });
let browser, server;
(async () => {
  fs.mkdirSync(report, { recursive: true });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const checks = [];
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => {
      if (!route.request().url().startsWith(origin + '/')) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    await page.addInitScript(() => { window.copiedText = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedText.push(text); } } }); });
    await page.goto(origin + '/playground');
    await page.waitForFunction(() => window.fixture?.loaded === true);
    const assistant = page.locator('.bubble[data-id="333333333333333333333333"]');
    await assistant.locator('.answer-blocks').waitFor();
    assert.equal(await assistant.locator('table.answer-block-table').count(), 2);
    assert.equal(await assistant.locator('th[scope="col"]').count(), 9);
    assert.equal(await assistant.locator('caption').first().textContent(), canonical.answerBlocks.blocks[0].title);
    assert.equal(await assistant.locator('.answer-block-table-wrap').first().evaluate(node => getComputedStyle(node).borderTopStyle), 'solid');
    assert.ok(await assistant.locator('th[scope="col"]').first().evaluate(node => parseFloat(getComputedStyle(node).paddingLeft)) > 0);
    assert.equal(await assistant.locator('tbody tr').first().locator('td').nth(2).textContent(), canonical.answerBlocks.blocks[0].rows[0][2]);
    assert.match(await assistant.locator('.answer-block-narrative').textContent(), /last estimate remains uncertain/);
    assert.equal(await assistant.locator('img,svg,script,iframe').count(), 0);
    assert.equal(await page.evaluate(() => window.tableAttack), undefined);
    const summary = assistant.locator('.answer-block-text-version > summary');
    await summary.focus(); await page.keyboard.press('Enter');
    assert.equal(await assistant.locator('.answer-block-text-version').evaluate(node => node.open), true);
    assert.equal(await assistant.locator('.answer-block-fallback').textContent(), canonical.content);
    await assistant.locator('button[title="Copy"]').click();
    assert.equal(await page.evaluate(() => window.copiedText.at(-1)), canonical.content);
    await summary.click();
    assert.equal(await page.locator('.bubble[data-id="444444444444444444444444"] .answer-blocks').count(), 0);
    assert.match(await page.locator('.bubble[data-id="444444444444444444444444"] .message-body').textContent(), /retain every word/);
    assert.equal(await page.locator('.bubble[data-id="555555555555555555555555"] .answer-blocks').count(), 0);
    assert.match(await page.locator('.bubble[data-id="555555555555555555555555"] .message-body').textContent(), /retain every word/);
    await page.evaluate(() => { const chat = document.getElementById('chatWindow'); const answer = chat.querySelector('[data-id="333333333333333333333333"]'); chat.scrollTop = answer.offsetTop - chat.offsetTop; });
    await page.screenshot({ path: path.join(report, `${name}-tables.png`), fullPage: true });
    const overflow = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      offenders: Array.from(document.querySelectorAll('body *')).filter(node => node.getBoundingClientRect().right > innerWidth + 1).slice(0, 20).map(node => ({ tag: node.tagName, id: node.id, classes: node.className, width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right, display: getComputedStyle(node).display })) }));
    if (overflow.documentWidth > overflow.width) console.log(JSON.stringify({ name, overflow }));
    assert.equal(overflow.documentWidth <= overflow.width, true);
    await page.evaluate(() => window.fixture.load());
    await assistant.locator('.answer-blocks').waitFor();
    assert.equal(await page.locator('.answer-blocks').count(), 1);
    assert.equal(await page.evaluate(() => window.fixture.state.history[1].answerBlocks.blocks.length), 2);
    checks.push(`${name}: production layout, history restoration, safe table data, uncertainty, keyboard text version, complete Copy, malformed/unknown fallback, no page overflow, repeat reload.`);
    await context.close();
    const missingContext = await browser.newContext({ viewport });
    const missingPage = await missingContext.newPage();
    await missingPage.route('**/answer-blocks-render.js', route => route.abort());
    await missingPage.goto(origin + '/playground');
    await missingPage.waitForFunction(() => window.fixture?.loaded === true);
    assert.equal(await missingPage.locator('.answer-blocks').count(), 0);
    assert.match(await missingPage.locator('.bubble[data-id="333333333333333333333333"] .message-body').textContent(), /last estimate remains uncertain/);
    assert.match(await missingPage.locator('.bubble[data-id="333333333333333333333333"] .message-body').textContent(), /Context/);
    checks.push(`${name}: unavailable enhancement retains full textual answer.`);
    await missingContext.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.equal(api.every(value => value === 'GET history' || readOnlyPageApis.some(route => value === 'GET ' + route)), true);
  const result = { checks, errors, externalFetches: external.length, api, modelCalls: 0, writes: 0,
    scope: 'Synthetic Core history reads through production Playground layout, loadConversation, appendMessage and renderer. No native instance data or inference.' };
  fs.writeFileSync(path.join(report, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
});
