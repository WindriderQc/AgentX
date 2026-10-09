'use strict';

const {
  SEQUENTIAL_FAMILIES, describeModelParallelism, readModelParallelism, _clearCache
} = require('../../src/services/ollamaModelParallelismService');

const show = ({ family, architecture = family, capabilities = ['completion'] } = {}) => ({
  details: { family },
  model_info: { 'general.architecture': architecture },
  capabilities
});

describe('describeModelParallelism', () => {
  it('reports the single request slot Ollama forces for a sequential architecture', () => {
    expect(describeModelParallelism(show({ family: 'qwen35', capabilities: ['completion', 'vision', 'tools'] })))
      .toEqual({ family: 'qwen35', architecture: 'qwen35', requestSlots: 1, reason: 'architecture' });
    expect(SEQUENTIAL_FAMILIES).toEqual(expect.arrayContaining(['qwen35', 'qwen35moe', 'qwen3next', 'mllama']));
  });

  it('reports one slot for a model that cannot complete text', () => {
    expect(describeModelParallelism(show({ family: 'bert', capabilities: ['embedding'] })))
      .toMatchObject({ requestSlots: 1, reason: 'no_completion' });
  });

  it('leaves any other model to the server setting', () => {
    expect(describeModelParallelism(show({ family: 'gemma3' })))
      .toEqual({ family: 'gemma3', architecture: 'gemma3', requestSlots: null, reason: 'server_setting' });
  });

  it('checks the family the scheduler reads, not only the GGUF architecture', () => {
    expect(describeModelParallelism(show({ family: 'qwen35', architecture: 'other' })))
      .toMatchObject({ family: 'qwen35', architecture: 'other', requestSlots: 1, reason: 'architecture' });
  });

  it.each([null, {}, { details: {} }])('does not guess without metadata (%j)', body => {
    expect(describeModelParallelism(body)).toEqual({ family: null, architecture: null, requestSlots: null, reason: 'unknown' });
  });
});

describe('readModelParallelism', () => {
  const hostUrl = 'http://synthetic-host:11434';
  const reply = body => ({ ok: true, json: async () => body });
  beforeEach(() => _clearCache());

  it('reads each distinct model once and keeps the answer cached', async () => {
    const fetchImpl = jest.fn(async (_url, options) => {
      const { model } = JSON.parse(options.body);
      return reply(model.startsWith('synthetic-qwen') ? show({ family: 'qwen35' }) : show({ family: 'bert', capabilities: ['embedding'] }));
    });
    const first = await readModelParallelism(hostUrl, ['synthetic-qwen:27b', 'synthetic-embedder:latest', 'synthetic-embedder'], { fetchImpl });
    expect(first).toEqual([
      { model: 'synthetic-qwen:27b', family: 'qwen35', architecture: 'qwen35', requestSlots: 1, reason: 'architecture' },
      { model: 'synthetic-embedder:latest', family: 'bert', architecture: 'bert', requestSlots: 1, reason: 'no_completion' }
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${hostUrl}/api/show`);
    await readModelParallelism(hostUrl, ['synthetic-qwen:27b'], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reads again once the cache expires', async () => {
    let clock = 0;
    const fetchImpl = jest.fn(async () => reply(show({ family: 'gemma3' })));
    await readModelParallelism(hostUrl, ['synthetic-model'], { fetchImpl, now: () => clock });
    clock = 10 * 60 * 1000 + 1;
    await readModelParallelism(hostUrl, ['synthetic-model'], { fetchImpl, now: () => clock });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports a failed read as unknown, without caching it', async () => {
    const fetchImpl = jest.fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce(reply(show({ family: 'qwen35' })));
    for (const expected of ['unknown', 'unknown', 'architecture']) {
      const [result] = await readModelParallelism(hostUrl, ['synthetic-model'], { fetchImpl });
      expect(result.reason).toBe(expected);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
