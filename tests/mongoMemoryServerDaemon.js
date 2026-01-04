const fs = require('fs');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

const MONGO_JSON_FILE = path.join(__dirname, '.jest-mongo.json');
const MONGO_URI_FILE = path.join(__dirname, '.jest-mongo-uri');

async function main() {
  const useExternalMongo = process.env.TEST_USE_EXTERNAL_MONGO === 'true';
  if (useExternalMongo) {
    process.exit(0);
  }

  const mongod = await MongoMemoryServer.create({
    instance: {
      dbName: 'agentx_test',
      launchTimeout: 30000
    }
  });

  const baseUri = mongod.getUri();
  const payload = {
    baseUri,
    pid: process.pid,
    startedAt: new Date().toISOString()
  };

  fs.writeFileSync(MONGO_JSON_FILE, JSON.stringify(payload), 'utf8');
  fs.writeFileSync(MONGO_URI_FILE, baseUri, 'utf8');

  const shutdown = async () => {
    try {
      await mongod.stop();
    } catch {
      // ignore
    }

    try {
      fs.unlinkSync(MONGO_JSON_FILE);
    } catch {
      // ignore
    }

    try {
      fs.unlinkSync(MONGO_URI_FILE);
    } catch {
      // ignore
    }

    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Keep the process alive for the duration of the Jest run.
  setInterval(() => {}, 1 << 30);
}

main().catch(err => {
  try {
    fs.writeFileSync(MONGO_JSON_FILE, JSON.stringify({ error: String(err) }), 'utf8');
  } catch {
    // ignore
  }
  // eslint-disable-next-line no-console
  console.error('mongoMemoryServerDaemon failed:', err);
  process.exit(1);
});
