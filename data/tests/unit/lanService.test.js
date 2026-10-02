const request = require('supertest');
const { app } = require('../../server');

test('LAN API keeps payload validation without credentials, request quotas or a CORS wildcard', async () => {
  const previous = process.env.DATA_API_KEY;
  process.env.DATA_API_KEY = 'obsolete-setting';
  app.locals.db = { collection: jest.fn() };
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    for (let index = 0; index < 105; index += 1) {
      const response = await request(server).get('/api/v1/network/scan-requests')
        .set('Origin', 'http://household-client.test');
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/scannerId/);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    await request(server).post('/api/v1/storage/scan/invalid/batch')
      .send({ files: [] }).expect(400);
    await request(server).post('/api/v1/storage/scan/invalid/batch')
      .set('Origin', 'https://foreign.example').set('Sec-Fetch-Site', 'cross-site')
      .send({ files: [] }).expect(403);
    expect(app.locals.db.collection).not.toHaveBeenCalled();
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.DATA_API_KEY;
    else process.env.DATA_API_KEY = previous;
  }
});
