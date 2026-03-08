const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { execFileSync } = require('child_process');

const MONGO_JSON_FILE = path.join(__dirname, '.jest-mongo.json');
const MONGO_URI_FILE = path.join(__dirname, '.jest-mongo-uri');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processExists(pid) {
  if (!pid) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessTree(pid) {
  if (!processExists(pid)) return;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore
  }

  const gracefulDeadline = Date.now() + 1500;
  while (Date.now() < gracefulDeadline && processExists(pid)) {
    await sleep(100);
  }

  if (!processExists(pid)) return;

  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // ignore
  }

  const forcedDeadline = Date.now() + 5000;
  while (Date.now() < forcedDeadline && processExists(pid)) {
    await sleep(100);
  }
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
        await terminateProcessTree(pid);
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
