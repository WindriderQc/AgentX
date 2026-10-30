// Synthetic conversations and real pricing rows in a disposable test database.
'use strict';
const Conversation = require('../../models/Conversation');
const Pricing = require('../../models/ModelPricingConfig');
const { clearPricingCache } = require('../../src/services/costCalculator');
const { persistConversation } = require('../../src/services/chat/conversationPersistence');
const originalEnv = { ...process.env };
const stats = { usage: { promptTokens: 1000000, completionTokens: 1000000, totalTokens: 2000000 } };
const input = (metadata = {}) => ({
  userId: 'fixture-owner', model: 'llama3.2:1b', message: 'Synthetic request', assistantContent: 'Synthetic reply',
  effectiveSystemPrompt: 'Fixture prompt', activePrompt: { name: 'fixture', version: 1 }, metadata, stats
});

beforeEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (/^(OLLAMA_.*COST|DEFAULT_FALLBACK_.*COST|COST_TRACKING_ENABLED)/.test(key)) delete process.env[key];
  }
  clearPricingCache();
  await Pricing.deleteMany({});
  await Conversation.deleteMany({});
  await Pricing.create({ provider: 'ollama', modelName: 'llama3.2:1b', pricing: { promptTokenCost: 2, completionTokenCost: 3 } });
});
afterEach(() => { process.env = { ...originalEnv }; clearPricingCache(); });

test('persists the tagged model database price and leaves a saved estimate unchanged after pricing changes', async () => {
  const first = await persistConversation(input());
  const stored = await Conversation.findById(first.conversation._id);
  const reply = stored.messages.find(item => item.role === 'assistant');
  expect(reply.cost.totalCost).toBe(5);
  expect(reply.cost.pricingSource).toMatchObject({ provider: 'ollama', modelName: 'llama3.2:1b', source: 'database' });
  expect(stored.totalCost.sum).toBe(5);
  await Pricing.updateOne({ modelName: 'llama3.2:1b' }, { $set: { 'pricing.promptTokenCost': 7 } });
  clearPricingCache();
  const second = await persistConversation(input());
  expect(second.conversation.messages.find(item => item.role === 'assistant').cost.totalCost).toBe(10);
  const unchanged = await Conversation.findById(stored._id);
  expect(unchanged.messages.find(item => item.role === 'assistant').cost.toObject()).toEqual(reply.cost.toObject());
});

test.each([null, { nanodollars: 125000000, currency: 'USD' }])('native receipt cost stays authoritative: %j', async cost => {
  const receipt = { source: 'openclaw', mode: 'model', cost, usage: { input: 1000000, output: 1000000, total: 2000000 } };
  const result = await persistConversation(input({ executionReceipt: receipt }));
  const stored = await Conversation.findById(result.conversation._id);
  const reply = stored.messages.find(item => item.role === 'assistant');
  expect(reply.cost.totalCost).toBe(cost ? 0.125 : null);
  expect(reply.cost.pricingSource.source).toBe(cost ? 'openclaw' : 'unconfigured');
  expect(stored.totalCost.sum).toBe(cost ? 0.125 : null);
});
