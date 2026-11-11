'use strict';

// The merged IllustratedFrame, real Chromium and synthetic native receipts.
// No image rendering, model call, microphone permission or external service.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const express = require('express'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const core = path.resolve(__dirname, '../..'), publicDir = path.join(core, 'surfaces/household/public');
const overlay = process.env.ILLUSTRATED_COMPAT_PUBLIC_DIR;
const output = process.env.ILLUSTRATED_RETENTION_OUTPUT_DIR;
assert.ok(output, 'Set ILLUSTRATED_RETENTION_OUTPUT_DIR outside Git for browser evidence'); fs.mkdirSync(output, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const sessions = new Map(), turns = [];
const operations = new Map(), receipts = new Map(), ends = new Map(), posts = [], reads = [], imageReads = [], errors = [], checks = [];
const operation = (sessionId, { epoch = randomUUID(), ttl = 60000 } = {}) => {
  const id = randomUUID(), statusUrl = `/api/voice-personas/family/sessions/${sessionId}/images/${id}`;
  const value = { id, sessionId, state: 'completed', runtimeRestored: true, statusUrl,
    artifact: { url: statusUrl + '/image', sha256: 'a'.repeat(64) },
    retention: { epoch, temporary: true, kept: false, expired: false, expiresAt: new Date(Date.now() + ttl).toISOString(), keep: null } };
  operations.set(id, value); return value;
};
const view = op => JSON.parse(JSON.stringify(op));
const block = op => ({ kind: 'image', source: 'local', presentation: 'illustration', body: 'A synthetic picture-book landscape', operation: view(op) });
let browser, server;
(async () => {
  const app = express(); app.use(express.json());
  if (overlay) app.use('/assets/household', express.static(overlay));
  app.use('/assets/household', express.static(publicDir));
  app.use('/js', express.static(path.join(core, 'public/js'))); app.use('/css', express.static(path.join(core, 'public/css')));
  app.get('/api/voix/player.js', (_req, res) => res.type('js').send(''));
  app.get('/api/household/avatar/llmx-face.js', (_req, res) => res.type('js').send("customElements.define('llmx-face',class extends HTMLElement{connectedCallback(){this.style.cssText='display:block;background:#183646';setTimeout(()=>this.dispatchEvent(new Event('llmx-face-ready')),0)}set presence(value){}});"));
  const personas = require('../../surfaces/household/persona-catalog');
  app.get('/api/voice-personas/catalog', (_req, res) => res.json({ data: { personas: personas.generatedPersonas().map(row => personas.snapshot({ ...row, _id: 'fixture', version: 1 })), runtime: { defaultBackend: 'agentx', openclawConfigured: false } } }));
  app.get('/api/photos/frame/status', (_req, res) => res.json({ data: { enabled: false } }));
  app.post('/api/voice-personas/family/sessions', (req, res) => { const session = { ...req.body, sessionId: randomUUID(), epoch: randomUUID(), status: 'active', turnCount: 0 }; sessions.set(session.sessionId, session); res.status(201).json({ data: { session } }); });
  app.post('/api/voice-personas/family/sessions/:session/turns/text', (req, res) => {
    const session = sessions.get(req.params.session); session.turnCount++; turns.push(req.body.text);
    const op = operation(session.sessionId, { epoch: session.epoch });
    res.type('application/x-ndjson').end(JSON.stringify({ type: 'show', block: block(op) }) + '\n' + JSON.stringify({ type: 'done', data: { session, reply: { text: 'Réponse synthétique.' }, routing: { backend: 'agentx' } } }) + '\n');
  });
  app.get('/fixture', (_req, res) => {
    let html = fs.readFileSync(overlay && fs.existsSync(path.join(overlay, 'index.html')) ? path.join(overlay, 'index.html') : path.join(publicDir, 'index.html'), 'utf8')
      .replace('<!-- product-navigation -->', '<span id="runtimePill"></span>').replace(/  <script src="\/assets\/household\/app.js[^\n]+/, '');
    html = html.replace('</body>', `<script>document.addEventListener('DOMContentLoaded',async()=>{
      window.microphoneCalls=0;navigator.mediaDevices.getUserMedia=async()=>{microphoneCalls++;throw Error('No microphone in retention journey')};
      const Original=NestorConversation.Conversation;NestorConversation.Conversation=class extends Original{constructor(...args){super(...args);window.retentionConversation=this}};
      const api=async(url,options={})=>{const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});const body=await response.json();if(!response.ok)throw Object.assign(Error(body.message||'Fixture error'),{status:response.status});return body.data??body};
      try{await mountConversation({app:document.getElementById('app'),api,esc:value=>String(value??''),space:'family',autoStart:false});window.fixtureReady=true}catch(error){window.fixtureError=error.stack}
    });</script></body>`); res.type('html').send(html);
  });
  app.get('/frame', (req, res) => res.type('html').send(`<!doctype html><html lang="fr"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/household/illustrated-frame.css"><style>body{margin:0;background:#07131d;color:#fff}.button{background:#173441;color:#fff;border:1px solid #71838f}</style><main>Family synthetic conversation</main><script>${req.query.blocked ? 'Object.defineProperty(window,"sessionStorage",{get(){throw Error("Storage unavailable")}});' : ''}window.microphoneCalls=0;navigator.mediaDevices.getUserMedia=async()=>{microphoneCalls++;throw Error('Microphone disabled in fixture')};</script><script src="/assets/household/illustrated-frame.js"></script><script>IllustratedFrame.follow({sessionId:${JSON.stringify(req.query.session || 'family-a')}});window.present=block=>IllustratedFrame.show(block,{delay:80});</script></html>`));
  app.post('/api/voice-personas/family/sessions/:session/images/retention/end', (req, res) => {
    posts.push({ kind: 'end', session: req.params.session, ...req.body });
    const previous = [...ends.values()].find(row => row.epoch === req.body.epoch && row.session === req.params.session);
    if (previous) return res.json({ ok: true, alreadyEnded: true, epoch: req.body.epoch, originalRequestId: previous.requestId });
    const receipt = { requestId: req.body.requestId, epoch: req.body.epoch, state: 'completed', session: req.params.session };
    ends.set(req.body.requestId, receipt);
    for (const op of operations.values()) if (op.sessionId === req.params.session && op.retention.epoch === req.body.epoch && !op.retention.kept) op.retention.expired = true;
    if (app.locals.dropEnd) { app.locals.dropEnd = false; return res.status(502).json({ ok: false }); }
    res.json({ ok: true, receipt });
  });
  app.get('/api/voice-personas/family/sessions/:session/images/retention/end', (req, res) => {
    reads.push({ kind: 'end', session: req.params.session, requestId: req.query.requestId });
    res.json({ ok: true, receipt: app.locals.hideEnd ? null : ends.get(req.query.requestId) || null });
  });
  app.post('/api/voice-personas/family/sessions/:session/images/:id/keep', async (req, res) => {
    const op = operations.get(req.params.id); posts.push({ kind: 'keep', session: req.params.session, imageId: req.params.id, ...req.body });
    assert.equal(op.sessionId, req.params.session);
    if (app.locals.dropBefore) { app.locals.dropBefore = false; return res.status(502).json({ ok: false }); }
    let receipt = receipts.get(req.body.requestId);
    if (!receipt) {
      receipt = { requestId: req.body.requestId, imageId: op.id, state: op.retention.expired ? 'refused' : 'completed' };
      receipts.set(req.body.requestId, receipt); op.retention.keep = receipt;
      if (receipt.state === 'completed') { op.retention.kept = true; op.retention.temporary = false; }
    }
    if (app.locals.holdKeep) await new Promise(resolve => { app.locals.releaseKeep = resolve; });
    if (app.locals.dropKeep) { app.locals.dropKeep = false; return res.status(502).json({ ok: false }); }
    res.json({ ok: true, receipt, operation: view(op) });
  });
  app.get('/api/voice-personas/family/sessions/:session/images/:id/keep', (req, res) => {
    const op = operations.get(req.params.id); reads.push({ kind: 'keep', session: req.params.session, imageId: op.id, requestId: req.query.requestId });
    res.json({ ok: true, receipt: app.locals.hideKeep ? null : receipts.get(req.query.requestId) || null, operation: view(op) });
  });
  app.get('/api/voice-personas/family/sessions/:session/images/:id/image', (req, res) => {
    const op = operations.get(req.params.id); imageReads.push(op.id);
    if (!op || op.sessionId !== req.params.session || op.retention.expired) return res.status(404).end();
    res.set('Cache-Control', 'private, no-store').type('png').send(PNG);
  });
  app.get('/api/voice-personas/family/sessions/:session/images/:id', (req, res) => {
    const op = operations.get(req.params.id); reads.push({ kind: 'status', imageId: op?.id });
    const snapshot = view(op);
    if (app.locals.holdStatus) { app.locals.releaseStatus = () => res.json({ ok: true, operation: snapshot }); return; }
    if (app.locals.denyStatus) return res.status(503).json({ ok: false });
    res.json({ ok: true, operation: snapshot });
  });
  app.use('/api', (req, res) => res.json({ data: req.path.endsWith('/recap/latest') ? null : { destinations: [], sessions: [], works: [], notes: [], active: 'primary', review: null } }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], ...(process.env.AGENTX_BROWSER_EXECUTABLE && { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }) });
  const context = await browser.newContext({ viewport: { width: 320, height: 740 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
  const frame = () => page.getByRole('figure', { name: 'Picture of the conversation' });
  const keep = () => frame().getByRole('button', { name: 'Garder cette image', exact: true });
  const present = async op => { await page.evaluate(value => present(value), block(op)); await page.waitForFunction(id => [...document.querySelectorAll('.illustrated-frame img.is-front')].some(image => image.src.includes(id)), op.id); };
  const journal = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('agentx.illustrated.retention.v1') || '[]'));
  const empty = () => page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('agentx.illustrated.retention.v1') || '[]').length);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  await page.goto(origin + '/frame');
  const first = operation('family-a'); await present(first);
  assert.equal(await frame().count(), 1, 'Uses the single existing frame');
  assert.equal(await keep().isEnabled(), true);
  assert.equal(await frame().getByRole('img').count(), 1, 'Only the front image is exposed');
  const before = posts.length; await keep().click(); await empty();
  assert.equal(posts.length, before + 1); assert.equal(posts.at(-1).kind, 'keep');
  assert.equal(first.retention.kept, true); assert.equal(await frame().getByRole('button', { name: 'Image gardée' }).isDisabled(), true);
  assert.deepEqual(Object.keys(posts.at(-1)).sort(), ['imageId', 'kind', 'requestId', 'session']); checks.push('native-keep-current-image');

  // A proxy loses the ACK after Core accepted; reload reads the same identity.
  const lost = operation('family-a'); await present(lost); app.locals.dropKeep = true; app.locals.hideKeep = true;
  await keep().click(); await page.getByRole('button', { name: 'Reprendre la même demande' }).waitFor();
  const saved = (await journal())[0], lostPosts = posts.length;
  assert.deepEqual(Object.keys(saved).sort(), ['epoch', 'kind', 'requestId', 'statusUrl']);
  assert.equal(saved.epoch, lost.retention.epoch);
  assert.ok(!JSON.stringify(saved).match(/data:image|blob:|\/image"|picture-book|sha256/));
  await page.reload(); await page.getByRole('button', { name: 'Reprendre la même demande' }).waitFor();
  assert.equal(posts.length, lostPosts, 'Reload never sends a compensating keep');
  assert.equal((await journal())[0].requestId, saved.requestId);
  app.locals.hideKeep = false; await page.getByRole('button', { name: 'Vérifier', exact: true }).click(); await empty();
  assert.ok(reads.some(read => read.kind === 'keep' && read.requestId === saved.requestId && read.imageId === lost.id));
  assert.equal(posts.length, lostPosts); checks.push('lost-ack-reload-exact-receipt-metadata-only');

  // Explicit resume of an unaccepted request reuses the original UUID.
  const retryOp = operation('family-a'); await present(retryOp); app.locals.dropBefore = true;
  await keep().click(); await page.getByRole('button', { name: 'Reprendre la même demande' }).waitFor();
  const oldId = posts.at(-1).requestId;
  await page.getByRole('button', { name: 'Reprendre la même demande' }).click(); await empty();
  assert.deepEqual(posts.slice(-2).map(post => post.requestId), [oldId, oldId]); checks.push('explicit-resume-same-identity');

  // Clear is local; explicit end targets its captured epoch, then late keep
  // completion can never mark a new conversation's image as kept.
  const pending = operation('family-a'); await present(pending); app.locals.holdKeep = true;
  await keep().click();
  for (let i = 0; i < 100 && !app.locals.releaseKeep; i++) await pause(5);
  assert.ok(app.locals.releaseKeep); const pendingId = posts.at(-1).requestId;
  const localBefore = posts.length; await page.evaluate(() => IllustratedFrame.clear()); assert.equal(posts.length, localBefore);
  await page.evaluate(() => IllustratedFrame.end());
  const second = operation('family-b'); await page.evaluate(() => IllustratedFrame.follow({ sessionId: 'family-b' })); await present(second);
  app.locals.holdKeep = false; app.locals.releaseKeep(); await empty();
  assert.equal(await keep().isEnabled(), true, 'Old keep cannot conserve the next image');
  assert.equal(second.retention.kept, false);
  assert.ok(posts.some(post => post.kind === 'end' && post.session === 'family-a' && post.epoch === pending.retention.epoch));
  assert.equal(posts.filter(post => post.kind === 'keep' && post.requestId === pendingId).length, 1);
  checks.push('clear-local-explicit-end-exact-epoch-late-keep-isolation');

  // Lost end ACK is read-only reconciled after moving to the next session.
  app.locals.dropEnd = true; app.locals.hideEnd = true; await page.evaluate(() => IllustratedFrame.end());
  const third = operation('family-c'); await page.evaluate(() => IllustratedFrame.follow({ sessionId: 'family-c' })); await present(third);
  await page.getByRole('button', { name: 'Reprendre la même demande' }).waitFor();
  const endEntry = (await journal())[0], endPosts = posts.length;
  assert.equal(endEntry.kind, 'end'); assert.equal(endEntry.epoch, second.retention.epoch);
  app.locals.hideEnd = false; await page.getByRole('button', { name: 'Vérifier', exact: true }).click(); await empty();
  assert.equal(posts.length, endPosts); assert.equal(await keep().isEnabled(), true);
  assert.ok(reads.some(read => read.kind === 'end' && read.requestId === endEntry.requestId && read.session === 'family-b')); checks.push('lost-end-ack-read-original-only');

  // Activity renews the same image's TTL without any new scene/show event.
  const extended = operation('family-c', { ttl: 350 }); await present(extended);
  const exactSrc = await frame().locator('img.is-front').getAttribute('src'), imageCount = imageReads.length;
  extended.retention.expiresAt = new Date(Date.now() + 1700).toISOString();
  await pause(650);
  assert.equal(await frame().isVisible(), true); assert.equal(await keep().isEnabled(), true);
  assert.equal(await frame().locator('img.is-front').getAttribute('src'), exactSrc); assert.equal(imageReads.length, imageCount);
  assert.ok(reads.some(read => read.kind === 'status' && read.imageId === extended.id)); checks.push('ttl-touch-without-new-scene-keeps-same-image');
  extended.retention.expired = true; await pause(1350);
  assert.equal(await frame().isVisible(), false); assert.equal(await page.locator('.illustrated-frame img[src]').count(), 0); checks.push('native-expiry-clears-local-source');

  const unavailable = operation('family-c', { ttl: 250 }); await present(unavailable); app.locals.denyStatus = true;
  await pause(450); assert.equal(await frame().isVisible(), false); app.locals.denyStatus = false; checks.push('unverifiable-expiry-clears-prudently');

  // Storage refusal never permits a keep with an unrecoverable identity.
  await page.goto(origin + '/frame?blocked=1'); const blocked = operation('family-a'); await present(blocked);
  const blockedPosts = posts.length;
  assert.equal(await keep().isDisabled(), true); await page.evaluate(() => IllustratedFrame.keep()); assert.equal(posts.length, blockedPosts); checks.push('storage-refusal-no-post');

  await page.goto(origin + '/frame'); const exit = operation('family-a'); await present(exit);
  const exitPosts = posts.length; await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(posts.length, exitPosts); assert.equal(await frame().isVisible(), false);
  assert.equal(await page.locator('.illustrated-frame img[src]').count(), 0); checks.push('pagehide-local-only');
  assert.equal(await page.evaluate(() => microphoneCalls), 0);

  // Shipped conversation wiring, using its native scene event, not another frame.
  await page.goto(origin + '/fixture'); await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
  assert.equal(await page.evaluate(() => window.fixtureError), undefined);
  await page.waitForFunction(() => AvatarDock.current); await page.evaluate(() => AvatarDock.current.setMode('cache'));
  const ask = async value => {
    const before = turns.length;
    await page.locator('#conversationMessage').fill(value); await page.locator('#conversationText').getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll('.conversation-message.assistant').length > count, before);
    await keep().waitFor();
  };
  await ask('Un paysage synthétique.'); const textTurns = turns.length;
  await page.locator('#conversationMessage').fill('Nestor, garde cette image'); await page.locator('#conversationText').getByRole('button', { name: 'Send', exact: true }).click();
  await empty(); await frame().getByRole('button', { name: 'Image gardée' }).waitFor();
  assert.equal(turns.length, textTurns, 'Typed keep is consumed before model dispatch');
  await ask('Un nouveau sujet synthétique.'); const voiceTurns = turns.length, voicePosts = posts.length;
  assert.equal(await page.evaluate(() => retentionConversation.io.localControl('garde cette image', { followup: false })), null);
  assert.equal(posts.length, voicePosts, 'Standby respects the native address decision');
  const voice = await page.evaluate(() => retentionConversation.io.localControl('Nestor, garde cette image', { followup: false }));
  assert.equal(voice.action, 'keep'); assert.equal(voice.addressed, true); await empty();
  assert.equal(turns.length, voiceTurns, 'Voice keep never starts a model turn');
  await page.evaluate(() => AvatarDock.current.setMode('scene'));
  await page.waitForFunction(() => document.body.dataset.avatarView === 'plein');
  const bounds = await frame().boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
  assert.equal(await frame().evaluate(node => document.elementFromPoint(node.getBoundingClientRect().x+20,node.getBoundingClientRect().y+20)?.closest('.illustrated-frame')===node), true);
  await page.screenshot({ path: path.join(output, 'merged-frame-keep-320.png') });
  await page.evaluate(() => AvatarDock.current.setMode('cache'));
  const beforeNew = posts.length, fullId = await page.evaluate(() => retentionConversation.session.sessionId), fullEpoch = sessions.get(fullId).epoch;
  await page.locator('#conversationNew').click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('agentx.illustrated.retention.v1')||'[]').length===0);
  assert.equal(posts.length, beforeNew + 1); assert.deepEqual([posts.at(-1).kind, posts.at(-1).session, posts.at(-1).epoch], ['end', fullId, fullEpoch]);
  assert.equal(await frame().isVisible(), false); assert.equal(await page.evaluate(() => microphoneCalls), 0);
  checks.push('shipped-typed-and-voice-keep-without-inference'); checks.push('shipped-new-conversation-exact-epoch'); checks.push('single-frame-mobile-scene-accessibility');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, browserErrors: errors, microphoneCalls: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, browserErrors: errors, microphoneCalls: 0 })); await context.close();
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); });
