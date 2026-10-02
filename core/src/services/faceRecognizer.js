'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

// One lazily started worker analyses frames in order. Model loading costs a
// few seconds once; a frame then takes about half a second of worker CPU.
function createFaceRecognizer({ timeoutMs = 30000 } = {}) {
  let worker = null;
  let nextId = 0;
  const pending = new Map();

  function settleAll(error) {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  }

  function start() {
    if (worker) return worker;
    worker = new Worker(path.join(__dirname, 'faceRecognizerWorker.js'));
    worker.unref();
    worker.on('message', ({ id, faces, error }) => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (error) entry.reject(new Error(error));
      else entry.resolve(faces);
    });
    worker.on('error', error => { settleAll(error); worker = null; });
    worker.on('exit', () => { settleAll(new Error('Face recognizer stopped')); worker = null; });
    return worker;
  }

  function analyze(image) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Face analysis timed out')); }, timeoutMs);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      start().postMessage({ id, image });
    });
  }

  async function close() {
    if (worker) await worker.terminate();
    worker = null;
  }

  return { analyze, close };
}

module.exports = { createFaceRecognizer };
