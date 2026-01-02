const request = require('supertest');
const { app } = require('../../src/app');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('../helpers/testDb');
const Conversation = require('../../models/Conversation');
const UserProfile = require('../../models/UserProfile');
const Feedback = require('../../models/Feedback');

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

afterEach(async () => {
  await Conversation.deleteMany({});
  await UserProfile.deleteMany({});
  await Feedback.deleteMany({});
});

describe('Phase 3 API Endpoints', () => {
  let agent;
  let user;

  beforeEach(async () => {
    agent = request.agent(app);
    user = new UserProfile({
      userId: 'testuser',
      email: 'test@example.com',
      password: 'password123'
    });
    await user.save();

    await agent
      .post('/api/auth/login')
      .send({ email: 'test@example.com', password: 'password123' });
  });

  describe('GET /api/analytics/feedback/summary', () => {
    it('returns summary with low performers flagged', async () => {
      const messages = [];
      for (let i = 0; i < 5; i += 1) {
        messages.push({ role: 'user', content: `Q${i}` });
        messages.push({ role: 'assistant', content: `A${i}`, feedback: { rating: -1 } });
      }

      const conv = new Conversation({
        userId: user.userId,
        model: 'qwen2.5:7b',
        promptName: 'default_chat',
        promptVersion: 1,
        messages
      });
      await conv.save();

      const res = await agent.get('/api/analytics/feedback/summary?threshold=0.7');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.lowPerformingPrompts.length).toBeGreaterThan(0);

      const flagged = res.body.data.lowPerformingPrompts.find(
        (p) => p.promptName === 'default_chat' && p.promptVersion === 1
      );
      expect(flagged).toBeDefined();
      expect(flagged.rate).toBe(0);
    });
  });

  describe('GET /api/dataset/conversations with prompt filters', () => {
    it('filters conversations by prompt name and version', async () => {
      const conv1 = new Conversation({
        userId: user.userId,
        model: 'qwen2.5:7b',
        promptName: 'default_chat',
        promptVersion: 1,
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Bad', feedback: { rating: -1 } }
        ]
      });
      await conv1.save();

      const conv2 = new Conversation({
        userId: user.userId,
        model: 'qwen2.5:7b',
        promptName: 'other_prompt',
        promptVersion: 1,
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Ok', feedback: { rating: 1 } }
        ]
      });
      await conv2.save();

      const res = await agent.get('/api/dataset/conversations?promptName=default_chat&promptVersion=1&minFeedback=-1&limit=20');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].promptName).toBe('default_chat');
      expect(res.body.data[0].promptVersion).toBe(1);
      expect(res.body.data[0].feedback.rating).toBe(-1);
    });
  });
});
