'use strict';
// The existing calendar controller, with disposable HTTP fixtures and no models.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const tree=path.resolve(__dirname,'../../..'),core=path.join(tree,'core'),req=createRequire(core+'/package.json');
const express=req('express'),{chromium}=require('playwright'),{mount}=req('./routes/automations');
const {buildProductNavigation}=require(tree+'/shared/productNavigation');
const report=process.env.OPERATIONS_REPORT_DIR;
if(!report||path.resolve(report).startsWith(tree+path.sep))throw Error('Set OPERATIONS_REPORT_DIR outside Git');
fs.mkdirSync(report,{recursive:true});
let server,browser;
const heavyJobs=[['old-receipt','completed'],['pending-request','requested'],['running-request','running']].map(([id,state])=>({
 id,title:id,state,kind:'diagnostic',priority:5,hosts:['native-host'],source:{type:'coding'},revision:1,createdAt:'2026-10-01T00:00:00Z'}));
// Two lane measurements: one the owner let start by itself, one waiting in its open slot.
const slot=(from,to)=>({start:new Date(Date.now()+from*60000).toISOString(),end:new Date(Date.now()+to*60000).toISOString(),estimated:true});
heavyJobs.push(...[['lane-auto',slot(60,240),true],['lane-open',slot(-5,175),false]].map(([id,reservation,autoStart])=>({
 id,title:`Full profile (${id})`,state:'reserved',kind:'profiler',priority:5,hosts:['http://127.0.0.1:11434'],source:{type:'operator',ref:'profiler-lane-capability-card'},
 executor:{hostId:'fixture',depth:'full',skipRecentDays:0,modelNames:['synthetic:model']},estimatedMinutes:180,revision:2,createdAt:'2026-10-02T00:00:00Z',
 reservation:{...reservation,autoStart}})));
