'use strict';
// Disposable Core process for the native question transport qualification.
// The caller owns Mongo and the native fixture. Never defaults to an instance.
const http = require('node:http');
const express = require('express');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { createConversationWorks } = require('../../src/services/conversationWorks/service');
const { registerConversationWorkRoutes } = require('../../src/services/conversationWorks/routes');
const { createNestorClient } = require('../../surfaces/household/personal-continuity');
const Model = require('../../models/ConversationWorkState');
const uri = process.env.QUESTION_FIXTURE_MONGO_URI;
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/questions_qualification_[a-z0-9-]+$/.test(uri || '')
    || !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.QUESTION_FIXTURE_ADAPTER_URL || '') || !process.send) {
  throw Error('An explicitly owned disposable Mongo, loopback adapter and IPC parent are required.');
}
const env = { PERSONAL_CONVERSATION_WORK_MODE: 'native', PERSONAL_CONVERSATION_WORK_AGENT_ID: 'fixture-worker',
  PERSONAL_CONVERSATION_WORK_TOKEN: 'synthetic-core-question-service-token-664',
  OPENCLAW_GATEWAY_URL: process.env.QUESTION_FIXTURE_ADAPTER_URL,
  OPENCLAW_GATEWAY_TOKEN: 'synthetic-question-trigger-token-664' };
const conversations = forSurface('household');
const continuity = createNestorClient({ env });
const runtime = { observe: (row, options) => continuity({ operation: 'questions', workId: row._id }, options?.signal),
  effect: (input, options) => continuity({ operation: 'question_effect', ...input }, options?.signal) };
const works = createConversationWorks({ conversations, tasks: {}, env, nativePrimary: true,
  questionRuntime: process.env.QUESTION_FIXTURE_BRIDGE_ENABLED === 'false' ? null : runtime });
const app = express(); app.use(express.json());
const router = express.Router(); registerConversationWorkRoutes(router, { works, env }); app.use('/api/voice-personas', router);
app.post('/fixture/work', async (_req, res) => {
  try {
    const session = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal',
      modeId: 'standard', status: 'active', agentId: 'main', backend: 'openclaw', turnCount: 0 });
    const accepted = await works.intake({ session, turnId: randomUUID(), text: 'Choose a synthetic day.', channel: 'voice' });
    await works.prepare(accepted.row._id, 'Synthetic context only.');
    const attempt = { id: randomUUID(), sessionId: randomUUID(), agentId: 'main', runId: 'resp_' + randomUUID() };
    attempt.sessionKey = `agent:main:household:direct:${attempt.sessionId}`;
    const row = await works.repo.mutate(accepted.row._id, () => ({ fields: { state: 'running', attempt }, event: 'fixture_native_started' }));
    res.json({ workId: row._id, sessionId: session.sessionId, attempt });
  } catch (error) { res.status(500).json({ code: error.code || 'FIXTURE_INTAKE_FAILED' }); }
});
app.get('/fixture/work/:id', async (req, res) => {
  const row = await works.repo.get(req.params.id); res.json(row);
});
let server;
async function stop() {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect(); process.exit(0);
}
process.once('SIGTERM', () => { void stop(); });
(async () => {
  await mongoose.connect(uri);
  await Model.createCollection(); await Model.createIndexes();
  server = http.createServer(app);
  await new Promise(resolve => server.listen(Number(process.env.QUESTION_FIXTURE_CORE_PORT || 0), '127.0.0.1', resolve));
  process.send({ port: server.address().port });
})().catch(error => { process.send?.({ error: error.code || error.name }); process.exit(1); });
