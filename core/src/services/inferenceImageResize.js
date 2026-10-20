'use strict';
// Core owns image size for inference: callers (Nestor, Famille, scripts) send
// photos as they are, and Core shrinks any whose longest side exceeds
// INFERENCE_IMAGE_MAX_SIDE before Ollama sees them. Vision models downsize
// internally anyway, so a 12 MP original only costs transfer and decode time.
// Anything this module cannot read (WebP, GIF, corrupt data, worker failure)
// is sent unchanged, exactly as before.
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DEFAULT_MAX_SIDE = 2048;
const JPEG_QUALITY = 90;
const WORKER_TIMEOUT_MS = 60000;

function maxSide(env = process.env) {
  const raw = env.INFERENCE_IMAGE_MAX_SIDE;
  if (raw === undefined || raw === '') return DEFAULT_MAX_SIDE;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_SIDE; // 0 disables
}

// Reads only the header: PNG IHDR or the JPEG start-of-frame marker.
function imageSize(bytes) {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    const length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { mimeType: 'image/jpeg', height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

function runWorker(jobs, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'inferenceImageResizeWorker.js'), { workerData: { jobs } });
    const stop = err => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); worker.terminate(); reject(err); };
    const onAbort = () => stop(signal.reason || new Error('aborted'));
    const timer = setTimeout(() => stop(new Error('image resize timed out')), WORKER_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', results => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); worker.terminate(); resolve(results);
    });
    worker.once('error', stop);
  });
}

/** Returns { messages, stats }. Input messages are never mutated. */
async function shrinkMessageImages(messages, { signal, env = process.env, run = runWorker } = {}) {
  const limit = maxSide(env);
  const stats = { images: 0, resized: 0, unreadable: 0, maxSide: limit, details: [] };
  if (!Array.isArray(messages)) return { messages, stats };
  const jobs = [];
  messages.forEach((message, m) => (Array.isArray(message?.images) ? message.images : []).forEach((image, k) => {
    stats.images++;
    if (!limit || typeof image !== 'string') return;
    const size = imageSize(Buffer.from(image.slice(0, 256 * 1024), 'base64'));
    if (!size) { stats.unreadable++; return; }
    if (Math.max(size.width, size.height) > limit) {
      jobs.push({ m, k, base64: image, mimeType: size.mimeType, maxSide: limit, quality: JPEG_QUALITY });
    }
  }));
  if (!jobs.length) return { messages, stats };

  let results;
  try {
    results = await run(jobs, signal);
  } catch (err) {
    // On cancellation the caller checks its own signal; the originals are returned untouched.
    stats.error = String(err.message).slice(0, 200);
    return { messages, stats };
  }
  const next = messages.map(message => (Array.isArray(message?.images) ? { ...message, images: [...message.images] } : message));
  jobs.forEach((job, j) => {
    const r = results[j] || {};
    if (r.resized && typeof r.base64 === 'string') {
      next[job.m].images[job.k] = r.base64;
      stats.resized++;
      stats.details.push({ from: r.from, to: r.to });
    } else if (r.error) stats.unreadable++;
  });
  return { messages: next, stats };
}

module.exports = { shrinkMessageImages, imageSize, maxSide, DEFAULT_MAX_SIDE };
