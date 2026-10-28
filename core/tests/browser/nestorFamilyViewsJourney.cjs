'use strict';

// Curated family views on the real Nestor page (#924): typed and spoken "agrandis",
// "ferme", "suivant"… act on the content workspace without a model turn.
// Loopback CPU fixtures only: no model, microphone, speech service or live data.
// The microphone and speech recognition are simulated; the page, conversation
// loop and content workspace are the shipped code.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const core = path.resolve(__dirname, '../..'), publicDir = path.join(core, 'surfaces/household/public');
const { generatedPersonas, snapshot } = require('../../surfaces/household/persona-catalog');
const personas = generatedPersonas().map(row => snapshot({ ...row, _id: 'fixture', version: 1 }));
const sessions = new Map(), submissions = [], screens = [], errors = [];
let browser, server, heard = '';
const output = process.env.SCREEN_COMMANDS_BROWSER_OUTPUT_DIR || '/tmp/agentx-nestor-screen-commands-browser';
fs.mkdirSync(output, { recursive: true });

// A fake microphone: `say()` delivers one finished utterance to the conversation loop.
const fakeAudio = `window.NestorConversation.openAudio = async () => {
  const audio = { canInterrupt: false,
    listen(callback) { audio.utterance = callback; }, quiet() {}, close() {}, holdPlayback() {}, resumePlayback() {},
    async play() {}, async settle() {} };
  window.say = () => audio.utterance(new Blob(['speech']), {});
  return audio;
};`;

