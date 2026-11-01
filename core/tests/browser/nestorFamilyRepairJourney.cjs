'use strict';
// Production Household page -> real turn handler/executor -> canonical in-memory fixture.
// Only speech transport, playback, model and persistence boundaries are synthetic.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{spawn}=require('node:child_process');
const express=require('express');
const core=path.resolve(__dirname,'../..'),publicDir=path.join(core,'surfaces/household/public');
const {harness}=require('../../surfaces/household/test/fixtures/persona-journey.cjs');
const {generatedPersonas,snapshot}=require('../../surfaces/household/persona-catalog');
const {publicSession}=require('../../surfaces/household/persona-records');
const {createSoundLibrary}=require('../../surfaces/household/sound-library');
const {normalizeVoiceTimings}=require('../../src/services/voice/timeline');
const mode=process.env.FAMILY_REPAIR_BROWSER||'chromium',output=process.env.FAMILY_REPAIR_BROWSER_OUTPUT;
if(!output||path.resolve(output).startsWith(path.resolve(core,'..')+path.sep))throw Error('Output must be outside checkout');
fs.mkdirSync(output,{recursive:true});
const personas=generatedPersonas().map(row=>snapshot({...row,_id:'synthetic-fixture',version:1})),sessions=new Map(),queue=[],errors=[],synthesis=[];
let server,browser,audioOpens=0,checkpoint=null,deliver;
const completed=new Promise(resolve=>{deliver=resolve;});

