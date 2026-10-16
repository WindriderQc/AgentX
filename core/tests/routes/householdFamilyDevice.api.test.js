'use strict';

/**
 * A device pinned to the family profile (#826) reaches family pages and their
 * APIs only; another device can list and unpin it.
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const request = require('supertest');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('../helpers/testDb');
const familyDevice = require('../../surfaces/household/family-device');

function app() {
  const instance = express();
  instance.use(cookieParser());
  const envelope = (res, data, status = 200) => res.status(status).json({ ok: true, status: 'success', data });
  const fail = (res, status, message, code) => res.status(status).json({ ok: false, status: 'error', message, code });
  familyDevice.register({ app: instance, mongoose, standardJsonParser: express.json(), envelope, fail, logger: null });
  for (const path of ['/panel', '/kids', '/dad', '/dad/family', '/voice-lab', '/nerve-center']) instance.get(path, (_req, res) => res.send(path));
  instance.post('/api/voice-personas/family/sessions', (_req, res) => res.json({ ok: true }));
  instance.post('/api/voice-personas/private/sessions', (_req, res) => res.json({ ok: true }));
  instance.post('/api/voice-personas/memory/search', (_req, res) => res.json({ ok: true }));
  instance.get('/api/memory/notes', (_req, res) => res.json({ ok: true }));
  return instance;
}

describe('allowedForFamilyDevice', () => {
  const allowed = (method, path, query = {}) => familyDevice.allowedForFamilyDevice({ method, path, query });

  test('keeps family pages, their APIs and static assets', () => {
    expect(allowed('GET', '/panel')).toBe(true);
    expect(allowed('GET', '/kids/sounds')).toBe(true);
    expect(allowed('GET', '/voice-lab', { scope: 'family' })).toBe(true);
    expect(allowed('POST', '/api/voice-personas/family/sessions')).toBe(true);
    expect(allowed('POST', '/api/voix/synthesize/stream')).toBe(true);
    expect(allowed('GET', '/assets/household/app.js')).toBe(true);
  });

  test('refuses personal pages, owner memory and parent tools', () => {
    expect(allowed('GET', '/dad')).toBe(false);
    expect(allowed('GET', '/dad/family')).toBe(false);
    expect(allowed('GET', '/voice-lab', { scope: 'personal' })).toBe(false);
    expect(allowed('POST', '/api/voice-personas/private/sessions')).toBe(false);
    expect(allowed('POST', '/api/voice-personas/memory/search')).toBe(false);
    expect(allowed('GET', '/api/household/family-devices')).toBe(false);
    expect(allowed('GET', '/nerve-center')).toBe(false);
  });
});

describe('family device pinning', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    await connectTestDb();
  });
  beforeEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  test('a pinned device keeps family access and loses everything else until unpinned elsewhere', async () => {
    const server = app();
    const tablet = request.agent(server);

    expect((await tablet.get('/dad')).status).toBe(200);
    const pin = await tablet.post('/api/household/family-device/pin').send({ label: 'Tablet' });
    expect(pin.status).toBe(201);
    expect(pin.headers['set-cookie'][0]).toMatch(/HttpOnly/);

    expect((await tablet.get('/panel')).status).toBe(200);
    expect((await tablet.post('/api/voice-personas/family/sessions')).status).toBe(200);
    const page = await tablet.get('/dad');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/panel');
    expect((await tablet.post('/api/voice-personas/private/sessions')).body.code).toBe('FAMILY_DEVICE_PINNED');
    expect((await tablet.post('/api/voice-personas/memory/search')).status).toBe(403);
    expect((await tablet.get('/api/memory/notes')).status).toBe(403);
    expect((await tablet.get('/api/household/family-devices')).status).toBe(403);
    expect((await tablet.get('/api/household/family-device')).body.data).toMatchObject({ pinned: true, label: 'Tablet' });

    // The owner's own device lists and unpins it.
    const owner = request.agent(server);
    const { body } = await owner.get('/api/household/family-devices');
    expect(body.data.devices).toEqual([expect.objectContaining({ label: 'Tablet' })]);
    expect(JSON.stringify(body)).not.toMatch(/tokenHash/);
    expect((await owner.delete(`/api/household/family-devices/${body.data.devices[0].id}`)).status).toBe(200);

    expect((await tablet.get('/dad')).status).toBe(200);
  });
});
