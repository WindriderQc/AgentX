'use strict';
jest.mock('../../src/services/routing/inferenceTelemetry', () => ({ recordInference: jest.fn() }));
jest.mock('../../src/services/chat/chatPromptHelpers', () => ({ getActivePrompt: jest.fn(async () => ({ systemPrompt: 'Core persona', name: 'persona', version: 2 })), buildSystemPrompt: jest.fn(() => 'Core persona and RAG') }));
jest.mock('../../src/helpers/userHelpers', () => ({ getOrCreateProfile: jest.fn(async () => ({ preferences: 'Core memory' })) }));
jest.mock('../../src/services/chat/chatOrchestrationPrelude', () => ({ prepareChatOrchestration: jest.fn(async () => ({ ragContext: 'Core RAG', ragUsed: true, ragSources: [], webSearchResults: [] })) }));
jest.mock('../../src/services/chat/conversationPersistence', () => ({ persistConversation: jest.fn(async () => ({ conversation: { _id: 'core-conversation' }, assistantMessageId: 'assistant', persistence: { saved: true } })) }));
const { handleOpenClawChat, withOpenClawChat } = require('../../src/services/chat/openclawChat');
const { persistConversation } = require('../../src/services/chat/conversationPersistence');
const { prepareChatOrchestration } = require('../../src/services/chat/chatOrchestrationPrelude');
const request = () => ({ model: 'openclaw:model:fixture/model', message: 'Current turn', messages: [{ role: 'user', content: 'Canonical earlier turn' }], conversationId: 'core-conversation', userId: 'owner', options: { num_predict: 64 } });
beforeEach(() => jest.clearAllMocks());

test('Core supplies and persists canonical context while OpenClaw executes only the selected source', async () => {
    const receipt = { source: 'openclaw', mode: 'model', usage: { input: 7, output: 2, cacheRead: 3, cacheWrite: 0, total: 12 }, cost: { nanodollars: 100, source: 'runtime-estimate' } };
    const client = { execute: jest.fn(async () => ({ text: 'answer', finishReason: 'stop', partial: false, receipt })) };
    const result = await handleOpenClawChat(request(), client);
    expect(client.execute.mock.calls[0][0]).toMatchObject({ execution: { source: 'openclaw', mode: 'model', model: 'fixture/model' },
        sessionId: 'core-conversation', messages: [{ role: 'system', content: 'Core persona and RAG' }, { role: 'user', content: 'Canonical earlier turn' }, { role: 'user', content: 'Current turn' }] });
    expect(prepareChatOrchestration.mock.calls[0][0]).not.toHaveProperty('target');
    expect(persistConversation.mock.calls[0][0]).toMatchObject({ conversationId: 'core-conversation', assistantContent: 'answer', metadata: { executionReceipt: receipt } });
    expect(result.stats.usage.promptTokens).toBe(10);
    expect(require('../../src/services/routing/inferenceTelemetry').recordInference).toHaveBeenCalledWith(expect.objectContaining({ executionSource: 'openclaw', executionMode: 'model', tokensIn: 10, tokensOut: 2 }));
});
test('uncertain failure retains partial output and unknown cost without switching to local inference', async () => {
    const onError = jest.fn(); const local = jest.fn();
    const client = { execute: jest.fn(async () => { throw Object.assign(new Error('failed'), { partialResponse: 'partial', executionState: 'unknown' }); }) };
    await withOpenClawChat(local, client)({ ...request(), onToken: jest.fn(), onError });
    expect(local).not.toHaveBeenCalled(); expect(client.execute).toHaveBeenCalledTimes(1); expect(onError).toHaveBeenCalled();
    expect(require('../../src/services/routing/inferenceTelemetry').recordInference).toHaveBeenCalledWith(expect.objectContaining({ tokensIn: null, tokensOut: null, fallbackUsed: null, status: 'error' }));
    expect(persistConversation.mock.calls[0][0]).toMatchObject({ assistantContent: 'partial', stats: null,
        metadata: { partial: true, executionReceipt: { cost: null, usage: null, completion: 'unknown' } } });
});
test('the existing local chat path receives the exact original request', async () => {
    const input = { model: 'qwen:8b', message: 'hello' }; const local = jest.fn(async () => 'local'); const client = { execute: jest.fn() };
    expect(await withOpenClawChat(local, client)(input)).toBe('local'); expect(local).toHaveBeenCalledWith(input); expect(client.execute).not.toHaveBeenCalled();
});
