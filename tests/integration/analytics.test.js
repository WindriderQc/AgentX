const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { app } = require('../../src/app');
const Conversation = require('../../models/Conversation');
const UserProfile = require('../../models/UserProfile');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Analytics Routes Integration', () => {
  let agent;
  let user;

  beforeEach(async () => {
    agent = request.agent(app);
    // Create a user and login
    // Use a unique email for each test to avoid rate limiting across tests if IP is shared
    const uniqueEmail = `test-${Date.now()}-${Math.random()}@example.com`;
    user = new UserProfile({ userId: 'testuser', email: uniqueEmail, password: 'password123' });
    await user.save();

    // Simulate different IP for each test execution to bypass rate limiting
    // Note: This relies on express-rate-limit trusting X-Forwarded-For if configured,
    // or we might need to manually mock req.ip if the middleware doesn't support it in test env.
    // However, since we are using supertest, the connection is local.
    // A better approach for testing is to disable rate limiting in test environment or mock the middleware.
    // Since we cannot easily modify the app setup here, we will try to just sleep a bit if needed,
    // but better to just mock the IP.

    const loginRes = await agent
      .post('/api/auth/login')
      .set('X-Forwarded-For', `10.0.0.${Math.floor(Math.random() * 255)}`)
      .send({ email: uniqueEmail, password: 'password123' });

    expect(loginRes.status).toBe(200);

    // Seed some conversation data with stats
    // Note: Conversation model uses userId field for string identifier (e.g. 'testuser'), not ObjectId
    const conv1 = new Conversation({
      userId: user.userId,
      model: 'llama2',
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: 'Hello',
          stats: {
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            performance: { totalDuration: 1000000000, tokensPerSecond: 5 } // 1 sec
          }
        }
      ]
    });
    await conv1.save();

    const conv2 = new Conversation({
      userId: user.userId,
      model: 'mistral',
      messages: [
        { role: 'user', content: 'Bye' },
        {
          role: 'assistant',
          content: 'Goodbye',
          stats: {
            usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
            performance: { totalDuration: 2000000000, tokensPerSecond: 5 } // 2 sec
          }
        }
      ]
    });
    await conv2.save();
  });

  afterEach(async () => {
    await Conversation.deleteMany({});
    await UserProfile.deleteMany({});
  });

  describe('GET /api/analytics/stats', () => {
    it('should return aggregated stats grouped by model', async () => {
      const res = await agent.get('/api/analytics/stats?groupBy=model');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.totals.totalTokens).toBe(45); // 15 + 30
      expect(res.body.data.totals.durationSec).toBe(3); // 1 + 2
      expect(res.body.data.totals.promptTokens).toBe(30); // 10 + 20
      expect(res.body.data.totals.completionTokens).toBe(15); // 5 + 10
      expect(res.body.data.totals.messages).toBe(2);
      expect(res.body.data.totals.avgDurationSec).toBe(1.5); // 3 / 2

      const breakdown = res.body.data.breakdown;
      expect(breakdown).toHaveLength(2);

      const llama2 = breakdown.find(b => b.key === 'llama2');
      expect(llama2).toBeDefined();
      expect(llama2.usage.totalTokens).toBe(15);

      const mistral = breakdown.find(b => b.key === 'mistral');
      expect(mistral).toBeDefined();
      expect(mistral.usage.totalTokens).toBe(30);
    });

    it('should return aggregated stats grouped by day', async () => {
      const res = await agent.get('/api/analytics/stats?groupBy=day');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.breakdown).toHaveLength(1); // Both created today
      expect(res.body.data.breakdown[0].usage.totalTokens).toBe(45);
    });

    it('should handle multiple days correctly', async () => {
      // Create a conversation from yesterday
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const convYesterday = new Conversation({
        userId: user.userId,
        model: 'llama2',
        createdAt: yesterday,
        messages: [
          { role: 'user', content: 'Hi' },
          {
            role: 'assistant',
            content: 'Hello',
            stats: {
              usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
              performance: { totalDuration: 1000000000, tokensPerSecond: 10 }
            }
          }
        ]
      });
      await convYesterday.save();

      const res = await agent.get('/api/analytics/stats?groupBy=day');

      expect(res.status).toBe(200);
      expect(res.body.data.breakdown.length).toBeGreaterThanOrEqual(2);

      // Sort breakdown by date to be sure
      const sorted = res.body.data.breakdown.sort((a, b) => a.key.localeCompare(b.key));
      const todayStr = new Date().toISOString().split('T')[0];
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const todayStats = sorted.find(b => b.key === todayStr);
      const yesterdayStats = sorted.find(b => b.key === yesterdayStr);

      expect(todayStats).toBeDefined();
      expect(todayStats.usage.totalTokens).toBe(45);

      expect(yesterdayStats).toBeDefined();
      expect(yesterdayStats.usage.totalTokens).toBe(10);
    });

    it('should not return stats for other users', async () => {
      // Create another user and a conversation for them
      const otherUser = new UserProfile({ userId: 'otheruser', email: 'other@example.com', password: 'password123' });
      await otherUser.save();

      const otherConv = new Conversation({
        userId: otherUser.userId,
        model: 'llama2',
        messages: [
          { role: 'user', content: 'Hi' },
          {
            role: 'assistant',
            content: 'Hello',
            stats: {
              usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
              performance: { totalDuration: 1000000000, tokensPerSecond: 5 }
            }
          }
        ]
      });
      await otherConv.save();

      // Request stats as original user (who has 45 tokens total)
      const res = await agent.get('/api/analytics/stats');

      expect(res.status).toBe(200);
      expect(res.body.data.totals.totalTokens).toBe(45); // Should NOT include the 150 from otherUser

      // Ensure breakdown also does not contain other user's data
      // otherUser used llama2, which user also used (15 tokens)
      const breakdown = res.body.data.breakdown;
      const llama2 = breakdown.find(b => b.key === 'llama2');
      expect(llama2.usage.totalTokens).toBe(15);
    });

    it('should handle invalid groupBy gracefully', async () => {
      // Default to model if invalid
      const res = await agent.get('/api/analytics/stats?groupBy=invalid');
      expect(res.status).toBe(200);
      expect(res.body.data.breakdown[0].key).toBeDefined(); // likely 'llama2' or 'mistral'
    });
  });

  describe('User Isolation on Existing Endpoints', () => {
    it('should isolate data on /usage', async () => {
      // Create other user data
      const otherUser = new UserProfile({ userId: 'other', email: 'o@e.com', password: 'p' });
      await otherUser.save();
      const c = new Conversation({ userId: otherUser.userId, messages: [{role:'user',content:'h'}] });
      await c.save();

      const res = await agent.get('/api/analytics/usage');
      expect(res.status).toBe(200);
      // User has 2 conversations (from beforeEach)
      expect(res.body.data.totalConversations).toBe(2);
    });

    it('should isolate data on /feedback', async () => {
       // User has no feedback in seed data. Add one for other user.
       const otherUser = new UserProfile({ userId: 'other2', email: 'o2@e.com', password: 'p' });
       await otherUser.save();
       const c = new Conversation({
         userId: otherUser.userId,
         messages: [{
           role:'assistant',
           content:'h',
           feedback: { rating: 1 }
         }]
       });
       await c.save();

       const res = await agent.get('/api/analytics/feedback');
       expect(res.status).toBe(200);
       expect(res.body.data.totalFeedback).toBe(0);
    });
  });
});
