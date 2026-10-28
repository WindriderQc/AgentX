'use strict';

// Shipped conversation, avatar layout and image cards; synthetic images/voice only.
// No physical microphone/camera, model, photo library, or external HTTP request.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const core = path.resolve(__dirname, '../..'), publicDir = path.join(core, 'surfaces/household/public');
const { generatedPersonas, snapshot } = require('../../surfaces/household/persona-catalog');
const { createReplyChannels } = require('../../surfaces/household/reply-channels');
const personas = generatedPersonas().map(row => snapshot({ ...row, _id: 'fixture', version: 1 }));
const output = process.env.IMAGE_PRESENTATION_OUTPUT_DIR;
assert.ok(output, 'Keep browser evidence outside Git: set IMAGE_PRESENTATION_OUTPUT_DIR');
fs.mkdirSync(output, { recursive: true });
const sessions = new Map(), submissions = [], errors = [], measurements = [];
let browser, server, heard = '';
const fakeAudio = `window.NestorConversation.openAudio = async () => {
  const audio = { canInterrupt:false, listen(callback){audio.utterance=callback;window.speechReady=true;}, quiet(){window.speechReady=false;}, close(){window.speechReady=false;},
    holdPlayback(){}, resumePlayback(){}, async play(){}, async settle(){} };
  window.say=()=>audio.utterance(new Blob(['synthetic speech']),{});return audio;
};`;
const face = `customElements.define('llmx-face', class extends HTMLElement {
  connectedCallback(){this.style.cssText='display:block;background:#183646';setTimeout(()=>this.dispatchEvent(new Event('llmx-face-ready')),0);}
  set presence(value) { this.latestPresence=value; }
});`;
const svg = portrait => `<svg xmlns="http://www.w3.org/2000/svg" width="${portrait ? 480 : 960}" height="${portrait ? 900 : 540}" viewBox="0 0 ${portrait ? 480 : 960} ${portrait ? 900 : 540}"><rect width="100%" height="100%" fill="#145e76"/><rect x="8" y="8" width="96%" height="96%" fill="none" stroke="#f8dc89" stroke-width="8"/><text x="30" y="80" font-size="32" fill="white">Synthetic ${portrait ? 'portrait' : 'landscape'}</text></svg>`;

