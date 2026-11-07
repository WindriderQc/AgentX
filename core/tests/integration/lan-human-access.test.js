'use strict';

const request = require('supertest');
const PipelineTask = require('../../models/PipelineTask');
const { app } = require('../../src/app');

describe('human access through the private LAN', () => {
  test('opens every human page directly and Family navigation leaves Nestor accessible', async () => {
    const browser = request.agent(app);
    for (const path of ['/', '/dad', '/panel', '/dad', '/panel', '/data-toolbox', '/portal', '/ecosystem', '/dad/family', '/lecture/parents', '/lecture/parents.html', '/playground']) {
      const response = await browser.get(path).expect(200);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.text).not.toMatch(/access-assets|Espace adulte|privacyGate|data-access="adult"/);
    }
    for (const path of ['/api/history', '/api/family/profiles', '/api/family/ideas', '/api/voice-personas/private/agents', '/api/portal/health']) {
      await browser.get(path).expect(200);
    }
    await browser.post('/api/voice-personas/private/notes').send({ operation: 'list' }).expect(200);
  });

  test('direct APIs still validate their own inputs, confirmations and resource scope', async () => {
    for (const space of ['private', 'family']) {
      const base = `/api/voice-personas/${space}`;
      expect((await request(app).get(`${base}/sessions/unknown-session/brain`).expect(404)).body.code).toBe('VOICE_PERSONA_SESSION_NOT_FOUND');
      expect((await request(app).get(`${base}/visuals/file?source=photos&path=a.jpg`).expect(404)).body.code).toBe('HOUSEHOLD_IMAGE_NOT_FOUND');
      expect((await request(app).delete(`${base}/sessions/unknown-session`).send({}).expect(400)).body.code).toBe('CONVERSATION_DELETE_CONFIRMATION_REQUIRED');
    }
    expect((await request(app).post('/api/family/math-receipts').send({}).expect(400)).body.code).toBe('MATH_RECEIPT_INVALID');
    await request(app).post('/api/family/chores/approve').send({}).expect(400);
    await request(app).post('/api/voice-personas/private/notes').send({ operation: 'invented' }).expect(400);
  });

  test('family check-in and explicit review preserve transitions without claiming parent identity', async () => {
    const profile = 'synthetic-lan-child';
    await request(app).post('/api/family/profiles').send({ profileId: profile, displayName: 'Synthetic profile', ageBand: 'school' }).expect(201);
    const created = (await request(app).post('/api/family/chores').send({ profileId: profile, title: 'Synthetic review task', cadence: 'once', stars: 2 }).expect(201)).body.data.chore;
    await request(app).post('/api/family/chores/check-in').send({ profileId: profile, ref: created.id }).expect(200);
    const pending = await PipelineTask.findOne({ pipelineId: created.id }).lean();
    expect(pending.status).toBe('review');
    await request(app).post('/api/family/chores/approve').send({ ref: created.id, authenticated: 'owner', by: 'verified-parent' }).expect(200);
    const approved = await PipelineTask.findOne({ pipelineId: created.id }).lean();
    expect(approved.status).toBe('done');
    expect(approved.transitions.at(-1)).toMatchObject({ kind: 'family_approved', actor: { authenticated: null, channel: 'family_surface' } });
    expect(approved.feedback.at(-1).text).not.toContain('completed by parent');
  });

  test('foreign browser mutations remain refused without consulting an adult session', async () => {
    const response = await request(app).post('/api/family/chores/approve').set('Sec-Fetch-Site', 'cross-site').send({}).expect(403);
    expect(response.body.code).toBe('CROSS_SITE_REQUEST_REJECTED');
  });
});
