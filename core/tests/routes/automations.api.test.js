'use strict';
const express = require('express');
const request = require('supertest');
const {createRouter, mount} = require('../../routes/automations');
test('catalogue is read-only and calendar uses the existing cluster API and do not register a second execution entrance', async () => {
  const service = {status: jest.fn(async () => ({jobs: [], sources: []}))};
  const app = express(); app.use('/api/automations', createRouter(service));
  expect((await request(app).get('/api/automations?refresh=1&offset=50')).status).toBe(200);
  expect(service.status).toHaveBeenCalledWith({refresh: true, offset: 50});
  expect((await request(app).get('/api/automations/calendar')).status).toBe(404);
  expect((await request(app).post('/api/automations/one/run')).status).toBe(404);
});
test('one canonical page chooses the existing resource view and its full script set', async () => {
  const app = express();
  app.response.render = function (_layout, locals) {this.json(locals);};
  mount(app, {}, {});
  const jobs = await request(app).get('/automations');
  expect(jobs.body.activePage).toBe('automations');
  expect(jobs.body.footerJs).toContain('automations-hub.js');
  const resources = await request(app).get('/automations?view=calendar');
  expect(resources.body.pageView).toBe('../pages/cluster-schedule');
  expect(resources.body.footerJs).toContain('cluster-schedule-queue.js');
  expect(resources.body.footerJs).not.toContain('automations-hub.js');
  expect((await request(app).get('/automations?view=resources')).headers.location).toBe('/automations?view=calendar');
});
