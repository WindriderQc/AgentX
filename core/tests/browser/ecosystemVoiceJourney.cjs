'use strict';
// Actual Core route, GraphysX embed, Nestor adapter and Web Audio player.
// Only the catalog and speech bytes are synthetic; no model or installed service is called.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../../..');
const bundle = process.env.DISKX_TEST_MODULE;
const report = process.env.ECOSYSTEM_BROWSER_REPORT;
if (!bundle || !report) throw new Error('DISKX_TEST_MODULE and ECOSYSTEM_BROWSER_REPORT required');
fs.mkdirSync(report, { recursive: true });
const app = express(), requests = [];
app.use(express.json());
app.get('/api/voice-personas/catalog', (_req, res) => res.json({ data: { personas: [{ id: 'nestor', voice: { provider: 'voxcpm', source: 'instance', voices: { fr: 'fixture-voice' } } }] } }));
app.get('/api/voix/player.js', (_req, res) => res.sendFile(path.join(root, 'integrations/voix/app/web/voice-audio.js')));
app.post('/api/voix/synthesize/stream', (req, res) => {
  const item = { body: req.body, res, closed: false }; requests.push(item);
  res.on('close', () => { item.closed = true; });
  res.type('application/x-ndjson');
  const samples = 800, pcm = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) pcm.writeFloatLE(Math.sin(i * Math.PI / 20) * 0.01, i * 4);
  res.write(JSON.stringify({ type: 'meta', protocol: 'voix-pcm-v1', encoding: 'f32le', channels: 1, sample_rate: 8000 }) + '\n');
  res.write(JSON.stringify({ type: 'audio', sequence: 1, samples, pcm: pcm.toString('base64') }) + '\n');
  item.release = () => res.end(JSON.stringify({ type: 'done', frames: 1, samples }) + '\n');
});
app.use('/js', express.static(path.join(root, 'core/public/js')));
app.use('/assets/household', express.static(path.join(root, 'core/surfaces/household/public')));
require('../../surfaces/diskx').register({ app, express, env: { DISKX_MODULE_URL: 'https://assets.example/embed/diskx.js' },
  fetchData: () => assert.fail('No domain data required'),
  fetchWithTimeout: async () => ({ ok: true, headers: new Map([['content-type', 'text/javascript']]), text: async () => fs.readFileSync(bundle, 'utf8') }) });
