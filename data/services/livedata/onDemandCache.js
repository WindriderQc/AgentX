/**
 * In-memory cache for on-demand upstream reads (TLE, tides, city weather).
 *
 * A fresh entry answers without calling the upstream, concurrent misses share
 * one request, and a key whose last fetch failed is not fetched again before
 * `failureBackoffMs` (the same error is returned instead). `peek` returns the
 * last good value whatever its age, so a caller can fall back to it and say it
 * is stale. A Data restart empties the cache; nothing is written to MongoDB.
 */

function createCache({ ttlMs, failureBackoffMs = 60_000, maxEntries = 200, now = () => Date.now() } = {}) {
  if (!(ttlMs > 0)) throw new Error('createCache needs a positive ttlMs');
  const entries = new Map();   // key -> { value, at }   (insertion order = age, oldest first)
  const failures = new Map();  // key -> { error, at }
  const inflight = new Map();  // key -> Promise

  function remember(key, value, at) {
    entries.delete(key);
    entries.set(key, { value, at });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  async function get(key, load) {
    const t = now();
    const hit = entries.get(key);
    if (hit && t - hit.at < ttlMs) return { value: hit.value, cached: true, fetchedAt: new Date(hit.at) };

    const failed = failures.get(key);
    if (failed && t - failed.at < failureBackoffMs) throw failed.error;

    if (inflight.has(key)) return inflight.get(key);
    const pending = (async () => {
      try {
        const value = await load();
        const at = now();
        remember(key, value, at);
        failures.delete(key);
        return { value, cached: false, fetchedAt: new Date(at) };
      } catch (error) {
        failures.set(key, { error, at: now() });
        throw error;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
    return pending;
  }

  function peek(key) {
    const hit = entries.get(key);
    return hit ? { value: hit.value, fetchedAt: new Date(hit.at) } : null;
  }

  function clear() {
    entries.clear();
    failures.clear();
    inflight.clear();
  }

  return { get, peek, clear };
}

/** An upstream that could not answer (502), or a source this instance has not configured (503). */
class SourceError extends Error {
  constructor(message, { status = 502, code = 'upstream_error' } = {}) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    this.code = code;
  }
}

module.exports = { createCache, SourceError };
