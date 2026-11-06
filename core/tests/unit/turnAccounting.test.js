'use strict';

const {
  normalizeUsage, sumUsage, servedModel, messageAccounting, accountingPaths, turnUsage, conversationRagFlags
} = require('../../src/services/conversations/turnAccounting');

describe('surface turn accounting', () => {
  test('normalizes every usage shape the household engines report', () => {
    const expected = { promptTokens: 12, completionTokens: 5, totalTokens: 17 };
    expect(normalizeUsage({ prompt_eval_count: 12, eval_count: 5 })).toEqual(expected);
    expect(normalizeUsage({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })).toEqual(expected);
    expect(normalizeUsage({ input_tokens: 12, output_tokens: 5 })).toEqual(expected);
    expect(normalizeUsage({ input: 7, cacheRead: 4, cacheWrite: 1, output: 5 })).toEqual(expected);
  });

  test('keeps incomplete usage unknown instead of counting it as zero', () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage({})).toBeNull();
    expect(normalizeUsage({ input_tokens: 10 })).toBeNull();
    expect(normalizeUsage({ prompt_eval_count: -1, eval_count: 3 })).toBeNull();
  });

  test('sums the calls of a tool loop, or reports unknown when one call has no counts', () => {
    expect(sumUsage([{ prompt_eval_count: 10, eval_count: 2 }, { prompt_eval_count: 30, eval_count: 8 }]))
      .toEqual({ promptTokens: 40, completionTokens: 10, totalTokens: 50 });
    expect(sumUsage([{ prompt_eval_count: 10, eval_count: 2 }, undefined])).toBeNull();
    expect(sumUsage([])).toBeNull();
  });

  test('resolves the principal alias to the pinned model and keeps it when the pin is unreadable', async () => {
    expect(await servedModel('agentx-primary', async () => 'pinned-synthetic')).toBe('pinned-synthetic');
    expect(await servedModel('agentx-primary', async () => { throw new Error('pin unavailable'); })).toBe('agentx-primary');
    expect(await servedModel('agentx-primary', async () => null)).toBe('agentx-primary');
    expect(await servedModel('local-synthetic', async () => { throw new Error('must not be read'); })).toBe('local-synthetic');
  });

  test('prices a local turn like the Playground and records the requested alias', async () => {
    const price = jest.fn(async () => ({ totalCost: 0, currency: 'USD', pricingSource: { source: 'default' } }));
    const result = await messageAccounting({ model: 'agentx-primary', usage: { prompt_eval_count: 100, eval_count: 20 } },
      { resolvePrincipal: async () => 'pinned-synthetic', calculateMessageCost: price });
    expect(result.stats).toEqual({ usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      meta: { model: 'pinned-synthetic', requestedModel: 'agentx-primary' } });
    expect(price).toHaveBeenCalledWith('pinned-synthetic', { usage: result.stats.usage });
    expect(result.cost.totalCost).toBe(0);
  });

  test('an unpriced cloud turn keeps its tokens and an unknown cost, never $0', async () => {
    const price = jest.fn(async () => ({ totalCost: 0, pricingSource: { source: 'default' } }));
    const result = await messageAccounting({ model: 'cloud-synthetic', provider: 'openai-codex',
      usage: { input_tokens: 900, output_tokens: 100 } }, { calculateMessageCost: price });
    expect(result.stats.usage.totalTokens).toBe(1000);
    expect(result.stats.meta.provider).toBe('openai-codex');
    expect(result.cost).toMatchObject({ totalCost: null, currency: 'USD', pricingSource: { source: 'unconfigured', provider: 'openai-codex' } });
    const priced = jest.fn(async () => ({ totalCost: 0.002, pricingSource: { source: 'database' } }));
    expect((await messageAccounting({ model: 'cloud-synthetic', provider: 'openrouter', usage: { input_tokens: 1, output_tokens: 1 } },
      { calculateMessageCost: priced })).cost.totalCost).toBe(0.002);
    expect(priced).toHaveBeenCalledWith('openrouter:cloud-synthetic', expect.any(Object));
  });

  test('a pricing failure keeps the turn with its tokens and an unknown cost', async () => {
    const result = await messageAccounting({ model: 'local-synthetic', usage: { prompt_eval_count: 1, eval_count: 1 } },
      { calculateMessageCost: async () => { throw new Error('pricing store unavailable'); } });
    expect(result.stats.usage.totalTokens).toBe(2);
    expect(result.cost).toMatchObject({ totalCost: null, pricingSource: { source: 'unconfigured' } });
  });

  test('update paths only replace the evidence an update carries', () => {
    expect(accountingPaths({ stats: { meta: { model: 'm' } } })).toEqual({ 'stats.meta': { model: 'm' } });
    expect(accountingPaths({ stats: { meta: { model: 'm' }, usage: { totalTokens: 3 } }, cost: { totalCost: 0 } }))
      .toEqual({ 'stats.meta': { model: 'm' }, 'stats.usage': { totalTokens: 3 }, cost: { totalCost: 0 } });
    expect(accountingPaths({})).toEqual({});
  });

  test('a turn without usage still records its model, and an empty turn records nothing', async () => {
    expect(await messageAccounting({ model: 'local-synthetic' })).toEqual({ stats: { meta: { model: 'local-synthetic' } } });
    expect(await messageAccounting({ model: '' })).toEqual({});
  });

  test('passes an engine\'s reported usage and provider to the turn record, and nothing it did not report', () => {
    expect(turnUsage({ usage: { input_tokens: 1, output_tokens: 2 }, provider: 'openai-codex', model: 'm' }))
      .toEqual({ usage: { input_tokens: 1, output_tokens: 2 }, modelProvider: 'openai-codex' });
    expect(turnUsage({ usage: null, provider: '' })).toEqual({});
    expect(turnUsage(undefined)).toEqual({});
  });

  test('RAG flags follow supplied sources or a knowledge tool receipt and only turn on', () => {
    expect(conversationRagFlags({ knowledgeStatus: 'ready', knowledgeSourceCount: 3 })).toEqual({ ragRequested: true, ragUsed: true });
    expect(conversationRagFlags({ knowledgeStatus: 'empty', knowledgeSourceCount: 0 })).toEqual({ ragRequested: true });
    expect(conversationRagFlags({ knowledgeStatus: 'agent-managed', knowledgeUsed: true })).toEqual({ ragRequested: true, ragUsed: true });
    expect(conversationRagFlags({ knowledgeStatus: 'agent-managed', knowledgeUsed: false })).toEqual({ ragRequested: true });
    // A configured corpus alone is not a retrieval on this turn.
    expect(conversationRagFlags({ knowledgeStatus: 'active', knowledgeSourceCount: 0 })).toEqual({});
  });
});
