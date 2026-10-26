'use strict';
// Real-browser journey against the disposable synthetic fixture only.
// CHROMIUM_PATH can select a browser; no package download or live Core needed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createFixture } = require('./atlasParityFixture.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function chromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const file of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) { try { await fs.access(file);return file; } catch {} }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache/ms-playwright');
  for (const name of (await fs.readdir(cache)).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) { const file = path.join(cache, name, rel);try { await fs.access(file);return file; } catch {} }
  }
  throw new Error('Set CHROMIUM_PATH to an installed Chromium browser');
}

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-parity-browser-'));
  const output = process.env.ATLAS_BROWSER_ARTIFACTS || await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-parity-evidence-'));
  await fs.mkdir(output, { recursive: true });
  const fixture = createFixture({ truncated: true });await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fixture.server.address().port}`;
  const browser = spawn(await chromium(), ['--headless', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    let port;
    for (let i = 0; i < 100; i++) { try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);break; } catch { await pause(50); } }
    assert.ok(port, 'Chromium debugging endpoint started');
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
    let serial = 0;const pending = new Map(), errors = [];
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial;pending.set(id, m => m.error ? reject(new Error(m.error.message)) : resolve(m.result));ws.send(JSON.stringify({ id, method, params })); });
    ws.addEventListener('message', e => { const m = JSON.parse(e.data);if (m.id) { pending.get(m.id)?.(m);pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Page.javascriptDialogOpening') call('Page.handleJavaScriptDialog', { accept: true }); });
    const evaluate = async expression => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);return r.result.value; };
    const until = async expression => { for (let i = 0; i < 180; i++) { if (await evaluate(expression)) return;await pause(60); }throw new Error(`Timed out: ${expression}`); };
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const close = () => evaluate("document.querySelector('[data-action=close],[data-close-info]')?.click()");
    const screenshot = async name => { await pause(120);const result = await call('Page.captureScreenshot', { format: 'png' });await fs.writeFile(path.join(output, `${name}.png`), Buffer.from(result.data, 'base64')); };
    const size = async (width, height = 1000) => { await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });await pause(140); };
    await call('Page.enable');await call('Runtime.enable');await size(1600);
    await call('Page.navigate', { url: `${base}/atlas/` });await until("globalThis.lifeAtlas?.state.events.length===38&&document.querySelectorAll('[data-story-thread]').length===6");
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
    assert.equal(await evaluate('lifeAtlas.state.scope'), 'life');
    assert.match(await evaluate("document.getElementById('coverage-warning').textContent"), /Au moins 38 relevés chargés/);
    assert.equal(await evaluate("document.querySelector('[data-intro-stat=pending] strong').textContent"), '37');
    const selectedDay=fixture.entries[37].id;await evaluate(`location.hash='#entry:${selectedDay}'`);await until("!!document.querySelector('.popup-title')");
    for(const scale of ['life','year','month','day'])await click(`[data-scale=${scale}]`);
    assert.deepEqual(await evaluate('lifeAtlas.state.range'),[Date.UTC(2012,6,13),Date.UTC(2012,6,14)]);await evaluate('lifeAtlas.fit()');
    await until("document.querySelectorAll('[data-temporal=period]').length>2");
    await screenshot('overview');
    await click('[data-gallery-undated]');await until("document.querySelector('.photo-viewer-stage img')?.naturalWidth>0");
    assert.match(await evaluate("document.querySelector('.photo-viewer-date').textContent"), /Date à préciser/);await screenshot('undated-photo');await close();
    await click('#immersive-button');await until("document.body.classList.contains('atlas-immersive')");
    assert.ok(await evaluate("document.querySelector('.minimap-row').getBoundingClientRect().bottom<=innerHeight"));
    await screenshot('immersive');await click('#immersive-button');
    await click('[data-story-thread]');await until("document.querySelectorAll('[data-thread-event]').length===1");await screenshot('personal-subject');await close();
    await click('#coverage-button');await until("document.querySelector('[data-native-coverage]')?.textContent.includes('Ce sont des copies')");
    const coverage = await evaluate("document.querySelector('[data-native-coverage]').textContent");assert.match(coverage, /4 textes de source relus au complet sur 20/);assert.doesNotMatch(coverage, /999/);await screenshot('coverage');await close();
    await click('#library-button');await until("document.querySelectorAll('[data-library-photo]').length===2");
    await until("[...document.querySelectorAll('.library-grid img')].every(i=>i.naturalWidth>0)");
    await click('[data-library-more]');await until("document.querySelectorAll('[data-library-photo]').length===3");await screenshot('native-library');
    await click('[data-library-photo]');await until("document.querySelector('.photo-viewer-stage img')?.naturalWidth>0");
    assert.match(await evaluate("document.querySelector('.photo-viewer-body').textContent"), /Bibliothèque native AgentX/);
    await click('[data-photo-back]');await until("document.querySelectorAll('[data-library-photo]').length===3");await close();
    await evaluate("document.getElementById('scope-filter').value='all';document.getElementById('scope-filter').dispatchEvent(new Event('change'))");
    assert.equal(await evaluate("document.querySelector('[data-intro-stat=pending] strong').textContent"),'38');
    await evaluate("document.getElementById('scope-filter').value='all';document.getElementById('scope-filter').dispatchEvent(new Event('change'));document.getElementById('subject-filter').value='thirdparty';document.getElementById('subject-filter').dispatchEvent(new Event('change'))");
    assert.equal(await evaluate('lifeAtlas.state.filtered.length'), 1);
    await click('#filters-reset');await click('#validation-button');await until("!!document.querySelector('[data-sprint-confirm]')");
    await click('[data-sprint-confirm]');await until('lifeAtlas.state.events.some(e=>e.core.assertionState===\'confirmed\')');
    assert.equal(await evaluate("document.querySelector('[data-intro-stat=pending] strong').textContent"),'36');
    assert.equal(fixture.writes.length, 1);assert.equal(fixture.writes[0].input.contextRevision, 1);assert.equal(fixture.writes[0].input.assertionState, 'confirmed');assert.match(fixture.writes[0].path, /\/review$/);await close();
    const confirmed = fixture.entries.find(e => e.assertionState === 'confirmed');
    await evaluate(`location.hash='#entry:${confirmed.id}'`);await until("!!document.querySelector('[data-action=edit]')");
    await click('[data-action=edit]');await until("!!document.querySelector('#event-editor')");
    await evaluate("document.querySelector('#event-editor textarea[name=description]').value='An owner correction with the date still approximate.';document.querySelector('#event-editor').requestSubmit()");
    await until(`lifeAtlas.state.events.find(e=>e.core.id==='${confirmed.id}').contextRevision===2`);
    assert.notEqual(await evaluate(`lifeAtlas.state.events.find(e=>e.core.id==='${confirmed.id}').reviewState`), 'confirmed');assert.equal(await evaluate("document.querySelector('[data-intro-stat=pending] strong').textContent"),'37');await close();
    const stale = fixture.entries[0];
    await evaluate(`location.hash='#entry:${stale.id}'`);await until("!!document.querySelector('[data-action=confirm]')");
    stale.contextRevision++;
    await click('[data-action=confirm]');await until("document.querySelector('[data-review-error]')?.hidden===false");
    assert.match(await evaluate("document.querySelector('[data-review-error]').textContent"), /a changé/);assert.equal(stale.assertionState, 'unknown');await screenshot('stale-confirmation');await close();
    await evaluate(`location.hash='#entry:${fixture.entries[3].id}'`);await until("!!document.querySelector('[data-action=sources]')");await click('[data-action=sources]');
    await until("document.querySelector('[data-sources]')?.textContent.includes('Synthetic lease')");
    assert.ok(await evaluate("!!document.querySelector('[data-sources] .source-file')"));
    assert.ok(await evaluate("document.querySelector('.event-photo-section').getBoundingClientRect().top<document.querySelector('.review-panel').getBoundingClientRect().top"));
    assert.equal(await evaluate("document.querySelector('.core-diagnostics').open"),false);await screenshot('source-document');await close();
    await evaluate('lifeAtlas.fit()');
    for (const [width, height] of [[768, 1000], [390, 900]]) { await size(width, height);await evaluate('window.scrollTo(0,0)');assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));await screenshot(`overview-${width}`); }
    const cta=await evaluate("(()=>{const r=document.getElementById('explore-life-button').getBoundingClientRect();return {top:r.top,bottom:r.bottom}})()");assert.ok(cta.top>=0&&cta.bottom<900);
    assert.equal(await evaluate("document.body.classList.contains('atlas-immersive')"),false);await click('#explore-life-button');
    await until("document.body.classList.contains('atlas-immersive')&&document.querySelectorAll('.lane').length===6");await click('[data-scale=year]');
    const beforePan=await evaluate('lifeAtlas.state.range');await click('#next-button');assert.notDeepEqual(await evaluate('lifeAtlas.state.range'),beforePan);
    await evaluate("document.querySelector('.minimap-row').scrollIntoView({block:'end',behavior:'instant'})");assert.ok(await evaluate("document.querySelector('.minimap-row').getBoundingClientRect().bottom<=900"));await screenshot('mobile-immersive-navigation');
    await evaluate("document.getElementById('immersive-button').scrollIntoView({block:'center',behavior:'instant'})");await click('#immersive-button');assert.equal(await evaluate("document.body.classList.contains('atlas-immersive')"),false);
    assert.equal(await evaluate('document.activeElement.id'),'explore-life-button');
    assert.deepEqual(errors, []);assert.ok(fixture.writes.every(w => !w.path.endsWith('/souvenir')));
    const report = { synthetic: true, entries: 38, subjects: 6, nativePhotoPages: 2, factualConfirmations: 1, souvenirWrites: 0, staleContextRejected: true,
      sourceDocumentPreserved: true, undatedPhotoAccessibleWithoutInventedDate: true, mobileEntryAndExit: true, selectedDayRetained: true, partialCoverageVisible: true, javascriptErrors: errors, writes: fixture.writes.map(w => ({ path: w.path, revision: w.input.revision, contextRevision: w.input.contextRevision })) };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');console.log(JSON.stringify({ passed: true, output, ...report }));
  } finally { ws?.close();browser.kill('SIGTERM');await new Promise(resolve => fixture.server.close(resolve));await new Promise(resolve => browser.exitCode !== null ? resolve() : browser.once('exit', resolve));await fs.rm(profile, { recursive: true, maxRetries: 5, retryDelay: 200 }); }
})().catch(error => { console.error(error);process.exitCode = 1; });
