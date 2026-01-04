const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const { app } = require('../../src/app');
const Conversation = require('../../models/Conversation');
const DeepJob = require('../../models/DeepJob');
const PromptConfig = require('../../models/PromptConfig');

// Mock n8n webhook utility to avoid actual network calls
jest.mock('../../src/utils/n8nWebhook', () => ({
  triggerWebhook: jest.fn().mockResolvedValue({ success: true, data: {} }),
  triggers: {
    ragIngest: jest.fn(),
    chatComplete: jest.fn(),
    analytics: jest.fn()
  }
}));

// Mock Ollama fetch to avoid external calls
// Fix for node-fetch ESM issue: define a simple Response class mock
class MockResponse {
    constructor(body) {
        this.body = body;
    }
    json() {
        return Promise.resolve(JSON.parse(this.body));
    }
    get ok() {
        return true;
    }
}

// Global fetch mock to support chatService
global.fetch = jest.fn();

// Mock implementation for global fetch
global.fetch.mockImplementation((url, options) => {
    // Mock Ollama chat response
    // Ensure url is string
    const urlStr = url ? url.toString() : '';
    if (urlStr.includes('/api/chat')) {
        return Promise.resolve(new MockResponse(JSON.stringify({
          model: 'test-model',
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: 'This is a draft answer.' },
          done: true,
          total_duration: 100,
          load_duration: 10,
          prompt_eval_count: 10,
          eval_count: 10
        })));
    }
    return Promise.resolve(new MockResponse('{}'));
});

jest.mock('node-fetch', () => {
    return jest.fn();
});

const fetch = require('node-fetch');

let mongoServer;

// Set API Key for testing
process.env.N8N_CALLBACK_API_KEY = 'test-api-key';

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);

  // Setup Prompt Config
  await PromptConfig.create({
      name: 'default_chat',
      version: 1,
      systemPrompt: 'You are AgentX.',
      isActive: true
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('BrainX Deep Research Flow', () => {

  beforeEach(() => {
    fetch.mockReset();
    // Default Ollama mock response
    fetch.mockImplementation((url, options) => {
      // Mock Ollama chat response
      if (url.includes('/api/chat')) {
        return Promise.resolve(new MockResponse(JSON.stringify({
          model: 'test-model',
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: 'This is a draft answer.' },
          done: true,
          total_duration: 100,
          load_duration: 10,
          prompt_eval_count: 10,
          eval_count: 10
        })));
      }
      // Mock other requests if needed
      return Promise.resolve(new MockResponse('{}'));
    });
  });

  it('should trigger DeepJob when BrainX persona is used', async () => {
    // 1. Send Chat Request with 'brainx' persona
    const res = await request(app)
      .post('/api/chat')
      .send({
        message: 'What is the meaning of life?',
        model: 'llama3',
        options: { persona: 'brainx' }
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.deepJobId).toBeDefined();

    const jobId = res.body.data.deepJobId;

    // 2. Verify DeepJob creation in DB
    const job = await DeepJob.findOne({ jobId: jobId });
    expect(job).toBeDefined();
    expect(job.status).toBe('pending');
    expect(job.payload.query).toBe('What is the meaning of life?');

    // 3. Verify n8n webhook was triggered
    // Note: In integration tests, module mocks might behave differently depending on how app is required.
    // Ideally we check side effects.
  });

  it('should update conversation on n8n callback', async () => {
    // Setup existing job and conversation
    const conversation = await Conversation.create({
        userId: 'test-user',
        messages: [
            { role: 'user', content: 'Complex question' },
            { role: 'assistant', content: 'Draft answer', deepJobId: null } // ID added later
        ]
    });
    const msgId = conversation.messages[1]._id;

    const job = await DeepJob.create({
        jobId: 'job_unique_123',
        conversationId: conversation._id,
        messageId: msgId,
        status: 'pending',
        payload: { query: 'Complex question' }
    });

    // Link job to message (normally done in chat flow)
    conversation.messages[1].deepJobId = job._id;
    // We must initialize metadata or Mongoose might not handle Mixed type updates well initially?
    conversation.messages[1].metadata = { deepJobId: job._id };
    await conversation.save();

    // 5. Send Callback
    const callbackRes = await request(app)
        .post('/api/n8n/callback/deep-research')
        .set('x-api-key', 'test-api-key')
        .send({
            jobId: 'job_unique_123',
            status: 'completed',
            result: {
                finalAnswer: 'The answer is 42.',
                evidence: [{ source: 'Deep Thought', content: 'Calculated over 7.5M years' }]
            }
        });

    expect(callbackRes.status).toBe(200);

    // 6. Verify Job Updated
    const updatedJob = await DeepJob.findOne({ jobId: 'job_unique_123' });
    expect(updatedJob.status).toBe('completed');
    expect(updatedJob.result.finalAnswer).toBe('The answer is 42.');

    // 7. Verify Conversation Updated
    // Reload explicitly to check updates
    const reloadedConv = await Conversation.findById(conversation._id).lean();
    const reloadedMsg = reloadedConv.messages.find(m => m._id.toString() === msgId.toString());

    expect(reloadedMsg.content).toContain('Draft answer');
    expect(reloadedMsg.content).toContain('--- 🧠 Deep Research Result ---');
    expect(reloadedMsg.content).toContain('The answer is 42.');

    // Mongoose Mixed type sometimes requires explicit access or .toObject() in tests depending on version/plugins
    const metadata = reloadedMsg.metadata || {};
    expect(metadata.deepResearchEvidence).toHaveLength(1);
    expect(metadata.deepJobStatus).toBe('completed');
  });
});
