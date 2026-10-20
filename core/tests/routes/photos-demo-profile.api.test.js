'use strict';

process.env.AGENTX_PROFILE = 'demo';
process.env.IMMICH_URL = 'http://immich.invalid';
process.env.IMMICH_API_KEY_FILE = '/nonexistent/immich-key';
const request = require('supertest');
const { app } = require('../../src/app');

describe('photos are unavailable in the demo profile', () => {
  test.each(['/api/photos/status', '/api/photos/people', '/api/photos/search/smart?q=beach'])(
    'rejects %s with the demo-disabled code', async (path) => {
      const response = await request(app).get(path).expect(404);
      expect(response.body.code).toBe('AGENTX_DEMO_SURFACE_DISABLED');
    }
  );
});