(async () => {
  const app = express();
  // The simulated recognizer answers before JSON parsing: the page posts the audio as a form.
  app.post('/api/voix/transcribe', (_req, res) => res.json({ data: { text: heard } }));
  app.use(express.json());
  app.use('/assets/household', express.static(publicDir));
  app.use('/js', express.static(path.join(core, 'public/js')));
  app.use('/css', express.static(path.join(core, 'public/css')));
  app.use('/psyx/assets', express.static(path.join(core, 'surfaces/psyx/public')));
  app.get('/api/voix/player.js', (_req, res) => res.type('js').send(''));
  app.get('/fixture', (_req, res) => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replace('<!-- product-navigation -->', '<span id="runtimePill"></span>')
      .replace(/  <script src="\/assets\/household\/app.js[^\n]+/, '')
      .replace('</body>', `<script>document.addEventListener('DOMContentLoaded', async () => {
        window.AvatarDock = undefined;
        ${fakeAudio}
        const api = async (url, options={}) => { const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}}); const body=await response.json(); if(!response.ok)throw Error(body.message||'fixture request failed'); return body.data; };
        try { await mountConversation({app:document.getElementById('app'),api,esc:value=>String(value??''),space:"family",autoStart:false});window.fixtureReady=true; }
        catch(error){window.fixtureError=error.stack;}
      });</script></body>`);
    res.type('html').send(html);
  });

  const pages = require('../../public/js/screen-pages').createCatalog([
    {id:'ecosystem',label:'Ecosystem',href:'/diskx?app=ecosystem',mode:'frame'},
    {id:'earth',label:'Earth',href:'/scene/earth',mode:'frame'},
    {id:'iss',label:'ISS',href:'/scene/iss',mode:'frame'}
  ]);
  const { createReplyChannels } = require('../../surfaces/household/reply-channels');
  app.get('/api/voice-personas/family/screen-pages',(_req,res)=>res.json({data:{destinations:pages.entries}}));
  app.get(['/diskx','/scene/earth','/scene/iss'],(req,res)=>res.type('html').send('<!doctype html><title>Synthetic source fixture</title><h1>Fixture scene</h1><p>Render fixture only; no live telemetry.</p>'));
  app.get('/api/voice-personas/catalog', (_req, res) => res.json({ data: { personas, runtime: { defaultBackend: 'agentx', hermesConfigured: true } } }));
  app.use('/api/voice-personas/private', (_req, res) => { errors.push('Private API requested by family'); res.sendStatus(403); });
  app.post('/api/voice-personas/family/sessions', (req, res) => {
    const session = { ...req.body, sessionId: randomUUID(), status: 'active', turnCount: 0 };
    sessions.set(session.sessionId, session); res.status(201).json({ data: { session } });
  });
  // The only model stand-in: every request that reaches it is counted.
  app.post('/api/voice-personas/family/sessions/:id/turns/text', (req, res) => {
    submissions.push(req.body.text);
    screens.push(req.body.screen);
    const session = sessions.get(req.params.id); session.turnCount++;

    const channels=createReplyChannels({allowPages:true,pageCatalog:pages});
    channels.push(req.body.text==='describe' ? 'Fixture follow-up.' : '<show kind="page">'+req.body.text+'</show>');
    const value=channels.end();
    res.type('application/x-ndjson');
    for(const block of value.display) res.write(JSON.stringify({type:'show',block})+'\n');
    res.end(JSON.stringify({type:'done',data:{session,traceId:randomUUID(),reply:{text:value.say},routing:{backend:'agentx'}}})+'\n');
  });
  const photoId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  app.get('/api/photos/frame/status', (_req, res) => res.json({ data: { enabled: true, idleSeconds: 120, intervalSeconds: 30 } }));
  app.get('/api/photos/frame/next', (_req, res) => res.json({ data: { id: photoId, src: '/api/photos/frame/' + photoId + '/image' } }));
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
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/fixture');
  await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
  assert.equal(await page.evaluate(() => window.fixtureError), undefined);



  const ask = async text => {
    await page.locator('#conversationMessage').fill(text);
    await page.locator('#conversationText').getByRole('button',{name:'Send',exact:true}).click();
    await page.waitForFunction(() => !document.querySelector('#conversationText button[type=submit]').disabled);
  };
  await ask('ecosystem play=network,memory');
  const frame=page.locator('#conversationVisual iframe');
  await frame.waitFor();
  assert.match(await frame.getAttribute('src'),/^\/diskx\?app=ecosystem&view=screen&from=nestor&play=network%2Cmemory&presentation=/);
  await frame.contentFrame().getByRole('heading',{name:'Fixture scene'}).waitFor();
  const sessionId=[...sessions.values()].at(-1).sessionId;
  assert.equal([...sessions.values()].at(-1).backend,'agentx');
  assert.equal([...sessions.values()].at(-1).agentId,'family');
  await page.locator('#conversationSettingsToggle').click();
  assert.equal(await page.locator('#conversationSettings').isVisible(),true);
  assert.equal(await page.locator('#conversationWorkshop').isVisible(),true);
  await page.locator('#conversationSettingsToggle').click();
  await ask('describe');
  await page.waitForFunction(() => document.querySelectorAll('.conversation-message').length>=4);
  assert.match(screens[1]?.[0]?.page || '', /^ecosystem play=network,memory$/);
  assert.doesNotMatch(JSON.stringify(screens[1]), /pipeline|private/);
  await page.getByRole('button',{name:'Retour à Nestor',exact:true}).click();
  assert.equal(await frame.count(),0);
  assert.equal([...sessions.values()].at(-1).sessionId,sessionId);
  await page.setViewportSize({width:390,height:844});
  await ask('earth'); await frame.waitFor();
  const previous = await frame.elementHandle();
  await ask('iss');
  await page.waitForFunction(() => document.querySelector('#conversationVisual iframe')?.src.includes('/scene/iss'));
  assert.equal(await frame.count(),1,'only the current Family 3D view stays mounted');
  assert.equal(await previous.getAttribute('src'),'about:blank','replaced scene is disposed');
  await page.getByRole('button',{name:'Retour à Nestor',exact:true}).click();
  for(const id of ['earth','iss']) {
    await ask(id); await frame.waitFor();
    await frame.contentFrame().getByRole('heading',{name:'Fixture scene'}).waitFor();
    assert.equal(await frame.getAttribute('src'),'/scene/'+id+'?view=screen&from=nestor');
    await page.locator('#conversationVisual').getByRole('button',{name:'Agrandir',exact:true}).click();
    assert.equal(await frame.evaluate(el=>el.classList.contains('is-expanded')),true);
    await page.getByRole('button',{name:'Retour à Nestor',exact:true}).click();
    assert.equal(await frame.count(),0);
  }
  await ask('pipeline');
  await page.waitForFunction(()=>!document.getElementById('conversationMessage').disabled);
  assert.equal(await frame.count(),0,'owner page proposal is discarded by native parser');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,scope:'family',views:['ecosystem','earth','iss'],liveModelCalls:0,errors}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;})
.finally(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());});
