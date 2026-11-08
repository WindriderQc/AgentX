const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const ts=require('node:module');
const source=fs.readFileSync(require.resolve('../host/chat-plugin-context.ts'),'utf8');
const compiled=ts.stripTypeScriptTypes(source,{mode:'strip'}).replace('export function createChatPluginContext','function createChatPluginContext');
const createChatPluginContext=new Function(compiled+';return createChatPluginContext')();
function setup(){
 const frames=[];let scope='a';const ws=new EventTarget();ws.readyState=1;ws.send=t=>frames.push(t);
 const c=createChatPluginContext({channel:'channel-a',profile:'primary',scope,active:true,ready:true,getSocket:()=>ws,getScope:()=>scope});
 return {c,ws,frames,change(){scope='b';},output:data=>ws.dispatchEvent(new MessageEvent('message',{data}))};
}
test('native paste waits for PTY acknowledgement before a separate Enter, once',async()=>{
 const {c,frames,output}=setup();const done=c.submitText('bonjour');
 assert.deepEqual(frames,['\x1b[200~bonjour\x1b[201~']);
 output('{"type":"session-title","title":"metadata"}');await Promise.resolve();assert.equal(frames.length,1);
 output('\x1b[1Gbonjour');output('another terminal update');await done;
 assert.deepEqual(frames,['\x1b[200~bonjour\x1b[201~','\r']);
});
test('a profile change between paste and acknowledgement cannot submit a stale draft',async()=>{
 const {c,frames,change,output}=setup();const done=c.submitText('bonjour');change();output('echo');
 await assert.rejects(done,/chat changed/);assert.equal(frames.length,1);assert.throws(()=>c.submitText('stale'),/chat changed/);
});
test('stopping voice before paste acknowledgement leaves a draft and never presses Enter',async()=>{
 const {c,frames,output}=setup();const abort=new AbortController();const done=c.submitText('bonjour',abort.signal);
 abort.abort();await assert.rejects(done,{name:'AbortError'});output('late echo');await Promise.resolve();assert.equal(frames.length,1);
});
test('lost terminal acknowledgement is bounded and never resends input',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const {c,frames,output}=setup();const done=c.submitText('bonjour');
 t.mock.timers.tick(3000);await assert.rejects(done,/did not acknowledge/);output('late echo');await Promise.resolve();assert.equal(frames.length,1);
});
test('terminal disconnect refuses the pending Enter',async()=>{
 const {c,ws,frames}=setup();const done=c.submitText('bonjour');ws.readyState=3;ws.dispatchEvent(new Event('close'));
 await assert.rejects(done,/disconnected/);assert.equal(frames.length,1);
});
test('transcription cannot inject terminal escape sequences',()=>{
 const {c}=setup();assert.throws(()=>c.submitText('hello\x1b[2J'),/terminal controls/);assert.throws(()=>c.submitText('hello\x9b2J'),/terminal controls/);
});
