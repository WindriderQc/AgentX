'use strict';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { registerParentalAccess } = require('../../src/middleware/parentalAccess');

const edge = pending => pending.set('X-AgentX-Entry', 'household');
const frame = tag => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(tag)]).toString('base64')}`;
const vector = value => Array.from({ length: 128 }, () => value);
const faces = {
  front: [{ width: 160, yaw: 0, descriptor: vector(0.1) }],
  left: [{ width: 160, yaw: 0.35, descriptor: vector(0.1) }],
  right: [{ width: 160, yaw: -0.35, descriptor: vector(0.1) }],
  other: [{ width: 160, yaw: 0, descriptor: vector(0.3) }]
};

function gateway(env = {}) {
  let stored = [];
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: '5mb' }));
  const access = registerParentalAccess({ app, express,
    env: { AGENTX_PARENTAL_CODE: 'synthetic', AGENTX_FACE_UNLOCK_ENABLED: 'true', ...env },
    faceRecognizer: { analyze: async image => faces[image.subarray(2).toString()] },
    faceStore: { load: async () => stored, save: async next => { stored = next; }, erase: async () => { stored = []; } } });
  app.get('/api/private', (_req, res) => res.json({ private: true }));
  return { app, access, stored: () => stored };
}

async function adultCookie(app) {
  const unlocked = await edge(request(app).post('/api/access/unlock')).send({ code: 'synthetic' }).expect(200);
  return unlocked.headers['set-cookie'][0].split(';')[0];
}

async function enroll(app) {
  const cookie = await adultCookie(app);
  for (let i = 0; i < 3; i += 1) {
    await edge(request(app).post('/api/access/face/enrollment/samples')).set('Cookie', cookie).send({ image: frame('front') }).expect(200);
  }
  return cookie;
}

async function passChallenge(app, next) {
  // Resolves to the response of the final, turned frame.
  const challenge = (await edge(request(app).post('/api/access/face/challenge')).send({}).expect(200)).body.data;
  const submit = tag => edge(request(app).post('/api/access/face/frame')).send({ challengeId: challenge.challengeId, image: frame(tag), next });
  expect((await submit('front').expect(200)).body.data).toMatchObject({ unlocked: false, step: 'turn' });
  return submit(challenge.direction).expect(200);
}

describe('face unlock at the household gateway', () => {
  test('stays off unless enabled and the parental code fallback is configured', async () => {
    // Disabled: no camera route exists, so the adult gate answers.
    // Enabled without any parental code: the camera answers like the code does.
    for (const [env, status] of [[{ AGENTX_FACE_UNLOCK_ENABLED: 'false' }, 401], [{ AGENTX_PARENTAL_CODE: '' }, 503]]) {
      const { app } = gateway(env);
      expect((await edge(request(app).get('/api/access/face/status')).expect(200)).body.data).toEqual({ enabled: false, ready: false });
      await edge(request(app).post('/api/access/face/challenge')).send({}).expect(status);
    }
  });

  test('enrollment and its page require the adult session', async () => {
    const { app, stored } = gateway();
    await edge(request(app).get('/access/face')).expect(302).expect('Location', '/unlock?next=%2Faccess%2Fface');
    await edge(request(app).get('/api/access/face/enrollment')).expect(401);
    await edge(request(app).post('/api/access/face/enrollment/samples')).send({ image: frame('front') }).expect(401);
    await edge(request(app).delete('/api/access/face/enrollment')).expect(401);
    expect((await edge(request(app).get('/api/access/face/status')).expect(200)).body.data).toEqual({ enabled: true, ready: false });
    await edge(request(app).post('/api/access/face/challenge')).send({}).expect(409);

    const cookie = await enroll(app);
    const page = await edge(request(app).get('/access/face')).set('Cookie', cookie).expect(200);
    expect(page.text).toContain('face-setup.js');
    expect(stored()).toHaveLength(3);
    expect((await edge(request(app).get('/api/access/face/status')).expect(200)).body.data.ready).toBe(true);
    const erased = await edge(request(app).delete('/api/access/face/enrollment')).set('Cookie', cookie).expect(200);
    expect(erased.body.data.samples).toBe(0);
  });

  test('a recognised face with the head turn opens the same adult session and returns to a safe destination', async () => {
    const { app } = gateway();
    await enroll(app);
    const unlocked = await passChallenge(app, 'https://evil.example/');
    expect(unlocked.body.data).toMatchObject({ unlocked: true, next: '/dad' });
    const cookie = unlocked.headers['set-cookie'][0].split(';')[0];
    expect(unlocked.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    await edge(request(app).get('/api/private')).set('Cookie', cookie).expect(200);
    expect((await passChallenge(app, '/psyx')).body.data.next).toBe('/psyx');
  });

  test('another face counts toward the shared unlock limit that also closes the code', async () => {
    const { app } = gateway();
    await enroll(app);
    for (let round = 0; round < 8; round += 1) {
      const { challengeId } = (await edge(request(app).post('/api/access/face/challenge')).send({}).expect(200)).body.data;
      const submit = () => edge(request(app).post('/api/access/face/frame')).send({ challengeId, image: frame('other') });
      expect((await submit().expect(200)).body.data.hint).toBe('not_recognized');
      await submit().expect(200);
      expect((await submit().expect(403)).body.code).toBe('FACE_NOT_RECOGNIZED');
    }
    await edge(request(app).post('/api/access/face/challenge')).send({}).expect(429);
    await edge(request(app).post('/api/access/unlock')).send({ code: 'synthetic' }).expect(429);
  });

  test('a recognizer failure leaves the code as the way in', async () => {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    registerParentalAccess({ app, express, env: { AGENTX_PARENTAL_CODE: 'synthetic', AGENTX_FACE_UNLOCK_ENABLED: 'true' },
      faceRecognizer: { analyze: async () => { throw new Error('model missing'); } },
      faceStore: { load: async () => [vector(0.1), vector(0.1), vector(0.1)], save: async () => {}, erase: async () => {} } });
    const { challengeId } = (await edge(request(app).post('/api/access/face/challenge')).send({}).expect(200)).body.data;
    const failed = await edge(request(app).post('/api/access/face/frame')).send({ challengeId, image: frame('front') }).expect(503);
    expect(failed.body.code).toBe('FACE_UNAVAILABLE');
    await edge(request(app).post('/api/access/unlock')).send({ code: 'synthetic' }).expect(200);
  });

  test('rejects an out-of-range match distance at startup', () => {
    expect(() => gateway({ AGENTX_FACE_UNLOCK_MAX_DISTANCE: '0.6' })).toThrow('Invalid face unlock distance');
  });
});
