const express = require('express');
const request = require('supertest');
const { createRequestLog } = require('../../middleware/requestLog');

describe('requestLog', () => {
  test('logs method, path and status without the query string', async () => {
    const lines = [];
    const app = express();
    app.use(createRequestLog(line => lines.push(line)));
    app.get('/api/v1/files', (req, res) => res.status(204).end());

    await request(app).get('/api/v1/files?search=private%20note&path=/home/me').expect(204);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^GET \/api\/v1\/files 204 \d+\.\dms$/);
    expect(lines[0]).not.toContain('private');
    expect(lines[0]).not.toContain('?');
  });
});
