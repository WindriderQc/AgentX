'use strict';

// Synthetic kiosk reliability: no real microphone, camera, permission grant or model.
// Screen commands on the real Nestor page (#924): typed and spoken "agrandis",
// "ferme", "suivant"… act on the content workspace without a model turn.
// Loopback CPU fixtures only: no model, microphone, speech service or live data.
// The microphone and speech recognition are simulated; the page, conversation
// loop and content workspace are the shipped code.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const core = path.resolve(__dirname, '../..'), publicDir = path.join(core, 'surfaces/household/public');
const { generatedPersonas, snapshot } = require('../../surfaces/household/persona-catalog');
const personas = generatedPersonas().map(row => snapshot({ ...row, _id: 'fixture', version: 1 }));
const sessions = new Map(), submissions = [], errors = [];
let browser, server, heard = '', delayTranscription = false, finishTranscription;
const output = process.env.VOICE_RELIABILITY_BROWSER_OUTPUT;
if (!output || path.resolve(output).startsWith(path.resolve(core, '..') + path.sep)) throw Error('Set VOICE_RELIABILITY_BROWSER_OUTPUT outside checkout');
let audioOpens = 0, failRecognition = false, recognitionRequests = 0, permissionState = 'granted';
let holdPermission = false, pendingPermissions = [];
const drawingRequest = 'Dessine un bateau.', followup = 'Pourquoi flotte-t-il ?';
const drawingPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCecAAAAASUVORK5CYII=', 'base64');
let drawing, followingReply, imageReads = 0;
fs.mkdirSync(output, { recursive: true });

// A fake microphone: `say()` delivers one finished utterance to the conversation loop.
const fakeAudio = `Object.defineProperty(navigator,'permissions',{configurable:true,value:{query:async()=>{window.permissionQueries=(window.permissionQueries||0)+1;const response=await fetch('/fixture/permission');return response.json();}}});
window.NestorConversation.openAudio = async (_signal,_onError,options={}) => {
  await fetch('/fixture/audio-opened',{method:'POST'});
  window.emitCaptureRecovery=state=>options.onCaptureRecovery?.({state});
  const audio = { canInterrupt: false,
    listen(callback) { audio.utterance = callback; }, quiet() {}, close() { window.fakeClosed=(window.fakeClosed||0)+1; }, holdPlayback() {}, resumePlayback() {},
    async play(speech) { window.fixturePlaybacks = (window.fixturePlaybacks || 0) + 1; await speech?.body?.cancel(); }, async settle() {} };
  window.say = () => audio.utterance(new Blob(['speech']), {});
  return audio;
};`;

