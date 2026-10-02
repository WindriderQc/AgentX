/**
 * Unit tests for hostPinPrimitives embedding-model detection.
 *
 * Regression context: pinning `qllama/bge-m3:f16` on Host Gamma stored fine but
 * every warm attempt hit `/api/generate` and was refused with
 * `"qllama/bge-m3:f16" does not support generate` — the name matcher knew
 * `embed`/`embedding`/`nomic` but not the BAAI `bge` family.
 */

const {
  isEmbeddingModelName,
  getWarmOrder,
  resolvePinnedRuntimeOptions,
  getLoadedEntryStatus,
  entrySatisfiedByLoadedModel,
  readVramSpill,
  verifyPinnedEntriesLoaded,
  isSpillOnlyRestore
} = require('../../src/services/hostPinPrimitives');

describe('isEmbeddingModelName', () => {
  it.each([
    'qllama/bge-m3:f16',
    'bge-m3:f16',
    'bge-large:latest',
    'nomic-embed-text:v1.5',
    'qwen3-embedding:8b',
    'all-minilm:l6-v2',
    'mxbai-embed-large'
  ])('detects %s as an embedding model', (name) => {
    expect(isEmbeddingModelName(name)).toBe(true);
  });

  it.each([
    'ax/gemma4:26b-a4b-it-qat',
    'ax/gemma4:31b-it-qat',
    'ax/qwen3.5:9b',
    'ax/Qwen3.5:35b-a3b-q8_0',
    'qwen3-coder:30b',
    'ax/qwen3.6:27b-mtp-q8_0',
    'llama3.2:3b'
  ])('does not flag generative model %s', (name) => {
    expect(isEmbeddingModelName(name)).toBe(false);
  });

  it('handles null/empty safely', () => {
    expect(isEmbeddingModelName(null)).toBe(false);
    expect(isEmbeddingModelName('')).toBe(false);
    expect(isEmbeddingModelName(undefined)).toBe(false);
  });
});

describe('getWarmOrder with bge pins', () => {
  it('warms the generative model before the bge embedder', () => {
    const order = getWarmOrder([
      { model: 'qllama/bge-m3:f16' },
      { model: 'ax/gemma4:26b-a4b-it-qat' }
    ]);
    expect(order.map((e) => e.model)).toEqual([
      'ax/gemma4:26b-a4b-it-qat',
      'qllama/bge-m3:f16'
    ]);
  });
});

describe('resolvePinnedRuntimeOptions', () => {
  const pref = {
    pinnedModels: [{
      model: 'ax/gemma4:31b-it-qat',
      keepAlive: -1,
      contextSize: 49152,
      autoRestore: true
    }]
  };

  it('applies the warm pin context and keep-alive to a chat request', () => {
    expect(resolvePinnedRuntimeOptions(pref, 'ax/gemma4:31b-it-qat', {})).toMatchObject({
      options: { num_ctx: 49152 },
      keepAlive: -1,
      numCtxSource: 'host_preference_pin',
      pinnedEntry: { model: 'ax/gemma4:31b-it-qat' }
    });
  });

  it('keeps namespace and tag identity exact when applying pin options', () => {
    expect(resolvePinnedRuntimeOptions(pref, 'gemma4:31b-it-qat', {}).pinnedEntry).toBeNull();
    expect(resolvePinnedRuntimeOptions(pref, 'gemma4:26b-a4b-it-qat', {}).pinnedEntry).toBeNull();
  });

  it('preserves explicit caller context and keep-alive', () => {
    expect(resolvePinnedRuntimeOptions(
      pref,
      'ax/gemma4:31b-it-qat',
      { num_ctx: 32768, keep_alive: '5m', temperature: 0.2 }
    )).toMatchObject({
      options: { num_ctx: 32768, temperature: 0.2 },
      keepAlive: '5m',
      numCtxSource: 'caller'
    });
  });

  it('leaves an unpinned model on its Modelfile runtime options', () => {
    expect(resolvePinnedRuntimeOptions(pref, 'ax/qwen3.5:9b', { temperature: 0.3 })).toEqual({
      options: { temperature: 0.3 },
      keepAlive: undefined,
      numCtxSource: 'modelfile',
      pinnedEntry: null
    });
  });
});

