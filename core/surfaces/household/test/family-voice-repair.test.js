'use strict';
// All words, transports and playback below are synthetic; no real device or model.
const test=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./fixtures/persona-journey.cjs');
const {createSoundLibrary}=require('../sound-library');
const {Conversation}=require('../public/browser-conversation');
const {normalizeVoiceTimings}=require('../../../src/services/voice/timeline');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

function loop(extra={}){
 let utterance,speech,heard='Une question synthétique';const timelines=[],texts=[],synthesis=[];
 const audio={listen(callback,onSpeech){utterance=callback;speech=onSpeech;},quiet(){},close(){},async play(_bytes,_signal,_a,_gain,callbacks={}){callbacks.onScheduled?.();}};
 const c=new Conversation({repairConversation:true,holdingDelayMs:null,wakeAckDelayMs:0,
  openAudio:async()=>audio,createSession:async()=>({sessionId:'synthetic-family-repair'}),transcribe:async()=>heard,
  turn:async(_s,text)=>{texts.push(text);return {text:'Réponse synthétique.'};},synthesize:async value=>{synthesis.push(value.text);return {synthetic:true};},
  message(){},timings:async(_s,_id,value)=>{timelines.push(value);return {};},...extra});
 return {c,audio,timelines,texts,synthesis,say:text=>{heard=text;return utterance(new Blob(['synthetic']));},speech:()=>speech?.()};
}

test('a family sound request bypasses inference and gives one brief honest introduction',async()=>{
 const h=harness({packId:'kidx_nestor',backend:'agentx',sounds:createSoundLibrary(),response:'A deliberately contradictory fake model answer.'});
 const reply=await h.turn('Fais-moi le bruit du T-Rex.','voice');
 assert.equal(reply.sound.id,'trex');assert.equal(h.sent.length,0);assert.equal(reply.routing.tier,'deterministic');
 assert.equal(reply.reply.text,'Écoute ce bruitage !');assert.equal(h.turns[0].soundId,'trex');
});

test('local sound handling respects safety and leaves ordinary and personal requests on their existing path',async()=>{
 const family=harness({packId:'kidx_nestor',backend:'agentx',sounds:createSoundLibrary()});
 const safe=await family.turn('Je veux me tuer. Fais le bruit du T-Rex.','voice');assert.equal(safe.sound,null);assert.equal(family.sent.length,0);
 await family.turn('Combien de pattes a un dinosaure?','voice');assert.equal(family.sent.length,1);
 const personal=harness({packId:'personal_operator',backend:'agentx',sounds:createSoundLibrary()});await personal.turn('Fais le bruit du T-Rex.','voice',{soundPlayback:true});assert.equal(personal.sent.length,1);
});

test('Pause during playback is user_paused, never playback_error',async()=>{
 const started=deferred(),h=loop();
 h.audio.play=async(_bytes,signal)=>{started.resolve();return new Promise((_done,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('Synthetic Pause'),{name:'AbortError'})),{once:true}));};
 await h.c.start({language:'fr'});const exchange=h.say('Question synthétique');await started.promise;h.c.pause();await exchange;await tick();
 const last=h.timelines.at(-1);assert.equal(h.c.state,'paused');assert.equal(last.playbackOutcome,'user_paused');assert.equal(last.stopReason,'user_pause');
 assert.equal(normalizeVoiceTimings(last).playbackOutcome,'user_paused');
});

test('a real synthetic playback failure remains an error with a bounded reason',async()=>{
 const h=loop();h.audio.play=async()=>{throw Error('Synthetic missing output');};
 await h.c.start({language:'fr'});await h.say('Question synthétique');await tick();
 assert.equal(h.c.state,'error');assert.equal(h.timelines.at(-1).playbackOutcome,'playback_error');assert.equal(h.timelines.at(-1).stopReason,'playback_error');h.c.stop();
});

test('explicit interruption is separate from Pause and retains its stop reason',async()=>{
 const started=deferred(),h=loop({interrupt:async()=>({interrupted:true})});
 h.audio.play=async(_bytes,signal)=>{started.resolve();return new Promise((_done,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('Synthetic interruption'),{name:'AbortError'})),{once:true}));};
 await h.c.start({language:'fr'});const exchange=h.say('Question synthétique');await started.promise;h.c.interrupt();await exchange;await tick();
 assert.equal(h.timelines.at(-1).playbackOutcome,'interrupted');assert.equal(h.timelines.at(-1).stopReason,'barge_in');h.c.stop();
});