(async () => {
  const app = express();
  app.post('/api/voix/transcribe', (_req,res)=>res.json({data:{text:heard}}));
  app.use(express.json());
  app.use('/assets/household',express.static(publicDir));
  app.use('/js',express.static(path.join(core,'public/js')));
  app.use('/css',express.static(path.join(core,'public/css')));
  app.use('/psyx/assets',express.static(path.join(core,'surfaces/psyx/public')));
  app.get('/api/voix/player.js',(_req,res)=>res.type('js').send(''));
  app.get('/api/household/avatar/llmx-face.js',(_req,res)=>res.type('js').send(face));
  app.get('/fixture',(req,res)=>{
    const space=req.query.space==='personal'?'personal':'family';
    let html=fs.readFileSync(path.join(publicDir,'index.html'),'utf8')
      .replace('<!-- product-navigation -->','<span id="runtimePill"></span>')
      .replace(/  <script src="\/assets\/household\/app.js[^\n]+/,'');
    if (process.env.IMAGE_PRESENTATION_BASELINE === '1') html=html.replace('</head>',`<style>
      .conversation-visual .display-block[data-kind=image]{grid-column:auto}
      :is(.conversation-visual,.page-presentation) .display-block[data-kind=image] .display-block-figure img{max-height:60vh}
      body[data-avatar-view=montre] .display-block-figure img{max-height:72dvh}
      </style></head>`);
    html=html.replace('</body>',`<script>document.addEventListener('DOMContentLoaded',async()=>{
      ${fakeAudio}
      const api=async(url,options={})=>{const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});const body=await response.json();if(!response.ok)throw Error(body.message||'fixture request failed');return body.data;};
      try{await mountConversation({app:document.getElementById('app'),api,esc:value=>String(value??''),space:${JSON.stringify(space)},autoStart:false});window.fixtureReady=true;}
      catch(error){window.fixtureError=error.stack;}
    });</script></body>`);
    res.type('html').send(html);
  });
  app.get('/api/voice-personas/catalog',(_req,res)=>res.json({data:{personas,runtime:{defaultBackend:'agentx',openclawConfigured:false,hermesConfigured:false}}}));
  app.get('/api/photos/frame/status',(_req,res)=>res.json({data:{enabled:false}}));
  app.post('/api/voice-personas/:scope/sessions',(req,res)=>{
    const session={...req.body,sessionId:randomUUID(),status:'active',turnCount:0};sessions.set(session.sessionId,session);res.status(201).json({data:{session}});
  });
  app.post('/api/voice-personas/:scope/sessions/:id/turns/text',(req,res)=>{
    submissions.push({scope:req.params.scope,text:req.body.text});const session=sessions.get(req.params.id);session.turnCount++;
    const query=req.body.text.includes('portrait')?'portrait':'landscape';
    const search=req.body.text.includes('search');const channels=createReplyChannels();
    channels.push(search?'A source. <show kind="link">https://source.example.test/article</show>':`Here is the picture. <show kind="image" source="web">${query}</show>`);
    const value=channels.end();
    res.type('application/x-ndjson');
    for(const block of value.display){
      if(block.kind==='image')Object.assign(block,{status:'found',image:{url:`https://images.example.test/${query}.svg`,sourceLabel:'Synthetic source',origin:'https://source.example.test/article'}});
      res.write(JSON.stringify({type:'show',block})+'\n');
    }
    res.end(JSON.stringify({type:'done',data:{session,traceId:randomUUID(),reply:{text:value.say},routing:{backend:'agentx'}}})+'\n');
  });
  app.use('/api',(req,res)=>res.json({data:req.path.endsWith('/recap/latest')?null:{destinations:[],sessions:[],works:[],notes:[],active:'primary',review:null}}));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.AGENTX_BROWSER_EXECUTABLE&&{executablePath:process.env.AGENTX_BROWSER_EXECUTABLE})});
  for(const viewport of [{width:1920,height:1080},{width:390,height:844}]){
    for(const space of ['family','personal']){
      const context=await browser.newContext({viewport});
      await context.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.hostname==='images.example.test')return route.fulfill({contentType:'image/svg+xml',body:svg(url.pathname.includes('portrait'))});
        return url.origin===origin?route.continue():route.abort();
      });
      const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin+'/fixture?space='+space);await page.waitForFunction(()=>window.fixtureReady||window.fixtureError);
      assert.equal(await page.evaluate(()=>window.fixtureError),undefined);
      await page.waitForFunction(()=>AvatarDock.current?.mode==='scene');
      if(space==='family'){
        await page.locator('.avatar-dock-stage').click();await page.waitForFunction(()=>window.speechReady);
      }else await page.evaluate(()=>AvatarDock.current.setMode('cache'));
      const ask=async text=>{
        const before=submissions.length;
        const messageCount=await page.locator('.conversation-message').count();
        const reply=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/turns/text'));
        if(space==='family'){heard='Hey Nestor, '+text;await page.evaluate(()=>window.say());}
        else {await page.locator('#conversationMessage').fill(text);await page.locator('#conversationText').getByRole('button',{name:'Send',exact:true}).click();}
        await (await reply).finished();
        await page.waitForFunction(n=>document.querySelectorAll('.conversation-message').length>=n,messageCount+2);
        if(space==='family')await page.waitForFunction(()=>window.speechReady);
        assert.equal(submissions.length,before+1);
      };
      await ask('search');assert.equal(await page.locator('.display-block-figure img').count(),0,'A plain search does not turn its links into an image presentation');
      for(const shape of ['landscape','portrait']){
        await ask('montre '+shape);
        const img=page.locator('.display-block[data-kind=image] .display-block-figure img').first();
        await img.waitFor();await img.evaluate(el=>el.decode());
        const card=page.locator('.display-block[data-kind=image]').first();const area=space==='family'?page.locator('#conversationVisual'):page.locator('.page-presentation');
        const imageBox=await img.boundingBox(),cardBox=await card.boundingBox(),areaBox=await area.boundingBox();
        assert.ok(cardBox.width>=areaBox.width*.9,`Shown image must span the presentation width (${space}, ${viewport.width}): ${cardBox.width}/${areaBox.width}`);
        const largestFittingHeight=Math.min(imageBox.width*(shape==='portrait'?900/480:540/960),Math.max(160,viewport.height-(viewport.width<700?260:210)));
        assert.ok(imageBox.height>=largestFittingHeight*.95,`Shown image must use the largest area that preserves its ratio: ${imageBox.height}/${largestFittingHeight}`);
        assert.equal(await img.evaluate(el=>getComputedStyle(el).objectFit),'contain');
        assert.ok(imageBox.width<=viewport.width&&imageBox.x>=0,'Image stays within viewport horizontally');
        assert.equal(await img.evaluate(el=>el.naturalWidth),shape==='portrait'?480:960);
        measurements.push({space,viewport,shape,imageBox,cardWidth:cardBox.width,areaWidth:areaBox.width});
        await page.screenshot({path:path.join(output,`${space}-${viewport.width}-${shape}.png`)});
      }
      const count=submissions.length;
      if(space==='family'){
        const back=page.getByRole('button',{name:'Show the conversation, keyboard and settings',exact:true});await back.click();
        await page.waitForFunction(()=>document.body.dataset.avatarView==='menu');
      }else await page.locator('.page-presentation [data-action=toggle]').click();
      assert.equal(await page.locator('#conversationSettingsToggle').isVisible(),true);
      await page.locator('#conversationSettingsToggle').click();assert.equal(await page.locator('#conversationWorkshop').isVisible(),true,'Microphone diagnostics remain reachable');
      assert.equal(submissions.length,count,'Returning to conversation does not send another turn');
      await context.close();
    }
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,measurements,liveModelCalls:0,media:'synthetic only',errors},null,2));
  console.log(JSON.stringify({passed:true,cases:measurements.length,liveModelCalls:0,errors}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve)||resolve());});
