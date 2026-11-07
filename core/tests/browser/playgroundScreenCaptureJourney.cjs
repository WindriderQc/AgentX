'use strict';
// Real Chromium getDisplayMedia with its synthetic device; no desktop, personal
// content, inference or instance services. Other cases inject consent outcomes.
// NODE_PATH=<directory containing playwright> node tests/browser/playgroundScreenCaptureJourney.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');
const express = require('express');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '../..');
const app = express();
app.use(express.json({ limit: '5mb' }));
app.set('view engine', 'ejs'); app.set('views', root + '/views');
app.locals.buildProductNavigation = require('../../../shared/productNavigation').buildProductNavigation;
require('../../../shared/localStyleVendorAssets').registerLocalStyleVendorAssets(app, root + '/node_modules');
app.use('/vendor/marked/18.0.11', express.static(root + '/node_modules/marked/lib'));
app.use('/vendor/dompurify/3.4.17', express.static(root + '/node_modules/dompurify/dist'));
app.use(express.static(root + '/public'));
let pageHandler;
vm.runInNewContext(fs.readFileSync(root + '/src/app.js', 'utf8').match(/app.get\('\/playground',[\s\S]*?\n\}\);/)[0], {
  app: { get: (_route, handler) => { pageHandler = handler; } }, isDemoProfile: () => false, agentxProfile: 'full'
});
app.get('/playground', (req, res) => {
  const render = res.render.bind(res);
  res.render = (view, options) => render(view, { ...options,
    footerJs: '<script type="module" src="/fixture-entry.js"></script>' });
  pageHandler(req, res);
});
app.get('/fixture-entry.js', (_req, res) => res.type('application/javascript').send(`
import { initScreenCapture } from '/js/chat/chat-attachments.js';
import { sendMessage, appendMessage } from '/js/chat/chat-messaging.js';
import { loadConversation, detachActiveReply } from '/js/chat/chat-history.js';
import { DEFAULTS } from '/js/chat/chat-constants.js';
const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
const state = { history: [], stats: {messages:0,replies:0}, showStats:false, settings:{...DEFAULTS,routingMode:'standard'},
  conversationId:null, threadId:'synthetic-thread', ollamaHostsLoaded:true, ollamaHosts:[{available:true,models:['fixture']}],
  hostPreferences:[],hostPreferencesByUrl:new Map() };
const helpers = { appendMessage:(message,options)=>appendMessage(message,options,state,elements),
  loadHistoryList:()=>{},refreshStats:()=>{},updateConversationStats:()=>{},speakText:()=>{},applyChatAvailability:()=>{},
  setStatus:()=>{},setFeedback:text=>{elements.chatAnnouncements.textContent=text;},
  loadConversation:(id,preserve)=>loadConversation(id,state,elements,helpers,preserve) };
state._helpers=helpers;
state.screenCapture=initScreenCapture(state);
elements.modelSelect.innerHTML='<option value="fixture">Synthetic model</option>';
elements.streamToggle.checked=false; elements.sendBtn.disabled=false;
elements.sendBtn.onclick=()=>sendMessage({state,elements,helpers,defaults:DEFAULTS});
const original=navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices);
let mode='native', grant;
window.captureStreams=[];window.captureCalls=[];
if(original) navigator.mediaDevices.getDisplayMedia=options=>{
  window.captureCalls.push(options);
  if(mode==='denied')return Promise.reject(new DOMException('Synthetic denial','NotAllowedError'));
  function syntheticStream(){
    const c=document.createElement('canvas');c.width=320;c.height=200;
    const stream=c.captureStream(30);
    const timer=setInterval(()=>c.getContext('2d').fillRect(0,0,320,200),30);
    for(const track of stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{clearInterval(timer);stop();};}
    return stream;
  }
  const pending=mode==='pending'?new Promise(resolve=>{grant=resolve;}):mode==='static'?Promise.resolve(syntheticStream()):original(options);
  return pending.then(stream=>{window.captureStreams.push(stream);return stream;});
};
window.fixture={state,ready:true,mode:value=>{mode=value;},load:id=>helpers.loadConversation(id,true),
  change:()=>{detachActiveReply(state,elements);state.conversationId=null;state.history=[];elements.chatWindow.replaceChildren();},
  grant:()=>{const c=document.createElement('canvas');c.width=320;c.height=200;c.getContext('2d').fillRect(0,0,320,200);grant(c.captureStream(1));},
  stopped:()=>window.captureStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))};
`));
const uploads = [], turns = [], conversations = new Map(), files = new Map();
let failUpload = false, holdUpload = false, releaseUpload;
const id = value => value.toString(16).padStart(24, '0');
app.post('/api/history/attachments', async (req, res) => {
  uploads.push(req.body);
  if (failUpload) { failUpload = false; return res.status(503).json({ message: 'Synthetic upload failure' }); }
  if (holdUpload) { holdUpload = false; await new Promise(resolve => { releaseUpload = resolve; }); }
  const conversationId = req.body.conversationId || id(100 + uploads.length);
  const attachmentId = id(200 + uploads.length);
  const bytes = Buffer.from(req.body.dataUrl.split(',')[1], 'base64');
  const decoded = PNG.sync.read(bytes);
  assert.ok(decoded.width > 0 && decoded.height > 0);
  const existing = [...files.values()].find(file => file.conversationId === conversationId && file.attachment.name === req.body.name && file.bytes.equals(bytes));
  const attachment = existing?.attachment || { id: attachmentId, name: req.body.name, mimeType: 'image/png', kind: 'image', size: bytes.length };
  files.set(attachmentId, { attachment, bytes, conversationId });
  if (!conversations.has(conversationId)) conversations.set(conversationId, { _id: conversationId, model: 'fixture', messages: [] });
  res.json({ status: 'success', data: { conversationId, attachment } });
});
app.get('/api/history/:id/attachments/:attachmentId', (req, res) => {
  const file = files.get(req.params.attachmentId);
  if (!file || file.conversationId !== req.params.id) return res.sendStatus(404);
  res.set('Cache-Control', 'private, no-store').type('png').send(file.bytes);
});
app.get('/api/history/:id', (req, res) => res.json({ status: 'success', data: conversations.get(req.params.id) }));
app.post(['/api/chat', '/api/chat/stream'], (req, res) => {
  turns.push(req.body);
  assert.ok(!JSON.stringify(req.body).includes('data:image/'));
  const row = conversations.get(req.body.conversationId);
  const attachments = req.body.attachmentIds.map(value => files.get(value).attachment);
  row.messages.push({ _id: id(300 + turns.length * 2), role: 'user', content: req.body.message, attachments },
    { _id: id(301 + turns.length * 2), role: 'assistant', content: 'Synthetic answer' });
  const data = { conversationId: row._id, messageId: row.messages.at(-1)._id, response: 'Synthetic answer', model: 'fixture' };
  if (req.path.endsWith('/stream')) return res.type('text/event-stream')
    .end('event: token\ndata: ' + JSON.stringify({ content: 'Synthetic answer' }) + '\n\nevent: done\ndata: ' + JSON.stringify(data) + '\n\n');
  res.json({ status: 'success', data });
});
app.use('/api', (_req, res) => res.json({ status: 'success', data: [] }));

