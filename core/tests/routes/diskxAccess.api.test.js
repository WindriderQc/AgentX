'use strict';

/**
 * DiskX gets the Data Toolbox's access rules: the private-LAN human access,
 * narrowed on a family-pinned device (family-device.js) and reopened only by
 * the owner's spoken unlock. There is no other adult gate in Core
 * (docs/PARENTAL_ACCESS.md, docs/LAN_ACCESS_SCOPE.md).
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const request = require('supertest');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('../helpers/testDb');
const familyDevice = require('../../surfaces/household/family-device');
const diskx = require('../../surfaces/diskx');

const MODULE = 'export {};';

function app({ unlockedUntil = null } = {}) {
  const instance = express();
  instance.use(cookieParser());
  const envelope = (res, data, status = 200) => res.status(status).json({ ok: true, status: 'success', data });
  const fail = (res, status, message, code) => res.status(status).json({ ok: false, status: 'error', message, code });
  const ownerUnlock = { activeUntil: async () => unlockedUntil, intercept: async () => null, relock: async () => false, forget: async () => {} };
  // Same order as Core: Household's device middleware first, then the surfaces.
  familyDevice.register({ app: instance, mongoose, standardJsonParser: express.json(), envelope, fail, logger: null, ownerUnlock });
  diskx.register({
    app: instance, express,
    env: { DISKX_ROOTS: '/srv/lake', DISKX_MODULE_URL: 'https://graphysx.example/embed/diskx.js' },
    fetchWithTimeout: async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'text/javascript']]), text: async () => MODULE })
  });
  instance.get('/data-toolbox', (_req, res) => res.send('toolbox'));
  instance.get('/api/data-toolbox/janitor/strategy/latest', (_req, res) => res.json({ ok: true }));
  return instance;
}

async function pinned(server) {
  const tablet = request.agent(server);
  expect((await tablet.post('/api/household/family-device/pin').send({ label: 'Tablet' })).status).toBe(201);
  return tablet;
}

describe('DiskX access', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    await connectTestDb();
  });
  beforeEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  test('an owner device on the private network gets the page and the module', async () => {
    const owner = request(app());
    const page = await owner.get('/diskx?janitor=latest');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<diskx-city api-base="/api/data-toolbox" roots="/srv/lake" janitor="latest" actions-href="/data-toolbox">');
    const ecosystem = await owner.get('/diskx?app=ecosystem');
    expect(ecosystem.status).toBe(200);
    expect(ecosystem.text).toContain('<agentx-ecosystem app="ecosystem">');
    const module = await owner.get('/api/diskx/diskx.js');
    expect(module.status).toBe(200);
    expect(module.text).toBe(MODULE);
  });

  test('a family-pinned device gets the ecosystem view and relay, but no DiskX reports or Toolbox data', async () => {
    const tablet = await pinned(app());
    const ecosystem = await tablet.get('/diskx?app=ecosystem&play=network');
    expect(ecosystem.status).toBe(200);
    expect(ecosystem.text).toContain('<agentx-ecosystem app="ecosystem" play="network">');
    expect(ecosystem.text).not.toContain('roots="/srv/lake"');
    expect((await tablet.get('/api/diskx/diskx.js')).text).toBe(MODULE);
    for (const path of ['/diskx', '/diskx?janitor=latest', '/diskx?app=diskx', '/data-toolbox']) {
      const page = await tablet.get(path);
      expect(page.status).toBe(302);
      expect(page.headers.location).toBe('/panel');
    }
    for (const path of ['/api/diskx/presentation?report=2026-01-01T00:00:00Z', '/api/data-toolbox/janitor/strategy/latest']) {
      const answer = await tablet.get(path);
      expect(answer.status).toBe(403);
      expect(answer.body.code).toBe('FAMILY_DEVICE_PINNED');
    }
    // The page's own assets are not family static paths either.
    const asset = await tablet.get('/assets/diskx/diskx-page.js');
    expect(asset.status).toBe(302);
    expect(asset.headers.location).toBe('/panel');
  });

  test('the owner\'s spoken unlock on a pinned device opens DiskX until it ends', async () => {
    const tablet = await pinned(app({ unlockedUntil: new Date(Date.now() + 600000) }));
    expect((await tablet.get('/diskx')).status).toBe(200);
    expect((await tablet.get('/api/diskx/diskx.js')).status).toBe(200);
  });
});