describe('loaded pin residency', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const pin = {
    model: 'nomic-embed-text:v1.5',
    keepAlive: -1,
    contextSize: 0,
    autoRestore: true
  };

  it('does not accept a five-minute Ollama TTL as an infinite pin', () => {
    const running = [{
      name: pin.model,
      context_length: 2048,
      expires_at: '2026-08-06T00:05:00Z'
    }];

    expect(getLoadedEntryStatus(pin, running, now)).toMatchObject({
      loaded: true,
      contextMismatch: false,
      residencyMismatch: true,
      expectedKeepAlive: -1
    });
    expect(entrySatisfiedByLoadedModel(pin, running)).toBe(false);
  });

  it('accepts the far-future expiry returned for a real infinite pin', () => {
    const running = [{
      name: pin.model,
      context_length: 2048,
      expires_at: '2318-11-16T00:00:00Z'
    }];

    expect(getLoadedEntryStatus(pin, running, now)).toMatchObject({
      loaded: true,
      contextMismatch: false,
      residencyMismatch: false
    });
  });

  it('fails open when an Ollama version omits expiry metadata', () => {
    expect(getLoadedEntryStatus(pin, [{ name: pin.model }], now).residencyMismatch).toBe(false);
  });
});

describe('loaded pin VRAM spill', () => {
  const pin = { model: 'qwen3.8:27b-mtp-q8_0', keepAlive: -1, contextSize: 65536, autoRestore: true };
  const loaded = (extra) => [{
    name: pin.model,
    context_length: 65536,
    expires_at: '2319-01-07T00:00:00Z',
    ...extra
  }];

  it('reports a pin that runs wholly on CPU without asking for a reload', () => {
    const running = loaded({ size: 30903852071, size_vram: 0 });
    expect(getLoadedEntryStatus(pin, running).vramSpill).toEqual({ size: 30903852071, sizeVram: 0 });
    expect(entrySatisfiedByLoadedModel(pin, running)).toBe(true);
  });

  it('reports a partial spill', () => {
    expect(readVramSpill({ size: 1263009790, size_vram: 581980651 }))
      .toEqual({ size: 1263009790, sizeVram: 581980651 });
  });

  it('accepts a pin wholly in VRAM', () => {
    expect(getLoadedEntryStatus(pin, loaded({ size: 31283342210, size_vram: 31283342210 })).vramSpill).toBeNull();
  });

  it('fails open when an Ollama version omits size metadata', () => {
    expect(getLoadedEntryStatus(pin, loaded({})).vramSpill).toBeNull();
    expect(readVramSpill({ size: 100 })).toBeNull();
  });

  it('does not verify a restore whose pin spilled', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ models: loaded({ size: 1000, size_vram: 400 }) })
    }));
    try {
      const result = await verifyPinnedEntriesLoaded('http://host:11434', [pin], 1);
      expect(result.verified).toBe(false);
      expect(result.statuses[0].vramSpill).toEqual({ size: 1000, sizeVram: 400 });

      global.fetch.mockImplementation(async () => ({
        ok: true,
        json: async () => ({ models: loaded({ size: 1000, size_vram: 1000 }) })
      }));
      expect((await verifyPinnedEntriesLoaded('http://host:11434', [pin], 1)).verified).toBe(true);
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('isSpillOnlyRestore', () => {
  const ok = { status: 'ok' };
  const loaded = extra => ({ loaded: true, contextMismatch: false, residencyMismatch: false, vramSpill: null, ...extra });

  it('accepts a complete restore whose only miss is a VRAM spill', () => {
    expect(isSpillOnlyRestore({
      results: [ok, ok],
      verification: { statuses: [loaded(), loaded({ vramSpill: { size: 100, sizeVram: 40 } })] },
    })).toBe(true);
  });

  it.each([
    ['a failed warm', { results: [ok, { status: 'error' }], verification: { statuses: [loaded({ vramSpill: { size: 1, sizeVram: 0 } })] } }],
    ['a missing pin', { results: [ok], verification: { statuses: [loaded({ vramSpill: { size: 1, sizeVram: 0 } }), { loaded: false }] } }],
    ['a context mismatch', { results: [ok], verification: { statuses: [loaded({ contextMismatch: true, vramSpill: { size: 1, sizeVram: 0 } })] } }],
    ['no spill at all', { results: [ok], verification: { statuses: [loaded()] } }],
    ['no verification', { results: [ok] }],
  ])('rejects %s', (_label, result) => {
    expect(isSpillOnlyRestore(result)).toBe(false);
  });
});
