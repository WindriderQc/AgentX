const {test}=require('node:test');const assert=require('node:assert/strict');
const {Bridge}=require('../dashboard/bridge.js');
class Socket {
 constructor(url){this.url=url;Socket.last=this;queueMicrotask(()=>this.onopen());}
 close(){this.onclose?.();}
 frame(type,session_id,payload){this.onmessage({data:JSON.stringify({jsonrpc:'2.0',method:'event',params:{type,session_id,payload}})+'\n'});}
}
async function setup(){const sent=[];const b=new Bridge({channel:'chat-a',submitText:t=>sent.push(t)},{sdk:{buildWsUrl:async(path,params)=>{assert.equal(path,'/api/events');assert.equal(params.channel,'chat-a');return 'wss://agent.test/events';}},WebSocketImpl:Socket});await b.connect();return {b,sent,ws:Socket.last};}
test('one transcript enters the native chat once; only its assistant text is spoken',async()=>{
 const {b,sent,ws}=await setup();const deltas=[];const p=b.turn('Bonjour',new AbortController().signal,x=>deltas.push(x));
 ws.frame('message.start','native-1');ws.frame('reasoning.delta','native-1',{text:'private reasoning'});ws.frame('tool.complete','native-1',{text:'tool output'});
 ws.frame('message.delta','other-session',{text:'other chat'});ws.frame('message.delta','native-1',{text:'Salut.'});
 ws.frame('message.complete','native-1',{text:'Salut.',status:'complete'});
 assert.deepEqual(await p,{text:'Salut.'});assert.deepEqual(sent,['Bonjour']);assert.deepEqual(deltas,['Salut.']);b.close();
});
test('a lost connection after submission is uncertain and never replays the prompt',async()=>{
 const {b,sent,ws}=await setup();const p=b.turn('Original',new AbortController().signal);const refused=assert.rejects(p,/Connexion interrompue/);ws.close();await refused;
 await assert.rejects(b.turn('Replacement',new AbortController().signal),/Connexion interrompue/);assert.deepEqual(sent,['Original']);b.close();
});
test('an unrelated active native turn cannot be replaced by recorded speech',async()=>{
 const {b,sent,ws}=await setup();ws.frame('message.start','typed-turn');await assert.rejects(b.turn('spoken',new AbortController().signal),/Attends/);assert.deepEqual(sent,[]);b.close();
});
test('stopping voice does not submit again or destroy the native chat',async()=>{
 const {b,sent,ws}=await setup();const abort=new AbortController();const p=b.turn('Hello',abort.signal);const stopped=assert.rejects(p,{name:'AbortError'});abort.abort();await stopped;
 ws.frame('message.complete','native-1',{text:'The native answer still exists',status:'complete'});assert.deepEqual(sent,['Hello']);b.close();
});
