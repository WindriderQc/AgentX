const { getTokenCounter } = require('../../src/services/tokenCounter');

describe('TokenCounterService', () => {
  let tokenCounter;

  beforeEach(() => {
    tokenCounter = getTokenCounter();
  });

  describe('countTokens', () => {
    it('should estimate tokens correctly (~4 chars/token)', () => {
      expect(tokenCounter.countTokens('1234')).toBe(1);
      expect(tokenCounter.countTokens('12345678')).toBe(2);
      expect(tokenCounter.countTokens('')).toBe(0);
      expect(tokenCounter.countTokens(null)).toBe(0);
    });

    it('should round up', () => {
      expect(tokenCounter.countTokens('1')).toBe(1);
      expect(tokenCounter.countTokens('12345')).toBe(2);
    });
  });

  describe('getModelPricing', () => {
    it('should return correct pricing for known models', () => {
      const gpt4 = tokenCounter.getModelPricing('gpt-4');
      expect(gpt4.prompt).toBe(30.00);
      expect(gpt4.completion).toBe(60.00);
    });

    it('should handle partial matches', () => {
      const gpt4Preview = tokenCounter.getModelPricing('gpt-4-turbo-preview');
      expect(gpt4Preview.prompt).toBe(30.00); // Assuming it matches gpt-4 or default if logic is strict, but implemented logic finds substring
    });

    it('should return default pricing for unknown models', () => {
      const unknown = tokenCounter.getModelPricing('super-unknown-model');
      expect(unknown.prompt).toBe(0.10);
      expect(unknown.completion).toBe(0.20);
    });
  });

  describe('calculateCost', () => {
    it('should calculate cost correctly', () => {
      // gpt-4: 30/60
      // 1M tokens prompt = $30
      // 100k tokens prompt = $3
      const cost = tokenCounter.calculateCost('gpt-4', 100000, 0);
      expect(cost).toBeCloseTo(3.00);
    });

    it('should sum prompt and completion costs', () => {
        // gpt-3.5-turbo: 0.50 / 1.50
        // 1M prompt = $0.50
        // 1M completion = $1.50
        const cost = tokenCounter.calculateCost('gpt-3.5-turbo', 1000000, 1000000);
        expect(cost).toBeCloseTo(2.00);
    });
  });

  describe('analyzeConversation', () => {
    it('should analyze conversation messages', () => {
      const conversation = {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: '1234' }, // 1 token
          { role: 'user', content: '1234' },   // 1 token
          { role: 'assistant', content: '12341234' } // 2 tokens
        ]
      };

      const analysis = tokenCounter.analyzeConversation(conversation);

      expect(analysis.promptTokens).toBe(2);
      expect(analysis.completionTokens).toBe(2);
      expect(analysis.totalTokens).toBe(4);
      expect(analysis.model).toBe('gpt-3.5-turbo');

      // Cost: (2/1M * 0.50) + (2/1M * 1.50)
      // = 0.000001 + 0.000003 = 0.000004
      expect(analysis.cost).toBeCloseTo(0.000004);
    });

    it('uses native measured tokens and cost instead of legacy transcript estimates', () => {
      const receipt = { source: 'openclaw', usage: { input: 10, output: 3, cacheRead: 5, cacheWrite: 0 },
        cost: { nanodollars: 1230000, currency: 'USD' } };
      const analysis = tokenCounter.analyzeConversation({ model: 'openclaw:model:openrouter/gpt-4',
        messages: [{ role: 'user', content: '1234' }, { role: 'assistant', content: '1234', metadata: { executionReceipt: receipt } }] });
      expect(analysis).toMatchObject({ promptTokens: 15, completionTokens: 3, totalTokens: 18, cost: .00123 });
    });
    it('keeps missing native usage and cost unknown even when text is present', () => {
      const analysis = tokenCounter.analyzeConversation({ model: 'openclaw:agent:main', messages: [
        { role: 'assistant', content: '1234', metadata: { executionReceipt: { source: 'openclaw', usage: null, cost: null } } }
      ] });
      expect(analysis).toMatchObject({ promptTokens: null, completionTokens: null, totalTokens: null, cost: null });
    });
    it('keeps unknown unanswered native calls and mixed conversation cost incomplete', () => {
      const receipt = { source: 'openclaw', usage: { input_tokens: 7, output_tokens: 2 }, cost: null };
      const unanswered = tokenCounter.analyzeConversation({ model: 'qwen:8b', messages: [
        { role: 'user', content: '1234', metadata: { executionReceipt: { ...receipt, usage: null } } }
      ] });
      expect(unanswered.totalTokens).toBeNull(); expect(unanswered.cost).toBeNull();
      const mixed = tokenCounter.analyzeConversation({ model: 'qwen:8b', messages: [
        { role: 'assistant', content: '1234', stats: { usage: { promptTokens: 10, completionTokens: 4 } }, cost: { totalCost: 0, currency: 'USD' } },
        { role: 'assistant', content: '1234', metadata: { executionReceipt: receipt } }
      ] });
      expect(mixed.totalTokens).toBe(23); expect(mixed.cost).toBeNull();
    });

    it('should handle empty conversation', () => {
        const analysis = tokenCounter.analyzeConversation({});
        expect(analysis.totalTokens).toBe(0);
        expect(analysis.cost).toBe(0);
    });
  });
});
