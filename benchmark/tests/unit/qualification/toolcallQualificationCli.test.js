'use strict';

const {
  buildLiveTransport,
  parseArgs
} = require('../../../scripts/toolcall-qualification');

describe('toolcall qualification live transport bounds', () => {
  test('replays completed harness calls and named results as native Ollama history without changing the fixture', async () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ name: 'lookup_word', args: { word: 'bonjour', language: 'fr' } }] },
      { role: 'tool', name: 'lookup_word', content: '{"definition":"salutation"}' }
    ];
    const before = JSON.stringify(messages);
    const generateImpl = jest.fn(async () => ({ done: true, message: { content: 'Une salutation.' } }));
    const transport = buildLiveTransport({ model: 'candidate', host: 'http://synthetic.test', generateImpl });
    await transport({ messages, tools: [], workloadId: 'campaign-a' });
    expect(generateImpl.mock.calls[0][1].messages).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: {
        name: 'lookup_word', arguments: { word: 'bonjour', language: 'fr' }
      } }] },
      { role: 'tool', tool_name: 'lookup_word', content: '{"definition":"salutation"}' }
    ]);
    expect(JSON.stringify(messages)).toBe(before);
  });

  test('uses Core workload admission for a successful tool call', async () => {
    const generateImpl = jest.fn(async () => ({
      done: true,
      message: {
        tool_calls: [{ function: { name: 'lookup', arguments: { id: 7 } } }]
      }
    }));
    const transport = buildLiveTransport({
      model: 'candidate',
      host: 'http://ollama:11434',
      generateImpl,
      timeoutMs: 1000
    });

    await expect(transport({
      messages: [],
      tools: [],
      workloadId: 'campaign-a',
      execution: {
        numCtx: 32768,
        numPredict: 1024,
        think: false,
        sampling: { temperature: 0.2, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, seed: 43 }
      }
    })).resolves.toEqual({
      toolCalls: [{ name: 'lookup', args: { id: 7 } }]
    });
    expect(generateImpl).toHaveBeenCalledWith('campaign-a', expect.objectContaining({
      model: 'candidate',
      host: 'http://ollama:11434',
      callerDetail: 'benchmark-batch-tool-qualification',
      stream: false,
      rawResponse: true,
      think: false,
      options: { num_ctx: 32768, num_predict: 1024,
        temperature: 0.2, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, seed: 43 }
    }), { signal: expect.any(AbortSignal) });
    const { resolveCallerPolicy } = require('../../../../core/src/services/routing/callerPolicy');
    expect(resolveCallerPolicy(generateImpl.mock.calls[0][1].callerDetail).lane).toBe('direct');
  });

  test('refuses to dispatch without the exact workload identity', async () => {
    const generateImpl = jest.fn();
    const transport = buildLiveTransport({
      model: 'candidate',
      host: 'http://ollama:11434',
      generateImpl,
      timeoutMs: 1000
    });

    await expect(transport({ messages: [], tools: [] }))
      .rejects.toMatchObject({ code: 'WORKLOAD_ADMISSION_REQUIRED' });
    expect(generateImpl).not.toHaveBeenCalled();
  });

  test('classifies only an explicit Ollama no-tool-surface response as unsupported', async () => {
    const failure = Object.assign(new Error('Core API 400: model does not support tools'), { status: 400 });
    const generateImpl = jest.fn(async () => { throw failure; });
    const transport = buildLiveTransport({
      model: 'candidate',
      host: 'http://ollama:11434',
      generateImpl,
      timeoutMs: 1000
    });

    await expect(transport({ messages: [], tools: [], workloadId: 'campaign-a' }))
      .resolves.toEqual({ toolSupport: false });
  });

  test('rejects a successful HTTP response without Ollama terminal evidence', async () => {
    const generateImpl = jest.fn(async () => ({
      message: { tool_calls: [{ function: { name: 'lookup', arguments: {} } }] }
    }));
    const transport = buildLiveTransport({
      model: 'candidate',
      host: 'http://ollama:11434',
      generateImpl,
      timeoutMs: 1000
    });

    await expect(transport({ messages: [], tools: [], workloadId: 'campaign-a' }))
      .rejects.toMatchObject({ code: 'OLLAMA_RESPONSE_INCOMPLETE' });
  });

  test('parses the typed campaign token and mandatory repetition count', () => {
    expect(parseArgs([
      'node',
      'toolcall-qualification.js',
      '--live',
      '--model', 'candidate',
      '--host', 'http://ollama:11434',
      '--repetitions', '5',
      '--confirm-campaign', 'RUN_NATIVE_TOOL_QUALIFICATION'
    ])).toMatchObject({
      live: true,
      model: 'candidate',
      host: 'http://ollama:11434',
      repetitions: 5,
      confirmCampaign: 'RUN_NATIVE_TOOL_QUALIFICATION'
    });
  });
});


describe('prepared campaign CLI intent', () => {
  test.each([{ tail: [] }, { tail: ['--model', 'candidate'] }, { tail: ['--host', 'http://synthetic.example:11434'] }])(
    'a missing preparation identity never becomes an ordinary campaign: %j', ({ tail }) => {
      expect(() => parseArgs(['node', 'toolcall-qualification.js', '--live', '--driver-preparation-id', ...tail]))
        .toThrow(expect.objectContaining({ code: 'TOOL_CAMPAIGN_PREPARATION_ID_REQUIRED' }));
    });
  test('retains an exact preparation identity and leaves ordinary parsing unchanged', () => {
    expect(parseArgs(['node', 'toolcall-qualification.js', '--live', '--driver-preparation-id', 'prepare-synthetic']))
      .toMatchObject({ live: true, driverPreparationId: 'prepare-synthetic' });
    expect(parseArgs(['node', 'toolcall-qualification.js', '--live', '--driver-preparation-id=prepare-synthetic']))
      .toMatchObject({ live: true, driverPreparationId: 'prepare-synthetic' });
    expect(() => parseArgs(['node', 'toolcall-qualification.js', '--live', '--driver-preparation-id=']))
      .toThrow(expect.objectContaining({ code: 'TOOL_CAMPAIGN_PREPARATION_ID_REQUIRED' }));
    expect(parseArgs(['node', 'toolcall-qualification.js', '--live'])).not.toHaveProperty('driverPreparationId');
  });
});
