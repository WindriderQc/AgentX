/* Actual native SPA + browser audio, with native turns and speech services replaced by CPU fixtures. */
const {chromium}=require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..');
const upstream=new URL(process.env.AGENTX_HERMES_PREVIEW_URL || 'http://127.0.0.1:19121');
const report=process.env.AGENTX_HERMES_VOICE_REPORT || fs.mkdtempSync(path.join(require('node:os').tmpdir(),'hermes-browser-voice-'));
fs.mkdirSync(report,{recursive:true});
const calls=[],errors=[],nativeInputs=[],feeds=new Map();let nativeCompletedAt=null;
function wav(seconds=3,mic=false){const rate=48000,n=rate*seconds,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++){const voiced=!mic || (i>rate*.2 && i<rate);b.writeInt16LE(voiced?Math.round(5000*Math.sin(i*2*Math.PI*440/rate)):0,44+i*2);}return b;}
const microphone=path.join(report,'fixture-mic.wav');fs.writeFileSync(microphone,wav(4,true));
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');const p=url.pathname;
 const json=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data}));};
 if(p==='/api/voice-personas/catalog')return json({personas:[{id:'nestor',voice:{provider:'voxcpm',source:'instance',presentation:'masculine',voices:{fr:'fixture_voice',en:'fixture_voice'}}}]});
 if(p==='/api/voix/transcribe'){const body=Buffer.concat(await Array.fromAsync(req));calls.push({kind:'stt',bytes:body.length});return json({text:'Bonjour, réponds brièvement.',language:'fr'});}
 if(p==='/api/voix/synthesize/stream'){const body=JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());calls.push({kind:'tts',at:Date.now(),...body});res.setHeader('Content-Type','audio/wav');return res.end(wav(.4));}
 const local=p.startsWith('/js/voice/') ? path.join(root,'core/public',p) : p==='/assets/household/persona-presentation.js' ? path.join(root,'core/surfaces/household/public/persona-presentation.js') : p==='/api/voix/player.js' ? path.join(root,'integrations/voix/app/web/voice-audio.js') : null;
 if(local && fs.existsSync(local)){res.setHeader('Content-Type','text/javascript');return fs.createReadStream(local).pipe(res);}
 if(p.startsWith('/hermes/')){
  const headers={...req.headers,host:'127.0.0.1','x-forwarded-prefix':'/hermes',origin:'http://127.0.0.1'};
  delete headers['x-forwarded-for'];delete headers['x-forwarded-proto'];
  const proxy=http.request(new URL(url.pathname.slice('/hermes'.length)+url.search,upstream),{method:req.method,headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
  proxy.on('error',e=>{res.statusCode=502;res.end(e.message);});req.pipe(proxy);return;
 }
 res.statusCode=404;res.end('fixture route unavailable');
});
function emit(channel,type,payload){for(const socket of feeds.get(channel)||[])socket.send(JSON.stringify({jsonrpc:'2.0',method:'event',params:{type,session_id:'cpu-native-turn',payload}}));}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+microphone]});
 try{
  const context=await browser.newContext({permissions:['microphone'],viewport:{width:1400,height:950}});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.captureCalls=0;window.stoppedTracks=0;window.playedBuffers=0;const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async options=>{window.captureCalls++;const stream=await original(options);stream.getTracks().forEach(track=>{const stop=track.stop.bind(track);track.stop=()=>{window.stoppedTracks++;stop();};});return stream;};const start=AudioBufferSourceNode.prototype.start;AudioBufferSourceNode.prototype.start=function(...args){window.playedBuffers++;return start.apply(this,args);};});
  await page.routeWebSocket(/\/api\/events(?:\?|$)/,socket=>{const channel=new URL(socket.url()).searchParams.get('channel');if(!feeds.has(channel))feeds.set(channel,new Set());feeds.get(channel).add(socket);socket.onClose(()=>feeds.get(channel)?.delete(socket));});
  await page.routeWebSocket(/\/api\/ws(?:\?|$)/,socket=>socket.onMessage(raw=>{const q=JSON.parse(raw);if(q.id)socket.send(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{session_id:'sidecar-fixture'}}));}));
  await page.routeWebSocket(/\/api\/pty(?:\?|$)/,socket=>{
   const channel=new URL(socket.url()).searchParams.get('channel');socket.send('CPU fixture: native chat transport ready.\r\n');let draft=null;
   socket.onMessage(raw=>{
    if(typeof raw!=='string')return;
    if(raw.includes('\x1b[200~')){draft=raw;socket.send('Native composer accepted the paste.\r\n');return;}
    if(raw!=='\r'||!draft)return;
    nativeInputs.push(draft);draft=null;emit(channel,'message.start',{});
    emit(channel,'message.interim',{text:'Je consulte les informations nécessaires.',already_streamed:false});
    setTimeout(()=>{nativeCompletedAt=Date.now();emit(channel,'message.delta',{text:'La voix du navigateur est prête.'});emit(channel,'message.complete',{status:'complete',text:'La voix du navigateur est prête.'});socket.send('\r\nLa voix du navigateur est prête.\r\n');},800);
   });
  });
  await page.goto(origin+'/hermes/chat',{waitUntil:'domcontentloaded'});
  const button=page.getByRole('button',{name:'Parler à Nestor',exact:true});await button.waitFor();await page.waitForFunction(()=>!document.querySelector('.agentx-voice button')?.disabled,{timeout:20000});
  assert.equal(await page.evaluate(()=>captureCalls),0,'no microphone before explicit click');
  assert.equal(await page.getByText(/Managing profile/).count(),0,'principal dashboard has no other-profile warning');
  await button.click();await page.waitForFunction(()=>document.querySelector('.agentx-voice [role=status]')?.textContent==='Je t’écoute',{timeout:12000});
  await page.waitForFunction(()=>window.playedBuffers>=2,{timeout:18000});
  await page.getByRole('button',{name:'Arrêter le micro',exact:true}).click();
  await page.waitForFunction(()=>window.stoppedTracks>0);
  assert.equal(nativeInputs.length,1,'one voice request, no model replay');assert.ok(nativeInputs[0].includes('Bonjour, réponds brièvement.'));
  assert.ok(calls.some(c=>c.kind==='stt'&&c.bytes>44));assert.ok(calls.some(c=>c.kind==='tts'&&c.voice==='fixture_voice'&&c.tts_provider==='voxcpm'));
  assert.equal(calls.filter(c=>c.kind==='tts').length,2,'commentary and final response are each spoken once');
  assert.ok(calls.find(c=>c.kind==='tts').at<nativeCompletedAt,'native commentary starts synthesis before the tool-backed final response');
  assert.equal(await page.evaluate(()=>captureCalls),1);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(report,'browser.png'),fullPage:true});
  await page.getByRole('button',{name:'Parler à Nestor',exact:true}).click();
  await page.waitForFunction(()=>window.captureCalls===2);
  await page.getByRole('link',{name:/sessions/i}).first().click();
  await page.waitForFunction(()=>window.stoppedTracks>=2);
  assert.equal(nativeInputs.length,1,'leaving chat stops capture before another prompt');
  await page.getByRole('link',{name:/^chat$/i}).first().click();
  await page.waitForFunction(()=>!document.querySelector('.agentx-voice button')?.disabled);
  await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('Microphone permission denied','NotAllowedError'));});
  await page.getByRole('button',{name:'Parler à Nestor',exact:true}).click();
  await page.locator('.agentx-voice [role=alert]').waitFor();
  assert.equal(nativeInputs.length,1,'denied permission cannot submit a request');
  const result={nativeInputs:nativeInputs.length,sttRequests:calls.filter(x=>x.kind==='stt').length,ttsRequests:calls.filter(x=>x.kind==='tts').length,commentaryBeforeFinal:true,permissionOnlyOnClick:true,tracksReleased:true,navigationReleasesMic:true,permissionDenialHandled:true,browserPlayback:true,pageErrors:errors,modelRequests:0};
  fs.writeFileSync(path.join(report,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
