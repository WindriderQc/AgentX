#!/usr/bin/env node
// Stdio MCP relay to one AgentX Core bus over HTTP, for clients that only
// launch local commands (Claude Desktop). No dependencies, no tool logic:
// Calls go to Core unchanged. The relay announces catalogue changes over MCP.
//
//   node relay.mjs https://agentx.example.invalid/mcp
//   AGENTX_CALLER  name sent as x-service-caller (default: claude-desktop)
//   AGENTX_RELAY_TIMEOUT_MS  per request (default: 120000)
//   AGENTX_RELAY_CATALOG_POLL_MS  discovery interval (default: 30000)

import { createInterface } from 'node:readline';
import { createCatalogWatcher } from './catalog-watch.mjs';

const url = process.argv[2] || process.env.AGENTX_MCP_URL;
if (!url) {
  process.stderr.write('usage: relay.mjs <bus URL>\n');
  process.exit(2);
}
const caller = process.env.AGENTX_CALLER || 'claude-desktop';
const timeoutMs = Number(process.env.AGENTX_RELAY_TIMEOUT_MS) || 120000;
let sessionId = null;
let protocolVersion = null;
let closing = false;
let catalogEnabled = false;
let initializedForwarded = false;

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = text => process.stderr.write(`[agentx-relay] ${text}\n`);

// Streamable HTTP may answer with JSON or with an SSE stream of data: lines.
function messages(text, type) {
  if (!text.trim()) return [];
  if (!type.includes('text/event-stream')) return [JSON.parse(text)];
  const result = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data) result.push(JSON.parse(data));
  }
  return result;
}

async function post(body, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-service-caller': caller,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
    },
    body,
    // Node 18 supports AbortSignal.timeout but not AbortSignal.any.
    signal: signal || AbortSignal.timeout(timeoutMs),
  });
  sessionId = response.headers.get('mcp-session-id') || sessionId;
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return messages(text, response.headers.get('content-type') || '');
}

const configuredPollMs = Number(process.env.AGENTX_RELAY_CATALOG_POLL_MS);
const watcher = createCatalogWatcher({
  intervalMs: Number.isFinite(configuredPollMs) && configuredPollMs > 0 ? configuredPollMs : 30000,
  request: async (message, signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    try {
      const responses = await post(JSON.stringify(message), controller.signal);
      return responses.find(response => response.id === message.id);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  },
  notify: () => send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
  log,
});

function startDiscovery() {
  if (!closing && catalogEnabled && initializedForwarded) watcher.start();
}

async function relay(line) {
  let message;
  try { message = JSON.parse(line); } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const id = message?.id ?? null;
  if (message?.method === 'initialize') {
    watcher.stop();
    catalogEnabled = false;
    initializedForwarded = false;
  }
  try {
    const responses = await post(line);
    for (const response of responses) {
      if (message?.method === 'initialize' && response.id === id && response.result?.capabilities) {
        protocolVersion = response.result.protocolVersion || null;
        const capabilities = response.result.capabilities;
        if (capabilities.tools) {
          capabilities.tools = { ...capabilities.tools, listChanged: true };
          catalogEnabled = true;
        }
      }
      send(response);
    }
    if (message?.method === 'notifications/initialized') initializedForwarded = true;
    startDiscovery();
  } catch (error) {
    log(`${message?.method || 'message'} failed: ${error.message}`);
    if (id !== null) send({ jsonrpc: '2.0', id, error: { code: -32000, message: `AgentX bus unreachable at ${url}: ${error.message}` } });
  }
}

const pending = new Set();
createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const work = relay(line).finally(() => pending.delete(work));
  pending.add(work);
}).on('close', async () => {
  closing = true;
  watcher.stop();
  // Let answers in flight finish; the process then ends on its own
  // (process.exit with open sockets crashes Node on Windows).
  await Promise.allSettled([...pending]);
  process.exitCode = 0;
});
