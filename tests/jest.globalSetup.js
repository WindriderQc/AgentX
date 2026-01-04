const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MONGO_JSON_FILE = path.join(__dirname, '.jest-mongo.json');
const MONGO_URI_FILE = path.join(__dirname, '.jest-mongo-uri');
const DAEMON_SCRIPT = path.join(__dirname, 'mongoMemoryServerDaemon.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = async () => {
  const useExternalMongo = process.env.TEST_USE_EXTERNAL_MONGO === 'true';
  if (useExternalMongo) return;

  // Clean up any stale files from interrupted runs.
  try { fs.unlinkSync(MONGO_JSON_FILE); } catch { /* ignore */ }
  try { fs.unlinkSync(MONGO_URI_FILE); } catch { /* ignore */ }

  // Start a persistent daemon process that owns MongoMemoryServer.
  // This avoids mongodb-memory-server's internal parent-death killer from
  // terminating mongod when Jest's globalSetup process exits.
  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env }
  });
  child.unref();

  // Wait for the daemon to write connection info.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (fs.existsSync(MONGO_JSON_FILE) && fs.existsSync(MONGO_URI_FILE)) {
      const raw = fs.readFileSync(MONGO_JSON_FILE, 'utf8');
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.baseUri) return;
      } catch {
        // keep waiting
      }
    }
    await sleep(100);
  }

  throw new Error('MongoMemoryServer daemon did not become ready within 30s');
};
