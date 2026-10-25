'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const request = require('supertest');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('../helpers/testDb');
const familyDevice = require('../../surfaces/household/family-device');
const { registerCalendarRoutes } = require('../../surfaces/household/calendar-routes');

function app({ unlockedUntil = null, operate = jest.fn(async () => ({ authority: 'google.calendar', calendarId: 'primary', events: [] })) } = {}) {
  const instance = express(); instance.use(cookieParser());
  const envelope = (res, data, status = 200) => res.status(status).json({ ok: true, data });
  const fail = (res, status, message, code) => res.status(status).json({ ok: false, message, code });
  const ownerUnlock = { activeUntil: async () => unlockedUntil, intercept: async () => null, relock: async () => false, forget: async () => {} };
  familyDevice.register({ app: instance, mongoose, standardJsonParser: express.json(), envelope, fail, logger: null, ownerUnlock });
  registerCalendarRoutes({ app: instance, calendar: { operate }, env: { PLANNING_TIME_ZONE: 'America/Toronto' } });
  return { instance, operate };
}

describe('owner calendar presentation access', () => {
  beforeAll(async () => { process.env.NODE_ENV = 'test'; await connectTestDb(); });
  beforeEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  test('owner page and API compose one read, refuse mutation parameters and retain no-store', async () => {
    const { instance, operate } = app(); const owner = request(instance);
    const page = await owner.get('/dad/calendar?view=screen&from=nestor&start=2026-11-01');
    expect(page.status).toBe(200); expect(page.text).toContain('/assets/household/calendar.js');
    expect(operate).not.toHaveBeenCalled();
    const view = await owner.get('/api/personal-calendar/view?start=2026-11-01&end=2026-11-02');
    expect(view.status).toBe(200); expect(view.headers['cache-control']).toBe('private, no-store');
    expect(view.body.data.snapshot.source).toBe('calendar.primary');
    expect(view.body.data.snapshot.events).toEqual([]);
    expect(operate).toHaveBeenCalledTimes(1);
    expect(operate.mock.calls[0][0]).toMatchObject({ action: 'list', calendarId: 'primary', timeMin: '2026-11-01T04:00:00.000Z', timeMax: '2026-11-02T05:00:00.000Z' });
    expect((await owner.get('/api/personal-calendar/view?action=create')).status).toBe(400);
    expect((await owner.get('/dad/calendar?start=2026-02-30')).status).toBe(400);
    expect((await owner.get('/api/personal-calendar/view?start=2026-01-01&start=2026-01-02')).status).toBe(400);
    expect((await owner.post('/api/personal-calendar/view').send({ action: 'create' })).status).toBe(404);
    expect(operate).toHaveBeenCalledTimes(1);
  });

  test('pinned family devices cannot read the owner calendar; native owner unlock retains its authority', async () => {
    for (const unlockedUntil of [null, new Date(Date.now() + 600000)]) {
      const { instance, operate } = app({ unlockedUntil }); const tablet = request.agent(instance);
      expect((await tablet.post('/api/household/family-device/pin').send({ label: 'Fixture tablet' })).status).toBe(201);
      const page = await tablet.get('/dad/calendar');
      const view = await tablet.get('/api/personal-calendar/view');
      expect(page.status).toBe(unlockedUntil ? 200 : 302);
      expect(view.status).toBe(unlockedUntil ? 200 : 403);
      if (!unlockedUntil) {
        expect(page.headers.location).toBe('/panel'); expect(view.body.code).toBe('FAMILY_DEVICE_PINNED');
        expect(operate).not.toHaveBeenCalled();
      } else {
        expect(operate).toHaveBeenCalledTimes(1);
        expect(page.text).toContain('family-unlock-banner');
        expect(page.text).toContain('/js/family-device-unlock.js');
        expect(page.text).toContain(new Date(unlockedUntil).toISOString());
      }
    }
  });

  test('provider failure is unavailable, never an empty agenda or a disclosed provider error', async () => {
    const { instance } = app({ operate: jest.fn(async () => { throw new Error('PRIVATE_PROVIDER_SECRET'); }) });
    const view = await request(instance).get('/api/personal-calendar/view');
    expect(view.status).toBe(502); expect(view.body.code).toBe('CALENDAR_VIEW_UNAVAILABLE');
    expect(JSON.stringify(view.body)).not.toContain('PRIVATE_PROVIDER_SECRET');
    expect(view.body.data).toBeUndefined();
  });
});