async function journey(){
 const check=(value,message)=>{if(!value)throw Error(message);};
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const state=()=>document.getElementById('conversationPresence').dataset.state;
 const wait=async predicate=>{const end=performance.now()+10000;while(!predicate()){if(performance.now()>end)throw Error('State timeout: '+state());await sleep(20);}};
 const read=async()=>{const r=await fetch('/fixture/state');return r.json();};
 const listening=()=>wait(()=>state()==='listening');
 const settled=async predicate=>{const end=performance.now()+10000;for(;;){const value=await read();if(predicate(value))return value;if(performance.now()>end)throw Error('Receipt timeout');await sleep(20);}};
 const latest=value=>value.sessions.at(-1),last=value=>latest(value).turns.at(-1);
 if(sessionStorage.getItem('familyFixtureStage')==='muted-reload'){
   check(state()==='paused','explicit mute must survive reload');const value=await read();
   check(value.audioOpens===value.checkpoint.audioOpens,'reload must not reopen the fake microphone after Pause');
   return {ok:true,...value.checkpoint,mutedReload:true,finalState:state(),realDevicePermissions:0,liveModelCalls:0};
 }
 await listening();window.playEvents=[];
 await say('Hey Nestor, fais le bruit du T-Rex.');await listening();
 let value=await settled(v=>last(v)?.voiceTimings?.clipOutcome==='completed');
 check(last(value).soundId==='trex','clip selected');check(last(value).replyText==='Écoute ce bruitage !','deterministic short intro');check(latest(value).modelCalls===0,'no model for sound-only');
 check(window.playEvents.map(v=>v.kind).join(',')==='speech,clip','intro before clip');
 window.playEvents=[];await say('Fais le bruit du T-Rex puis explique les saisons.');await listening();
 value=await settled(v=>latest(v).turns.length===2&&last(v)?.voiceTimings?.clipOutcome==='completed');
 check(window.playEvents.map(v=>v.kind).join(',')==='speech,clip,speech','compound request keeps intro, clip, then answer');check(latest(value).modelCalls===1,'remaining question runs once');
 await say('Explique les saisons.');await listening();value=await read();const beforeRepair=latest(value).turns.length;
 const pending=say('Non, non, je voulais');await wait(()=>document.getElementById('conversationStatus').textContent.includes('correction'));
 beginSpeech();await say('un exemple');beginSpeech();await say('avec un arbre');const repairAt=performance.now();
 await pending;await listening();value=await settled(v=>latest(v).turns.length===beforeRepair+1&&last(v)?.voiceTimings?.playbackOutcome==='completed');
 const repairLatencyMs=Math.round(performance.now()-repairAt);
 check(last(value).inputText==='Non, non, je voulais un exemple avec un arbre','fragments merged once');check(last(value).voiceTimings.repairFragments===3,'fragment receipt');
 check(repairLatencyMs>=600&&repairLatencyMs<2500,'bounded repair quiet delay');
 for(const text of ['Oui','Non']){await say(text);await listening();value=await settled(v=>last(v)?.inputText===text&&last(v)?.voiceTimings?.playbackOutcome==='completed');check(last(value).voiceTimings.requestSent-last(value).voiceTimings.sttDone<300,'yes/no has no repair timer');}
 const cancelled=say('Non, non, plutôt');await wait(()=>document.getElementById('conversationStatus').textContent.includes('correction'));await say('Stop');await cancelled;
 value=await read();const beforeStopNext=latest(value).turns.length;await say('Fais le bruit du T-Rex.');await listening();value=await settled(v=>latest(v).turns.length===beforeStopNext+1&&last(v)?.voiceTimings?.clipOutcome==='completed');
 check(!last(value).inputText.includes('plutôt'),'Stop drops queued correction');
 // Echo must resume the old reply, without another canonical/model turn.
 window.holdNext='speech';const echoTurn=say('Explique une étoile.');await wait(()=>window.held?.kind==='speech');value=await read();const beforeEcho=latest(value).turns.length;
 beginSpeech();await say('La réponse synthétique répond à la question sans autre action.');
 value=await read();check(latest(value).turns.length===beforeEcho,'echo creates no turn');releasePlayback();await echoTurn;await listening();
 // Confirmed Stop before and during a clip is a terminal interruption, not a failure.
 for(const phase of ['speech','clip']){
   window.holdNext=phase;const utterance=say('Fais le bruit du T-Rex.');await wait(()=>window.held?.kind===phase);beginSpeech();await say('Stop');await utterance;await listening();
   value=await settled(v=>last(v)?.voiceTimings?.playbackOutcome==='interrupted');check(last(value).voiceTimings.stopReason==='spoken_stop','spoken Stop reason');
   if(phase==='speech')check(last(value).voiceTimings.clipStarted===undefined,'interrupted intro does not start clip');else check(last(value).voiceTimings.clipEnded>=last(value).voiceTimings.clipStarted,'interrupted clip has end');
 }
 const old=latest(value).id;const abandoned=say('Non, non, je voulais');await wait(()=>document.getElementById('conversationStatus').textContent.includes('correction'));
 document.getElementById('conversationNew').click();await abandoned;document.getElementById('conversationStart').click();await listening();
 await say('Hey Nestor, explique la pluie.');await listening();value=await settled(v=>v.sessions.length===2&&last(v)?.voiceTimings?.playbackOutcome==='completed');
 check(latest(value).id!==old,'new session identity');check(latest(value).turns.length===1,'old fragments do not cross sessions');
 check(!latest(value).lastModelRequest.includes('T-Rex')&&!latest(value).lastModelRequest.includes('avec un arbre'),'old subject does not cross sessions');
 window.failNextPlayback=true;await say('Une autre question.');await wait(()=>state()==='error');value=await settled(v=>last(v)?.voiceTimings?.playbackOutcome==='playback_error');
 check(last(value).voiceTimings.stopReason==='playback_error','real output failure remains explicit');document.getElementById('conversationStart').click();await listening();
 window.holdNext='clip';const paused=say('Hey Nestor, fais le bruit du T-Rex.');await wait(()=>window.held?.kind==='clip');document.getElementById('conversationStart').click();await paused;
 check(state()==='paused','Pause closes the fake audio');value=await settled(v=>last(v)?.voiceTimings?.playbackOutcome==='user_paused');check(last(value).voiceTimings.stopReason==='user_pause','Pause is not a playback fault');
 const summary={repairLatencyMs,audioOpens:value.audioOpens,sessionCount:value.sessions.length,canonicalTurns:value.sessions.reduce((n,s)=>n+s.turns.length,0),modelBoundaryCalls:value.sessions.reduce((n,s)=>n+s.modelCalls,0),cases:['sound-only','compound','fragments','yes-no','Stop-next','echo','interrupt-before-clip','interrupt-during-clip','new-session','playback-error','Pause-clip']};
 await fetch('/fixture/checkpoint',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(summary)});sessionStorage.setItem('familyFixtureStage','muted-reload');location.reload();return null;
}