const ownerEntries=[
 {id:'cron',name:'Native report',taskType:'sync',metadata:{scheduler:'openclaw',requiresGpu:false}},
 {id:'host-job',name:'Archive copy',taskType:'backup',metadata:{scheduler:'agentx-operations',requiresGpu:false,gateType:'snapshot',sourceAuthority:'native-operations-supervisor'}},
 {id:'core:backup',name:'Sauvegarde Core',taskType:'backup',metadata:{scheduler:'core-backup',requiresGpu:false}}
].map(entry=>({...entry,_id:entry.id,source:'agentx-system',sourceId:entry.id,host:null,model:null,enabled:true,priority:5,vramMb:0,schedule:{type:'cron',cron:'0 8 * * *',timezone:'America/Toronto'}}));
const timeline=date=>ownerEntries.map(entry=>({...entry,slots:[{start:date+'T12:00:00Z',end:date+'T12:02:00Z'}],scheduleType:'cron'}));
(async()=>{
 const app=express();app.set('view engine','ejs');app.set('views',core+'/views');app.locals.buildProductNavigation=buildProductNavigation;
 app.use('/vendor/fontawesome/6.4.0',express.static(core+'/node_modules/@fortawesome/fontawesome-free'));app.use(express.static(core+'/public'));
 mount(app,{},{});app.get('/cluster-schedule',(_request,response)=>response.redirect('/automations?view=calendar'));
 app.get('/api/health',(_request,response)=>response.json({status:'ok'}));
 app.get('/api/*',(request,response)=>{
  const date=request.query.date||'2026-10-14',now=new Date().toISOString();let data={};
  switch(request.path){
   case '/api/cluster/schedule/timeline':data={date,timezone:'America/Toronto',timeline:timeline(date)};break;
   case '/api/cluster/schedule/timeline-by-host':data={date,hosts:[{hostId:'unassigned',hostName:'Sans GPU',vramMb:0,tasks:timeline(date)}]};break;
   case '/api/cluster/schedule':data={entries:ownerEntries,count:ownerEntries.length};break;
   case '/api/cluster/schedule/live':data={hosts:[],evidence:{authority:'agentx.cluster-schedule-live-detail',scope:'loaded-model-and-vram-detail',observedAt:now,headlineAuthority:false}};break;
   case '/api/nerve-center/ecosystem':data={schemaVersion:2,authority:'agentx-product',readOnly:true,generatedAt:now,health:{configuredHosts:0,onlineHosts:0,offlineHosts:0,observedModels:0,status:'ok'}};break;
   case '/api/cluster/schedule/next':data={tasks:[]};break;
   case '/api/cluster/schedule/work-queue':data={authority:'core.heavy-work-queue',jobs:heavyJobs,archivedCount:0};break;
   case '/api/cluster/schedule/conflicts':data={conflicts:[]};break;
   case '/api/cluster/schedule/claims':data={claims:[]};break;
   case '/api/cluster/schedule/heatmap':data={hosts:[],days:[],cells:[],timeZone:'America/Toronto'};break;
   case '/api/cluster/schedule/actual-vs-planned':data={date,hosts:[],unassigned:[]};break;
  }
  response.json({status:'success',data});
 });
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;app.locals.publicUrls={core:base,benchmark:base+'/benchmark',rag:base+'/rag'};
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'America/Toronto'});
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 await page.goto(base+'/cluster-schedule');assert.equal(new URL(page.url()).searchParams.get('view'),'calendar');
 await page.waitForSelector('.cs-label-name');assert.equal(await page.locator('.cs-label-name').count(),3);
 assert.equal(await page.locator('#automationCalendar').count(),0);assert.equal(await page.locator('a[href="/automations?view=resources"]').count(),0);
 assert.equal(await page.locator('#scheduleMeasurements').evaluate(element=>element.open),false);
 assert.equal(await page.locator('#scheduleMeasurements #liveBar').count(),1);
 await page.locator('[data-queue-id="pending-request"]').waitFor();assert.equal(await page.locator('[data-queue-id="old-receipt"]').count(),0);
 await page.locator('[data-queue-action="finished"]').click();assert.equal(await page.locator('[data-queue-id="old-receipt"]').count(),1);
 await page.locator('[data-queue-action="active"]').click();assert.equal(await page.locator('[data-queue-id="pending-request"]').count(),1);
 assert((await page.locator('[data-queue-id="lane-auto"]').innerText()).includes('Starts automatically at its time'));
 assert.equal(await page.locator('[data-queue-id="lane-auto"] [data-queue-action="run"]').count(),0);
 assert.equal(await page.locator('[data-queue-id="lane-open"] [data-queue-action="run"]').count(),1);
 await page.locator('[data-queue-id="lane-open"] [data-queue-action="reserve"]').click();
 assert(await page.locator('#heavyQueueReservation [data-queue-auto]').isVisible());
 await page.screenshot({path:report+'/calendar-slot-dialog.png'});
 await page.locator('#heavyQueueReservation button[value="cancel"]').click();
 await page.locator('[data-queue-id="pending-request"] [data-queue-action="reserve"]').click();
 assert.equal(await page.locator('#heavyQueueReservation [data-queue-auto]').isVisible(),false);
 await page.locator('#heavyQueueReservation button[value="cancel"]').click();
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:report+'/calendar-desktop.png',fullPage:true});
 await page.locator('#scheduleOwner').selectOption('openclaw');await page.waitForFunction(()=>document.querySelectorAll('.cs-label-name').length===1);
 assert((await page.locator('#heatmapContainer').innerText()).includes('Native report'));
 await page.locator('#scheduleOwner').selectOption('all');await page.locator('#scheduleSearch').fill('Archive');
 await page.waitForFunction(()=>document.querySelectorAll('.cs-label-name').length===1);assert((await page.locator('#heatmapContainer').innerText()).includes('Archive copy'));
 await page.locator('#scheduleSearch').fill('');await page.waitForFunction(()=>document.querySelectorAll('.cs-label-name').length===3);
 await page.locator('#viewHost').click();await page.waitForFunction(()=>document.querySelector('#viewHost').getAttribute('aria-pressed')==='true');
 await page.locator('#viewTask').click();await page.waitForSelector('.cs-label-name');
 const label=await page.locator('#dateLabel').innerText();await page.locator('#nextDateBtn').click();assert.notEqual(await page.locator('#dateLabel').innerText(),label);await page.locator('#todayBtn').click();
 await page.locator('#scheduleMeasurements summary').click();assert.equal(await page.locator('#scheduleMeasurements').evaluate(element=>element.open),true);await page.locator('#btnAvp').click();await page.locator('#btnHeatmap').click();
 await page.locator('#scheduleMeasurements summary').click();await page.setViewportSize({width:390,height:844});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:report+'/calendar-mobile.png',fullPage:true});
 await page.goto(base+'/automations?view=resources');assert.equal(new URL(page.url()).searchParams.get('view'),'calendar');
 assert.deepEqual(errors,[]);fs.writeFileSync(report+'/calendar-journey.json',JSON.stringify({passed:true,checks:['one existing calendar','legacy URLs redirect','task and host views','owner and text filters','date navigation','measured views preserved','queue preserved','Profiler auto-start and Run now','desktop/mobile'],errors},null,2));
 console.log('PASS: one Cluster Schedule calendar, controls, filters, aliases and desktop/mobile.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));});