let browser, server;
(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  // Chromium's fake device generates the entire frame. No real display source
  // or browser profile is available to this isolated headless browser.
  browser = await chromium.launch({ channel: 'chromium', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--auto-select-tab-capture-source-by-title=AgentX synthetic capture target'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/playground');
  await page.waitForFunction(() => window.fixture?.ready);
  await page.evaluate(() => { document.title = 'AgentX synthetic capture target'; });
  const captureButton = page.locator('#captureScreenBtn');
  const draftImages = page.locator('#captureScreenDraft img');
  const checks = [];
  async function capture() {
    const previous = await draftImages.count();
    await captureButton.click();
    await page.waitForFunction(count => document.querySelectorAll('#captureScreenDraft img').length === count + 1, previous);
    assert.equal(await page.evaluate(() => fixture.stopped()), true);
  }
  async function send(text) {
    await page.locator('#messageInput').fill(text);
    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => !fixture.state.sending && !fixture.state.preparingAttachments);
  }
  await capture();
  assert.equal(uploads.length, 0);
  assert.deepEqual(await page.evaluate(() => captureCalls[0]), { video: true, audio: false });
  await send('Explain this synthetic screen');
  assert.equal(uploads.length, 1); assert.equal(turns.length, 1);
  assert.equal(turns[0].attachmentIds.length, 1);
  assert.equal(await draftImages.count(), 0);
  const conversationId = turns[0].conversationId;
  await page.evaluate(id => fixture.load(id), conversationId);
  await page.waitForFunction(() => [...document.querySelectorAll('.chat-attachment img')].some(img => img.complete && img.naturalWidth > 0));
  checks.push('native getDisplayMedia, PNG snapshot, stopped tracks, deferred upload, JSON send, history preview');

  await capture(); await page.evaluate(() => { document.getElementById('streamToggle').checked = true; }); await send('Second synthetic screen');
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[1].messages[0].attachments.map(file => file.id), turns[0].attachmentIds);
  checks.push('streamed send and scoped historical attachment references');

  await page.evaluate(() => fixture.change());
  await page.evaluate(() => fixture.mode('denied'));
  await captureButton.click();
  await page.waitForFunction(() => document.getElementById('captureScreenStatus').textContent.includes('permission was denied'));
  assert.equal(await draftImages.count(), 0);
  checks.push('denied consent');

  await page.evaluate(() => fixture.mode('pending'));
  await captureButton.click(); await captureButton.click();
  await page.evaluate(() => fixture.grant());
  await page.waitForFunction(() => fixture.stopped());
  assert.equal(await draftImages.count(), 0);
  await captureButton.click(); await page.evaluate(() => { fixture.change(); fixture.grant(); });
  await page.waitForFunction(() => fixture.stopped());
  assert.equal(await draftImages.count(), 0);
  await captureButton.click(); await page.evaluate(() => { dispatchEvent(new Event('pagehide')); fixture.grant(); });
  await page.waitForFunction(() => fixture.stopped());
  assert.equal(await draftImages.count(), 0);
  checks.push('cancelled chooser, late grant, conversation change and pagehide cleanup');

  await page.evaluate(() => fixture.mode('native'));
  await capture(); failUpload = true; await send('Retry the synthetic upload');
  assert.equal(await draftImages.count(), 1);
  assert.equal(await page.locator('#messageInput').inputValue(), 'Retry the synthetic upload');
  const requestId = uploads.at(-1).requestId;
  await send('Retry the synthetic upload');
  assert.equal(uploads.at(-1).requestId, requestId);
  assert.equal(await draftImages.count(), 0);
  checks.push('upload failure retains draft and request identity for retry');

  await page.evaluate(() => fixture.change()); await capture(); holdUpload = true;
  await page.locator('#messageInput').fill('Synthetic upload in flight');
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => fixture.state.preparingAttachments);
  while (!releaseUpload) await new Promise(resolve => setTimeout(resolve, 10));
  const before = turns.length;
  await page.evaluate(() => fixture.change()); releaseUpload();
  await page.waitForFunction(() => !fixture.state.preparingAttachments);
  assert.equal(await draftImages.count(), 0); assert.equal(turns.length, before);
  assert.equal(await page.evaluate(() => fixture.state.conversationId), null);
  checks.push('conversation change aborts upload and cannot send into the next view');

  await page.evaluate(() => fixture.mode('static'));
  await capture(); await capture(); await capture();
  assert.equal(await captureButton.isDisabled(), true);
  await page.getByRole('button', { name: 'Remove snapshot' }).first().click();
  assert.equal(await captureButton.isDisabled(), false);
  await send('Two identical synthetic snapshots');
  assert.equal(turns.at(-1).attachmentIds.length, 1);
  checks.push('three-snapshot bound, draft removal and canonical duplicate-image deduplication');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await captureButton.isVisible());
  const bounds = await captureButton.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await context.close();
  const unsupported = await browser.newContext();
  await unsupported.addInitScript(() => Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined }));
  const unavailable = await unsupported.newPage(); await unavailable.goto(origin + '/playground');
  await unavailable.waitForFunction(() => window.fixture?.ready);
  assert.equal(await unavailable.locator('#captureScreenBtn').isDisabled(), true);
  assert.match(await unavailable.locator('#captureScreenStatus').textContent(), /unavailable/);
  await unsupported.close();
  checks.push('phone-width capture control and unsupported-browser disclosure');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ chromium: browser.version(), checks, uploads: uploads.length, turns: turns.length, pageErrors: errors }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
});