const fakeAudio=String.raw`Object.defineProperty(navigator,'permissions',{configurable:true,value:{query:async()=>({state:'granted'})}});Object.defineProperty(navigator,'wakeLock',{configurable:true,value:undefined});
window.NestorConversation.openAudio=async()=>{
 await fetch('/fixture/audio-opened',{method:'POST'});
 const audio={canInterrupt:true,listen(callback,onSpeech){audio.utterance=callback;audio.speech=onSpeech;},quiet(){},close(){},holdPlayback(){},resumePlayback(){},async settle(){},
 async play(bytes,signal,_flag,_gain,callbacks={}){
  const kind=bytes instanceof ArrayBuffer?'clip':'speech';if(bytes?.body)await bytes.body.cancel();
  window.playEvents.push({kind});callbacks.onFirstBytes?.();callbacks.onScheduled?.();callbacks.onSignalScheduled?.({aheadMs:0,outputLatencyMs:0,queueMs:0});
  if(window.failNextPlayback){window.failNextPlayback=false;throw Object.assign(Error('Synthetic output failure'),{playbackStarted:true});}
  if(window.holdNext===kind){window.holdNext=null;return new Promise((resolve,reject)=>{window.held={kind,resolve};signal.addEventListener('abort',()=>{window.held=null;reject(Object.assign(Error('Synthetic cancellation'),{name:'AbortError'}));},{once:true});});}
 }};
 window.playEvents=[];window.beginSpeech=()=>audio.speech?.();window.releasePlayback=()=>{const held=window.held;window.held=null;held?.resolve();};
 window.say=async text=>{window.lastSyntheticText=text;await fetch('/fixture/recognition',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});audio.speech?.();return audio.utterance(new Blob(['synthetic PCM']),{audioMs:800,silenceMs:1000});};return audio;
};`;

