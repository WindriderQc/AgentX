'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  COOKIE_NAME,
  accessTokenValid,
  dshStudioConfig,
  issueAccessToken,
  registerDshStudioOperations,
  validateDshStudioEnvironment,
} = require('../dsh/studio');

const repoRoot = path.resolve(__dirname, '../../../..');

const KEYS = [
  'CORE_PUBLIC_URL',
  'DSH_STUDIO_PUBLIC_URL',
  'DSH_STUDIO_ACCESS_SECRET',
  'DSH_STUDIO_SESSION_TTL_SECONDS',
  'DSH_STUDIO_ISOLATION',
  'DSH_STUDIO_MODEL',
  'DSH_STUDIO_LAUNCH_FILE',
];

function withEnvironment(values, run) {
  const prior = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try { return run(); }
  finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeExpress() {
  return {
    Router() {
      const routes = [];
      return {
        routes,
        get(path, ...handlers) { routes.push({ method: 'get', path, handlers }); },
      };
    },
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) {
      if (typeof name === 'object') Object.assign(this.headers, name);
      else this.headers[name] = value;
      return this;
    },
    type(value) { this.headers['Content-Type'] = value; return this; },
    send(value) { this.body = value; return this; },
    json(value) { this.body = value; return this; },
    redirect(code, location) { this.statusCode = code; this.headers.Location = location; return this; },
    end() { return this; },
  };
}

function request(headers = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    protocol: 'http',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    get(name) { return normalized[String(name).toLowerCase()] || ''; },
  };
}

test('DSH Studio is disabled by default and validates an explicit secure origin', () => {
  withEnvironment({}, () => {
    assert.deepEqual(dshStudioConfig(), { configured: false, isolation: 'bubblewrap' });
    assert.equal(validateDshStudioEnvironment().configured, false);
  });
  withEnvironment({
    CORE_PUBLIC_URL: 'https://192.0.2.99',
    DSH_STUDIO_PUBLIC_URL: 'https://192.0.2.99:18791',
    DSH_STUDIO_ACCESS_SECRET: 'a'.repeat(48),
    DSH_STUDIO_ISOLATION: 'host',
  }, () => {
    const config = validateDshStudioEnvironment();
    assert.equal(config.configured, true);
    assert.equal(config.isolation, 'host');
    assert.equal(config.publicUrl, 'https://192.0.2.99:18791');
  });
});

test('invalid DSH public, isolation, TTL, and secret settings fail closed', () => {
  const baseline = {
    CORE_PUBLIC_URL: 'https://192.0.2.99',
    DSH_STUDIO_PUBLIC_URL: 'https://192.0.2.99:18791',
    DSH_STUDIO_ACCESS_SECRET: 'a'.repeat(48),
  };
  withEnvironment({ ...baseline, DSH_STUDIO_ISOLATION: 'none' }, () => {
    assert.throws(validateDshStudioEnvironment, /bubblewrap or host/);
  });
  withEnvironment({ ...baseline, DSH_STUDIO_SESSION_TTL_SECONDS: '60' }, () => {
    assert.throws(validateDshStudioEnvironment, /integer from 300/);
  });
  withEnvironment({ ...baseline, DSH_STUDIO_ACCESS_SECRET: 'too-short' }, () => {
    assert.throws(validateDshStudioEnvironment, /at least 32/);
  });
  withEnvironment({ ...baseline, DSH_STUDIO_PUBLIC_URL: 'http://192.0.2.99:18791' }, () => {
    assert.throws(validateDshStudioEnvironment, /must use HTTPS/);
  });
  withEnvironment({ ...baseline, DSH_STUDIO_PUBLIC_URL: 'https://other.example:18791' }, () => {
    assert.throws(validateDshStudioEnvironment, /same hostname/);
  });
  for (const suffix of ['?token=excluded', '#fragment', '?', '#']) {
    withEnvironment({ ...baseline, DSH_STUDIO_PUBLIC_URL: `https://192.0.2.99/dsh/${suffix}` }, () => {
      assert.throws(validateDshStudioEnvironment, /query|fragment/);
    });
  }
  withEnvironment({ ...baseline, DSH_STUDIO_PUBLIC_URL: 'https://user:secret@192.0.2.99/dsh/' }, () => {
    assert.throws(validateDshStudioEnvironment, /credentials/);
  });
});

