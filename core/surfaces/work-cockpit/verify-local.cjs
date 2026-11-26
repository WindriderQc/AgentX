'use strict';

// Standalone acceptance with disposable TLS, synthetic identities and local data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const {createHash, X509Certificate} = require('node:crypto');
const express = require('express');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {registerWorkCockpit, mountPath} = require('./routes');

async function run() {
  const cert = fs.readFileSync(process.env.TEST_TLS_CERT);
  const key = fs.readFileSync(process.env.TEST_TLS_KEY);
  const spki = new X509Certificate(cert).publicKey.export({type:'spki',format:'der'});
  const pin = createHash('sha256').update(spki).digest('base64');
  const app = express();
  app.use(require('cookie-parser')());
  let owner = false, unlocked = false, reads = 0;
  require('../household/family-device').register({app, standardJsonParser:express.json(),
    mongoose:{models:{AgentXHouseholdFamilyDevice:{findOneAndUpdate:()=>({lean:async()=>({label:'Synthetic device'})})}}},
    ownerUnlock:{activeUntil:async()=>unlocked ? new Date(Date.now()+10000) : null},
    envelope:(res,data)=>res.json({data}), fail:(res,code)=>res.sendStatus(code)});
  const scope = {pipelineId:'0007',service:'engineering',label:'Dossier fictif',intent:'Contrôle synthétique.'};
  const now = new Date().toISOString();
  const options = {express, scope, verifyOwner:async()=>owner,
    readDossier:async input=>{
      reads++;
      assert.equal(input.pipelineId,scope.pipelineId);
      return {task:{pipelineId:scope.pipelineId,service:scope.service,status:'queued',nextAction:{
        reference:'/pipeline?task=0007',observedAt:now,code:'intake_review'},intakeView:{state:'proposed'},
        workView:{entryCount:0},automationAttemptCount:0,timeline:[],updatedAt:now,title:'synthetic-excluded-field'}};
    },
    readTeam:async()=>{
      reads++;
      return {readOnly:true,generatedAt:now,agents:[{registryId:'fixture',runtime:'test',confidence:'configured',
        persona:{label:'Persona de test',description:'synthetic-excluded-field'}}]};
    }};
  app.use(mountPath,registerWorkCockpit(options));
  app.use('/missing-verifier',registerWorkCockpit({...options,verifyOwner:undefined}));
  const server = https.createServer({cert,key},app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = 'https://127.0.0.1:'+server.address().port;
  function get(path,family=false) {
    return new Promise((resolve,reject)=>{
      https.get(origin+path,{ca:cert,headers:family ? {Cookie:'agentx_family_device=fixture-only'} : {}},res=>{
        let body=''; res.setEncoding('utf8'); res.on('data',chunk=>body+=chunk);
        res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));
      }).on('error',reject);
    });
  }
  let browser;
  try {
    const paths=['/','/data','/cockpit.css','/cards.js','/cockpit.js'];
    for (const path of paths) assert.equal((await get(mountPath+path)).status,403);
    owner=true;
    for(const path of ['/','/data']) {
      assert.equal((await get('/missing-verifier'+path)).status,403);
      const family=await get(mountPath+path,true);
      assert.equal(family.status,302); assert.equal(family.headers.location,'/panel');
    }
    unlocked=true;
    for(const path of ['/','/data']) assert.equal((await get(mountPath+path,true)).status,403);
    assert.equal(reads,0);
    const result=await get(mountPath+'/data');
    assert.equal(result.status,200); assert.equal(reads,2);
    assert.match(result.headers['cache-control'],/private, no-store/);
    assert.doesNotMatch(result.body,/synthetic-excluded-field/);
    assert.equal(JSON.parse(result.body).pipeline.record.pipelineId,'0007');
    assert.deepEqual(Object.keys(JSON.parse(result.body).registry.agents[0]).sort(),['id','observation','persona','runtime']);
    browser=await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH || undefined,
      args:['--ignore-certificate-errors-spki-list='+pin]});
    for (const width of [1280,390]) {
      const page=await browser.newPage({viewport:{width,height:width===390 ? 844 : 980}});
      const external=[], errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*', route=>{
        const req=route.request();
        if(new URL(req.url()).origin!==origin || req.method()!=='GET') {external.push(req.method());return route.abort();}
        return route.continue();
      });
      assert.equal((await page.goto(origin+mountPath+'/')).status(),200);
      const rows=page.locator('#rows .row');
      await rows.first().waitFor(); assert.equal(await rows.count(),3);
      await page.locator('#pipeline-0007').click();
      assert.equal(await page.locator('#detail a').getAttribute('href'),'/pipeline?task=0007');
      await page.getByRole('button',{name:'Retour à la liste'}).click();
      await page.locator('#sample').selectOption('demo');
      assert.equal(await rows.count(),30);
      const row=rows.nth(27);
      await row.evaluate(el=>el.scrollIntoView({block:'center'}));
      const before=await row.evaluate(el=>el.getBoundingClientRect().top);
      await row.click(); await page.getByRole('button',{name:'Retour à la liste'}).click();
      assert.equal(await row.evaluate(el=>el===document.activeElement),true);
      assert.ok(Math.abs(before-await row.evaluate(el=>el.getBoundingClientRect().top))<=1);
      await page.locator('#search').fill('accessibilite');
      if(width===390) await page.locator('#facets summary').click();
      await page.locator('#domain').selectOption('Finance');
      assert.equal(await rows.count(),1);
      await page.locator('#executor').selectOption('Dot');
      assert.equal(await rows.count(),0);
      assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
      await page.close(); console.log(width+'px HTTPS loopback: list, detail, filtered search, scroll and return OK');
    }
    console.log('Owner fixture 200; anonymous and missing verifier 403; Family redirect to /panel; unlocked pinned device 403; denied requests made zero source reads.');
  } finally {
    if(browser) await browser.close();
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
