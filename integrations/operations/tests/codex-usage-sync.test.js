const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  buildCodexUsagePayload,
  parseCodexSession,
  postPayload,
} = require('../codex-usage-sync');

test('direct HTTP sync requires an explicit acceptance receipt', async (t) => {
  const server = require('node:http').createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { hostId: 'test-host', sessions: [] });
    if (req.url === '/accepted') res.end(JSON.stringify({ ok: true, result: { acceptedSessions: 0 } }));
    else if (req.url === '/rejected') res.end(JSON.stringify({ ok: false, error: 'rejected' }));
    else if (req.url === '/invalid') res.end('invalid JSON');
    else { res.statusCode = 503; res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const payload = { hostId: 'test-host', sessions: [] };
  assert.equal((await postPayload(payload, { endpoint: `${endpoint}/accepted` })).ok, true);
  for (const suffix of ['rejected', 'invalid', 'unavailable']) {
    await assert.rejects(postPayload(payload, { endpoint: `${endpoint}/${suffix}` }));
  }
});

function fixture(root, name, rows) {
  const dir = path.join(root, '2026', '07', '17');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  fs.writeFileSync(target, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return target;
}

test('parses only sanitized Codex counters from the latest token_count event', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-sync-'));
  const file = fixture(root, 'rollout-2026-07-17T01-02-03-session.jsonl', [
    { timestamp: '2026-07-17T01:02:03Z', type: 'event_msg', payload: { type: 'user_message', message: 'never include me' } },
    { timestamp: '2026-07-17T01:03:00Z', type: 'turn_context', payload: { model: 'gpt-test', cwd: 'never/include/path' } },
    { timestamp: '2026-07-17T01:04:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } }, rate_limits: { plan_type: 'prolite', primary: { used_percent: 42, window_minutes: 10080, resets_at: 1784859300 }, credits: { has_credits: false, unlimited: false, balance: '0' } } } },
  ]);
  const parsed = parseCodexSession(file, root, 1024 * 1024);
  assert.equal(parsed.session.model, 'gpt-test');
  assert.equal(parsed.session.totalTokens, 120);
  assert.equal(parsed.account.primary.usedPercent, 42);
  assert.equal(parsed.account.primary.resetsAtMs, 1784859300000);
  const serialized = JSON.stringify(parsed);
  assert.equal(serialized.includes('never include me'), false);
  assert.equal(serialized.includes('never/include/path'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('builds a versioned payload with hashed session identifiers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-sync-'));
  fixture(root, 'rollout-2026-07-17T01-02-03-session.jsonl', [
    { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }, rate_limits: { plan_type: 'prolite' } } },
  ]);
  const payload = buildCodexUsagePayload({ sessionsRoot: root, lookbackDays: 2, hostId: 'workstation' });
  assert.equal(payload.version, 1);
  assert.equal(payload.source, 'codex-local');
  assert.equal(payload.hostId, 'workstation');
  assert.equal(payload.sessions.length, 1);
  assert.match(payload.sessions[0].sessionKey, /^[a-f0-9]{64}$/);
  assert.equal(payload.sessions[0].totalTokens, 12);
  fs.rmSync(root, { recursive: true, force: true });
});

test('LAN sync sends no credentials and refuses redirects', async (t) => {
  const seen = [];
  const server = require('node:http').createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    req.resume();
    if (req.url === '/redirect') {
      res.writeHead(307, { Location: '/forbidden' });
      res.end();
    } else res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  await postPayload({}, { endpoint: `${base}/accepted` });
  await assert.rejects(postPayload({}, { endpoint: `${base}/redirect` }));
  assert.deepEqual(seen, [
    { path: '/accepted', authorization: undefined },
    { path: '/redirect', authorization: undefined },
  ]);
  assert.equal(seen.length, 2);
});