(async () => {
  const app = express();
  app.post('/fixture/audio-opened',(_req,res)=>{audioOpens++;res.sendStatus(204);});
  app.get('/fixture/permission',(_req,res)=>{if(holdPermission)pendingPermissions.push(res);else res.json({state:permissionState});});
  // The simulated recognizer answers before JSON parsing: the page posts the audio as a form.
  app.post('/api/voix/transcribe', (_req, res) => { recognitionRequests++; if(failRecognition)return res.status(503).json({message:'Synthetic recognition outage'}); const text = heard; if (delayTranscription) finishTranscription = () => res.json({data:{text}}); else res.json({data:{text}}); });
  app.use(express.json());
  app.use('/assets/household', express.static(publicDir));
  app.use('/js', express.static(path.join(core, 'public/js')));
  app.use('/css', express.static(path.join(core, 'public/css')));
  app.get('/api/voix/player.js', (_req, res) => res.type('js').send(''));
  app.get('/fixture', (_req, res) => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replace('<!-- product-navigation -->', '<span id="runtimePill"></span>')
      .replace(/  <script src="\/assets\/household\/app.js[^\n]+/, '')
      .replace('</body>', `<script>document.addEventListener('DOMContentLoaded', async () => {
        window.AvatarDock = undefined;
        ${fakeAudio}
        const api = async (url, options={}) => { const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}}); const body=await response.json(); if(!response.ok)throw Object.assign(Error(body.message||'fixture request failed'),{status:response.status}); return body.data; };
        try { await mountConversation({app:document.getElementById('app'),api,esc:value=>String(value??''),space:"family",autoStart:true});window.fixtureReady=true; }
        catch(error){window.fixtureError=error.stack;}
      });</script></body>`);
    res.type('html').send(html);
  });
  app.get('/api/voice-personas/catalog', (_req, res) => res.json({ data: { personas, runtime: { defaultBackend: 'openclaw', hermesConfigured: true } } }));
  app.use('/api/voice-personas/private', (_req, res) => { errors.push('Private API requested by family'); res.sendStatus(403); });
  app.post('/api/voice-personas/family/sessions', (req, res) => {
    const session = { ...req.body, sessionId: randomUUID(), status: 'active', turnCount: 0 };
    sessions.set(session.sessionId, session); res.status(201).json({ data: { session } });
  });
  // The only model stand-in: every request that reaches it is counted.
  app.post('/api/voice-personas/family/sessions/:id/turns/text', (req, res) => {
    submissions.push(req.body.text);
    const session = sessions.get(req.params.id); session.turnCount++;
    res.type('application/x-ndjson');
    const done = (text, extra) => res.end(JSON.stringify({ type: 'done', data: { session, traceId: randomUUID(), reply: { text }, routing: { backend: 'agentx' },
      tools: { status: 'not_supported', authority: 'agentx/ollama', receipts: [] }, ...extra } }) + '\n');
    if (req.body.text.toLowerCase() === drawingRequest.toLowerCase()) {
      const id = randomUUID(), statusUrl = '/api/voice-personas/family/sessions/' + session.sessionId + '/images/' + id;
      drawing = { id, statusUrl, state: 'queued', runtimeRestored: false };
      const block = { kind: 'image', source: 'local', key: 'image:' + id, title: 'Bateau', body: 'Un bateau.', operation: drawing };
      res.write(JSON.stringify({ type: 'show', block }) + '\n');
      return done('Le dessin est en préparation.', { familyDrawing: true, display: [block] });
    }
    if (req.body.text === followup && drawing) { followingReply = () => done('Il déplace de l’eau.'); return; }
    done('Voici.');
  });
  app.get('/api/voice-personas/family/sessions/:id/images/:imageId', (req, res) => {
    if (!drawing || req.path !== drawing.statusUrl) return res.sendStatus(404);
    res.json({ ok: true, operation: drawing });
  });
  app.get('/api/voice-personas/family/sessions/:id/images/:imageId/image', (req, res) => {
    if (!drawing?.artifact || req.path !== drawing.artifact.url) return res.sendStatus(404);
    imageReads++;
    res.type('image/png').send(drawingPng);
  });
  const photoId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const secondPhotoId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let photoRequests = 0;
  app.get('/api/photos/frame/status', (_req, res) => res.json({ data: { enabled: true, idleSeconds: 120, intervalSeconds: 30 } }));
  app.get('/api/photos/frame/next', (req, res) => { photoRequests++; const id = req.query.exclude === photoId ? secondPhotoId : photoId; res.json({data:{id,src:'/api/photos/frame/'+id+'/image'}}); });
  app.get('/api/photos/frame/:id/image', (_req, res) => res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#145e76"/></svg>'));
  app.use('/api', (req, res) => {
    if (req.path.endsWith('/recap/latest')) return res.json({ data: null });
    res.json({ data: { destinations: [], sessions: [], works: [], notes: [], active: 'primary', review: null } });
  });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AGENTX_BROWSER_EXECUTABLE && { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/fixture');
  await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
  assert.equal(await page.evaluate(() => window.fixtureError), undefined);


  const state = () => page.locator('#conversationPresence').getAttribute('data-state');
  const ready = () => page.waitForFunction(() => window.fixtureReady || window.fixtureError);
  const listening = () => page.waitForFunction(() => document.getElementById('conversationPresence').dataset.state === 'listening');
  await listening(); assert.equal(audioOpens,1);
  await page.locator('#conversationStart').click(); assert.equal(await state(),'paused');
  await page.reload(); await ready();
  assert.equal(await state(),'paused','a deliberately muted microphone must stay off after reload');
  assert.equal(audioOpens,1,'saved permission alone must not reopen a deliberately muted microphone');
  assert.match(await page.locator('#conversationStatus').textContent(),/micro.*coup/i);
  await page.locator('#conversationStart').click(); await listening(); assert.equal(audioOpens,2);
  await page.clock.install();
  await page.evaluate(()=>document.activeElement?.blur()); await page.clock.fastForward(2*60*60*1000);
  assert.equal(await state(),'listening','a long absence does not silently mute an armed microphone');
  assert.equal(audioOpens,2); assert.equal(submissions.length,0);
  await page.evaluate(()=>emitCaptureRecovery('waiting-silence'));
  assert.equal(await state(),'recovering'); assert.match(await page.locator('#conversationStatus').textContent(),/silence/i);
  await page.evaluate(()=>emitCaptureRecovery('ready')); await listening(); assert.equal(audioOpens,2);
  await page.evaluate(()=>emitCaptureRecovery('waiting-silence'));
  await page.locator('#conversationStart').click();
  await page.evaluate(()=>emitCaptureRecovery('ready'));
  assert.equal(await state(),'paused','late recovery must never undo Pause');
  await page.reload(); await ready(); assert.equal(await state(),'paused'); assert.equal(audioOpens,2);
  await page.locator('#conversationStart').click(); await listening(); assert.equal(audioOpens,3);
  await page.clock.install();
  failRecognition=true; heard='Hey Nestor, une question synthétique'; await page.evaluate(()=>say());
  assert.equal(await state(),'recovering'); assert.match(await page.locator('#conversationStatus').textContent(),/reconnaissance/i);
  await page.clock.fastForward(2100);await listening();assert.equal(recognitionRequests,1);assert.equal(audioOpens,3);
  await page.evaluate(()=>Object.defineProperty(navigator,'onLine',{configurable:true,value:false}));
  await page.evaluate(()=>say());assert.equal(await state(),'recovering');
  await page.clock.fastForward(24*60*60*1000);assert.equal(recognitionRequests,2);assert.equal(audioOpens,3);
  await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,value:true});dispatchEvent(new Event('online'));});
  await listening();assert.equal(recognitionRequests,2,'reconnect does not replay a failed utterance');
  failRecognition=false;heard='Ambiance synthétique';await page.evaluate(()=>say());await listening();
  assert.equal(submissions.length,0,'unaddressed ambient text stays outside Nestor requests');
  failRecognition=true;heard='Hey Nestor, une question synthétique';
  await page.evaluate(()=>say());assert.equal(await state(),'recovering');
  await page.locator('#conversationStart').click();await page.clock.fastForward(60000);
  await page.evaluate(()=>dispatchEvent(new Event('online')));assert.equal(await state(),'paused');assert.equal(audioOpens,3);
  failRecognition=false;
  await page.reload();await ready();assert.equal(await state(),'paused');assert.equal(audioOpens,3);
  await page.locator('#conversationStart').click();await listening();assert.equal(audioOpens,4);
  permissionState='prompt';await page.reload();await ready();assert.equal(await state(),'idle');
  assert.equal(audioOpens,4,'automatic start does not ask for a new microphone permission');
  assert.match(await page.locator('#conversationStatus').textContent(),/Activer Nestor/);
  permissionState='granted';await page.locator('#conversationStart').click();await listening();assert.equal(audioOpens,5);
  await page.evaluate(()=>{emitCaptureRecovery('waiting-silence');document.getElementById('app').replaceChildren();});
  await page.waitForFunction(()=>window.fakeClosed>0);
  await page.evaluate(()=>emitCaptureRecovery('ready'));assert.equal(audioOpens,5,'unmount cannot reopen the old microphone');
  // A slow permission lookup must respect a newer mute from another tab.
  holdPermission=true;await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.permissionQueries===1&&document.getElementById('conversationStart'));
  await page.evaluate(()=>{const key='household.space.family.microphoneWanted';localStorage.setItem(key,'off');dispatchEvent(new StorageEvent('storage',{key,newValue:'off'}));});
  assert.equal(await state(),'paused');
  holdPermission=false;for(const response of pendingPermissions.splice(0))response.json({state:'granted'});
  await ready();assert.equal(await state(),'paused','a late permission result respects a mute from another tab');
  assert.equal(audioOpens,5);

  // A kiosk can mount the page behind another window. It may use an already
  // granted microphone only when it first becomes visible, without a click.
  await page.addInitScript(() => {
    if (!location.search.includes('covered')) return;
    localStorage.setItem('household.space.family.microphoneWanted', 'on');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  });
  await page.goto(origin + '/fixture?covered');
  await ready();
  assert.equal(audioOpens, 5);
  assert.equal(await page.evaluate(() => window.permissionQueries || 0), 0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await listening();
  assert.equal(audioOpens, 6);
  assert.equal(await page.evaluate(() => window.permissionQueries), 1);
  const kitchenSession = [...sessions.values()].at(-1);
  const playbacks = await page.evaluate(() => window.fixturePlaybacks);
  heard = 'Hey Nestor, ' + drawingRequest;
  await page.evaluate(() => say()); await listening();
  assert.ok(drawing, 'the first voice turn requested a drawing');
  const card = page.locator('.display-block[data-kind="image"]');
  assert.equal(await card.count(), 1);
  assert.equal(await card.locator('img').count(), 0);
  heard = followup;
  const followupSent = page.waitForRequest(request => request.url().endsWith('/turns/text') && request.postDataJSON().text === followup);
  await page.evaluate(() => { window.pendingAnswer = say(); });
  await followupSent;
  drawing = { ...drawing, state: 'completed', runtimeRestored: true,
    artifact: { sha256: createHash('sha256').update(drawingPng).digest('hex'), url: drawing.statusUrl + '/image' } };
  await page.waitForFunction(() => document.querySelector('.display-block[data-kind="image"] img')?.naturalWidth === 1);
  assert.equal(imageReads, 1);
  assert.equal(await state(), 'thinking', 'the drawing appeared before the follow-up answer arrived');
  followingReply(); await page.evaluate(() => window.pendingAnswer); await listening();
  assert.deepEqual(submissions.map(text => text.toLowerCase()), [drawingRequest.toLowerCase(), followup.toLowerCase()]);
  assert.equal(kitchenSession.turnCount, 2);
  assert.equal(await page.evaluate(() => window.fixturePlaybacks), playbacks + 2);
  assert.equal(audioOpens, 6, 'both turns used the same synthetic microphone');
  // Becoming hidden during the initial permission check has the same result.
  holdPermission = true;
  await page.goto(origin + '/fixture', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.permissionQueries === 1);
  const visible = isVisible => page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: !value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, isVisible);
  await visible(false);
  holdPermission = false;
  for (const response of pendingPermissions.splice(0)) response.json({ state: 'granted' });
  await ready(); assert.equal(audioOpens, 6);
  await visible(true); await listening(); assert.equal(audioOpens, 7);
  await visible(false); await visible(true);
  assert.equal(await state(), 'paused', 'leaving an active conversation still stops capture');
  assert.deepEqual(errors,[]);
  const result={ok:true,scope:'family',audioOpens,recognitionRequests,liveModelCalls:0,realDevicePermissions:0,submissions:submissions.length,errors};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(error => { console.error(error.stack); process.exitCode=1; })
.finally(async () => { for(const response of pendingPermissions.splice(0))response.end();await browser?.close();server?.closeAllConnections();await new Promise(resolve => server ? server.close(resolve) : resolve()); });
