'use strict';

process.env.AGENTX_PROFILE = 'full';
delete process.env.IMMICH_URL;
delete process.env.IMMICH_API_KEY_FILE;
const request = require('supertest');
const { app } = require('../../src/app');

describe('photos are mounted in the full profile', () => {
  test('report themselves off until Immich is configured', async () => {
    const response = await request(app).get('/api/photos/status').expect(200);
    expect(response.headers['x-agentx-profile']).toBe('full');
    expect(response.body).toEqual({ ok: true, data: { enabled: false, descriptionWriteEnabled: false } });
    const search = await request(app).get('/api/photos/search/smart?q=beach').expect(503);
    expect(search.body.code).toBe('PHOTOS_NOT_CONFIGURED');
  });
});
