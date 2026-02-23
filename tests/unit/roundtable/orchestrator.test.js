const { callAgent, createRoundtable } = require('../../../src/services/roundtable/orchestrator');
const { formatTranscript, formatTelegramSummary } = require('../../../src/services/roundtable/formatters');
const { DEFAULT_PANEL, DEFAULT_SYNTHESIZER } = require('../../../src/services/roundtable/defaults');

// Mock logger
jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

// Mock node-fetch
jest.mock('node-fetch', () => jest.fn());
const fetch = require('node-fetch');

// Mock modelRouter
jest.mock('../../../src/services/modelRouter', () => ({
  getTargetForModel: jest.fn(() => 'http://host1:11434')
}));
const { getTargetForModel } = require('../../../src/services/modelRouter');

// Mock httpAgent
jest.mock('../../../src/helpers/httpAgent', () => ({
  getFetchOptions: jest.fn((url, opts) => opts)
}));

// Mock Roundtable model
jest.mock('../../../models/Roundtable', () => {
  const mockDoc = {
    _id: 'test-id-123',
    question: 'Redis vs Memcached?',
    rounds: 2,
    status: 'pending',
    panelConfig: [],
    synthesizerConfig: {},
    turns: [],
    save: jest.fn().mockResolvedValue(true)
  };

  const Model = jest.fn().mockImplementation(() => mockDoc);
  Model.create = jest.fn().mockResolvedValue(mockDoc);
  Model.findById = jest.fn().mockResolvedValue(mockDoc);
  Model.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
  Model.countDocuments = jest.fn().mockResolvedValue(0);
  Model.find = jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({
      skip: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue([])
      })
    })
  });

  return Model;
});

function okJson(data) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
}

describe('callAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getTargetForModel.mockReturnValue('http://host1:11434');
  });

  it('returns parsed response from Ollama', async () => {
    fetch.mockResolvedValueOnce(okJson({
      message: { content: 'This is my analysis.' },
      done: true,
      eval_count: 50,
      eval_duration: 2000000000,
      prompt_eval_count: 20
    }));

    const result = await callAgent(
      { agentId: 'test', role: 'Tester', model: 'qwen2.5:7b-instruct-q4_0', systemPrompt: 'Test' },
      [{ role: 'user', content: 'Hello' }],
      5000
    );

    expect(result.response).toBe('This is my analysis.');
    expect(result.error).toBeNull();
    expect(result.target).toBe('http://host1:11434');
    expect(result.hostName).toBe('host1');
    expect(result.stats.tokensPerSecond).toBe(25);
    expect(result.startedAt).toBeInstanceOf(Date);
    expect(result.completedAt).toBeInstanceOf(Date);
  });

  it('handles timeout via AbortController', async () => {
    fetch.mockImplementation(() => new Promise((_, reject) => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      setTimeout(() => reject(err), 10);
    }));

    const result = await callAgent(
      { agentId: 'test', role: 'Tester', model: 'qwen2.5:7b-instruct-q4_0', systemPrompt: 'Test' },
      [{ role: 'user', content: 'Hello' }],
      50
    );

    expect(result.error).toContain('Timeout');
    expect(result.response).toBe('');
  });

  it('handles HTTP error from Ollama', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error'
    });

    const result = await callAgent(
      { agentId: 'test', role: 'Tester', model: 'qwen2.5:7b-instruct-q4_0', systemPrompt: 'Test' },
      [{ role: 'user', content: 'Hello' }],
      5000
    );

    expect(result.error).toContain('500');
    expect(result.response).toBe('');
  });

  it('handles no host found', async () => {
    getTargetForModel.mockReturnValue(null);

    const result = await callAgent(
      { agentId: 'test', role: 'Tester', model: 'nonexistent:model', systemPrompt: 'Test' },
      [{ role: 'user', content: 'Hello' }],
      5000
    );

    expect(result.error).toContain('No host found');
  });
});

