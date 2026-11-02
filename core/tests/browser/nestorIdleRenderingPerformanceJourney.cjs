'use strict';

// Real DOM/intersection delivery with counter renderers; no WebGL, live service or media.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const publicDir = path.resolve(__dirname, '../../surfaces/household/public');
const files = new Set(['avatar-dock.js', 'avatar-dock.css', 'idle-photos.js', 'idle-photos.css', 'nestor-progress.js']);
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', results = [], errors = [];
let server, browser;
const counters = `
  class CounterSurface extends HTMLElement {
    connectedCallback() {
      this.draws=0; this.updates=0; this.visible=false;
      this.observer=new IntersectionObserver(rows=>{this.visible=rows.some(row=>row.isIntersecting);});
      this.observer.observe(this);
      const tick=()=>{if(this.visible)this.draws++;this.frame=requestAnimationFrame(tick);};
      this.frame=requestAnimationFrame(tick);this.dispatchEvent(new CustomEvent('llmx-face-ready'));
    }
    set presence(value){this.latest=value;this.updates++;}
    disconnectedCallback(){cancelAnimationFrame(this.frame);this.observer.disconnect();}
  }
  customElements.define('llmx-face',class extends CounterSurface{});
  customElements.define('llmx-stage',class extends CounterSurface{});`;

