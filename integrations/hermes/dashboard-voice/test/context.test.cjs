const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const ts=require('node:module');
// Node's built-in TypeScript stripping executes the actual generic host adapter.
const source=fs.readFileSync(require.resolve('../host/chat-plugin-context.ts'),'utf8');
const compiled=ts.stripTypeScriptTypes(source,{mode:'strip'}).replace('export function createChatPluginContext','function createChatPluginContext');
const createChatPluginContext=new Function(compiled+';return createChatPluginContext')();
test('native paste is scoped to the active chat generation, including profile switches',()=>{
 const frames=[];let scope='a';const ws={readyState:1,send:t=>frames.push(t)};
 const c=createChatPluginContext({channel:'channel-a',profile:'primary',scope,active:true,ready:true,getSocket:()=>ws,getScope:()=>scope});
 c.submitText('bonjour');assert.deepEqual(frames,['\x1b[200~bonjour\x1b[201~\r']);scope='b';assert.throws(()=>c.submitText('stale'),/chat changed/);assert.equal(frames.length,1);
});
test('transcription cannot inject terminal escape sequences',()=>{
 const c=createChatPluginContext({scope:'a',active:true,ready:true,getSocket:()=>({readyState:1,send(){throw Error('must not send')}}),getScope:()=> 'a'});
 assert.throws(()=>c.submitText('hello\x1b[2J'),/terminal controls/);
 assert.throws(()=>c.submitText('hello\x9b2J'),/terminal controls/);
});
