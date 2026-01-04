const fs = require('fs');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

const MONGO_URI_FILE = path.join(__dirname, '.jest-mongo-uri');

module.exports = async () => {
  const useExternalMongo = process.env.TEST_USE_EXTERNAL_MONGO === 'true';
  if (useExternalMongo) return;

  const mongod = await MongoMemoryServer.create({
    instance: {
      dbName: 'agentx_test',
      launchTimeout: 30000
    }
  });

  global.__MONGOD__ = mongod;

  const baseUri = mongod.getUri();
  fs.writeFileSync(MONGO_URI_FILE, baseUri, 'utf8');
};
