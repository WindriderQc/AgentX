const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MONGO_JSON_FILE = path.join(__dirname, '.jest-mongo.json');
const MONGO_URI_FILE = path.join(__dirname, '.jest-mongo-uri');
const DAEMON_SCRIPT = path.join(__dirname, 'mongoMemoryServerDaemon.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getStartupDeadlineMs() {
  const configured = Number(process.env.JEST_MONGO_START_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return process.platform === 'win32' ? 120000 : 30000;
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
  const deadline = Date.now() + getStartupDeadlineMs();
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

  // Fall back to per-process MongoMemoryServer startup in setup-env.js.
  // This is slower, but avoids hard-failing on Windows when the first
  // binary download or extraction takes longer than expected.
  // eslint-disable-next-line no-console
  console.warn('Jest Mongo daemon did not become ready before the startup deadline; falling back to per-process startup.');
};
