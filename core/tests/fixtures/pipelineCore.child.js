'use strict';

// Disposable Core process for interruption scenarios. The Pipeline routes,
// services, models and MongoDB are real; only the crash point is a fixture:
// with PIPELINE_CRASH_AT set, the process reports the committed write over IPC
// and never answers, so the parent can terminate it before its response.
process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const express = require('express');
const PipelineTask = require('../../models/PipelineTask');

const crashAt = process.env.PIPELINE_CRASH_AT || '';
const port = Number(process.env.PIPELINE_CHILD_PORT);
const send = message => process.send?.(message);

const boundaries = {
  // Automated claim: attempt pushed, lease written.
  claim: update => Boolean(update?.$push?.automationAttempts),
  // Worker terminal feedback: attempt closed, lease removed, slot still held.
  feedback: update => Boolean(update?.$set?.['automationAttempts.$[attempt].finalState'] && update?.$push?.feedback),
  // Human review decision recorded against the latest attempt.
  review: update => Boolean(update?.$set?.['automationAttempts.$[reviewAttempt].reviewOutcome']),
};

if (crashAt) {
  if (!boundaries[crashAt]) throw new Error(`Unknown crash boundary: ${crashAt}`);
  const original = PipelineTask.findOneAndUpdate.bind(PipelineTask);
  PipelineTask.findOneAndUpdate = function crashAfterCommit(filter, update, options) {
    const query = original(filter, update, options);
    if (!boundaries[crashAt](update)) return query;
    return query.exec().then(async document => {
      if (!document) return document;
      send({ event: `committed:${crashAt}` });
      // Hold the response until the parent kills this process.
      await new Promise(() => {});
      return document;
    });
  };
}

(async () => {
  await mongoose.connect(process.env.PIPELINE_CHILD_MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  const app = express();
  app.use(express.json());
  app.use('/api/pipeline', require('../../routes/pipeline'));
  const server = app.listen({ host: '127.0.0.1', port, exclusive: true }, () => send({ event: 'ready', pid: process.pid }));
  server.on('error', error => { send({ event: 'error', message: error.message }); process.exit(2); });
  process.on('message', async message => {
    if (message?.command !== 'stop') return;
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  });
})().catch(error => {
  send({ event: 'error', message: error.message });
  process.exit(1);
});
