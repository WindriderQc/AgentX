'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../models/InferenceLog', () => ({ aggregate: jest.fn() }));
jest.mock('../../src/services/costCalculator', () => ({
  calculateMessageCost: jest.fn(async () => ({ totalCost: 0.01, pricingSource: { source: 'configured' } }))
}));
jest.mock('../../src/services/codexUsageService', () => ({
  ingestCodexUsage: jest.fn(),
  readCodexSubscriptionValue: jest.fn(async () => null)
}));

const InferenceLog = require('../../models/InferenceLog');
const router = require('../../routes/analytics-federated');

function app() {
  const instance = express();
  instance.use('/api/analytics', router);
  return instance;
}

describe('federated analytics agent grouping', () => {
  test('groups and filters agents by consumer contract, never by caller text', async () => {
    InferenceLog.aggregate.mockResolvedValue([]);

    const res = await request(app()).get('/api/analytics/federated').query({ window: '24h', agentId: 'native-conversation-v1' });

    expect(res.status).toBe(200);
    const pipelines = InferenceLog.aggregate.mock.calls.map(([pipeline]) => JSON.stringify(pipeline));
    expect(pipelines.length).toBeGreaterThan(0);
    for (const pipeline of pipelines) {
      expect(pipeline).not.toContain('callerDetail');
      expect(pipeline).toContain('"consumerContract":"native-conversation-v1"');
    }
  });
});
