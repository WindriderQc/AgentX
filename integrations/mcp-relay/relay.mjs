#!/usr/bin/env node
// Stdio MCP relay to one AgentX Core bus over HTTP, for clients that only
// launch local commands (Claude Desktop). No dependencies, no tool logic:
// every message goes to Core unchanged, every answer comes back unchanged.
//
//   node relay.mjs https://agentx.specialblend.icu/mcp
//   AGENTX_CALLER  name sent as x-service-caller (default: claude-desktop)
//   AGENTX_RELAY_TIMEOUT_MS  per request (default: 120000)

import { createInterface } from 'node:readline';

const url = process.argv[2] || process.env.AGENTX_MCP_URL;
if (!url) {
  process.stderr.write('usage: relay.mjs <bus URL>\n');
  process.exit(2);
}
const caller = process.env.AGENTX_CALLER || 'claude-desktop';
const timeoutMs = Number(process.env.AGENTX_RELAY_TIMEOUT_MS) || 120000;
let sessionId = null;

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = text => process.stderr.write(`[agentx-relay] ${text}\n`);

// Streamable HTTP may answer with JSON or with an SSE stream of data: lines.
function forward(text, type) {
  if (!text.trim()) return;
  if (!type.includes('text/event-stream')) return send(JSON.parse(text));
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data) send(JSON.parse(data));
  }
}

async function relay(line) {
  let message;
  try { message = JSON.parse(line); } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const id = message?.id ?? null;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-service-caller': caller,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: line,
      signal: AbortSignal.timeout(timeoutMs),
    });
    sessionId = response.headers.get('mcp-session-id') || sessionId;
    const text = await response.text();
    if (!response.ok && !text.trim()) throw new Error(`HTTP ${response.status}`);
    forward(text, response.headers.get('content-type') || '');
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
  // Let answers in flight finish; the process then ends on its own
  // (process.exit with open sockets crashes Node on Windows).
  await Promise.allSettled([...pending]);
  process.exitCode = 0;
});