(async () => {
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/api/household/avatar/llmx-face.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(counters); }
    if (files.has(name.slice(1))) {
      res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript');
      return res.end(fs.readFileSync(path.join(publicDir, name.slice(1))));
    }
    if (name === '/api/photos/frame/' + id + '/image') {
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#183f60"/></svg>');
    }
    if (name !== '/') { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width">
      <link rel="stylesheet" href="/avatar-dock.css"><link rel="stylesheet" href="/idle-photos.css">
      <style>llmx-stage{display:block;width:160px;height:120px}.page-presentation,.conversation-visual{position:absolute;top:0;left:0}</style>
      <main id="app"><nav id="toolbar"></nav><section id="progress"></section>
        <section class="page-presentation"><llmx-stage id="pageStage"></llmx-stage></section>
        <section class="conversation-visual"><llmx-stage id="legacyStage"></llmx-stage></section></main>
      <script src="/avatar-dock.js"></script><script src="/idle-photos.js"></script><script src="/nestor-progress.js"></script>
      <script>
        window.clockNow=100000;Date.now=()=>clockNow;window.language='fr';window.amplitude=.2;
        window.dock=AvatarDock.mount();
        const interval=window.setInterval;
        window.setInterval=(run,ms)=>interval(run,1000000);
        window.photos=NestorIdlePhotos.mount({host:document.getElementById('toolbar'),now:()=>clockNow,api:async url=>
          url.endsWith('/status')?{enabled:true,idleSeconds:30,intervalSeconds:5}:{id:'${id}',src:'/api/photos/frame/${id}/image'}});
        window.setInterval=(run,ms)=>{window.renderProgress=run;return interval(run,1000000);};
        window.progress=NestorProgress.create({host:document.getElementById('progress'),getLanguage:()=>language});
        window.setInterval=interval;
        window.view={turns:Array.from({length:12},(_,i)=>({id:'done-'+i,done:true,browserStartedAt:10000,browserEndedAt:40000}))};
        progress.update(view);
      </script>`);
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless:true,
    ...(process.env.AGENTX_BROWSER_EXECUTABLE && {executablePath:process.env.AGENTX_BROWSER_EXECUTABLE})});
  for (const viewport of [{width:1440,height:1000}, {width:390,height:844}]) {
    const context = await browser.newContext({viewport});
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector('llmx-face')?.updates > 0 && pageStage.draws > 0 && legacyStage.draws > 0);
    const idle = await page.evaluate(async () => {
      const face=document.querySelector('llmx-face'),orb=document.querySelector('.avatar-dock-orb');
      let mutations=0;const observer=new MutationObserver(rows=>{mutations+=rows.length;});
      observer.observe(orb,{attributes:true});const updates=face.updates;
      await new Promise(resolve=>setTimeout(resolve,350));observer.disconnect();
      return {updates:face.updates-updates,mutations};
    });
    assert.deepEqual(idle, {updates:0,mutations:0}, 'unchanged presence does not write to the face or orb');
    await page.evaluate(() => dispatchEvent(new CustomEvent('persona-presence',{detail:{state:'speaking',sample:{speech:()=>({amplitude,brightness:.3})}}})));
    await page.waitForFunction(() => document.querySelector('llmx-face').latest.phase === 'speaking');
    await page.evaluate(() => { amplitude=.4; });
    await page.waitForFunction(() => document.querySelector('llmx-face').latest.level === .4);
    await page.evaluate(() => dispatchEvent(new CustomEvent('persona-activity',{detail:{kind:'tools',count:1}})));
    await page.waitForFunction(() => document.querySelector('llmx-face').latest.toolPulses === 1);
    await page.evaluate(() => dispatchEvent(new CustomEvent('persona-presence',{detail:{state:'idle'}})));
    await page.waitForFunction(() => document.querySelector('llmx-face').latest.phase === 'sleeping');

    const terminal = await page.evaluate(async () => {
      const host=document.getElementById('progress'),nodes=[...host.querySelectorAll('li')];
      let mutations=0;const observer=new MutationObserver(rows=>{mutations+=rows.length;});
      observer.observe(host,{subtree:true,childList:true,attributes:true,characterData:true});
      for(let i=0;i<100;i++){clockNow+=1000;renderProgress();await Promise.resolve();}
      observer.disconnect();return {mutations,nodesPreserved:nodes.every((node,i)=>node===host.querySelectorAll('li')[i])};
    });
    assert.deepEqual(terminal, {mutations:0,nodesPreserved:true}, 'finished clocks and rows remain inert');
    await page.evaluate(() => {
      view.turns.push({id:'active',browserStartedAt:clockNow-10000,currentActivity:{kind:'tool',tool:'read'}});progress.update(view);
      window.progressNodes=[...document.querySelectorAll('#progress li')];clockNow+=1000;renderProgress();
    });
    assert.match(await page.locator('#progress li').last().textContent(), /0:11 · read/);
    assert.equal(await page.evaluate(() => progressNodes.every((node,i)=>node===document.querySelectorAll('#progress li')[i])), true);
    await page.evaluate(() => { language='en';progress.update(view); });
    assert.match(await page.locator('#progress').textContent(), /Tool running/);
    await page.evaluate(() => { view={turns:[]};progress.update(view); });
    assert.equal(await page.locator('#progress').getAttribute('hidden'), '');
    await page.evaluate(() => { document.activeElement?.blur();clockNow+=31000;photos.tick(); });
    await page.waitForFunction(() => photos.active());
    await page.waitForFunction(() => !pageStage.visible && !legacyStage.visible);
    const during = await page.evaluate(async () => {
      const before=[pageStage.draws,legacyStage.draws];
      view={turns:[{id:'hidden-work',done:true,browserStartedAt:10000,browserEndedAt:40000}]};progress.update(view);
      await new Promise(resolve=>setTimeout(resolve,200));
      return {draws:[pageStage.draws-before[0],legacyStage.draws-before[1]],progressHidden:document.getElementById('progress').hidden};
    });
    assert.deepEqual(during, {draws:[0,0],progressHidden:true}, 'covered scenes and progress suspend');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => pageStage.visible && legacyStage.visible);
    await page.evaluate(() => renderProgress());
    assert.equal(await page.locator('#progress').isVisible(), true);
    assert.equal(await page.locator('#progress li').count(), 1);
    assert.equal(await page.evaluate(() => progressNodes[0] === document.querySelector('#progress li')), true, 'resuming reuses the first status row');
    assert.equal(await page.evaluate(() => progressNodes[1]?.isConnected), false, 'extra rows are removed after resuming');
    const hidden = await page.evaluate(async () => {
      Object.defineProperty(document,'hidden',{configurable:true,value:true});
      const host=document.getElementById('progress');let changes=0;
      const observer=new MutationObserver(rows=>{changes+=rows.length;});observer.observe(host,{subtree:true,childList:true,attributes:true});
      view.turns[0].error=true;progress.update(view);await Promise.resolve();observer.disconnect();return changes;
    });
    assert.equal(hidden,0,'background progress waits without mutating the page');
    await page.evaluate(() => {Object.defineProperty(document,'hidden',{configurable:true,value:false});renderProgress();});
    assert.match(await page.locator('#progress').textContent(),/Error/);
    await page.evaluate(() => { progress.dispose();photos.dispose();dock.dispose(); });
    results.push({viewport,idle,terminal,coveredDraws:during.draws});await context.close();
  }
  assert.deepEqual(errors, []);console.log(JSON.stringify({ok:true,results,errors,webgl:false,modelCalls:0}));
})().catch(error => { console.error(error.stack);process.exitCode=1; }).finally(async () => {
  await browser?.close();await new Promise(resolve => server ? server.close(resolve) : resolve());
});
