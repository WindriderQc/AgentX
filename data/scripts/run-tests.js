'use strict';
const { MongoMemoryServer } = require('mongodb-memory-server');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { run } = require('../../shared/testing/runJest');

(async () => {
  const mongo = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION || '7.0.24' }, spawn: { windowsHide: true } });
  try {
    process.env.TEST_USE_EXTERNAL_MONGO = 'true';
    process.env.MONGODB_URI_TEST = mongo.getUri(`agentx_data_test_${randomUUID().replace(/-/g, '')}`);
    process.env.MONGODB_URI = process.env.MONGODB_URI_TEST;
    delete process.env.MONGO_TEST_URI;
    process.exitCode = await run(path.resolve(__dirname, '..'));
  } finally { await mongo.stop(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