describe('createRoundtable', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates doc with default panel and synthesizer', async () => {
    const Roundtable = require('../../../models/Roundtable');

    await createRoundtable({ question: 'Redis vs Memcached?' });

    expect(Roundtable.create).toHaveBeenCalledTimes(1);
    const args = Roundtable.create.mock.calls[0][0];
    expect(args.question).toBe('Redis vs Memcached?');
    expect(args.rounds).toBe(2);
    expect(args.status).toBe('pending');
    expect(args.panelConfig).toHaveLength(3);
    expect(args.panelConfig[0].agentId).toBe('devils-advocate');
    expect(args.panelConfig[1].agentId).toBe('pragmatist');
    expect(args.panelConfig[2].agentId).toBe('visionary');
    expect(args.synthesizerConfig.model).toBe('qwen32b:perf');
  });

  it('clamps rounds to 1-3 range', async () => {
    const Roundtable = require('../../../models/Roundtable');

    await createRoundtable({ question: 'Test', rounds: 10 });
    expect(Roundtable.create.mock.calls[0][0].rounds).toBe(3);

    await createRoundtable({ question: 'Test', rounds: 0 });
    expect(Roundtable.create.mock.calls[1][0].rounds).toBe(1);
  });
});

describe('formatTranscript', () => {
  it('produces valid markdown with all sections', () => {
    const doc = {
      question: 'Redis vs Memcached?',
      status: 'completed',
      rounds: 2,
      totalDurationMs: 45000,
      turns: [
        { agentId: 'devils-advocate', role: "Devil's Advocate", round: 1, model: 'qwen2.5:7b-instruct-q4_0', hostName: 'host1', response: 'Redis has complexity.', stats: { tokensPerSecond: 25, latencyMs: 8000 } },
        { agentId: 'pragmatist', role: 'Pragmatist', round: 1, model: 'deepseek-r1:8b', hostName: 'host2', response: 'Depends on use case.', stats: { tokensPerSecond: 15, latencyMs: 12000 } },
        { agentId: 'visionary', role: 'Visionary', round: 1, model: 'qwen32b:perf', hostName: 'host3', response: 'Think long-term.', stats: { tokensPerSecond: 10, latencyMs: 20000 } }
      ],
      synthesis: {
        model: 'qwen32b:perf',
        hostName: 'host3',
        response: 'Use Redis for most cases.',
        stats: { tokensPerSecond: 10, latencyMs: 15000 }
      }
    };

    const md = formatTranscript(doc);

    expect(md).toContain('# Roundtable: Redis vs Memcached?');
    expect(md).toContain('**Status:** completed');
    expect(md).toContain('45.0s');
    expect(md).toContain('## Performance');
    expect(md).toContain("Devil's Advocate");
    expect(md).toContain('Redis has complexity.');
    expect(md).toContain('## Synthesis');
    expect(md).toContain('Use Redis for most cases.');
  });
});

describe('formatTelegramSummary', () => {
  it('produces compact summary under 500 chars', () => {
    const doc = {
      question: 'Redis vs Memcached?',
      status: 'completed',
      totalDurationMs: 45000,
      turns: [
        { agentId: 'devils-advocate', role: "Devil's Advocate", round: 1, response: 'Redis has complexity and overhead.' },
        { agentId: 'pragmatist', role: 'Pragmatist', round: 1, response: 'Depends on use case and team.' }
      ],
      synthesis: { response: 'Use Redis for most cases.' }
    };

    const summary = formatTelegramSummary(doc);
    expect(summary.length).toBeLessThan(500);
    expect(summary).toContain('Roundtable [completed]');
    expect(summary).toContain("Devil's Advocate");
  });
});

describe('defaults', () => {
  it('panel has 3 agents in correct GPU-aware order', () => {
    expect(DEFAULT_PANEL).toHaveLength(3);
    expect(DEFAULT_PANEL[0].agentId).toBe('devils-advocate');
    expect(DEFAULT_PANEL[1].agentId).toBe('pragmatist');
    expect(DEFAULT_PANEL[2].agentId).toBe('visionary');
    // Visionary must be last (GPU optimization)
    expect(DEFAULT_PANEL[2].model).toBe('qwen32b:perf');
  });

  it('synthesizer uses same model as visionary for VRAM efficiency', () => {
    expect(DEFAULT_SYNTHESIZER.model).toBe(DEFAULT_PANEL[2].model);
  });
});
