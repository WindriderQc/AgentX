'use strict';

const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Inspect the first NDJSON event before committing success headers, then forward
// every original byte. Cancellation also unblocks a reader waiting for frames.
async function firstEvent(body, signal) {
  const reader = body.getReader();
  const chunks = [];
  const cancel = () => reader.cancel().catch(() => {});
  const aborted = () => { void cancel(); };
  signal?.addEventListener('abort', aborted, { once: true });
  const cleanup = async () => {
    signal?.removeEventListener('abort', aborted);
    await cancel();
  };
  let text = '';
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (value) { const chunk = Buffer.from(value); chunks.push(chunk); text += chunk.toString('utf8'); }
      const end = text.indexOf('\n');
      if ((end < 0 ? text.length : end) > 65536) throw new Error('Invalid voice stream header');
      if (end >= 0 || done) {
        let event = null;
        try { event = JSON.parse(end >= 0 ? text.slice(0, end) : text); } catch { /* forwarded as is */ }
        async function* rest() {
          try {
            yield* chunks;
            for (;;) { const next = await reader.read(); if (next.done) return; yield Buffer.from(next.value); }
          } finally { await cleanup(); }
        }
        return { event, stream: Readable.from(rest()), cancel: cleanup };
      }
    }
  } catch (error) { await cleanup(); throw error; }
}

async function relaySynthesisStream(response, res) {
  const abort = new AbortController();
  const close = () => { if (!res.writableFinished) abort.abort(); };
  res.once('close', close);
  let head;
  try {
    head = await firstEvent(response.body, abort.signal);
    if (head.event?.type === 'error') {
      throw Object.assign(new Error('Local speech synthesis failed'), { code: 'VOICE_SYNTHESIS_FAILED', statusCode: 503 });
    }
    res.set('Content-Type', response.headers.get('content-type') || 'application/x-ndjson');
    res.set('X-Accel-Buffering', 'no');
    res.set('Cache-Control', 'no-store');
    for (const name of ['x-voix-provider', 'x-voix-voice', 'x-voix-language']) {
      if (response.headers.has(name)) res.set(name, response.headers.get(name));
    }
    await pipeline(head.stream, res);
  } finally {
    res.off('close', close);
    await head?.cancel();
  }
}

module.exports = { firstEvent, relaySynthesisStream };
