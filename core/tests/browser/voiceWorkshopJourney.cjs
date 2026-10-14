const {chromium}=require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../..'),report=process.env.AGENTX_VOICE_BROWSER_REPORT || fs.mkdtempSync(path.join(require('node:os').tmpdir(),'agentx-voice-workshop-'));
fs.mkdirSync(report,{recursive:true});
const calls=[],errors=[],unknown=[];let ttsDelayMs=0;
const persona={id:'nestor',name:'Nestor',description:'Test personality',version:1,voice:{provider:'voxcpm',voices:{fr:'gazz',en:'gazz'},source:'instance'}};
const catalog={providers:[{id:'voxcpm',name:'Pocket TTS',available:true}],voices:[{id:'gazz',name:'Gazz',provider:'voxcpm',language:'fr',locale:'fr-CA',available:true},{id:'gazz',name:'Gazz',provider:'voxcpm',language:'en',locale:'en',available:true}]};
const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'};
function wav(){const rate=24000,pcm=Buffer.alloc(rate*4);for(let i=0;i<pcm.length/2;i++)pcm.writeInt16LE(Math.round(3000*Math.sin(i*2*Math.PI*220/rate)),i*2);const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(pcm.length+36,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(rate,24);h.writeUInt32LE(rate*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);}
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://test'),p=url.pathname;const json=v=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data:v}));};
if(p.startsWith('/api/')){
 const raw=Buffer.concat(await Array.fromAsync(req));calls.push({path:p,method:req.method,bytes:raw.length,contentType:req.headers['content-type'],body:raw.toString().slice(0,150)});
 if(p==='/api/voix/player.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(root+'/integrations/voix/app/web/voice-audio.js'));}
 if(p==='/api/voice-personas/catalog')return json({personas:[persona],runtime:{defaultBackend:'openclaw',openclawConfigured:true}});
 if(p==='/api/voice-personas/private/agents')return json({agents:[{id:'main',name:'Main',model:'test',personalNotes:true}]});
 if(p==='/api/voix/catalog'||p==='/api/psyx/voice/catalog')return json(catalog);
 if(p==='/api/voix/settings')return json({owner:'speech-service',editable:false,model:'test-whisper',device:'cpu-test',computeType:'fixture',vadThreshold:.85,queueTimeoutSeconds:120});
 if(p==='/api/psyx/bootstrap')return json({persona:{active:true},voice:{enabled:true},privacy:{accessMode:'lan'},modes:{},depths:{}});
 if(p==='/api/psyx/state')return json({revision:0,patterns:[],hypotheses:[],activeThreads:[],notes:[],openLoops:[],experiments:[]});
 if(p==='/api/psyx/sessions')return json([]);
 if(p==='/api/psyx/voice/status')return json({enabled:true,reachable:true,config:{whisperModel:'fixture',ttsProvider:'voxcpm'}});
 if(p==='/api/voix/upstream')return json({active:'primary'});
 if(p==='/api/household/avatar/llmx-face.js'){res.statusCode=503;return json({error:'Avatar not configured in this fixture'});}
 if(p.endsWith('/sessions/recap/latest'))return json({recap:null});
 if(p.includes('/sessions/recent'))return json({sessions:[]});
 if(p.includes('conversation-preferences'))return json({revision:0,preferences:{}});
 if(p.endsWith('/transcribe')){
  const mark=raw.indexOf('name="file"'),a=raw.indexOf('\r\n\r\n',mark)+4,boundary=(req.headers['content-type']||'').split('boundary=')[1],b=raw.indexOf('\r\n--'+boundary,a);const audio=mark>=0?raw.subarray(a,b):raw;
  calls.at(-1).audioSha256=crypto.createHash('sha256').update(audio).digest('hex');
  return json({text:'Raconte-moi une blague.',language:'fr',detectedLanguage:'fr',model:'test-whisper',recognitionId:crypto.randomUUID(),sttMs:23,recognition:{schema:1,queueMs:0,decodeMs:23}});
 }
 if(p.endsWith('/synthesize/stream')){if(ttsDelayMs)await new Promise(resolve=>setTimeout(resolve,ttsDelayMs));res.setHeader('Content-Type','audio/wav');res.setHeader('X-Voix-Provider','voxcpm');res.setHeader('X-Voix-Voice','gazz');res.setHeader('X-Voix-Language','fr');return res.end(wav());}
 unknown.push(p);return json({});
}
let file;if(p==='/psyx'){res.setHeader('Content-Type','text/html');return res.end(fs.readFileSync(root+'/core/surfaces/psyx/public/index.html','utf8').replace('<!-- product-navigation -->','<nav><a href="/voice-lab">Atelier vocal</a></nav>'));}
if(['/dad','/panel','/voice-lab','/voice-lab/devices','/lecture','/kids'].includes(p)){
 let html=fs.readFileSync(root+'/core/surfaces/household/public/index.html','utf8').replace('<!-- product-navigation -->',p.startsWith('/voice-lab') ? '<nav><a href="/voice-lab">Atelier vocal</a></nav>' : '<nav><a id="readingVoiceSettings" href="/voice-lab">Atelier vocal</a><span id="runtimePill"></span></nav>');res.setHeader('Content-Type','text/html');return res.end(html);
}
if(p==='/psyx/assets/voice-audio.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(root+'/integrations/voix/app/web/voice-audio.js'));}
if(p.startsWith('/assets/household/'))file=root+'/core/surfaces/household/public/'+p.slice('/assets/household/'.length);
else if(p.startsWith('/psyx/assets/'))file=root+'/core/surfaces/psyx/public/'+p.slice('/psyx/assets/'.length);
else file=root+'/core/public'+p;
if(fs.existsSync(file)&&fs.statSync(file).isFile()){res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');return res.end(fs.readFileSync(file));}
res.statusCode=404;res.end('missing');
}catch(e){res.statusCode=500;res.end(e.message);}});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port,browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
try{const context=await browser.newContext();await context.addInitScript(()=>{window.captureCalls=0;if(!localStorage.getItem('agentx.voice.capture.v1.personal'))localStorage.setItem('agentx.voice.capture.v1.personal',JSON.stringify({inputDeviceId:'saved-mic'}));if(!localStorage.getItem('household.conversation.preferences.v2'))localStorage.setItem('household.conversation.preferences.v2',JSON.stringify({personaId:'nestor',profiles:{nestor:{language:'fr',selections:{fr:'voxcpm|gazz'}}}}));navigator.permissions.query=async()=>({state:'prompt'});navigator.mediaDevices.getUserMedia=async constraints=>{window.lastAudioConstraints=constraints;window.captureCalls++;const c=new AudioContext(),dest=c.createMediaStreamDestination(),osc=c.createOscillator(),gain=c.createGain();osc.connect(gain);gain.connect(dest);gain.gain.value=.035;osc.start();await c.resume();setTimeout(()=>gain.gain.value=0,1100);for(const track of dest.stream.getTracks())track.addEventListener('ended',()=>c.close());return dest.stream;};});
await context.addInitScript(() => {
  window.playbackEvents = [];
  for (const method of ['start', 'stop']) {
    const original = AudioBufferSourceNode.prototype[method];
    AudioBufferSourceNode.prototype[method] = function (...args) {
      window.playbackEvents.push(method);
      return original.apply(this, args);
    };
  }
});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
await page.goto(origin+'/dad');await page.locator('#conversationWorkshop').waitFor();await page.waitForTimeout(150);assert.deepEqual(errors,[]);await page.locator('[data-scene="menu"]').click();await page.setViewportSize({width:320,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Nestor mobile overflow');await page.setViewportSize({width:1024,height:1000});await page.evaluate(()=>{window.originalSignal=document.getElementById('conversationWorkflow');});assert.equal(await page.locator('.conversation-cockpit > #conversationWorkflow').count(),1,'daily conversation keeps its visible signal');await page.locator('#conversationWorkshop').click();await page.locator('.voice-workshop h1').waitFor();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.captureCalls),0);await page.locator('[data-action="close"]').click();await page.waitForFunction(()=>document.querySelector('.conversation-cockpit > #conversationWorkflow')===window.originalSignal);assert.equal(await page.locator('#conversationWorkflow .workflow-graph-node').count(),6,'the same signal returns after closing diagnostics');for(const width of [1600,1280,820,390,320]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'daily signal overflow '+width);assert.equal(await page.locator('.conversation-cockpit > #conversationWorkflow').count(),1);const widths=await page.evaluate(()=>({flow:document.getElementById('conversationWorkflow').getBoundingClientRect().width,dialogue:document.querySelector('.conversation-dialogue').getBoundingClientRect().width}));assert.ok(Math.abs(widths.flow-widths.dialogue)<2||widths.flow>widths.dialogue*1.8,'signal uses full available width or two thirds of a wide cockpit '+JSON.stringify(widths));}
for(let i=0;i<2;i++){await page.locator('#conversationWorkshop').click();await page.locator('.voice-workshop h1').waitFor();await page.locator('[data-tab="conversation"]').click();assert.equal(await page.locator('.voice-workshop #conversationWorkflow').count(),1);await page.locator('[data-action="close"]').click();await page.waitForFunction(()=>document.querySelector('.conversation-cockpit > #conversationWorkflow')===window.originalSignal);assert.equal(await page.locator('#conversationWorkflow').count(),1,'opening diagnostics never duplicates the signal');}
// A controller fixture verifies that the attached buttons route to their own owner.
// Backend task continuation remains covered by the conversation interruption tests.
await page.evaluate(async () => {
  const fixture = window.attachedControl = {
    state: 'preparing', activeTurn: { speech: new AbortController() }, stops: 0, interruptions: [],
    audio: { reviewStatus: () => ({}), readInputLevel: () => 0 },
    stop() { this.stops++; },
    interrupt(_turn, options) { this.interruptions.push(options); this.activeTurn.speech.abort(); this.state = 'hearing'; }
  };
  window.attachedWorkshop = await AgentXVoiceWorkshop.open({ conversation: fixture });
});
await page.locator('[data-tab="speech"]').click();
assert.equal(await page.locator('[data-action="stopSpeech"]').isDisabled(), false);
assert.equal(await page.locator('[data-action="stopReplay"]').isDisabled(), true);
await page.locator('[data-action="stopReplay"]').dispatchEvent('click');
assert.equal(await page.evaluate(() => attachedControl.interruptions.length), 0, 'replay Stop cannot interrupt the conversation');
await page.locator('[data-action="stopSpeech"]').click();
assert.deepEqual(await page.evaluate(() => attachedControl.interruptions), [{stop:true}]);
assert.equal(await page.evaluate(() => attachedControl.stops), 0, 'cutting speech never pauses the session');
assert.equal(await page.locator('[data-action="stopSpeech"]').isDisabled(), true);
await page.evaluate(() => { attachedControl.state = 'thinking'; attachedControl.activeTurn = { speech: new AbortController() }; attachedWorkshop.refresh(); });
assert.equal(await page.locator('[data-action="stopSpeech"]').isDisabled(), true, 'thinking alone is not playback');
await page.locator('[data-action="close"]').click();
await page.setViewportSize({width:1600,height:1000});await page.locator('#conversationWorkflow').screenshot({path:report+'/daily-signal.png'});await page.setViewportSize({width:1024,height:1000});
await page.locator('#conversationLanguage').selectOption('en');await page.locator('#conversationLanguage').selectOption('fr');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('household.conversation.preferences.v2')).profiles.nestor.selections.fr),'voxcpm|gazz');
await page.goto(origin+'/voice-lab');await page.locator('[data-action="start"]').waitFor();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.captureCalls),0);assert.equal(await page.locator('[data-step="response"]').getAttribute('data-state'),'off');assert.equal(await page.evaluate(()=>[...document.querySelectorAll('[data-role="signalBars"] rect')].every(r=>r.getAttribute('height')==='2')),true);
const stopReplay = page.locator('[data-action="stopReplay"]');
const stopSpeech = page.locator('[data-action="stopSpeech"]');
assert.equal(await stopReplay.isDisabled(), true, 'idle replay cannot be stopped');
assert.equal(await stopSpeech.isDisabled(), true, 'idle speech cannot be stopped');
await stopReplay.dispatchEvent('click');
assert.equal(await page.locator('[data-role="notice"]').textContent(), '', 'idle Stop never reports an interruption');
const testLanguage = page.locator('[data-field="testLanguage"]');
const speechText = page.locator('[data-field="speechText"]');
await page.locator('[data-tab="speech"]').click();
const initialFrench = await speechText.inputValue();
assert.match(initialFrench, /^Bonjour/);
await testLanguage.selectOption('en');
assert.match(await speechText.inputValue(), /^Hello/);
assert.equal(await page.locator('[data-field="language"]').inputValue(), 'fr', 'test language never saves a conversation language');
await testLanguage.selectOption('fr');
assert.equal(await speechText.inputValue(), initialFrench);
await page.locator('[data-tab="microphone"]').click();
await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:report+'/workshop-initial.png',fullPage:true});
await page.locator('[data-tab="settings"]').click();await page.locator('[data-field="inputDeviceId"]').selectOption('');await page.locator('[data-tab="microphone"]').click();await page.locator('[data-action="start"]').click();await page.locator('[data-role="transcript"]').filter({hasText:'Raconte-moi une blague.'}).waitFor({timeout:10000});assert.equal(await page.evaluate(()=>window.captureCalls),1);assert.equal(await page.evaluate(()=>window.lastAudioConstraints.audio.deviceId),undefined,'an explicit system-default choice overrides a saved device for this test');
assert.equal(await page.locator('[data-step="recognition"]').getAttribute('data-state'),'complete');assert.equal(await page.locator('[data-step="response"]').getAttribute('data-state'),'off');assert.equal(await page.locator('[data-stat="recognition"]').textContent(),'23 ms');
await page.setViewportSize({width:1360,height:1000});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:report+'/workshop-capture-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:1000});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:report+'/workshop-capture-mobile.png',fullPage:true});await page.setViewportSize({width:1024,height:1000});
assert.equal(await stopReplay.isDisabled(), true, 'capture is controlled by Pause, not replay Stop');
await page.locator('[data-action="review"]').click();
assert.equal(await stopReplay.isDisabled(), true, 'selecting an excerpt does not start playback');
await page.locator('[data-action="replay"]').click();
await page.waitForFunction(() => !document.querySelector('[data-action="stopReplay"]').disabled && window.playbackEvents.includes('start'));
assert.equal(await stopSpeech.isDisabled(), true, 'replay does not enable TTS Stop');
const stoppedBeforeReplay = await page.evaluate(() => window.playbackEvents.filter(e => e === 'stop').length);
await stopReplay.click();
assert.equal(await stopReplay.isDisabled(), true, 'Stop disables immediately');
await page.waitForFunction(n => window.playbackEvents.filter(e => e === 'stop').length > n, stoppedBeforeReplay);
await page.locator('[data-role="replayState"]').filter({hasText:'Réécoute arrêtée.'}).waitFor();
assert.match(await page.locator('[data-role="clip"]').textContent(), /Extrait temporaire/, 'Stop retains the excerpt');
assert.equal(await page.locator('[data-role="notice"]').textContent(), '', 'replay Stop has no global TTS message');
await stopReplay.dispatchEvent('click');
assert.equal(await page.locator('[data-role="replayState"]').textContent(), 'Réécoute arrêtée.');
await page.locator('[data-action="replay"]').click();
await page.waitForFunction(() => !document.querySelector('[data-action="replay"]').disabled);
assert.equal(await stopReplay.isDisabled(), true, 'Stop returns to rest after natural completion');
assert.equal(await page.evaluate(() => window.captureCalls), 1, 'replay Stop does not reopen the microphone');
await page.locator('[data-action="compare"]').click();await page.locator('[data-role="comparison"] dd').first().waitFor();const transcribes=calls.filter(c=>c.path.endsWith('/transcribe'));assert.equal(transcribes.length,3);assert.equal(transcribes[1].audioSha256,transcribes[2].audioSha256);
await page.locator('[data-action="erase"]').click();assert.equal(await page.locator('[data-action="compare"]').isDisabled(),true);
await page.locator('[data-tab="settings"]').click();await page.locator('[data-capture="threshold"]').fill('0.01');await page.locator('[data-role="settings"] button[type="submit"]').click();await page.locator('[data-role="saved"]').filter({hasText:'Enregistré'}).waitFor();assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('agentx.voice.capture.v1.personal')).threshold),.01);
await page.locator('[data-tab="speech"]').click();await page.locator('[data-action="speak"]').click();
await page.locator('[data-role="speechState"]').filter({hasText:'Lecture programmée'}).waitFor();
assert.equal(await stopReplay.isDisabled(), true, 'TTS does not enable replay Stop');
const stoppedBeforeTts = await page.evaluate(() => window.playbackEvents.filter(e => e === 'stop').length);
await stopSpeech.click();
assert.equal(await stopSpeech.isDisabled(), true);
await page.waitForFunction(n => window.playbackEvents.filter(e => e === 'stop').length > n, stoppedBeforeTts);
await page.locator('[data-role="speechState"]').filter({hasText:'Lecture interrompue'}).waitFor({timeout:5000});
await page.waitForTimeout(200);assert.equal(await page.locator('[data-step="voice"]').getAttribute('data-state'),'caution');assert.equal(await page.locator('[data-role="speechState"]').textContent(),'Lecture interrompue');
const startsBeforeCancelledPreparation = await page.evaluate(() => window.playbackEvents.filter(e => e === 'start').length);
ttsDelayMs=400;await page.locator('[data-action="speak"]').click();await page.locator('[data-role="speechState"]').filter({hasText:'Préparation de la lecture'}).waitFor();await stopSpeech.click();await page.waitForTimeout(500);assert.equal(await page.locator('[data-role="speechState"]').textContent(),'Lecture interrompue');assert.equal(await page.locator('[data-step="voice"]').getAttribute('data-state'),'caution');ttsDelayMs=0;
assert.equal(await page.evaluate(() => window.playbackEvents.filter(e => e === 'start').length), startsBeforeCancelledPreparation, 'a cancelled preparation never starts later');
await page.locator('[data-field="testVoice"]').selectOption('voxcpm|gazz');await page.locator('[data-preset="numbers"]').click();assert.equal(await page.locator('[data-field="testVoice"]').inputValue(),'voxcpm|gazz','a text preset preserves the selected voice within its language');
const frenchNumbers = await speechText.inputValue();
assert.match(frenchNumbers, /^Un, deux/);
await testLanguage.selectOption('en');
assert.match(await speechText.inputValue(), /^One, two/);
assert.equal(await speechText.getAttribute('lang'), 'en');
await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:report+'/workshop-speech-english.png',fullPage:true});
await page.locator('[data-preset="natural"]').click();
assert.equal(await testLanguage.inputValue(), 'en', 'natural preset follows the selected language');
assert.match(await speechText.inputValue(), /^Hi!/);
await page.locator('[data-preset="numbers"]').click();
assert.match(await speechText.inputValue(), /^One, two/);
await testLanguage.selectOption('fr');
assert.equal(await speechText.inputValue(), frenchNumbers);
await page.locator('[data-preset="english"]').click();
assert.equal(await testLanguage.inputValue(), 'en');
assert.match(await speechText.inputValue(), /^Hello!/);
assert.equal(await page.locator('[data-field="testVoice"]').inputValue(),'','another language returns to its own effective voice');
assert.equal(await page.locator('[data-field="language"]').inputValue(),'fr');
await testLanguage.selectOption('fr');
assert.match(await speechText.inputValue(), /^Bonjour/);
await page.locator('[data-preset="natural"]').click();
const frenchDraft = 'Mon propre texte de test en français.';
const englishDraft = 'My own English test draft.';
await speechText.fill(frenchDraft);
await testLanguage.selectOption('en');
assert.match(await speechText.inputValue(), /^Hi!/, 'first English visit uses the selected example');
await speechText.fill(englishDraft);
await testLanguage.selectOption('fr');
assert.equal(await speechText.inputValue(), frenchDraft, 'French draft is restored');
assert.equal(await speechText.getAttribute('lang'), 'fr-CA');
await speechText.fill('');
await testLanguage.selectOption('en');
assert.equal(await speechText.inputValue(), englishDraft, 'English draft is restored');
await testLanguage.selectOption('fr');
assert.equal(await speechText.inputValue(), '', 'an intentionally empty draft is retained');
await page.locator('[data-preset="natural"]').click();
assert.match(await speechText.inputValue(), /^Salut/);
await testLanguage.selectOption('en');
assert.equal(await speechText.inputValue(), englishDraft, 'a French preset does not overwrite the English draft');
await page.locator('[data-preset="natural"]').click();
assert.match(await speechText.inputValue(), /^Hi!/, 'an explicit preset replaces only the active language draft');
await testLanguage.selectOption('fr');
assert.match(await speechText.inputValue(), /^Salut/);
assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => /My own English test draft|Mon propre texte de test/.test(value))), false, 'drafts never enter browser storage');
await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:report+'/workshop-speech.png',fullPage:true});
await page.locator('[data-action="speak"]').click();await page.locator('[data-role="speechState"]').filter({hasText:'Lecture terminée'}).waitFor({timeout:10000});assert.equal(await page.locator('[data-step="voice"]').getAttribute('data-state'),'complete');assert.equal(await page.locator('[data-stat="voice"]').textContent(),'gazz');assert.equal(await page.locator('[data-stat-note="voice"]').textContent(),'voxcpm');assert.match(await page.locator('[data-role="speechDetail"]').textContent(),/gazz.*voxcpm.*FR/);assert.equal(await page.locator('[data-role="liveBadge"]').textContent(),'Au repos');
assert.equal(await stopSpeech.isDisabled(), true, 'completed speech cannot be stopped');
await stopSpeech.dispatchEvent('click');
assert.equal(await page.locator('[data-role="speechState"]').textContent(), 'Lecture terminée', 'a repeated Stop cannot overwrite success');
assert.equal(await page.locator('[data-role="notice"]').textContent(), '');
await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:report+'/workshop-speech-complete.png',fullPage:true});
await page.locator('[data-step="capture"]').click();assert.equal(await page.locator('[data-panel="microphone"]').isVisible(),true);
for(const width of [1024,736,360,320]){await page.setViewportSize({width,height:1000});for(const tab of ['microphone','speech','conversation','settings']){await page.locator('[data-tab="'+tab+'"]').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'overflow '+width+' '+tab);}}
await page.setViewportSize({width:1024,height:1000});await page.locator('[data-tab="microphone"]').click();await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:report+'/workshop-desktop.png',fullPage:true});await page.setViewportSize({width:360,height:1100});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:report+'/workshop-mobile.png',fullPage:true});
assert.deepEqual(errors,[]);assert.equal(calls.filter(c=>c.method==='POST'&&!/\/transcribe$|\/synthesize\/stream$/.test(c.path)).length,0);
const beforePsyx=calls.length; await page.goto(origin+'/psyx');await page.locator('#voiceSettings').waitFor();await page.waitForTimeout(150);await page.locator('#voiceSettings').click();await page.locator('.voice-workshop h1').waitFor();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.captureCalls),0);
await page.setViewportSize({width:320,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'PsyX mobile overflow');await page.setViewportSize({width:1024,height:1000});
const workshopCalls=calls.slice(beforePsyx).filter(c=>c.path.includes('/voice/'));assert.ok(workshopCalls.every(c=>c.path.startsWith('/api/psyx/voice/')));await page.locator('[data-action="close"]').click();assert.deepEqual(errors,[]);
await page.evaluate(() => localStorage.setItem('household.reading.language.v1', 'en'));
await page.goto(origin+'/voice-lab?scope=reading&tab=speech');
await page.locator('[data-field="testLanguage"]').waitFor();
await page.waitForFunction(() => document.querySelector('[data-field="testLanguage"]').value === 'en');
assert.match(await page.locator('[data-field="speechText"]').inputValue(), /^Hello/, 'an initially English workshop never presents a French example');
const initialEnglish = await page.locator('[data-field="speechText"]').inputValue();
await page.locator('[data-tab="settings"]').click();
await page.locator('[data-field="language"]').selectOption('fr');
assert.match(await page.locator('[data-field="speechText"]').inputValue(), /^Bonjour/);
await page.locator('[data-field="language"]').selectOption('en');
assert.equal(await page.locator('[data-field="speechText"]').inputValue(), initialEnglish);
await page.goto(origin+'/psyx');
await page.route('**/psyx/assets/voice-audio.js*',route=>route.abort());await page.goto(origin+'/psyx');await page.locator('#voiceSettings').click();await page.locator('[data-role="notice"]').filter({hasText:'lecteur TTS est indisponible'}).waitFor();assert.equal(await page.evaluate(()=>window.captureCalls),0);await page.locator('[data-action="close"]').click();assert.deepEqual(errors,[]);await page.unroute('**/psyx/assets/voice-audio.js*');
await page.goto(origin+'/voice-lab?tab=settings&persona=missing-personality');await page.locator('[data-action="sharedVoice"]').waitFor();await page.locator('[data-role="sharedStatus"]').filter({hasText:'indisponible'}).waitFor();assert.equal(await page.locator('[data-action="sharedVoice"]').isDisabled(),true);

fs.writeFileSync(report+'/browser-check.json',JSON.stringify({state:'passed',errors,unknown,calls: calls.map(({body,...r})=>r),physicalDevice:false,liveModels:0},null,2));console.log(JSON.stringify({state:'passed',networkRequests:calls.length,transcriptions:transcribes.length,scriptErrors:0,realModelCalls:0,unknown}));
}finally{await browser.close();server.close();}})().catch(e=>{fs.writeFileSync(report+'/browser-errors.json',JSON.stringify({error:e.message,stack:e.stack,errors,unknown,calls},null,2));console.error(e);server.close();process.exitCode=1;});