const {QUIET_MS,MAX_WAIT_MS,CARRY_MS,MAX_CHARS,MAX_FRAGMENTS}=require('../../../public/js/voice/voice-repair');
const {familyRepairContext}=require('../family-repair-context');

test('repair fragments become one request on the same subject rather than multiple fresh replies',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=loop();t.after(()=>h.c.stop());await h.c.start({language:'fr'});
 const first=h.say('Non, non, je voulais');await tick();assert.equal(h.texts.length,0);
 h.speech();t.mock.timers.tick(QUIET_MS);assert.equal(h.texts.length,0,'speech postpones dispatch');
 await h.say('le bruit du');await tick();h.speech();await h.say('T-Rex');await tick();
 t.mock.timers.tick(QUIET_MS-1);await tick();assert.equal(h.texts.length,0);
 t.mock.timers.tick(1);await first;await tick();
 assert.deepEqual(h.texts,['Non, non, je voulais le bruit du T-Rex']);assert.equal(h.timelines.at(-1).repairFragments,3);assert.equal(h.c.state,'listening');
});

test('standalone yes and no remain immediate legitimate answers',async t=>{
 const h=loop();t.after(()=>h.c.stop());await h.c.start({language:'fr'});
 await h.say('Oui');await h.say('Non');assert.deepEqual(h.texts,['Oui','Non']);assert.equal(h.c.repairs.pending,null);
});

test('a pure Stop cancels a pending repair; the next complete request is not swallowed or replayed',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=loop();t.after(()=>h.c.stop());await h.c.start({language:'fr'});
 const first=h.say('Non, non, je voulais');await tick();await h.say('Stop');await first;
 await h.say('Fais le bruit du T-Rex');t.mock.timers.tick(60000);await tick();assert.deepEqual(h.texts,['Fais le bruit du T-Rex']);
});

test('Pause and a new session discard pending fragments and every late timer',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=loop();t.after(()=>h.c.stop());await h.c.start({language:'fr'});
 const first=h.say('Non, non, je voulais');await tick();h.c.pause();await first;t.mock.timers.tick(60000);await tick();
 assert.equal(h.c.state,'paused');assert.equal(h.texts.length,0);
 await h.c.start({language:'fr'});await h.say('Une autre question');assert.deepEqual(h.texts,['Une autre question']);
});

test('a long continuation waits for its end without dispatching over the person and has bounded carry lifetime',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=loop();t.after(()=>h.c.stop());await h.c.start({language:'fr'});
 const first=h.say('Non, non, je voulais');await tick();h.speech();t.mock.timers.tick(MAX_WAIT_MS);await first;
 assert.equal(h.texts.length,0);assert.ok(h.c.repairs.carry);assert.equal(h.c.repairs.pending,null);
 await h.say('une explication complète');assert.deepEqual(h.texts,['Non, non, je voulais une explication complète']);
 const next=h.say('Non, non, plutôt');await tick();h.speech();t.mock.timers.tick(MAX_WAIT_MS);await next;t.mock.timers.tick(CARRY_MS);await tick();assert.equal(h.c.repairs.carry,null);
});

test('limits never truncate the complete newest utterance or create an unbounded queue',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=loop();t.after(()=>h.c.stop());await h.c.start({language:'fr'});
 const first=h.say('Non, non, je voulais');await tick();const complete='Une explication '+ 'x'.repeat(MAX_CHARS);await h.say(complete);await first;
 assert.deepEqual(h.texts,[complete]);assert.equal(h.c.repairs.pending,null);assert.equal(h.c.repairs.carry,null);
 const p=h.say('Non, non, plutôt');await tick();for(let i=1;i<MAX_FRAGMENTS;i++)await h.say('fragment '+i);await p;assert.equal(h.texts.length,2);assert.equal(h.c.repairs.pending,null);
});

test('echo of the interrupted reply is not appended to the repair or turned into a new request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=loop();t.after(()=>h.c.stop());await h.c.start({language:'fr'});
 const first=h.say('Non, non, je voulais');await tick();h.c.repairs.pending.echo='Cette étoile est très brillante dans le ciel.';
 await h.say('Cette étoile est très brillante dans le ciel.');await tick();t.mock.timers.tick(QUIET_MS);await first;assert.deepEqual(h.texts,['Non, non, je voulais']);
});

