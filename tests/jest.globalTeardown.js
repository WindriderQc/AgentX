const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const MONGO_JSON_FILE = path.join(__dirname, '.jest-mongo.json');
const MONGO_URI_FILE = path.join(__dirname, '.jest-mongo-uri');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = async () => {
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }

  try {
    if (fs.existsSync(MONGO_JSON_FILE)) {
      const raw = fs.readFileSync(MONGO_JSON_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      const pid = parsed?.pid;
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // ignore
        }

        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && (fs.existsSync(MONGO_JSON_FILE) || fs.existsSync(MONGO_URI_FILE))) {
          await sleep(100);
        }
      }
    }
  } catch {
    // ignore
  } finally {
    try { fs.unlinkSync(MONGO_JSON_FILE); } catch { /* ignore */ }
    try { fs.unlinkSync(MONGO_URI_FILE); } catch { /* ignore */ }
  }

  if (global.gc) {
    global.gc();
  }

  await new Promise(resolve => setTimeout(resolve, 250));
};