const catalog = require('../../public/js/screen-pages').createCatalog(require('../../../shared/screenDestinations').screenDestinations({ agentxProfile: 'full' }));
app.get('/fixture', (_req, res) => res.send(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Guide et Nestor</title>
<style>*{box-sizing:border-box}body{margin:12px;background:#07181e;color:white;font:16px system-ui}.page-presentation-board iframe{width:100%;height:700px}.page-presentation-board[hidden]{display:none}</style>
<div id="app"><div class="conversation-layout"><section id="text"></section><section id="visual"></section></div><button id="ask">Poser une question</button></div>
<script src="/js/screen-pages.js"></script><script src="/assets/household/page-presentation.js"></script><script src="/assets/household/display-board.js"></script>
<script src="/js/voice/speech-language.js"></script><script src="/js/voice/voice-capture.js"></script><script src="/js/voice/browser-conversation.js"></script><script src="/api/voix/player.js"></script>
<script>AgentXScreenPages.configure(${JSON.stringify(catalog.entries)});window.board=DisplayBoard.createScreen({text:document.getElementById('text'),visual:document.getElementById('visual')},{space:'personal'});board.add({kind:'page',title:'Visite',body:'ecosystem play=overview,frank'});
window.presence=busy=>dispatchEvent(new CustomEvent('persona-presence',{detail:{conversationBusy:busy}}));
document.getElementById('ask').onclick=async()=>{presence(true);const voice=new VoixAudio.Speech();await voice.speak(signal=>fetch('/api/voix/synthesize/stream',{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Nestor répond à la question.',language:'fr',voice:'fixture-voice',tts_provider:'voxcpm'})}));presence(false);};</script></html>`));

app.get('/simple-board', (_req,res)=>res.send('<!doctype html><html><iframe style="width:100%;height:800px" src="/diskx?app=ecosystem&play=overview,frank"></iframe></html>'));

(async () => {
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [], responses = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) responses.push(response.status() + ' ' + response.url()); });
    await page.addInitScript(() => {
      window.audioEvents = [];
      window.speechRequests = [];
      const fetchAudio = window.fetch.bind(window);
      window.fetch = (url, options) => {
        if (String(url).endsWith('/api/voix/synthesize/stream')) {
          const row = { aborted: false }; window.speechRequests.push(row);
          options?.signal?.addEventListener('abort', () => { row.aborted = true; }, { once: true });
        }
        return fetchAudio(url, options);
      };
      for (const name of ['start', 'stop']) {
        const original = AudioBufferSourceNode.prototype[name];
        AudioBufferSourceNode.prototype[name] = function (...args) { window.audioEvents.push(name); return original.apply(this, args); };
      }
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/diskx?app=ecosystem&play=overview,frank,summary`);
    await page.waitForFunction(() => document.querySelector('agentx-ecosystem').state()?.presentation);
    assert.equal(await page.getByRole('button', { name: '🔇 Couper la voix', exact: true }).getAttribute('aria-pressed'), 'true');
    const count = async n => { for (let i = 0; i < 100 && requests.length < n; i++) await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(requests.length, n); };
    await count(1);
    const first = await page.evaluate(() => document.querySelector('agentx-ecosystem').state().presentation);
    assert.equal(requests[0].body.text, first.narration);
    assert.equal(requests[0].body.voice, 'ff_siwis');
    assert.equal(requests[0].body.tts_provider, 'kokoro');
    // The former seven-second overview timer must never cut an unfinished spoken phrase.
    await page.waitForTimeout(7600);
    assert.equal(await page.evaluate(() => document.querySelector('agentx-ecosystem').state().presentation.tour.index), 0);
    assert.ok((await page.evaluate(() => audioEvents)).includes('start'), 'real Web Audio scheduled the synthetic PCM');
    requests[0].release(); await count(2);
    await page.waitForFunction(() => document.querySelector('agentx-ecosystem').state().presentation.tour.index === 1);
    await page.getByRole('button', { name: 'Étape suivante', exact: true }).click(); await count(3);
    assert.equal(await page.evaluate(() => speechRequests[1].aborted), true, 'changing stop aborts the old synthesis signal');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => speechRequests[2].aborted), true);
    await page.waitForFunction(() => document.querySelector('agentx-ecosystem').state().presentation.tour.playing === false);
    await page.getByRole('button', { name: 'Lire', exact: true }).click(); await count(4);
    assert.equal(requests[3].body.text, requests[2].body.text, 'resume reads the interrupted stop again');
    requests[3].release();
    await page.waitForFunction(() => !document.querySelector('agentx-ecosystem').state().presentation.tour.playing);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: path.join(report, 'ecosystem-voice-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(() => document.querySelector('agentx-ecosystem').tour.goto(0));
    await page.waitForFunction(() => document.querySelector('agentx-ecosystem').state().presentation.tour.index === 0);
    const node = await page.evaluate(() => document.querySelector('agentx-ecosystem').state().nodes.find(item => item.kind === 'host' && item.screen));
    await page.mouse.click(...node.screen); await count(5);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.waitForTimeout(150); assert.equal(await page.evaluate(() => speechRequests[4].aborted), true, 'a selected component also offers a working Pause');
    await page.getByRole('button', { name: 'Lire', exact: true }).click(); await count(6);
    assert.equal(requests[5].body.text, requests[4].body.text, 'resume keeps the selected component');
    await page.getByRole('button', { name: 'Quitter', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => speechRequests[5].aborted), true, 'closing releases speech');
    // The real content workspace relays question onset and Nestor's speaking state.
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await count(7);
    const frame = page.frames().find(f => new URL(f.url()).pathname === '/diskx');
    await frame.waitForFunction(() => document.querySelector('agentx-ecosystem').state()?.presentation);
    const beforeQuestion = await frame.evaluate(() => document.querySelector('agentx-ecosystem').state().presentation.tour.index);
    await page.evaluate(() => dispatchEvent(new CustomEvent('nestor-question-start')));
    await frame.getByRole('button', { name: 'Reprendre la visite', exact: true }).waitFor();
    assert.equal(await frame.evaluate(() => speechRequests[0].aborted),true,'typing a question cancels guide synthesis');
    await page.getByRole('button', { name: 'Poser une question', exact: true }).click(); await count(8);
    assert.equal(requests[7].body.voice,'fixture-voice','the conversation keeps Nestor’s own voice');
    assert.equal(await frame.getByRole('button', { name: 'Reprendre la visite', exact: true }).isDisabled(),true);
    requests[7].release();
    await page.waitForFunction(() => document.querySelector('iframe').contentDocument.querySelector('[data-action="toggle"]').disabled === false);
    assert.equal(requests.length,8,'Nestor finishing does not restart the guide');
    await page.setViewportSize({width:390,height:900});
    assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'paused guide controls fit mobile');
    await page.screenshot({path:path.join(report,'guide-question-mobile.png'),fullPage:true});
    assert.equal(await frame.evaluate(() => document.querySelector('agentx-ecosystem').state().presentation.tour.index),beforeQuestion);
    await frame.getByRole('button', { name: 'Reprendre la visite', exact: true }).click(); await count(9);
    assert.equal(requests[8].body.text,requests[6].body.text);
    assert.equal(requests[8].body.voice,'ff_siwis');
    await page.evaluate(() => presence(true));
    assert.equal(await frame.evaluate(() => speechRequests[1].aborted),true,'spoken question onset cancels the guide too');
    assert.equal(await frame.getByRole('button', { name: 'Reprendre la visite', exact: true }).isDisabled(),true);
    await page.evaluate(() => presence(false));
    await frame.getByRole('button', { name: 'Reprendre la visite', exact: true }).click(); await count(10);
    await page.locator('[data-action="toggle"]').click();
    assert.equal(await frame.evaluate(() => speechRequests[2].aborted),true,'closing the parent workspace also stops the guide');
    assert.deepEqual(errors, []); assert.deepEqual(responses, []);
    const lockedBrowser = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=document-user-activation-required'] });
    try {
      const locked = await lockedBrowser.newPage({ viewport: {width:800,height:700}, reducedMotion:'reduce' });
      locked.on('pageerror', error => errors.push(error.message));
      await locked.goto(`http://127.0.0.1:${server.address().port}/diskx?app=ecosystem&play=overview,frank`);
      await locked.getByText('La voix est prête. Touchez la visite pour autoriser le son.').waitFor();
      assert.equal(requests.length,10,'blocked autoplay does not invoke synthesis');
      assert.equal(await locked.getByRole('button',{name:'🔇 Couper la voix',exact:true}).getAttribute('aria-pressed'),'true');
      await locked.getByRole('button',{name:'Lire',exact:true}).click(); await count(11);
      await locked.getByRole('button',{name:'Quitter',exact:true}).click();
    } finally { await lockedBrowser.close(); }
    assert.deepEqual(errors, []);
    await page.goto(`http://127.0.0.1:${server.address().port}/diskx?app=ecosystem&play=overview,frank&voice=off`);
    await page.waitForFunction(() => document.querySelector('agentx-ecosystem').state()?.presentation);
    assert.equal(await page.getByRole('button',{name:'🔊 Activer la voix',exact:true}).getAttribute('aria-pressed'),'false');
    assert.equal(requests.length,11,'ambient opt-out opens no synthesis');
    assert.equal(await page.evaluate(() => document.querySelector('agentx-ecosystem').state().presentation.tour.playing),true,'ambient silent clock still plays');
    await page.goto(`http://127.0.0.1:${server.address().port}/simple-board`); await count(12);
    const simple = page.frames().find(f=>new URL(f.url()).pathname==='/diskx');
    await page.evaluate(()=>dispatchEvent(new CustomEvent('persona-presence',{detail:{conversationBusy:true}})));
    await simple.getByRole('button',{name:'Reprendre la visite',exact:true}).waitFor();
    assert.equal(await simple.getByRole('button',{name:'Reprendre la visite',exact:true}).isDisabled(),true);
    await page.evaluate(()=>dispatchEvent(new CustomEvent('persona-presence',{detail:{conversationBusy:false}})));
    assert.equal(requests.length,12,'a simple family board also waits for manual resume');
    const result = { ok: true, nativeModelCalls: 0, syntheticSpeech: true, realWebAudio: true,
      checks: ['voice enabled by default', 'explicit silent ambient playback retained', 'simple family board conversation pause', 'blocked autoplay retains voice and retries on Play', 'separate female guide voice', 'full displayed narration', 'waits for speech completion', 'automatic next step', 'step replacement abort', 'pause abort', 'resume', 'last step stops', 'mobile controls', 'selected component pause/resume', 'typed question pause', 'spoken question pause', 'Nestor voice unchanged', 'resume blocked during answer', 'manual resume at same stop', 'hidden workspace stops speech', 'close abort'], errors, responses };
    fs.writeFileSync(path.join(report, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
