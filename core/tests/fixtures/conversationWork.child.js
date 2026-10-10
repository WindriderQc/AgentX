'use strict';
const mongoose = require('mongoose');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { createConversationWorks } = require('../../src/services/conversationWorks/service');
const { createWorkObserver } = require('../../src/services/conversationWorks/observer');
(async () => {
  await mongoose.connect(process.env.WORK_TEST_MONGO_URI, { autoCreate: false, autoIndex: false });
  const works = createConversationWorks({ conversations: forSurface('household'), tasks: {}, env: {} });
  const observer = createWorkObserver({ works, env: { PERSONAL_CONVERSATION_WORK_AGENT_ID: 'worker' },
    observe: async () => null,
    execute: async ({ row }) => {
      process.send({ event: 'dispatched', workId: row._id, attempt: row.attempt });
      await new Promise(() => {});
    } });
  await observer.tick();
})().catch(error => { process.stderr.write(error.stack); process.exit(1); });
