'use strict';

// Optional owner-only presentation settings. These never enter history entries,
// source records, decisions, or memories. No default subjects are invented.
const fs = require('node:fs/promises');
const MAX_BYTES = 32 * 1024;
const clean = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';

function normalize(value) {
  const threads = Array.isArray(value?.storyThreads) ? value.storyThreads : [];
  const seen = new Set();
  return { storyThreads: threads.slice(0, 12).filter(t => t && typeof t.id === 'string' && /^[a-z0-9-]{1,80}$/.test(t.id) && clean(t.label, 120))
    .filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; }).map(t => ({
      id: t.id, label: clean(t.label, 120), hint: clean(t.hint, 500),
      eventIds: (Array.isArray(t.eventIds) ? t.eventIds : []).slice(0, 30).map(v => clean(v, 256)).filter(Boolean),
      queries: (Array.isArray(t.queries) ? t.queries : []).slice(0, 10).filter(Array.isArray)
        .map(q => q.slice(0, 5).map(v => clean(v, 100)).filter(Boolean)).filter(q => q.length),
    })) };
}

async function read(file = process.env.ATLAS_DISPLAY_PREFERENCES_PATH) {
  if (!file) return { storyThreads: [] };
  let handle;
  try {
    handle = await fs.open(file, 'r');
    if (!(await handle.stat()).isFile()) return { storyThreads: [] };
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) return { storyThreads: [] };
    return normalize(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  } catch {
    // A missing or malformed optional display file cannot hide the history.
    return { storyThreads: [] };
  } finally { await handle?.close(); }
}

module.exports = { normalize, read };
