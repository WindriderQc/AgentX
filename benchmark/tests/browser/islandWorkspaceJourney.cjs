'use strict';
// Actual Benchmark page/modules + built GraphysX viewer; synthetic APIs only.
// Run under the instance heavy-work queue and GraphysX native verify lock.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const express=require('../../node_modules/express');

const graph=process.env.GRAPHYSX_CHECKOUT,output=process.env.ISLAND_REPORT_DIR;
if(!graph||!output||path.resolve(output).startsWith(path.resolve(__dirname,'../../..')+path.sep))throw Error('Set GRAPHYSX_CHECKOUT and an out-of-Git ISLAND_REPORT_DIR.');
const ID='00000000-0000-4000-8000-000000000001';
let server,viewer,browser,memoryReads=0,replayReads=0;
const errors=[];
(async()=>{
 const {startStaticServer}=await import(pathToFileURL(path.join(graph,'scripts/static-server.mjs')).href);
 viewer=await startStaticServer({root:path.join(graph,'dist'),port:0});
 const app=express(),root=path.resolve(__dirname,'../..');
 app.use('/js',express.static(path.join(root,'public/js')));app.use('/css',express.static(path.join(root,'public/css')));
 const run={id:ID,agent:'Eko',world:'living-island',phase:'running',queue:{state:'completed'},replayable:true,hasMemory:true,requestedAt:'2026-01-01T00:00:00Z'};
 const ok=data=>({ok:true,data});
 const liveUrl=()=>`${viewer.url}/?app=island&source=fixture&embed=1`;
 app.get('/benchmark/api/island/runs',(_req,res)=>res.json(ok({runs:[run],worlds:[{id:'local',label:'Local'},{id:'living-island',label:'Île vivante',liveUrl:liveUrl()}],view:{live:true,replay:true},queueRead:true})));
 app.get('/benchmark/api/island/worlds/:id/live',(_req,res)=>res.json(ok({available:true,selectedActive:true,activeWorld:{id:'living-island',label:'Île vivante'},recordingState:'paused',liveUrl:liveUrl()})));
 app.get('/benchmark/api/island/runs/:id/memory',(_req,res)=>{memoryReads++;res.json(ok({runs:[run],files:{'SOUL.md':{text:'Personnalité',bytes:12},'EPISODIC_MEMORY.md':{text:'Récit enregistré <source>',bytes:120,truncated:true},'EPISODIC_MEMORY.jsonl':{text:'{"summary":"Exploration","detail":"Un arbre"}',bytes:50},'SEMANTIC_MEMORY.md':{missing:true}}}));});
 app.post('/benchmark/api/island/runs/:id/replay',(_req,res)=>{if(++replayReads===1)return res.status(503).json({status:'error',message:'Synthetic replay unavailable'});res.json(ok({src:liveUrl()}));});
 app.get('/benchmark/island',(_req,res)=>res.type('html').send(`<!doctype html><html lang="fr"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/island.css"><style>body{margin:24px;background:#0b1824;color:#eef5f5;font:16px system-ui}a{color:#a4dfed}button,input,select{font:inherit}iframe{width:100%;border:1px solid #477381}section{padding:16px}pre{white-space:pre-wrap}[hidden]{display:none!important}</style></head><body>${fs.readFileSync(path.join(root,'views/pages/island.ejs'),'utf8')}<script type="module" src="/js/island/index.js"></script></body></html>`));
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
 const {launchSmokeBrowser}=await import(pathToFileURL(path.join(graph,'scripts/smoke-harness.mjs')).href);
 browser=await launchSmokeBrowser();
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(45000);page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(`http://127.0.0.1:${server.address().port}/benchmark/island`);
 await page.locator('#island-watch').waitFor({state:'visible'});
 assert.equal(await page.locator('#island-world').inputValue(),'local');
 await page.locator('#island-watch').click();
 await page.locator('#island-viewer').waitFor({state:'visible'});
 assert.match(await page.locator('#island-live-status').textContent(),/Enregistrement suspendu/);
 await page.locator('#island-viewer-close').click();
 assert.equal(await page.locator('#island-frame').getAttribute('src'),'about:blank');
 await page.locator(`[data-replay="${ID}"]`).click();
 await page.getByText(/Relecture indisponible/).waitFor();
 assert.equal(await page.locator('#island-frame').getAttribute('src'),'about:blank');
 await page.locator(`[data-replay="${ID}"]`).click();assert.equal(await page.locator('[data-live]').count(),0);
 const frame=page.frameLocator('#island-frame');await frame.locator('[data-ix-world]').waitFor({state:'attached'});
 if(!await frame.locator('.gx-island-explorer').isVisible())await frame.locator('[data-action="explore"]').click();
 await frame.locator('[data-ix-category="objects"]').click();await frame.locator('.ix-item[data-ix-select]').first().click();
 const frameElement=await page.locator('#island-frame').elementHandle(),content=await frameElement.contentFrame();
 const selected=await content.evaluate(()=>JSON.parse(window.render_game_to_text()).application.explorer.selected);
 const src=await page.locator('#island-frame').getAttribute('src');
 await frame.locator('[data-ix-memory]').click();await page.locator('#island-memory').waitFor({state:'visible'});
 assert.equal(memoryReads,1);assert.match(await page.locator('#island-memory-provenance').textContent(),/ne sont pas synchronisés/);
 await page.locator('[data-file="EPISODIC_MEMORY.md"]').click();assert.match(await page.locator('#island-memory-body').textContent(),/Récit enregistré <source>/);assert.match(await page.locator('#island-memory-body').textContent(),/120 octets/);
 await page.locator('[data-file="SEMANTIC_MEMORY.md"]').click();assert.match(await page.locator('#island-memory-body').textContent(),/Fichier absent/);
 await page.locator('[data-file="SOUL.md"]').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('[data-file="EPISODIC_MEMORY.md"]').getAttribute('aria-selected'),'true');
 await page.getByRole('link',{name:'Revenir à l’exploration (sélection conservée)'}).click();
 assert.equal(await page.locator('#island-frame').getAttribute('src'),src);assert.equal(await content.evaluate(()=>JSON.parse(window.render_game_to_text()).application.explorer.selected),selected);
 fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'benchmark-island-workspace.png')});
 for(const width of [390,768]){
  await page.setViewportSize({width,height:1024});
  await page.locator('#island-watch').click();
  await page.frameLocator('#island-frame').locator('[data-ix-world]').waitFor({state:'attached'});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
  await page.locator('#island-viewer').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,`benchmark-island-${width}.png`)});
  await page.locator('#island-viewer-close').click();
  assert.equal(await page.locator('#island-frame').getAttribute('src'),'about:blank');
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'benchmark-island-result.json'),JSON.stringify({passed:true,errors,coverage:['direct visible with local launch terrain and paused recording','replay error and retry','close disconnects iframe','390px and 768px layouts','terminal state disables stale live link','run opens actual viewer','memory request origin/frame/run validation','four memory files and missing/truncated states','keyboard tabs','return preserves iframe selection']},null,2));
 console.log('ok: Benchmark island workspace and memory round trip');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();await viewer?.close();if(server)await new Promise(r=>server.close(r));});
