const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
function fixture(spoken=true){
 const calls=[];let io;let plays=0;
 const root={localStorage:{},fetch:async(url,init)=>{calls.push({url,init});return {ok:true,json:async()=>({ok:true,data:{text:'Bonjour',personas:[{id:'nestor'}]}})};}};
 root.AgentXVoiceSettings={read:(scope,personas)=>{assert.equal(scope,'personal');assert.equal(personas[0].id,'nestor');return {language:'fr',wakeWord:false,capture:{threshold:.02},inputDeviceId:'my-pc-mic'};}};
 root.AgentXVoice={Conversation:class {constructor(value){io=value;}start(selection){return io.openAudio(new AbortController().signal,()=>{},{selection});}stop(){}},openAudio:async(signal,failed,options)=>{calls.push({capture:options});return {play:async()=>{plays++;}};}};
 root.PersonaPresentation={read:()=>({profiles:{nestor:{selections:{fr:'local|my-voice'}}}}),speechChoices:(p,l,prefs)=>{assert.equal(prefs.selections.fr,'local|my-voice');return [{provider:'local',voice:'my-voice'}];}};
 root.AgentXSpeechLadder={createSpeechLadder:({request})=>({speak:({text,language,choices},signal)=>request({text,language,choice:choices[0]},signal)})};
 const sandbox={window:root,FormData,AbortController};vm.runInNewContext(fs.readFileSync(require.resolve('../dashboard/adapter.js'),'utf8'),sandbox);
 const sent=[];const voice=root.AgentXHermesVoice.create({chat:{scope:'native-chat'},bridge:{turn:(...args)=>sent.push(args),close(){}},persona:{id:'nestor'},changed(){},speak:()=>spoken});
 return {root,voice,calls,sent,get io(){return io;},get plays(){return plays;}};
}
test('capture uses the same saved personal PC microphone; initialization never opens it',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);await f.voice.start();assert.equal(f.calls[0].capture.inputDeviceId,'my-pc-mic');assert.equal(f.calls[0].capture.captureScope,'personal');
 const abort=new AbortController();await f.io.transcribe(new Blob(['recording']),'fr',abort.signal);
 assert.equal(f.calls[1].url,'/api/voix/transcribe');assert.equal(f.calls[1].init.body.get('language'),'fr');
 f.io.turn({},'Original',abort.signal,()=>{});assert.equal(f.sent.length,1);assert.equal(f.sent[0][0],'Original');
});
test('spoken replies use the existing personal voice and Core streaming synthesis',async()=>{
 const f=fixture();await f.io.synthesize({text:'Salut',language:'fr'},new AbortController().signal);
 assert.equal(f.calls[0].url,'/api/voix/synthesize/stream');assert.deepEqual(JSON.parse(f.calls[0].init.body),{text:'Salut',language:'fr',tts_provider:'local',voice:'my-voice'});
});
test('speech toggle prevents synthesis and speaker playback without another voice provider',async()=>{
 const f=fixture(false);const audio=await f.voice.start();const bytes=await f.io.synthesize({text:'Quiet',language:'en'},new AbortController().signal);await audio.play(bytes);assert.equal(f.plays,0);assert.equal(f.calls.length,1);
});
