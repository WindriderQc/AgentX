'use strict';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const { registerParentalAccess } = require('../../src/middleware/parentalAccess');

const edge = pending => pending.set('X-AgentX-Entry', 'household');
const codes = () => mongoose.connection.collection('access_parental_code');

function gateway(env = {}) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const access = registerParentalAccess({ app, express, env });
  app.get('/api/private', (_req, res) => res.json({ private: true }));
  return { app, access };
}

async function adultCookie(app, code) {
  const unlocked = await edge(request(app).post('/api/access/unlock')).send({ code }).expect(200);
  return unlocked.headers['set-cookie'][0].split(';')[0];
}

beforeEach(async () => { await codes().deleteMany({}); });

describe('parental code set from the AgentX host', () => {
  test('without any code, adult entry stays closed and the host may set the first code', async () => {
    const { app } = gateway();
    const family = (await edge(request(app).get('/api/access/session')).expect(200)).body.data;
    expect(family).toMatchObject({ configured: false, managedByConfig: false, setupAllowed: false, numericCodeLength: null });
    expect((await request(app).get('/api/access/session').expect(200)).body.data.setupAllowed).toBe(true);
    await edge(request(app).post('/api/access/unlock')).send({ code: '4826' }).expect(503);
    await edge(request(app).get('/api/private')).expect(401);

    // Family devices come through the gateway marker: they cannot set it.
    const refused = await edge(request(app).post('/api/access/code/setup')).send({ code: '4826', confirm: '4826' }).expect(403);
    expect(refused.body.code).toBe('ADULT_CODE_SETUP_HOST_ONLY');
    expect(await codes().countDocuments()).toBe(0);

    await request(app).post('/api/access/code/setup').send({ code: '4826', confirm: '4827' }).expect(400);
    await request(app).post('/api/access/code/setup').send({ code: '482', confirm: '482' }).expect(400);
    await request(app).post('/api/access/code/setup').send({ code: '4826', confirm: '4826' }).expect(200);

    const stored = await codes().findOne({});
    expect(JSON.stringify(stored)).not.toContain('4826');
    expect(stored).toMatchObject({ subject: 'default', N: 16384, r: 8, p: 1, numericLength: 4 });
    expect(Buffer.from(stored.hash, 'base64')).toHaveLength(32);

    const status = (await edge(request(app).get('/api/access/session')).expect(200)).body.data;
    expect(status).toMatchObject({ configured: true, managedByConfig: false, setupAllowed: false, numericCodeLength: 4 });
    await edge(request(app).post('/api/access/unlock')).send({ code: '0000' }).expect(403);
    const cookie = await adultCookie(app, '4826');
    await edge(request(app).get('/api/private')).set('Cookie', cookie).expect(200);
  });

  test('a second setup is refused once a code exists, including from another process', async () => {
    const first = gateway();
    await request(first.app).post('/api/access/code/setup').send({ code: 'maison', confirm: 'maison' }).expect(200);
    await request(first.app).post('/api/access/code/setup').send({ code: 'autre1', confirm: 'autre1' }).expect(409);
    await adultCookie(first.app, 'maison');

    // A gateway that loaded before the code existed still refuses to replace it.
    await codes().deleteMany({});
    const stale = gateway();
    expect((await request(stale.app).get('/api/access/session').expect(200)).body.data.configured).toBe(false);
    const { hashCode } = require('../../src/services/parentalCodeService');
    await codes().insertOne({ subject: 'default', ...hashCode('maison') });
    const raced = await request(stale.app).post('/api/access/code/setup').send({ code: 'autre1', confirm: 'autre1' }).expect(409);
    expect(raced.body.code).toBe('ADULT_CODE_EXISTS');
    expect((await edge(request(stale.app).get('/api/access/session')).expect(200)).body.data.numericCodeLength).toBeNull();
    await adultCookie(stale.app, 'maison');
  });

  test('changing the code needs an adult session and the current code; other sessions are revoked', async () => {
    const { app } = gateway();
    await request(app).post('/api/access/code/setup').send({ code: '4826', confirm: '4826' }).expect(200);
    const change = body => edge(request(app).post('/api/access/code/change')).send(body);
    await change({ current: '4826', code: '9137', confirm: '9137' }).expect(401);
    await edge(request(app).get('/access/code')).expect(302).expect('Location', '/unlock?next=%2Faccess%2Fcode');

    const mine = await adultCookie(app, '4826');
    const other = await adultCookie(app, '4826');
    await edge(request(app).get('/access/code')).set('Cookie', mine).expect(200);
    await change({ current: '4826', code: '9137', confirm: '9138' }).set('Cookie', mine).expect(400);
    const wrong = await change({ current: '0000', code: '9137', confirm: '9137' }).set('Cookie', mine).expect(403);
    expect(wrong.body.code).toBe('ADULT_UNLOCK_FAILED');
    await change({ current: '4826', code: '9137', confirm: '9137' }).set('Cookie', mine).expect(200);

    await edge(request(app).get('/api/private')).set('Cookie', mine).expect(200);
    await edge(request(app).get('/api/private')).set('Cookie', other).expect(401);
    await edge(request(app).post('/api/access/unlock')).send({ code: '4826' }).expect(403);
    await adultCookie(app, '9137');
    expect(JSON.stringify(await codes().findOne({}))).not.toContain('9137');
  });

  test('wrong current codes count toward the shared failed-unlock limit', async () => {
    const { app } = gateway();
    await request(app).post('/api/access/code/setup').send({ code: '4826', confirm: '4826' }).expect(200);
    const cookie = await adultCookie(app, '4826');
    for (let count = 0; count < 4; count++) {
      await edge(request(app).post('/api/access/code/change')).set('Cookie', cookie)
        .send({ current: '1111', code: '9137', confirm: '9137' }).expect(403);
    }
    for (let count = 0; count < 4; count++) await edge(request(app).post('/api/access/unlock')).send({ code: '1111' }).expect(403);
    await edge(request(app).post('/api/access/unlock')).send({ code: '4826' }).expect(429);
    await edge(request(app).post('/api/access/code/change')).set('Cookie', cookie)
      .send({ current: '4826', code: '9137', confirm: '9137' }).expect(429);
  });

  test('AGENTX_PARENTAL_CODE stays authoritative and cannot be set or changed here', async () => {
    const { app } = gateway({ AGENTX_PARENTAL_CODE: '739251' });
    const status = (await request(app).get('/api/access/session').expect(200)).body.data;
    expect(status).toMatchObject({ configured: true, managedByConfig: true, setupAllowed: false, numericCodeLength: 6 });
    await request(app).post('/api/access/code/setup').send({ code: '4826', confirm: '4826' }).expect(409);
    const cookie = await adultCookie(app, '739251');
    const refused = await edge(request(app).post('/api/access/code/change')).set('Cookie', cookie)
      .send({ current: '739251', code: '4826', confirm: '4826' }).expect(409);
    expect(refused.body.code).toBe('ADULT_CODE_MANAGED_BY_CONFIG');
    expect(await codes().countDocuments()).toBe(0);
  });

  test('a stored code is ignored while AGENTX_PARENTAL_CODE is set', async () => {
    const { hashCode } = require('../../src/services/parentalCodeService');
    await codes().insertOne({ subject: 'default', ...hashCode('4826') });
    const { app } = gateway({ AGENTX_PARENTAL_CODE: '739251' });
    await edge(request(app).post('/api/access/unlock')).send({ code: '4826' }).expect(403);
    await adultCookie(app, '739251');
  });
});
