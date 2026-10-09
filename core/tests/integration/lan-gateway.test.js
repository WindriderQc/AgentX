'use strict';

// Optional local integration: CADDY_BIN=/path/to/caddy npm run test:gateway.
// Real apps, disposable test Mongo and a private temporary CA; no homelab.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const gatewayTest = process.env.CADDY_BIN ? test : test.skip;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function request(port, ca, url, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', servername: 'localhost', port, path: url, ca, method,
      // An explicit length keeps a DELETE body framed on the shared connection.
      headers: { Host: `localhost:${port}`, ...(body ? { 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(body)) } : {}), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text,
        body: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Local gateway timeout')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

// Caddy orders `handle` before `respond`: outside `route`, the path blocks
// would answer before the peer guard. This check needs no Caddy binary.
test('the gateway example keeps the peer guard ahead of the single-address routes', () => {
  const example = fs.readFileSync(path.resolve(__dirname, '../../../config/household.Caddyfile.example'), 'utf8');
  const site = example.slice(example.indexOf('https://household.example.invalid {'), example.indexOf('# Optional Data entry'));
  const route = site.slice(site.indexOf('route {'));
  expect(site).toContain('route {');
  expect(route.indexOf('respond @outside')).toBeGreaterThan(0);
  expect(route.indexOf('respond @outside')).toBeLessThan(route.indexOf('handle'));
  expect(route).toContain('@benchmark path /benchmark /benchmark/*');
  expect(route).toContain('@rag path /rag /rag/*');
  expect(example).not.toMatch(/invalid:308[12]/);
});

gatewayTest('private HTTPS gateway forwards every service without adult auth and retains actual API checks', async () => {
  const root = path.resolve(__dirname, '../../..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-lan-gateway-'));
  const servers = [];
  let child;
  let logs = '';
  try {
    // Import app entry points, never start production supervisors or collectors.
    const apps = [require('../../src/app').app, require('../../../benchmark/server'),
      require('../../../rag/app'), require('../../../data/server').app];
    // Use the same disposable database as Core; do not start Data collectors.
    apps[3].locals.db = require('mongoose').connection.db;
    const backendPorts = [];
    for (const app of apps) {
      const server = app.listen(0, '127.0.0.1'); servers.push(server);
      await once(server, 'listening'); backendPorts.push(server.address().port);
    }
    const ports = [];
    for (let i = 0; i < 5; i++) ports.push(await freePort());
    let config = fs.readFileSync(path.join(root, 'config/household.Caddyfile.example'), 'utf8');
    config = config.replace('bind 192.168.1.10', 'bind 127.0.0.1')
      .replace('https://household.example.invalid {', `https://localhost:${ports[0]} {`);
    // One address serves Core, Benchmark and RAG; only optional Data keeps a port.
    config = config.replace('https://household.example.invalid:3083', `https://localhost:${ports[3]}`);
    for (let i = 0; i < 4; i++) config = config.replace(`127.0.0.1:${3180 + i}`, `127.0.0.1:${backendPorts[i]}`);
    config = config.replace('{\n', '{\n    admin off\n    skip_install_trust\n');
    // A socket outside an allowed subnet is denied even with a forged proxy
    // header. The denied site is the single-address site itself, so the guard
    // is proven to run before the Benchmark and RAG routes too.
    const site = config.slice(config.indexOf(`https://localhost:${ports[0]} {`), config.indexOf('# Optional Data entry'));
    config += '\n' + site.replace(`localhost:${ports[0]}`, `localhost:${ports[4]}`).replace('import agentx_private_lan',
      'bind 127.0.0.1\n tls internal\n @outside not remote_ip 192.0.2.0/24\n respond @outside "Private LAN only" 403');
    const filename = path.join(temporary, 'Caddyfile'); fs.writeFileSync(filename, config);
    child = spawn(process.env.CADDY_BIN, ['run', '--config', filename, '--adapter', 'caddyfile'], {
      env: { ...process.env, XDG_DATA_HOME: path.join(temporary, 'data'), XDG_CONFIG_HOME: path.join(temporary, 'config') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
    let ca;
    let ready = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Local Caddy exited: ' + logs.slice(-3000));
      try {
        ca = fs.readFileSync(path.join(temporary, 'data/caddy/pki/authorities/local/root.crt'));
        ready = (await request(ports[0], ca, '/dad')).status === 200;
        if (ready) break;
      } catch { /* wait for local CA and listeners */ }
      await pause(100);
    }
    if (!ready) throw new Error('Local Caddy did not become ready: ' + logs.slice(-3000));
    for (const [service, url] of [[0, '/'], [0, '/dad'], [0, '/panel'], [0, '/dad'], [0, '/psyx'], [0, '/api/psyx/state'],
      [0, '/api/voice-personas/private/agents'], [0, '/assets/household/app.js'],
      [0, '/benchmark/leaderboard'], [0, '/benchmark/api/config/status'], [0, '/benchmark/css/leaderboard-v2.css'],
      [0, '/rag/'], [0, '/rag/api/rag/ingestion/policy'], [0, '/rag/js/api.js'],
      [3, '/health'], [3, '/api/v1/hardware/collectors']]) {
      const response = await request(ports[service], ca, url);
      expect({ service, url, status: response.status }).toEqual({ service, url, status: 200 });
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    // Each prefix reaches its own service: Core answers neither route itself.
    expect((await request(ports[0], ca, '/benchmark/leaderboard')).text).toContain('data-agentx-surface="benchmark-leaderboard"');
    expect((await request(ports[0], ca, '/rag/')).text).toContain('data-agentx-surface="rag-home"');
    expect((await request(ports[0], ca, '/benchmarkfoo')).status).toBe(404);
    // A bare prefix only gains its slash, on the same address.
    expect((await request(ports[0], ca, '/rag')).headers.location).toBe('/rag/');
    expect((await request(ports[0], ca, '/benchmark')).headers.location).toBe('/benchmark/');
    const invalidBatch = await request(ports[0], ca, '/benchmark/api/benchmark/batch/not-an-id');
    expect(invalidBatch).toMatchObject({ status: 400 });
    const deletion = await request(ports[0], ca, '/rag/api/rag/documents/synthetic-document', 'DELETE', {});
    expect(deletion.status).toBe(400);
    expect(deletion.body.error).toBe('CONFIRMATION_REQUIRED');
    const approval = await request(ports[3], ca, '/api/v1/janitor/profiles/runs/synthetic/actions/0/approve', 'POST', {});
    expect(approval.status).toBe(400);
    expect(approval.body.message).toContain('explicit confirmation required');
    const liveApply = await request(ports[3], ca, '/api/v1/janitor/profiles/runs/synthetic/actions/0/approve', 'POST', { confirm: true, dry_run: false });
    expect(liveApply.status).toBe(400);
    expect(liveApply.body.message).toContain('preview_id');
    expect((await request(ports[0], ca, '/api/access/authorize')).status).toBe(404);
    for (const url of ['/dad', '/benchmark/leaderboard', '/rag/', '/rag/api/rag/ingestion/policy']) {
      expect((await request(ports[4], ca, url, 'GET', null, { 'X-Forwarded-For': '192.168.1.2' })).status).toBe(403);
    }
  } finally {
    if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
    for (const server of servers) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}, 45000);
