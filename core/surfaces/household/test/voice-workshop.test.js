'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../public/persona-presentation');
const PsyX = require('../../psyx/public/voice-preferences');
const { Endpoint } = require('../../../public/js/voice/browser-conversation');
const { serviceSettings } = require('../../../src/services/voice/settings');
const personas = [{ id:'nestor', name:'Nestor' }, { id:'helper', name:'Helper' }];
function settings(initial = {}, browser = {}) {
  const values = new Map(Object.entries(initial));
  const storage = { getItem:k => values.get(k) ?? null, setItem:(k,v) => values.set(k,String(v)), removeItem:k => values.delete(k) };
  const window = { localStorage:storage, PersonaPresentation:P, PsyXVoicePreferences:PsyX, ...browser };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../../public/js/voice/voice-settings.js'),'utf8'), { window });
  return { api:window.AgentXVoiceSettings, storage, values };
}
test('workshop preserves existing preference owners, other languages and other personalities', () => {
  const h = settings({ 'household.conversation.preferences.v2':JSON.stringify({ personaId:'nestor', agentId:'main', interruption:true,
    profiles:{ nestor:{ language:'fr', selections:{ en:'voxcpm|jarvis' } }, helper:{ language:'en' } } }) });
  const old = P.read(h.storage,personas);
  h.api.save('personal', { ...h.api.read('personal',personas), language:'fr', voice:'voxcpm|gazz', wakeWord:true }, { ...h.api.DEFAULTS, threshold:.01 }, personas,h.storage);
  const saved = P.read(h.storage,personas);
  assert.equal(saved.agentId,'main'); assert.deepEqual(saved.profiles.helper,old.profiles.helper);
  assert.equal(saved.profiles.nestor.selections.fr,'voxcpm|gazz'); assert.equal(saved.profiles.nestor.selections.en,'voxcpm|jarvis');
  assert.equal(h.storage.getItem('household.space.personal.listening'),'wake');
  assert.equal(h.api.capture('personal',h.storage).threshold,.01); assert.equal(h.api.capture('family',h.storage).threshold,.015);
});
test('reading and PsyX edits use their own keys without changing shared speech configuration', () => {
  const h = settings({ 'household.reading.voices.v1':JSON.stringify({ fr:'voxcpm|gazz' }), 'psyx.voice.preferences.v1':JSON.stringify({ language:'fr', ttsProvider:'voxcpm', ttsVoice:'helper', autoSend:true }) });
  h.api.save('reading',{ language:'en',voice:'voxcpm|jarvis',inputDeviceId:'reader-mic' },h.api.DEFAULTS,personas,h.storage);
  assert.deepEqual(JSON.parse(h.storage.getItem('household.reading.voices.v1')),{ fr:'voxcpm|gazz',en:'voxcpm|jarvis' });
  assert.equal(h.api.read('reading',personas,h.storage).inputDeviceId,'reader-mic');
  assert.equal(PsyX.readPreferences(h.storage).ttsVoice,'helper');
  h.api.save('psyx',{ language:'en', voice:'voxcpm|analyst', inputDeviceId:'psyx-mic', spokenReplies:true,autoSend:false },h.api.DEFAULTS,personas,h.storage);
  assert.equal(PsyX.readPreferences(h.storage).ttsVoice,'analyst'); assert.equal(PsyX.readPreferences(h.storage).inputDeviceId,'psyx-mic');
  assert.equal(h.storage.getItem('household.reading.language.v1'),'en');
  assert.ok([...h.values.keys()].every(k => /^(household\.|psyx\.|agentx\.voice\.capture\.)/.test(k)));
});
test('invalid capture edits refuse before any preference changes and storage failure restores previous values', () => {
  const h = settings({ 'household.reading.language.v1':'fr' }), before = [...h.values];
  for (const threshold of [0,NaN,Infinity,'0.01',.5]) {
    assert.throws(() => h.api.save('reading',{ language:'en',voice:'' },{ ...h.api.DEFAULTS, threshold },personas,h.storage));
    assert.deepEqual([...h.values],before);
  }
  let once = true; const set = h.storage.setItem;
  h.storage.setItem = (k,v) => { if (k.startsWith('agentx.voice.capture') && once) { once=false; throw Error('quota'); } set(k,v); };
  assert.throws(() => h.api.save('reading',{ language:'en',voice:'' },h.api.DEFAULTS,personas,h.storage),/Previous values are preserved/);
  assert.deepEqual([...h.values],before);
});
test('capture tuning changes the real shared endpoint while reference defaults preserve quiet rejection', () => {
  const original = new Endpoint(1000), trial = new Endpoint(1000,100,600,.005);
  for (let i=0;i<2;i++) { const quiet = new Float32Array(100).fill(.01); assert.equal(original.push(quiet),null); trial.push(quiet); }
  assert.equal(original.speaking,false); assert.equal(trial.speaking,true);
  let ended; for (let i=0;i<6;i++) ended = trial.push(new Float32Array(100));
  assert.ok(ended instanceof Float32Array); assert.equal(ended.length,800);
});
test('service settings expose only declared scalar fields, excluding prompts, paths, lexicons and secrets', () => {
  const result = serviceSettings({ static:{ whisper_model:'model',whisper_device:'cuda',whisper_compute_type:'int8_float16',whisper_vad_threshold:.85,
    whisper_initial_prompt:'private words',whisper_hotwords:'private names',stt_corrections_path:'/private/path',tts_provider:'voxcpm' }, config:{ secret:'private' } });
  assert.equal(result.model,'model'); assert.equal(result.vadThreshold,.85); assert.equal(result.editable,false);
  assert.doesNotMatch(JSON.stringify(result),/private|hotwords|prompt|corrections/);
});
function sessionHarness(scope='personal') {
  const requests = [], changes = [], results = [], speech = [];
  let io, now = 100, failFetch = false;
  class Conversation {
    constructor(adapter,changed) { io=adapter; this.changed=changed; this.state='idle'; this.audio={ reviewStatus:()=>({ id:'clip',expiresAt:Date.now()+10000,seconds:2 }), reviewBlob:()=>new Blob(['same-audio'],{type:'audio/wav'}) }; }
    start(selection) { this.selection=selection; return io.createSession().then(x => { this.session=x; this.state='listening'; }); }
    stop() { this.state='paused'; }
    review() { this.state='reviewing'; }
  }
  const window = { AgentXVoice:{ Conversation,openAudio:async(_s,_e,options)=>options,speakWithBrowser(){} },
    AgentXSpeechLadder:{ createSpeechLadder:options=>({ speak:async value=>{ speech.push({options,value});return {}; } }) },
    VoixAudio:{ Speech:class { cancel(){} async speak(fn,{segments}) { for (const text of segments) await fn(new AbortController().signal,text); } } },
    PersonaPresentation:{ speechChoices:()=>[{provider:'voxcpm',voice:'gazz'}] },
    speechSynthesis:{}, NestorSpeech:{ splitSpeechText:text=>[text],speechText:text=>text }, performance:{ now:()=>now+=10 },
    fetch:async(url,options)=>{ requests.push({url,options}); if (failFetch) throw Error('Lost reply'); return new Response(JSON.stringify({text:'Bonjour',recognitionId:'id-'+requests.length}),{headers:{'Content-Type':'application/json'}}); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../../public/js/voice/voice-workshop-session.js'),'utf8'), { window,Blob,FormData,AbortController,DOMException,Date,setTimeout,clearTimeout });
  const session=window.AgentXVoiceWorkshopSession.create({scope,language:()=> 'fr',capture:()=>({threshold:.01}),preferences:()=>({wakeWord:false,voice:'voxcpm|gazz'}),persona:()=>({}),changed:x=>changes.push(x),result:x=>results.push(x)});
  return {session,requests,results,speech,fail(){failFetch=true;},get io(){return io;}};
}
test('standalone STT uses shared conversation callbacks without a business route or conversation write', async () => {
  const h=sessionHarness(); await h.session.start();
  assert.equal(h.session.conversation.session.testOnly,true);
  const result=await h.io.transcribe(new Blob(['sound']), 'fr',new AbortController().signal);
  await h.io.turn({},result.text,new AbortController().signal);
  assert.equal(h.requests.length,1); assert.equal(h.requests[0].url,'/api/voix/transcribe');
  assert.equal(h.requests[0].options.body.get('language'),'fr'); assert.equal(h.results[0].recognitionId,'id-1');
  assert.equal((await h.io.openAudio(null,null,{})).captureScope,'personal');
});
test('A/B is explicit, reuses one excerpt, refuses expired audio and performs no retry after a lost reply', async () => {
  const h=sessionHarness(); h.session.review(); const result=await h.session.compare('en');
  assert.equal(h.requests.length,2); assert.equal(result.rows[0].language,'fr');assert.equal(result.rows[1].language,'en');
  assert.equal(await h.requests[0].options.body.get('file').text(),await h.requests[1].options.body.get('file').text());
  h.session.conversation.audio.reviewStatus=()=>({id:'expired',expiresAt:0});
  await assert.rejects(()=>h.session.compare('fr'),/unexpired/);assert.equal(h.requests.length,2);
  h.session.conversation.audio.reviewStatus=()=>({id:'live',expiresAt:Date.now()+10000}); h.fail();
  await assert.rejects(()=>h.session.compare('en'),/Lost reply/); assert.equal(h.requests.length,3,'an uncertain result is never retried automatically');
});
test('PsyX tests stay on protected routes and request local-only English fallback', async () => {
  const h=sessionHarness('psyx');await h.io.transcribe(new Blob(['sound']), 'en',new AbortController().signal);
  assert.equal(h.requests[0].url,'/api/psyx/voice/transcribe');assert.equal(h.requests[0].options.headers['X-PsyX-Language'],'en');
  await h.session.speak('Hello',null,'en');
  assert.equal(h.speech[0].value.language,'en');
  assert.equal(h.speech[0].options.deviceVoice({language:'en'}).localOnly,true);
  assert.equal(h.speech[0].options.deviceVoice({language:'fr'}),false);
  const response=await h.speech[0].options.request({text:'Hello',language:'en',choice:{provider:'voxcpm',voice:'gazz'}},new AbortController().signal);
  assert.equal(response.status,200);assert.equal(h.requests[1].url,'/api/psyx/voice/synthesize/stream');
});

test('workshop microphone discovery releases late permission tracks after its owner closes', async () => {
  let resolve, stopped=0, enumerated=0;
  const granted=new Promise(done=>{resolve=done;});
  const h=settings({}, {navigator:{mediaDevices:{getUserMedia:()=>granted,enumerateDevices:async()=>{enumerated++;return [];}}}});
  const abort=new AbortController(), pending=h.api.microphones(abort.signal);
  abort.abort();resolve({getTracks:()=>[{stop(){stopped++;}}]});
  await assert.rejects(()=>pending,{name:'AbortError'});assert.equal(stopped,1);assert.equal(enumerated,0);
});
test('workshop device discovery closes temporary streams and never opens a second live microphone', async () => {
  let stopped=0, captures=0;
  const h=settings({}, {navigator:{mediaDevices:{getUserMedia:async()=>{captures++;return {getTracks:()=>[{stop(){stopped++;}}]};},
    enumerateDevices:async()=>[{kind:'audioinput',deviceId:'mic'},{kind:'videoinput',deviceId:'camera'}]}}});
  assert.equal((await h.api.microphones(new AbortController().signal)).length,1);assert.equal(stopped,1);
  await h.api.microphones(new AbortController().signal,{requestPermission:false});assert.equal(captures,1);
});
