'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHermesTransport } = require('../../../src/services/conversations/hermesTransport');
const { householdUserText } = require('../../../src/services/conversations/protectedSources');
const { createAgentClient } = require('../conversation-agent');
const { createConversationExecutor } = require('../conversation-executor');
const { packById } = require('../packs');
const { harness } = require('./fixtures/persona-journey.cjs');
const { createCatalog } = require('../../../public/js/screen-pages');

const env = { HOUSEHOLD_NATIVE_EXPLICIT_INPUT_ONLY: 'true', HOUSEHOLD_HERMES_URL: 'http://127.0.0.1:1', HOUSEHOLD_HERMES_TOKEN: 'fixture',
  HOUSEHOLD_CONVERSATION_RELAY_ENABLED: 'true', OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:1', OPENCLAW_GATEWAY_TOKEN: 'fixture' };
const current = 'A voluntary synthetic question', previous = 'RETAINED_PRIVATE_FIXTURE', blocked = 'HOUSEHOLD_NATIVE_SOURCE_TRANSFER_BLOCKED';
const pack = packById('personal_operator');
function transport(fetchImpl) {
  return createHermesTransport({ env, fetchImpl, persist: async () => {}, stopMs: 100, pollMs: 1 });
}
function wireResponse(url, options, calls) {
  const path = new URL(url).pathname;
  calls.push({ path, body: options.body && JSON.parse(options.body), sessionKey: options.headers['X-Hermes-Session-Key'] });
  if (path === '/v1/runs') return Response.json({ run_id: 'run_fixture' });
  if (path.endsWith('/events')) return new Response('data: {"event":"run.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  return Response.json({ run_id: 'run_fixture', status: 'completed', completed: true, partial: false, output: 'Synthetic reply', usage: {} });
}

for (const retained of [false, true]) {
  test('only the current human text reaches the Hermes wire for a ' + (retained ? 'retained' : 'new') + ' household conversation', async () => {
    const calls = [], reads = [];
    const hermesClient = transport((url, init) => wireResponse(url, init, calls));
    const screenPages = createCatalog([{ id:'fixture', label:'Fixture', href:'/fixture', mode:'frame' }]);
    const j = harness({ packId: pack.id, backend: 'hermes', conversationEnv: env, hermesClient, screenPages, failContext: kind => reads.push(kind) });
    j.state.notes = [{text:previous}]; j.state.profiles = [{id:'fixture',displayName:previous}]; j.state.advice = previous;
    j.turns.push({inputText:previous,replyText:previous,createdAt:new Date(),traceId:'older-fixture',outcome:'completed'});
    if (retained) j.session.agentSessionKey = 'agentx:personal:' + j.session.sessionId;
    await j.turn(current, retained ? 'voice' : 'text', { screen:[{page:'fixture',status:'visible',title:previous}] });
    const submissions = calls.filter(call => call.path === '/v1/runs');
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].sessionKey, 'agentx:personal:' + j.session.sessionId);
    assert.deepEqual(submissions[0].body, {input:[{role:'user',content:current}],instructions:''});
    assert.deepEqual(reads, []);
    assert.equal(j.turns[0].replyText, 'Synthetic reply');
    const res = { on() {},removeListener() {},writableEnded:false,headersSent:false };
    await j.handle({params:{sessionId:j.session.sessionId},body:{text:current,attachmentIds:['fixture-file']}},res,'private');
    assert.equal(res.failure?.code, blocked);
    assert.equal(res.failure?.status, 409);
    assert.equal(calls.filter(call=>call.path==='/v1/runs').length, 1);
  });
}

test('a native OpenClaw submission retains its agent and sends no screen, synthetic source, prior output or history', async () => {
  const session = {sessionId:'fixture',packId:pack.id,scopeId:'personal',modeId:'operator',agentId:'main'};
  const calls = [];
  const agent = createAgentClient({env,fetchImpl:async (_url,init)=>{calls.push(JSON.parse(init.body));throw new Error('Synthetic transport boundary');}});
  const request = {session,[householdUserText]:current,text:current,channel:'text',currentContent:[{type:'input_text',text:previous}],
    turnContext:previous, turnDirective:previous,instructions:previous,history:[{role:'user',content:previous}],
    browserReply:{previousOutput:{type:'message',content:previous}}};
  for (const key of ['', 'agent:main:household:direct:fixture']) {
    session.agentSessionKey = key;
    await assert.rejects(agent(request));
    const body = calls.at(-1);
    assert.equal(body.model,'openclaw/main');
    assert.deepEqual(body.input,[{type:'message',role:'user',content:current}]);
    assert.equal(JSON.stringify(body).includes(previous),false);
    assert.equal(body.tools,undefined);
  }
  await assert.rejects(agent({...request,[householdUserText]:undefined}),{code:blocked});
  assert.equal(calls.length,2);
});

test('an uncertain old Hermes admission cannot resubmit its previously enriched body', async () => {
  let attempts = 0;
  const hermes = transport(async()=>{attempts++;throw new Error('Unexpected call');});
  const session = {sessionId:'fixture',packId:pack.id,scopeId:'personal'};
  for (const tag of [undefined,'explicit-user-text']) {
    session.hermesRuntime = {state:'dispatching',key:'old-fixture',startedAt:new Date().toISOString(),
      inputPolicy:tag,requestText:current,body:{input:[{role:'user',content:previous}],instructions:previous}};
    await assert.rejects(hermes({session,pack,text:current,[householdUserText]:current}),{code:blocked});
    assert.equal(session.hermesRuntime.key,'old-fixture');
  }
  assert.equal(attempts,0);
});

test('the continuity relay receives only the current utterance and cannot load a recap or attachment', async () => {
  const captures = [];
  const hermes = Object.assign(async()=>assert.fail('Occupied native engine was submitted'),{occupation:async()=>({state:'running'})});
  const execute = createConversationExecutor({env,hermesClient:hermes,personalRecaps:{read:async()=>assert.fail('Loaded a recap')},
    inference:{conversation:async(body,options)=>{captures.push([body,options.relayRequest]);return {ok:true,body:{response:'Synthetic relay response'},metadata:{}};}}});
  const result=await execute({backend:'hermes',session:{sessionId:'fixture',scopeId:'personal',packId:pack.id,modeId:'operator'},pack,channel:'voice',
    text:current,[householdUserText]:current,turnContext:previous,history:[{role:'user',content:previous}],hermesInstructions:previous,agentxInstructions:previous,
    attachmentStore:{prepare:async()=>assert.fail('Loaded an attachment')},conversationFeatures:{recapContext:true}});
  assert.ok(result);assert.equal(captures.length,1);
  for(const body of captures[0]) {
    assert.equal(JSON.stringify(body).includes(previous),false);
    assert.ok(body.messages.some(message=>message.role==='user'&&message.content===current));
  }
});
