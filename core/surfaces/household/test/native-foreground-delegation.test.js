'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { nativeTurnStarted, isForegroundRun } = require('../persona-native-start');
const { registerConversationWorkRoutes } = require('../../../src/services/conversationWorks/routes');

test('only active authenticated native foreground delegation receives a source-free decision', async () => {
  const session = { sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal', agentId: 'main' };
  const entry = { abort: new AbortController() }, turns = new Map([[session.sessionId, entry]]);
  const context = { agentId: 'main', runId: 'resp_' + randomUUID(), sessionKey: 'agent:main:household:direct:' + session.sessionId };
  const env = { PERSONAL_CONVERSATION_WORK_TOKEN: randomUUID(), HOUSEHOLD_NATIVE_EXPLICIT_INPUT_ONLY: 'true' };
  const app = express(); app.use(express.json());
  registerConversationWorkRoutes(app, { works: {}, env, isForegroundRun: native => isForegroundRun(turns, native) });
  const body = { operation: 'guardian_tool', context, input: { tool: 'sessions_spawn' }, callId: 'call_synthetic_1' };
  const post = (changes = {}) => request(app).post('/native/work').set('Authorization', 'Bearer '+env.PERSONAL_CONVERSATION_WORK_TOKEN).send({ ...body, ...changes });
  const start = changes => nativeTurnStarted({ session, turnSession: session, backend: 'openclaw', inputOnly: true,
    entry, conversations: { updateSession: async () => {} }, ...changes })(context.sessionKey, context.runId);

  assert.equal((await post()).status, 409);
  await start({session:{...session,scopeId:'family'}});
  assert.equal((await post()).status, 409);
  await start();
  assert.deepEqual((await post()).body.data,{authority:'core.conversation-works', foreground:true,delegated:false});
  assert.deepEqual((await post({operation:'native_budget'})).body.data,{authority:'core.conversation-works',foreground:true,admitted:true});
  assert.equal((await request(app).post('/native/work').send(body)).status,403);
  for(const changes of [{input:{tool:'gmail_secretary_read'}},{operation:'guardian_read'},{operation:'context'},{operation:'publish'},
    {callId:''},{context:{...context,runId:'resp_'+randomUUID()}},{context:{...context,agentId:'family'}},{input:{tool:'sessions_spawn',query:'private'}}]){
    assert.equal((await post(changes)).status,409);
  }
  env.HOUSEHOLD_PROTECTED_SOURCES_LOCAL_ONLY='true';
  assert.equal((await post()).body.code,'HOUSEHOLD_PROTECTED_SOURCES_LOCAL_ONLY');
  delete env.HOUSEHOLD_PROTECTED_SOURCES_LOCAL_ONLY;
  entry.executionSettled=true;
  assert.equal((await post()).status,409);
  entry.executionSettled=false; entry.abort.abort();
  assert.equal((await post()).status,409);
  turns.clear();
  assert.equal((await post()).status,409);
});
