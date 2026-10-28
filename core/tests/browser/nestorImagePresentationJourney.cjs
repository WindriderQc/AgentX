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
const sizes = { landscape:[960,540], portrait:[480,900], small:[96,64] };
const svg = shape => { const [w,h]=sizes[shape]; return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#145e76"/><rect x="${w*.02}" y="${h*.02}" width="${w*.96}" height="${h*.96}" fill="none" stroke="#f8dc89" stroke-width="${w*.008}"/><text x="${w*.03}" y="${h*.13}" font-size="${w*.035}" fill="white">Synthetic ${shape}</text></svg>`; };

(async () => {
  const app = express();
  app.post('/api/voix/transcribe', (_req,res)=>res.json({data:{text:heard}}));
  app.use(express.json());
  if(process.env.IMAGE_PRESENTATION_BASELINE_CSS)app.get('/assets/household/display-board.css',(_req,res)=>res.type('css').send(fs.readFileSync(process.env.IMAGE_PRESENTATION_BASELINE_CSS,'utf8')));
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
    const query=Object.keys(sizes).find(shape=>req.body.text.includes(shape))||'landscape';
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
  for(const viewport of [{width:1920,height:1080},{width:1280,height:720},{width:390,height:844},{width:844,height:390}]){
    for(const space of ['family','personal']){
      const context=await browser.newContext({viewport});
      await context.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.hostname==='images.example.test')return route.fulfill({contentType:'image/svg+xml',body:svg(path.basename(url.pathname,'.svg'))});
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
      for(const shape of Object.keys(sizes)){
        await ask('montre '+shape);
        const img=page.locator('.display-block[data-kind=image] .display-block-figure img').first();
        await img.waitFor();await img.evaluate(el=>el.decode());
        const card=page.locator('.display-block[data-kind=image]').first();const area=space==='family'?page.locator('#conversationVisual'):page.locator('.page-presentation');
        // Wait for the shipped avatar transition, then require that it leaves the image clear.
        await page.waitForFunction(()=>{
          const img=document.querySelector('.display-block[data-kind=image]:not([hidden]) img'),dock=document.querySelector('.avatar-dock');
          if(!img||!dock||dock.dataset.mode==='cache')return true;
          const a=img.getBoundingClientRect(),b=dock.getBoundingClientRect();return a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom;
        });
        await page.waitForFunction(()=>{
          const el=document.querySelector('.display-block[data-kind=image]:not([hidden]) img');
          if(!el)return false;const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+1;
        });
        const imageBox=await img.boundingBox(),cardBox=await card.boundingBox(),areaBox=await area.boundingBox();
        assert.ok(cardBox.width>=areaBox.width*.9,`Shown image must span the presentation width (${space}, ${viewport.width}): ${cardBox.width}/${areaBox.width}`);
        const availableWidth=await card.evaluate(el=>{const css=getComputedStyle(el);return el.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight);});
        assert.ok(imageBox.width>=availableWidth*.95,'The image itself must use the card width, not remain a thumbnail inside a large card');
        const [naturalWidth,naturalHeight]=sizes[shape],heightBudget=Math.max(160,viewport.height-300);
        const largestFittingHeight=Math.min(availableWidth*naturalHeight/naturalWidth,heightBudget);
        assert.ok(imageBox.height>=largestFittingHeight*.95,`Shown image must use the largest area that preserves its ratio: ${imageBox.height}/${largestFittingHeight}`);
        assert.ok(imageBox.height<=heightBudget+1,'Image leaves room for persistent controls');
        assert.equal(await img.evaluate(el=>getComputedStyle(el).objectFit),'contain');
        assert.ok(imageBox.width<=viewport.width&&imageBox.x>=0,'Image stays within viewport horizontally');
        assert.equal(await img.evaluate(el=>el.naturalWidth),naturalWidth);
        assert.equal(await img.evaluate(el=>el.naturalHeight),naturalHeight);
        const unobscured=await img.evaluate(el=>{
          const box=el.getBoundingClientRect(),scale=Math.min(box.width/el.naturalWidth,box.height/el.naturalHeight);
          const width=el.naturalWidth*scale,height=el.naturalHeight*scale;
          const r={left:box.x+(box.width-width)/2,top:box.y+(box.height-height)/2};r.right=r.left+width;r.bottom=r.top+height;
          return [...document.querySelectorAll('.avatar-camera,.avatar-scene-actions')].filter(c=>c.getClientRects().length).every(c=>{
            const b=c.getBoundingClientRect();return r.right<=b.left||r.left>=b.right||r.bottom<=b.top||r.top>=b.bottom;
          });
        });
        assert.ok(unobscured,`Persistent controls must not cover the painted picture (${space}, ${viewport.width}, ${shape})`);
        measurements.push({space,viewport,shape,imageBox,cardWidth:cardBox.width,areaWidth:areaBox.width});
        await page.screenshot({path:path.join(output,`${space}-${viewport.width}-${shape}.png`)});
      }
      const count=submissions.length,source=await page.locator('.display-block[data-kind=image] img').first().getAttribute('src');
      for(let cycle=0;cycle<3;cycle++){
        if(space==='family'){
          await page.getByRole('button',{name:'Show the conversation, keyboard and settings',exact:true}).click();
          await page.waitForFunction(()=>document.body.dataset.avatarView==='menu');
        }else await page.locator('.page-presentation [data-action=toggle]').click();
        assert.equal(await page.locator('#conversationSettingsToggle').isVisible(),true);
        await page.locator('#conversationSettingsToggle').click();assert.equal(await page.locator('#conversationWorkshop').isVisible(),true,'Microphone diagnostics remain reachable');
        assert.equal(await page.locator('#conversationStart').isVisible(),true,'Voice remains reachable');
        await page.locator('#conversationSettingsToggle').click();
        assert.equal(submissions.length,count,'Returning to conversation does not send another turn');
        // On a short landscape screen the existing camera panel overlaps the
        // avatar's center. Use its exposed corner; never force a covered click.
        if(space==='family')await page.locator('.avatar-dock-stage').click({position:{x:10,y:10}});
        else await page.locator('.page-presentation [data-action=toggle]').click();
        assert.equal(await page.locator('.display-block[data-kind=image] img').first().getAttribute('src'),source,'Reopening preserves the same image');
      }
      const pictures=await page.locator('.display-block[data-kind=image]').count();await ask('search');
      assert.equal(await page.locator('.display-block[data-kind=image]').count(),pictures,'An ordinary search does not add or reopen an image');
      if(space==='personal')assert.equal(await page.locator('.display-block[data-kind=image]:visible').count(),0);
      else assert.equal(await page.locator('.conversation-stage').getAttribute('data-shown'),'text');
      await context.close();
    }
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,measurements,liveModelCalls:0,media:'synthetic only',errors},null,2));
  console.log(JSON.stringify({passed:true,cases:measurements.length,liveModelCalls:0,errors}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve)||resolve());});
