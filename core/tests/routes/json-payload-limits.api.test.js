'use strict';

const request = require('supertest');
const { app } = require('../../src/app');

describe('Core JSON transport boundaries', () => {
  it('enforces the 1 MiB chat parser before the product default parser', async () => {
    const response = await request(app)
      .post('/api/chat')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ message: 'x'.repeat(1024 * 1024 + 1) }))
      .expect(413);

    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(response.body.message).toContain('configured route limit');
  });

  it('enforces the 5 MiB product default on routes without a local parser', async () => {
    const response = await request(app)
      .post('/api/not-a-real-route')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ value: 'x'.repeat(5 * 1024 * 1024 + 1) }))
      .expect(413);

    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('admits photo-sized bodies on /api/inference/generate up to its 32 MiB route limit', async () => {
    const accepted = await request(app)
      .post('/api/inference/generate')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ prompt: 'x'.repeat(6 * 1024 * 1024) }));
    expect(accepted.status).not.toBe(413);

    const refused = await request(app)
      .post('/api/inference/generate')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ prompt: 'x'.repeat(32 * 1024 * 1024 + 1) }))
      .expect(413);
    expect(refused.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('lets Roundtable interjections keep their 16 KiB route-owned limit', async () => {
    const response = await request(app)
      .post('/api/roundtable/any-roundtable/interjections')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ value: 'x'.repeat(16 * 1024 + 1) }))
      .expect(413);

    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