test('recognition recovery and capture overflow cancel a buffered correction rather than sending stale text',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=loop({recoverCapture:true,canResumeRecognition:()=>true});t.after(()=>h.c.stop());await h.c.start({language:'fr'});
 const first=h.say('Non, non, je voulais');await tick();h.c.recovery.capture({state:'waiting-silence'},h.c.epoch);await first;t.mock.timers.tick(60000);assert.equal(h.texts.length,0);assert.equal(h.c.recovery.captureWaiting,true);
 h.c.recovery.capture({state:'ready'},h.c.epoch);const next=h.say('Non, non, plutôt');await tick();h.c.recovery.recognition(Object.assign(Error('Synthetic network'),{status:503}),h.c.epoch);await next;t.mock.timers.tick(2000);await tick();assert.equal(h.texts.length,0);
});

test('family repair reference keeps the earlier request beyond two exchanges, within one bounded family scope',()=>{
 const now=Date.now(),row=(input,ago=0,extra={})=>({inputText:input,createdAt:new Date(now-ago),packId:'kidx_nestor',scopeId:'family',...extra});
 const rows=[row('Un fragment'),row('Non, non, plutôt'),row('Une confirmation'),row('Fais le bruit du hibou')];
 const context=familyRepairContext(rows,'le cri du hibou',{now});assert.match(context,/Fais le bruit du hibou/);assert.match(context,/reference data/);
 assert.equal(familyRepairContext(rows,'Raconte une blague',{now}), '');
 assert.equal(familyRepairContext([row('Non, non'),row('Fais le bruit du hibou',121000)],'je veux dire autre chose',{now}), '');
 assert.equal(familyRepairContext([row('Fais ma demande personnelle',0,{scopeId:'personal',packId:'personal_operator'})],'Non, non, plutôt',{now}), '');
 assert.equal(familyRepairContext([row('Fais '+ 'x'.repeat(801))],'Non, non',{now}), '');
});

for(const action of ['complete','pause-before-clip','pause-during-clip','interrupt-before-clip','interrupt-during-clip'])test('clip lifecycle: '+action,async t=>{
 const previous=global.fetch;global.fetch=async()=>new Response(new Uint8Array([7,8,9]));t.after(()=>{global.fetch=previous;});
 const clip={id:'synthetic-clip',url:'https://fixture.invalid/'+action+'.ogg',gain:1},entered=deferred();let scheduleLate,played=[];
 const h=loop({turn:async()=>({text:'Écoute !',sound:clip}),interrupt:async()=>({interrupted:true})});t.after(()=>h.c.stop());
 h.audio.play=async(bytes,signal,_a,_gain,callbacks={})=>{
  const isClip=bytes instanceof ArrayBuffer;played.push(isClip?'clip':'intro');
  const hold=action.includes('before')?!isClip:action.includes('during')?isClip:false;
  if(!hold){callbacks.onScheduled?.();return;}
  scheduleLate=callbacks.onScheduled;if(isClip)callbacks.onScheduled?.();entered.resolve();return new Promise((_done,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('Synthetic stop'),{name:'AbortError'})),{once:true}));
 };
 await h.c.start({language:'fr'});const exchange=h.say('Un son synthétique');
 if(action!=='complete'){await entered.promise;if(action.startsWith('pause'))h.c.pause();else h.c.interrupt();}
 await exchange;scheduleLate?.();await tick();const v=h.timelines.at(-1),normalized=normalizeVoiceTimings(v);
 assert.equal(v.clipId,clip.id);assert.equal(normalized.clipId,clip.id);
 if(action==='complete'){assert.deepEqual(played,['intro','clip']);assert.equal(v.clipOutcome,'completed');assert.equal(v.playbackOutcome,'completed');assert.ok(v.clipEnded>=v.clipStarted);}
 else{const outcome=action.startsWith('pause')?'user_paused':'interrupted';assert.equal(v.playbackOutcome,outcome);assert.equal(v.clipOutcome,outcome);assert.equal(v.stopReason,outcome==='user_paused'?'user_pause':'barge_in');if(action.includes('before'))assert.equal(v.clipStarted,undefined);else assert.ok(v.clipEnded>=v.clipStarted);}
});


test('repair topic is carried as quoted reference and its directive remains outside that data block',async()=>{
 const h=harness({packId:'kidx_nestor',backend:'agentx'});
 await h.turn('Explique les saisons.','voice');await h.turn('Non, non, je voulais un exemple.','voice');await h.turn('Un exemple court.','voice');await h.turn('Avec un arbre.','voice');
 await h.turn('Non, je voulais préciser.','voice');
 const last=h.sent.at(-1).request;assert.match(last,/Explique les saisons/);
 assert.ok(last.indexOf('The current utterance corrects')>last.indexOf('</selected_context>'),'trusted repair directive is not buried in reference data');
 assert.equal(h.turns.length,5);
});