(async()=>{
 const app=express();
 app.post('/api/voix/transcribe',(_req,res)=>{const text=queue.shift();if(text===undefined)return res.status(500).json({message:'Synthetic recognition queue empty'});res.json({data:{text,recognitionId:randomUUID(),sttMs:1}});});
 app.use(express.json());
 app.post('/fixture/recognition',(req,res)=>{queue.push(req.body.text);res.sendStatus(204);});
 app.post('/fixture/audio-opened',(_req,res)=>{audioOpens++;res.sendStatus(204);});
 app.post('/fixture/checkpoint',(req,res)=>{checkpoint=req.body;res.sendStatus(204);});
 app.post('/fixture/result',(req,res)=>{res.sendStatus(204);deliver(req.body);});
 app.get('/fixture/state',(_req,res)=>res.json({audioOpens,checkpoint,sessions:[...sessions.values()].map(h=>({id:h.session.sessionId,turns:h.turns.slice().reverse().map(row=>({inputText:row.inputText,replyText:row.replyText,soundId:row.soundId,voiceTimings:row.voiceTimings})),modelCalls:h.sent.length,lastModelRequest:h.sent.at(-1)?.request||''}))}));
 app.use('/assets/household',express.static(publicDir));app.use('/js',express.static(path.join(core,'public/js')));app.use('/css',express.static(path.join(core,'public/css')));app.use('/psyx/assets',express.static(path.join(core,'surfaces/psyx/public')));
 app.get('/api/voix/player.js',(_req,res)=>res.type('js').send(''));
 app.post('/api/voix/synthesize/stream',(req,res)=>{synthesis.push(req.body.text);res.type('audio/wav').set({'X-Voix-Voice':'synthetic','X-Voix-Upstream':'primary'}).send(Buffer.from([0,1,2]));});
 app.post('/api/voix/warm',(_req,res)=>res.sendStatus(204));app.get('/api/voix/health',(_req,res)=>res.json({data:{status:'ok'}}));
 app.get('/api/voice-personas/catalog',(_req,res)=>res.json({data:{personas,runtime:{defaultBackend:'agentx'}}}));
 app.use('/api/voice-personas/private',(_req,res)=>{errors.push('Family requested private route');res.sendStatus(403);});
 app.post('/api/voice-personas/family/sessions',(req,res)=>{
   const h=harness({packId:'kidx_nestor',backend:'agentx',sounds:createSoundLibrary(),validClientTurnId:id=>/^[a-f0-9-]{36}$/i.test(id),response:'La réponse synthétique répond à la question sans autre action.'});
   h.session.sessionId=randomUUID();h.session.voice={language:'fr'};h.session.persona=personas.find(p=>p.id===req.body.personaId)||personas[0];sessions.set(h.session.sessionId,h);res.status(201).json({data:{session:publicSession(h.session)}});
 });
 app.post('/api/voice-personas/family/sessions/:sessionId/turns/text',async(req,res)=>{
  const h=sessions.get(req.params.sessionId);if(!h)return res.sendStatus(404);
  await h.handle(req,res,'child',{packId:'kidx_nestor',scopeId:'family',modeId:'family',browser:true});
  if(!res.headersSent){if(res.failure)res.status(res.failure.status).json(res.failure);else res.json({data:res.payload});}
 });
 app.post('/api/voice-personas/family/sessions/:sessionId/voice-timings',(req,res)=>{
  const h=sessions.get(req.params.sessionId),row=h?.turns.find(t=>t.clientTurnId===req.body.turnId),timings=normalizeVoiceTimings(req.body.timings);
  if(!row||!timings)return res.status(404).json({message:'Synthetic timing identity missing'});row.voiceTimings=timings;res.json({data:{turnId:req.body.turnId,voiceTimings:timings}});
 });
 app.post('/api/voice-personas/family/sessions/:sessionId/interrupt',(req,res)=>{const row=sessions.get(req.params.sessionId)?.turns.find(t=>t.clientTurnId===req.body.turnId);if(row)row.interrupted=true;res.json({data:{interrupted:true,turnId:req.body.turnId}});});
 app.get('/fixture',(_req,res)=>{
  const html=fs.readFileSync(path.join(publicDir,'index.html'),'utf8').replace('<!-- product-navigation -->','<span id="runtimePill"></span>').replace(/  <script src="\/assets\/household\/app.js[^\n]+/,'')
   .replace('</body>',`<script>document.addEventListener('DOMContentLoaded',async()=>{window.AvatarDock=undefined;${fakeAudio}
 const ActualConversation=NestorConversation.Conversation;NestorConversation.Conversation=class extends ActualConversation{constructor(...args){super(...args);window.fixtureConversation=this;}};
    const api=async(url,options={})=>{const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});const body=await response.json();if(!response.ok)throw Error(body.message||'Synthetic API failed');return body.data;};
    try{await mountConversation({app:document.getElementById('app'),api,esc:value=>String(value??''),space:'family',autoStart:true});const result=await (${journey.toString()})();if(result)await fetch('/fixture/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});}catch(error){await fetch('/fixture/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ok:false,error:error.stack,clientState:window.fixtureConversation?.state,repairs:!!window.fixtureConversation?.repairs,pendingRepair:!!window.fixtureConversation?.repairs?.pending,lastInput:window.lastSyntheticText})});}
   });</script></body>`);fs.writeFileSync(path.join(output,'fixture.html'),html);res.type('html').send(html);
 });
 app.get('/api/photos/frame/status',(_req,res)=>res.json({data:{enabled:false}}));
 app.use('/api',(_req,res)=>res.json({data:{destinations:[],sessions:[],works:[],notes:[],active:'primary',review:null}}));
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const origin='http://127.0.0.1:'+server.address().port;
 if(mode==='chromium'){
  const {chromium}=require(process.env.AGENTX_PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});const context=await browser.newContext();await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/fixture');
 }else if(mode==='firefox'){
  const profile=fs.mkdtempSync('/tmp/agentx-family-fixture-');assert.match(profile,/^\/tmp\/agentx-family-fixture-[A-Za-z0-9]+$/);
  fs.writeFileSync(path.join(profile,'user.js'),['user_pref("network.proxy.type",1);','user_pref("network.proxy.http","127.0.0.1");','user_pref("network.proxy.http_port",9);','user_pref("network.proxy.ssl","127.0.0.1");','user_pref("network.proxy.ssl_port",9);','user_pref("network.proxy.no_proxies_on","127.0.0.1,localhost");','user_pref("toolkit.telemetry.enabled",false);'].join('\n'));
  const child=spawn('/usr/bin/firefox',['--headless','--no-remote','--profile',profile,origin+'/fixture'],{detached:true,stdio:['ignore','ignore','pipe'],env:{...process.env,MOZ_HEADLESS:'1'}});child.stderr.on('data',data=>fs.appendFileSync(path.join(output,'firefox-stderr.log'),data));
  browser={close:async()=>{if(child.exitCode===null){process.kill(-child.pid,'SIGTERM');await new Promise(resolve=>child.once('close',resolve));}fs.rmSync(profile,{recursive:true,force:true});}};
 }else throw Error('Unknown fixture browser');
 let timer;const result=await Promise.race([completed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Family journey exceeded 90s')),90000);})]).finally(()=>clearTimeout(timer));
 result.browser=mode;result.errors=errors;fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));assert.equal(result.ok,true,result.error);assert.deepEqual(errors,[]);
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve());});
