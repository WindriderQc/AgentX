'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/interactivePriorityService', () => ({ yieldPoint: jest.fn() }));

const priority = require('../../src/services/interactivePriorityService');
const { CALLER_HEADER } = require('../../src/helpers/requestCaller');
const router = require('../../routes/nerve-center-interactive-priority');

describe('workload yield point API (#62)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/nerve-center', router);
  });

  test('passes the exact proof, caller principal and in-flight count to Core', async () => {
    priority.yieldPoint.mockResolvedValue({ yield: true, yielded: true, retryAfterMs: 2000, expiresAt: 'later' });
    const response = await request(app)
      .post('/api/nerve-center/workload-admissions/admission-a/yield-point')
      .set(CALLER_HEADER, 'benchmark-service')
      .send({ generation: 'generation-a', inFlight: 0, ttlMs: 600000 })
      .expect(200);
    expect(response.body.data).toEqual({ yield: true, yielded: true, retryAfterMs: 2000, expiresAt: 'later' });
    expect(priority.yieldPoint).toHaveBeenCalledWith({ admissionId: 'admission-a', generation: 'generation-a',
      principal: 'benchmark-service', inFlight: 0, ttl: 600000 });
  });

  test('refuses a malformed in-flight count and reports a refused proof as a conflict', async () => {
    await request(app).post('/api/nerve-center/workload-admissions/a/yield-point')
      .send({ generation: 'g', inFlight: -1 }).expect(400);
    expect(priority.yieldPoint).not.toHaveBeenCalled();
    priority.yieldPoint.mockResolvedValue({ yield: false, reason: 'workload admission is not active' });
    const response = await request(app).post('/api/nerve-center/workload-admissions/a/yield-point')
      .send({ generation: 'g' }).expect(409);
    expect(response.body.data.reason).toBe('workload admission is not active');
  });
});
