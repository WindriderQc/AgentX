import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { createDiskxMcpServer } from './server.mjs';

const key = 'a'.repeat(64);
const coreOrigin = 'http://127.0.0.1:3180';
const linkOrigin = 'https://core.example.test';
const generatedAt = '2026-01-02T03:04:05.000Z';
const reportLink = '/diskx?janitor=latest&report=2026-01-02T03%3A04%3A05.000Z';
const validReport = {
  available: true,
  readOnly: true,
  status: 'ready_for_review',
  generatedAt,
  link: reportLink,
  summary: 'private summary that the connector does not need',
  counts: { verifiedGroups: 12 },
  notes: ['private detail'],
};

async function openServer(t, fetchCore = () => assert.fail('Unexpected call to Core')) {
  const server = createDiskxMcpServer({ key, coreOrigin, linkOrigin, fetchCore });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = `http://127.0.0.1:${server.address().port}`;
  const request = (message, { headers, path = '/mcp', method = 'POST', body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(root + path, {
      method, headers: { 'content-type': 'application/json', 'x-api-key': key, ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? body ?? JSON.stringify(message) : undefined);
  });
  return request;
}

const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 7, method, params });

function coreReply(report, checkRequest = () => {}, isError = false) {
  return (url, init) => {
    const call = JSON.parse(init.body);
    checkRequest(url, init, call);
    return Response.json({ jsonrpc: '2.0', id: call.id, result: { isError, structuredContent: report } });
  };
}

test('the relay requires its key and rejects unrelated paths, hosts and origins', async t => {
  const request = await openServer(t);
  assert.equal((await request(rpc('tools/list'), { headers: { 'x-api-key': '' } })).status, 401);
  assert.equal((await request(rpc('initialize'), { headers: { 'x-api-key': 'b'.repeat(64) } })).status, 401);
  assert.equal((await request(rpc('tools/list'), { headers: { origin: 'https://other.example.test' } })).status, 403);
  assert.equal((await request(rpc('tools/list'), { headers: { host: 'unexpected.example.test' } })).status, 403);
  assert.equal((await request(rpc('tools/list'), { path: '/api/diskx/presentation' })).status, 404);
  assert.equal((await request(rpc('tools/list'), { path: '/mcp?passthrough=1' })).status, 404);
  assert.equal((await request(null, { method: 'GET' })).status, 405);
});

test('initialization negotiates a supported version and advertises one read-only tool', async t => {
  const request = await openServer(t);
  const init = await (await request(rpc('initialize', { protocolVersion: '2025-06-18' }))).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  const unsupported = await (await request(rpc('initialize', { protocolVersion: '2040-06-01' }))).json();
  assert.equal(unsupported.result.protocolVersion, '2025-11-25');
  assert.equal((await request({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const listing = await (await request(rpc('tools/list'), { headers: { origin: 'https://claude.ai' } })).json();
  assert.equal(listing.result.tools.length, 1);
  assert.equal(listing.result.tools[0].name, 'janitor_report_view');
  assert.equal(listing.result.tools[0].annotations.readOnlyHint, true);
  assert.equal(listing.result.tools[0].inputSchema.additionalProperties, false);
});

test('an authenticated report call reuses the native owner tool and its dated private link', async t => {
  let calls = 0;
  const request = await openServer(t, coreReply(validReport, (url, init, call) => {
    calls++;
    assert.equal(url.href, coreOrigin + '/api/consumers/nestor/v1/mcp');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['x-service-caller'], 'claude-ai-diskx');
    assert.equal(init.headers['x-api-key'], undefined);
    assert.equal(call.method, 'tools/call');
    assert.deepEqual(call.params, { name: 'janitor_report_view', arguments: {} });
  }));
  const response = await (await request(rpc('tools/call', { name: 'janitor_report_view', arguments: {} }))).json();
  assert.equal(calls, 1);
  assert.equal(response.id, 7);
  assert.equal(response.result.isError, false);
  assert.deepEqual(response.result.structuredContent, {
    available: true,
    status: 'ready_for_review',
    readOnly: true,
    source: 'AgentX Core / Data Janitor',
    generatedAt,
    link: linkOrigin + reportLink,
    linkScope: 'private_network',
  });
  assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
});

test('no caller can select a different tool, group, presentation or upstream', async t => {
  const request = await openServer(t);
  for (const params of [
    { name: 'find_files', arguments: {} },
    { name: 'janitor_report_view', arguments: { group: 'a'.repeat(64) } },
    { name: 'janitor_report_view', arguments: { play: 'summary' } },
    { name: 'janitor_report_view', arguments: { url: 'http://127.0.0.1:9000' } },
    { name: 'janitor_report_view', arguments: null },
  ]) {
    const response = await (await request(rpc('tools/call', params))).json();
    assert.equal(response.error.code, -32602);
  }
  const batch = await request([rpc('tools/call', { name: 'janitor_report_view' })]);
  assert.equal(batch.status, 400);
  assert.equal((await request(null, { body: ' '.repeat(4097) })).status, 413);
  assert.equal((await request(null, { body: '{' })).status, 400);
});

test('the relay propagates unavailable reports and rejects an unverified private link', async t => {
  const unavailable = await openServer(t, coreReply({ available: false, readOnly: true, status: 'unavailable' }));
  const call = rpc('tools/call', { name: 'janitor_report_view' });
  const empty = await (await unavailable(call)).json();
  assert.equal(empty.result.structuredContent.available, false);
  assert.equal(empty.result.structuredContent.link, null);
  const foreign = await openServer(t, coreReply({ ...validReport, link: 'https://other.example.test' + reportLink }));
  const wrongDate = await openServer(t, coreReply({ ...validReport, generatedAt: '2026-02-02T03:04:05.000Z' }));
  for (const request of [foreign, wrongDate]) {
    const reply = await (await request(call)).json();
    assert.deepEqual(reply.result, {
      content: [{ type: 'text', text: 'AgentX could not verify the stored Janitor report.' }],
      isError: true,
    });
  }
});
