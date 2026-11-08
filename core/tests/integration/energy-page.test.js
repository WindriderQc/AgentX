'use strict';

const request = require('supertest');
const { app } = require('../../src/app');

test('Energy serves the shared polling controller before the page script', async () => {
  const page = await request(app).get('/energy').expect(200);
  const controller = '/js/utils/polling-controller-global.js';
  expect(page.text.indexOf(controller)).toBeGreaterThan(-1);
  expect(page.text.indexOf(controller)).toBeLessThan(page.text.indexOf('/js/energy.js'));
  for (const asset of [controller, '/js/energy.js']) {
    await request(app).get(asset).expect('Content-Type', /javascript/).expect(200);
  }
});