test('prefix launch preserves the mount through native authentication and relative client endpoints', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mount-'));
  const file = path.join(directory, 'launch.json');
  fs.writeFileSync(file, JSON.stringify({ contract: 'agentx.dsh-studio-launch/v1', token: 'n'.repeat(43) }));
  try {
    for (const suffix of ['/dsh', '/dsh/']) withEnvironment({
      CORE_PUBLIC_URL: 'https://agentx.example', DSH_STUDIO_PUBLIC_URL: `https://agentx.example${suffix}`,
      DSH_STUDIO_ACCESS_SECRET: 'z'.repeat(48), DSH_STUDIO_LAUNCH_FILE: file,
    }, () => {
      assert.equal(validateDshStudioEnvironment().publicUrl, 'https://agentx.example/dsh/');
      const router = registerDshStudioOperations({ express: fakeExpress() });
      const launched = response();
      router.routes.find(route => route.path === '/control-launch').handlers.at(-1)(request(), launched);
      assert.equal(launched.headers.Location, `https://agentx.example/dsh/?token=${'n'.repeat(43)}`);
      const authenticated = new URL('./', launched.headers.Location); // native token-exchange redirect
      assert.equal(authenticated.href, 'https://agentx.example/dsh/');
      assert.equal(new URL('api', authenticated).pathname, '/dsh/api');
      assert.equal(new URL('assets/client.js', authenticated).pathname, '/dsh/assets/client.js');
      const check = response();
      router.routes.find(route => route.path === '/access-check').handlers.at(-1)(
        request({ cookie: launched.headers['Set-Cookie'].split(';')[0] }), check);
      assert.equal(check.statusCode, 204);
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('signed browser access expires and rejects tampering', () => {
  withEnvironment({ DSH_STUDIO_ACCESS_SECRET: 's'.repeat(48) }, () => {
    const now = Date.parse('2026-09-03T04:00:00Z');
    const token = issueAccessToken({ now, randomBytes: () => Buffer.alloc(18, 7) });
    assert.equal(accessTokenValid(token, { now: now + 1000, ttlSeconds: 300 }), true);
    assert.equal(accessTokenValid(`${token}x`, { now: now + 1000, ttlSeconds: 300 }), false);
    assert.equal(accessTokenValid(token, { now: now + 301000, ttlSeconds: 300 }), false);
  });
  withEnvironment({}, () => {
    assert.throws(() => issueAccessToken(), /access secret is unavailable/);
    assert.equal(accessTokenValid('v1.1.nonce.signature'), false);
  });
});

test('launcher sets a host-only secure cookie and the access check accepts only that cookie', () => {
  withEnvironment({
    CORE_PUBLIC_URL: 'https://192.0.2.99',
    DSH_STUDIO_PUBLIC_URL: 'https://192.0.2.99:18791',
    DSH_STUDIO_ACCESS_SECRET: 'z'.repeat(48),
  }, () => {
    const router = registerDshStudioOperations({ express: fakeExpress() });
    const launch = router.routes.find((route) => route.path === '/control-launch');
    const launched = response();
    launch.handlers.at(-1)(request(), launched);
    assert.equal(launched.statusCode, 302);
    assert.equal(launched.headers.Location, 'https://192.0.2.99:18791');
    assert.match(launched.headers['Set-Cookie'], new RegExp(`^${COOKIE_NAME}=`));
    assert.match(launched.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Strict/);
    assert.doesNotMatch(launched.headers['Set-Cookie'], /Domain=/);

    const cookie = launched.headers['Set-Cookie'].split(';')[0];
    const check = router.routes.find((route) => route.path === '/access-check').handlers.at(-1);
    const accepted = response();
    check(request({ cookie }), accepted);
    assert.equal(accepted.statusCode, 204);

    const denied = response();
    check(request(), denied);
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.body.code, 'DSH_STUDIO_ACCESS_REQUIRED');
  });
});

test('external navigation commits the launcher before Studio and keeps the token out of its page', () => {
  withEnvironment({
    CORE_PUBLIC_URL: 'https://agentx.example',
    DSH_STUDIO_PUBLIC_URL: 'https://agentx.example:18791',
    DSH_STUDIO_ACCESS_SECRET: 'z'.repeat(48),
  }, () => {
    const router = registerDshStudioOperations({ express: fakeExpress() });
    const launched = response();
    router.routes.find(route => route.path === '/control-launch').handlers.at(-1)(
      request({ 'Sec-Fetch-Site': 'cross-site' }), launched);
    assert.equal(launched.statusCode, 200);
    assert.equal(launched.headers.Location, undefined);
    assert.equal(launched.headers['Content-Type'], 'html');
    assert.match(launched.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Strict/);
    assert.match(launched.body, /http-equiv="refresh" content="0;url=https:\/\/agentx\.example:18791"/);
    assert.match(launched.body, /href="https:\/\/agentx\.example:18791"/);
    assert.equal(launched.headers['Cache-Control'], 'no-store, max-age=0');
    const cookie = launched.headers['Set-Cookie'].split(';')[0];
    assert.equal(launched.body.includes(cookie.split('=')[1]), false);
    const checked = response();
    router.routes.find(route => route.path === '/access-check').handlers.at(-1)(request({ cookie }), checked);
    assert.equal(checked.statusCode, 204);
  });
});

test('native launch exchange stays on the configured origin and missing records refuse without granting access', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launch-'));
  const file = path.join(directory, 'launch.json');
  try {
    withEnvironment({ CORE_PUBLIC_URL: 'https://agentx.example', DSH_STUDIO_PUBLIC_URL: 'https://agentx.example:18791',
      DSH_STUDIO_ACCESS_SECRET: 'z'.repeat(48), DSH_STUDIO_LAUNCH_FILE: file }, () => {
      const router = registerDshStudioOperations({ express: fakeExpress() });
      const launch = router.routes.find(route => route.path === '/control-launch').handlers.at(-1);
      const unavailable = response();
      launch(request(), unavailable);
      assert.equal(unavailable.statusCode, 503);
      assert.equal(unavailable.headers['Set-Cookie'], undefined);
      assert.equal(JSON.stringify(unavailable.body).includes(file), false);
      fs.writeFileSync(file, JSON.stringify({ contract: 'agentx.dsh-studio-launch/v1', token: 'n'.repeat(43), url: 'https://untrusted.example' }));
      const ready = response();
      launch(request(), ready);
      assert.equal(ready.headers.Location, `https://agentx.example:18791/?token=${'n'.repeat(43)}`);
      assert.match(ready.headers['Set-Cookie'], /SameSite=Strict/);
      const external = response();
      launch(request({ 'Sec-Fetch-Site': 'cross-site' }), external);
      assert.equal(external.statusCode, 200);
      assert.match(external.body, /https:\/\/agentx\.example:18791\/\?token=n{43}/);
      const status = response();
      router.routes.find(route => route.path === '/status').handlers.at(-1)(request(), status);
      assert.equal(JSON.stringify(status.body).includes('n'.repeat(43)), false);
      fs.writeFileSync(file, JSON.stringify({ contract: 'agentx.dsh-studio-launch/v1', token: 'invalid&url=elsewhere' }));
      const invalid = response();
      launch(request(), invalid);
      assert.equal(invalid.statusCode, 503);
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Studio forwards the optional public mount to the native web process', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-'));
  const bin = path.join(directory, 'runtime/node_modules/.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'dsh'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  const fakeNode = path.join(directory, 'node');
  // This shell transport test does not run the settings helper or call Core.
  fs.writeFileSync(fakeNode, `#!/bin/sh\nif [ "$1" = "-e" ]; then exec '${process.execPath}' "$@"; fi\nexit 0\n`, { mode: 0o700 });
  const settings = path.join(directory, 'settings.yaml');
  fs.writeFileSync(settings, '{}');
  try {
    for (const publicUrl of ['', 'https://runtime.example/dsh/']) {
      const env = { ...process.env, HOME: directory, AGENTX_NODE_BIN: fakeNode,
        AGENTX_LLM_DSH_STUDIO_TOKEN: 'synthetic-studio-key', DSH_STUDIO_ISOLATION: 'host',
        DSH_STUDIO_DSH_ROOT: path.join(directory, 'runtime'), DSH_STUDIO_SETTINGS_FILE: settings,
        DSH_STUDIO_WORKSPACE_ROOT: path.join(directory, 'workspaces'),
        DSH_STUDIO_STATE_ROOT: path.join(directory, 'state'), DSH_STUDIO_PUBLIC_URL: publicUrl,
        DSH_STUDIO_LAUNCH_FILE: '', DSH_STUDIO_BROWSER_EXECUTABLE: '', DSH_STUDIO_PORT: '3085',
        DSH_STUDIO_TRUSTED_HOST: 'runtime.example:18791' };
      const result = spawnSync('bash', [path.join(repoRoot, 'integrations/coding/dsh-studio.sh')], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const args = result.stdout.trim().split('\n');
      assert.equal(args[0], 'web');
      assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
      assert.equal(args.includes('--public-url'), Boolean(publicUrl));
      const trustedHosts = args.filter((arg, i) => args[i - 1] === '--trusted-host');
      assert.deepEqual(trustedHosts, publicUrl ? ['runtime.example:18791', 'runtime.example'] : ['runtime.example:18791']);
      if (publicUrl) assert.equal(args[args.indexOf('--public-url') + 1], publicUrl);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Studio stays loopback-only and the OpenClaw worker sandbox stays mandatory', () => {
  const studio = fs.readFileSync(path.join(repoRoot, 'integrations/coding/dsh-studio.sh'), 'utf8');
  const worker = fs.readFileSync(path.join(repoRoot, 'integrations/coding/dsh-headless.sh'), 'utf8');

  assert.match(studio, /web .*--host 127\.0\.0\.1/);
  assert.doesNotMatch(studio, /--host 0\.0\.0\.0/);
  // The gateway key reaches the sandbox through its private home, never argv.
  assert.doesNotMatch(studio, /--setenv AGENTX_CORE_API_KEY/);
  assert.match(studio, /AGENTX_CORE_API_KEY="\$\(< \/home\/agent\/\.dsh\/agentx-core\.key\)"/);
  assert.match(worker, /\/usr\/bin\/bwrap/);
  assert.doesNotMatch(worker, /DSH_STUDIO_ISOLATION|DSH_CODING_AGENT_ISOLATION/);
});