test('a compound sound and explanation keeps both parts and separates the short introduction from the answer',async()=>{
 const h=harness({packId:'kidx_nestor',backend:'agentx',sounds:createSoundLibrary(),response:'Une réponse synthétique sur les dinosaures.'});
 const reply=await h.turn('Fais le bruit du T-Rex puis explique pourquoi les dinosaures ont disparu.','voice');
 assert.equal(h.sent.length,1);assert.equal(reply.sound.id,'trex');assert.equal(reply.sound.play,'after-introduction');
 assert.equal(reply.reply.soundIntroduction,'Écoute ce bruitage !');assert.equal(reply.reply.afterSoundText,'Une réponse synthétique sur les dinosaures.');
 assert.match(reply.reply.text,/Écoute ce bruitage ! Une réponse/);assert.match(h.sent[0].request,/Answer all remaining parts/);
});

test('a pending or carried repair refuses background speech until its own turn is settled',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=loop();t.after(()=>h.c.stop());await h.c.start({language:'fr'});
 const first=h.say('Non, non, je voulais');await tick();assert.equal(await h.c.interject({text:'Remarque de fond synthétique.'}),false);
 h.speech();t.mock.timers.tick(MAX_WAIT_MS);await first;assert.ok(h.c.repairs.carry);assert.equal(await h.c.interject({text:'Autre remarque.'}),false);
 await h.say('une explication');assert.deepEqual(h.texts,['Non, non, je voulais une explication']);
});

test('a late sound response after Pause cannot plan a new clip on a terminal timeline',async()=>{
 const waiting=deferred(),h=loop({turn:async()=>waiting.promise});await h.c.start({language:'fr'});const exchange=h.say('Un son synthétique');await tick();h.c.pause();
 waiting.resolve({text:'Écoute !',sound:{id:'late-clip',url:'https://fixture.invalid/late.ogg'}});await exchange;await tick();const v=h.timelines.at(-1);
 assert.equal(v.playbackOutcome,'user_paused');assert.equal(v.clipId,undefined);assert.equal(v.clipRequested,undefined);
});

test('a stream transport failure after successful speech is request_error, not a broken output device',async()=>{
 const played=deferred();const h=loop({turn:async(_s,_t,_signal,delta)=>{delta('Une phrase synthétique. ');await played.promise;throw TypeError('Synthetic network connection lost');}});
 h.audio.play=async()=>{played.resolve();};await h.c.start({language:'fr'});await h.say('Une question synthétique');await tick();
 assert.equal(h.timelines.at(-1).playbackOutcome,'playback_error');assert.equal(h.timelines.at(-1).stopReason,'request_error');h.c.stop();
});


for(const request of ['Fais le bruit du T-Rex. Raconte une histoire de dinosaure.','Fais le bruit du T-Rex et donne un exemple de dinosaure.','Fais le bruit du T-Rex et chante une chanson.'])test('a second request is never discarded: '+request,async()=>{
 const h=harness({packId:'kidx_nestor',backend:'agentx',sounds:createSoundLibrary(),response:'La seconde demande est conservée.'});const reply=await h.turn(request,'voice');assert.equal(h.sent.length,1);assert.equal(reply.reply.afterSoundText,'La seconde demande est conservée.');assert.equal(reply.sound.id,'trex');
});
for(const request of ['Comment fait le chat ?','How does a cow sound?','Non, non, je voulais le bruit du T-Rex.'])test('a complete sound-only request uses no inference: '+request,async()=>{
 const h=harness({packId:'kidx_nestor',backend:'agentx',sounds:createSoundLibrary()});const reply=await h.turn(request,'voice');assert.ok(reply.sound);assert.equal(h.sent.length,0);
});


test('FR and EN direct imitations retain catalog matching and bypass inference', async () => {
 for (const [request, id] of [['fais miaou','cat'], ['ouaf ouaf','dog'], ['make moo','cow']]) {
  const h=harness({packId:'kidx_nestor',backend:'agentx',sounds:createSoundLibrary()});
  const reply=await h.turn(request,'voice');
  assert.equal(reply.sound.id,id,request); assert.equal(h.sent.length,0,request);
  assert.equal(reply.routing.tier,'deterministic');
 }
});
