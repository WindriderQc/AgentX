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
      handler(JSON.parse(body), res, req);
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

test('announces changing tools over stdio while a tool call stays in flight', { timeout: 10000 }, async () => {
  let tools = [{ name: 'first', inputSchema: { type: 'object' } }];
  let finishCall;
  const { server, seen, url } = await bus((message, res) => {
    res.setHeader('content-type', 'application/json');
    if (message.method === 'initialize') {
      res.setHeader('mcp-session-id', 'fixture-session');
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2025-06-18', serverInfo: { name: 'fixture', version: '1' },
        capabilities: { tools: { listChanged: false }, resources: {} },
      } }));
    }
    if (message.method === 'notifications/initialized') return res.writeHead(202).end();
    if (message.method === 'tools/list') {
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } }));
    }
    finishCall = () => res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: 'original call completed' }],
    } }));
  });
  const child = spawn(process.execPath, [RELAY, url], { env: {
    ...process.env, AGENTX_CALLER: 'discovery-test', AGENTX_RELAY_CATALOG_POLL_MS: '20',
  } });
  const output = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line) output.push(JSON.parse(line));
  });
  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  const write = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const waitFor = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), 'relay did not settle');
  };
  const notifications = () => output.filter(item => item.method === 'notifications/tools/list_changed').length;
  try {
    write({ id: 1, method: 'initialize', params: {} });
    await waitFor(() => output.some(item => item.id === 1));
    assert.deepEqual(output.find(item => item.id === 1).result.capabilities,
      { tools: { listChanged: true }, resources: {} });
    assert.equal(seen.length, 1, 'no polling before initialized');
    write({ method: 'notifications/initialized' });
    await waitFor(() => notifications() === 1);
    write({ id: 2, method: 'tools/call', params: { name: 'first', arguments: {} } });
    await waitFor(() => finishCall);
    tools.push({ name: 'new_tool', description: 'discovered without reconnecting', inputSchema: { type: 'object' } });
    await waitFor(() => notifications() === 2);
    assert.ok(!output.some(item => item.id === 2), 'call remains in flight during discovery');
    write({ id: 3, method: 'tools/list' });
    await waitFor(() => output.some(item => item.id === 3));
    assert.equal(output.find(item => item.id === 3).result.tools.length, 2);
    finishCall();
    await waitFor(() => output.some(item => item.id === 2));
    assert.equal(output.find(item => item.id === 2).result.content[0].text, 'original call completed');
    assert.ok(seen.slice(1).every(item => item.headers['mcp-session-id'] === 'fixture-session'));
    assert.ok(seen.slice(1).every(item => item.headers['mcp-protocol-version'] === '2025-06-18'));
    assert.ok(seen.every(item => item.headers['x-service-caller'] === 'discovery-test'));
    assert.equal(seen.filter(item => item.body.method === 'tools/call').length, 1);
    assert.equal(seen.filter(item => item.body.method === 'initialize').length, 1);
    assert.ok(output.every(item => item.id === undefined || [1, 2, 3].includes(item.id)),
      'internal discovery replies never reach the client');
    child.stdin.end();
    assert.equal(await exited, 0);
  } finally {
    child.kill();
    server.closeAllConnections();
    server.close();
  }
});
