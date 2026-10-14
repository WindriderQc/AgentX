'use strict';
const express = require('express');
const request = require('supertest');
const {createRouter, mount} = require('../../routes/automations');
test('catalogue and calendar are read-only and do not register a second execution entrance', async () => {
  const service = {status: jest.fn(async () => ({jobs: [], sources: []})), calendar: jest.fn(async options => options)};
  const app = express(); app.use('/api/automations', createRouter(service));
  expect((await request(app).get('/api/automations?refresh=1&offset=50')).status).toBe(200);
  expect(service.status).toHaveBeenCalledWith({refresh: true, offset: 50});
  expect((await request(app).get('/api/automations/calendar?date=2026-10-14&timezone=UTC')).body.data).toEqual({date: '2026-10-14', timezone: 'UTC'});
  expect((await request(app).post('/api/automations/one/run')).status).toBe(404);
});
test('invalid calendar inputs return a bounded error without leaking native diagnostics', async () => {
  const app = express(); app.use('/api/automations', createRouter({calendar: async () => {throw Object.assign(Error('private diagnostic'), {status: 400});}}));
  const result = await request(app).get('/api/automations/calendar?date=invalid');
  expect(result.status).toBe(400);
  expect(result.text).not.toContain('private diagnostic');
});
test('one canonical page chooses the existing resource view and its full script set', async () => {
  const app = express();
  app.response.render = function (_layout, locals) {this.json(locals);};
  mount(app, {}, {});
  const jobs = await request(app).get('/automations');
  expect(jobs.body.activePage).toBe('automations');
  expect(jobs.body.footerJs).toContain('automations-hub.js');
  const resources = await request(app).get('/automations?view=resources');
  expect(resources.body.pageView).toBe('../pages/cluster-schedule');
  expect(resources.body.footerJs).toContain('cluster-schedule-queue.js');
});
