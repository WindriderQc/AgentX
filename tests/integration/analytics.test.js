const request = require('supertest');
const { app } = require('../../src/app');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('../helpers/testDb');
const Conversation = require('../../models/Conversation');
const UserProfile = require('../../models/UserProfile');

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('Analytics Routes Integration', () => {
  let agent;
  let user;

  beforeEach(async () => {
    agent = request.agent(app);
    // Create a user and login
    user = new UserProfile({ userId: 'testuser', email: 'test@example.com', password: 'password123' });
    await user.save();

    await agent
      .post('/api/auth/login')
      .send({ email: 'test@example.com', password: 'password123' });

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
    });
  });
});
