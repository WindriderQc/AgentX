// Transport-only discovery: never calls a tool or keeps a second tool registry.
import { createHash, randomUUID } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function catalogFingerprint(tools) {
  const ordered = tools.map(canonical).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export function createCatalogWatcher({ request, notify, log, intervalMs = 30000 }) {
  let active = null;
  let sequence = 0;
  const prefix = `agentx-catalog-${randomUUID()}`;

  async function readCatalog(signal) {
    const tools = [];
    const cursors = new Set();
    const names = new Set();
    let cursor;
    for (let page = 0; page < 100; page += 1) {
      const message = {
        jsonrpc: '2.0', id: `${prefix}-${++sequence}`, method: 'tools/list',
        ...(cursor === undefined ? {} : { params: { cursor } }),
      };
      const response = await request(message, signal);
      if (response?.id !== message.id || response.error || !Array.isArray(response.result?.tools)) {
        throw new Error('catalogue response is incomplete');
      }
      for (const tool of response.result.tools) {
        if (!tool || typeof tool.name !== 'string' || names.has(tool.name)) {
          throw new Error('catalogue contains invalid or duplicate tool names');
        }
        names.add(tool.name);
        tools.push(tool);
      }
      cursor = response.result.nextCursor;
      if (cursor === undefined) return catalogFingerprint(tools);
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) {
        throw new Error('catalogue pagination did not advance');
      }
      cursors.add(cursor);
    }
    throw new Error('catalogue exceeds 100 pages');
  }

  async function poll(state) {
    try {
      const fingerprint = await readCatalog(state.controller.signal);
      if (active !== state) return;
      if (state.fingerprint !== fingerprint) {
        // The first notification also closes a race with the client's initial list.
        state.fingerprint = fingerprint;
        notify();
      }
      if (state.failures) log('catalogue discovery recovered');
      state.failures = 0;
    } catch (error) {
      if (active !== state) return;
      if (!state.failures) log(`catalogue discovery unavailable: ${error.message}`);
      state.failures += 1;
    }
    if (active === state) {
      const delay = intervalMs * 2 ** Math.min(state.failures, 4);
      state.timer = setTimeout(() => poll(state), delay);
      state.timer.unref();
    }
  }

  function stop() {
    const state = active;
    active = null;
    if (state) {
      clearTimeout(state.timer);
      state.controller.abort();
    }
  }

  return {
    start() {
      if (active) return;
      active = { controller: new AbortController(), fingerprint: null, failures: 0 };
      void poll(active);
    },
    stop,
  };
}
