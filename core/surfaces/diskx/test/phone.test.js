'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  express = require('express'),
  request = require('supertest'),
  crypto = require('node:crypto');
const { registerPhone } = require('../phone');
const { allowedForFamilyDevice } = require('../../household/family-device');
const { demoSurfaceDisabled } = require('../../../../shared/agentxRuntimeProfile');
const { createPhoneWorkbenchBridge } = require('../../../src/services/photos/phoneWorkbenchBridge');
const uuid = () => crypto.randomUUID();
function fixture() {
  const app = express(),
    calls = [];
  registerPhone({
    app,
    express,
    bridge: {
      call: async (input) => {
        calls.push(input);
        return { received: true };
      },
    },
  });
  return { app, calls };
}
test('phone workbench is linked to storage, self-hosted and protected from family/demo devices', async () => {
  const { app, calls } = fixture();
  const result = await request(app).get('/diskx/phone').expect(200);
  assert.match(result.text, /href="\/diskx"/);
  assert.match(result.text, /SUPPRIMER|confirmation/);
  assert.doesNotMatch(result.text, /<script(?![^>]*src=)/);
  assert.equal(calls.length, 0);
  for (const route of ['/diskx/phone', '/api/phone-media', '/assets/diskx/phone.js'])
    assert.equal(allowedForFamilyDevice({ path: route, method: 'GET' }), false);
  assert.equal(demoSurfaceDisabled('/diskx/phone', 'demo'), true);
  assert.equal(demoSurfaceDisabled('/api/phone-media', 'demo'), true);
});
test('HTTP only admits bounded reads, review and selected start/prepare requests', async () => {
  const { app, calls } = fixture();
  await request(app).get('/api/phone-media?op=runs').expect(200);
  assert.deepEqual(calls[0], { op: 'runs' });
  await request(app).get('/api/phone-media?op=authorize').expect(400);
  await request(app).post('/api/phone-media').send({ op: 'deleted', planId: uuid() }).expect(400);
  await request(app)
    .post('/api/phone-media')
    .send({ op: 'prepare', runId: uuid(), planId: uuid(), items: Array.from({ length: 101 }, uuid) })
    .expect(400);
  assert.equal(calls.length, 1);
  await request(app)
    .post('/api/phone-media')
    .send({ op: 'prepare', runId: uuid(), planId: uuid(), items: [uuid()] })
    .expect(200);
  assert.equal(calls[1].op, 'prepare');
});
test('collector absence is explicit rather than an empty successful phone inventory', async () => {
  const app = express();
  registerPhone({ app, express, bridge: createPhoneWorkbenchBridge({ env: {} }) });
  const response = await request(app).get('/api/phone-media?op=status').expect(503);
  assert.equal(response.body.code, 'PHONE_NOT_CONFIGURED');
});
test('SSH bridge keeps browser text in base64 and only runs operator-configured paths', async () => {
  let seen;
  const bridge = createPhoneWorkbenchBridge({
    config: {
      sshTarget: 'collector',
      worker: 'C:\\Tools\\workbench.cjs',
      clientConfig: 'C:\\Instance\\phone.json',
    },
    runner: async (target, command) => {
      seen = { target, command };
      return { stdout: JSON.stringify({ ok: true, data: {} }) };
    },
  });
  const search = '`$() & hello';
  await bridge.call({ op: 'page', search });
  assert.equal(seen.target, 'collector');
  assert.equal(seen.command.includes(search), false);
  assert.deepEqual(JSON.parse(Buffer.from(seen.command.split(' ').at(-1), 'base64')), { op: 'page', search });
  await assert.rejects(
    createPhoneWorkbenchBridge({
      config: { sshTarget: '-oProxyCommand=bad', worker: 'C:\\tool.cjs', clientConfig: 'C:\\config.json' },
    }).call({ op: 'status' }),
    { code: 'INVALID_CONFIGURATION' },
  );
});

test('a dedicated forced-command identity sends only the bounded phone payload', async () => {
  let seen;
  const config = {
    sshTarget: 'collector',
    worker: 'C:\\Tools\\workbench.cjs',
    clientConfig: 'C:\\Instance\\phone.json',
    forcedCommand: true,
    identityFile: '/instance/keys/collector',
    knownHostsFile: '/instance/keys/known_hosts',
  };
  const bridge = createPhoneWorkbenchBridge({
    config,
    runner: async (target, command, connection) => {
      seen = { target, command, connection };
      return { stdout: JSON.stringify({ ok: true, data: { available: true } }) };
    },
  });
  assert.equal((await bridge.call({ op: 'status' })).available, true);
  assert.match(seen.command, /^[A-Za-z0-9+/=]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(seen.command, 'base64')), { op: 'status' });
  assert.equal(seen.connection.identityFile, config.identityFile);
});
