import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RELAY = fileURLToPath(new URL('./relay.mjs', import.meta.url));

function bus(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      handler(JSON.parse(body), res);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

function run(url, lines, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RELAY, url], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, messages: out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }));
    child.stdin.end(lines.map(line => `${typeof line === 'string' ? line : JSON.stringify(line)}\n`).join(''));
  });
}

test('relays requests unchanged with the caller name and returns JSON and SSE answers', async () => {
  const { server, seen, url } = await bus((message, res) => {
    if (message.id === undefined) return res.writeHead(202).end();
    if (message.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })}\n\n`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echo: message.params } }));
  });
  try {
    const { code, messages } = await run(url, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ], { AGENTX_CALLER: 'claude-desktop-test' });
    assert.equal(code, 0);
    assert.deepEqual(messages.sort((a, b) => a.id - b.id), [
      { jsonrpc: '2.0', id: 1, result: { echo: { a: 1 } } },
      { jsonrpc: '2.0', id: 2, result: { tools: [] } },
    ]);
    assert.equal(seen.length, 3);
    assert.ok(seen.every(item => item.headers['x-service-caller'] === 'claude-desktop-test'));
    assert.deepEqual(seen[0].body, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } });
  } finally { server.close(); }
});

test('an unreachable bus answers requests with a JSON-RPC error and ignores notifications', async () => {
  const { messages } = await run('http://127.0.0.1:9/mcp', [
    { jsonrpc: '2.0', id: 7, method: 'tools/list' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    'not json',
  ], { AGENTX_RELAY_TIMEOUT_MS: '3000' });
  assert.equal(messages.length, 2);
  const failure = messages.find(item => item.id === 7);
  assert.equal(failure.error.code, -32000);
  assert.match(failure.error.message, /AgentX bus unreachable/);
  assert.equal(messages.find(item => item.id === null).error.code, -32700);
});
