'use strict';

/**
 * Chat-lane costs, feedback and RAG adoption count messages observed in the
 * window, the same basis as the Conversations tile. A conversation started
 * before the window still contributes its in-window turns, and nothing from
 * before the window leaks in.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../routes/analytics-prompt', () => require('express').Router());
jest.mock('../../routes/analytics-effectiveness', () => require('express').Router());
jest.mock('../../routes/analytics-inference', () => require('express').Router());

const Conversation = require('../../models/Conversation');
const router = require('../../routes/analytics');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('../helpers/testDb');

const DAY = 24 * 60 * 60 * 1000;

function app() {
  const instance = express();
  instance.use('/api/analytics', router);
  return instance;
}

function assistant(at, cost, rating) {
  return {
    role: 'assistant',
    content: 'answer',
    timestamp: at,
    feedback: { rating },
    stats: { usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } },
    cost: { totalCost: cost, promptTokenCost: cost / 2, completionTokenCost: cost / 2 }
  };
}

describe('chat-lane activity basis', () => {
  const now = Date.now();
  const from = new Date(now - 2 * DAY).toISOString();
  const to = new Date(now).toISOString();

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    await connectTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    // Started ten days ago, continued an hour ago.
    await Conversation.collection.insertOne({
      model: 'cloud/model',
      createdAt: new Date(now - 10 * DAY),
      ragUsed: true,
      messages: [
        { role: 'user', content: 'old question', timestamp: new Date(now - 10 * DAY) },
        assistant(new Date(now - 10 * DAY), 1, 1),
        { role: 'user', content: 'new question', timestamp: new Date(now - 60 * 60 * 1000) },
        assistant(new Date(now - 60 * 60 * 1000), 2, -1)
      ]
    });
    // Entirely before the window.
    await Conversation.collection.insertOne({
      model: 'cloud/model',
      createdAt: new Date(now - 5 * DAY),
      ragUsed: false,
      messages: [assistant(new Date(now - 5 * DAY), 4, 1)]
    });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  test('costs count only in-window assistant messages', async () => {
    const res = await request(app()).get('/api/analytics/costs').query({ from, to });
    expect(res.status).toBe(200);
    expect(res.body.data.summary.totalCost).toBe(2);
    expect(res.body.data.summary.totalMessages).toBe(1);
    expect(res.body.data.summary.totalConversations).toBe(1);
  });

  test('feedback counts votes on in-window messages', async () => {
    const res = await request(app()).get('/api/analytics/feedback').query({ from, to });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalFeedback: 1, positive: 0, negative: 1 });
  });

  test('RAG adoption uses conversations active in the window', async () => {
    const res = await request(app()).get('/api/analytics/rag-stats').query({ from, to });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalConversations: 1, ragConversations: 1, noRagConversations: 0 });
    expect(res.body.data.feedback.rag).toMatchObject({ total: 1, positive: 0 });
    expect(res.body.data.feedback.noRag.total).toBe(0);
  });
});

describe('chat-lane date validation', () => {
  test.each(['/api/analytics/usage', '/api/analytics/feedback', '/api/analytics/rag-stats', '/api/analytics/costs'])('%s refuses an invalid range with 400', async (path) => {
    const invalid = await request(app()).get(path).query({ from: 'not-a-date' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.message).toBe('from and to must be valid dates.');
    const reversed = await request(app()).get(path).query({ from: '2026-10-10T00:00:00Z', to: '2026-10-01T00:00:00Z' });
    expect(reversed.status).toBe(400);
  });
});
