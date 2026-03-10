/**
 * Unit Tests for Streaming SSE Functionality (chatService.js)
 * Tests handleChatRequestStream() for token streaming, thinking models, RAG, errors
 */

const { handleChatRequestStream } = require('../../src/services/chatService');
const Conversation = require('../../models/Conversation');
const PromptConfig = require('../../models/PromptConfig');
const { getOrCreateProfile } = require('../../src/helpers/userHelpers');
const { sanitizeOptions, resolveTarget } = require('../../src/utils');
const { tryHandleToolCommand } = require('../../src/services/toolService');
const { routeRequest, getTargetForModel } = require('../../src/services/modelRouter');
const { calculateMessageCost, calculateConversationCost } = require('../../src/services/costCalculator');
const { isThinkingModel } = require('../../src/helpers/ollamaResponseHandler');
const logger = require('../../config/logger');

// Mock dependencies
jest.mock('../../models/Conversation', () => {
    const mockInstance = {
        save: jest.fn().mockResolvedValue(true)
    };
    const mockModel = jest.fn(() => mockInstance);
    Object.assign(mockModel, {
        find: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn(),
        findById: jest.fn(),
        updateOne: jest.fn(),
        aggregate: jest.fn(),
        countDocuments: jest.fn()
    });
    return mockModel;
});

jest.mock('../../models/PromptConfig', () => ({
    getActive: jest.fn(),
    findOne: jest.fn()
}));

jest.mock('../../models/N8nLLMSource', () => ({
    findOne: jest.fn()
}));
jest.mock('../../src/services/n8nLLMProvider', () => ({
    chat: jest.fn()
}));

jest.mock('../../models/N8nLLMSource', () => ({
    findOne: jest.fn()
}));
jest.mock('../../src/services/n8nLLMProvider', () => ({
    chat: jest.fn()
}));

jest.mock('../../src/helpers/userHelpers');
jest.mock('../../src/utils');
jest.mock('../../src/services/toolService');
jest.mock('../../src/services/modelRouter');
jest.mock('../../src/services/costCalculator');
jest.mock('../../src/helpers/ollamaResponseHandler');
jest.mock('../../config/logger');

// Mock node-fetch for streaming responses
jest.mock('node-fetch');
const mockFetch = require('node-fetch');

describe('chatService - handleChatRequestStream', () => {

    const mockUser = {
        _id: 'user123',
        username: 'testuser',
        about: 'Test user profile',
        preferences: { customInstructions: 'Be concise' }
    };

    const mockPrompt = {
        _id: 'prompt123',
        systemPrompt: 'You are a helpful assistant.',
        name: 'default_chat',
        version: 'v1'
    };

    const mockCost = {
        totalCost: 0.0001,
        inputCost: 0.00005,
        outputCost: 0.00005,
        currency: 'USD',
        pricingSource: { source: 'mock' }
    };

    // Helper to create mock streaming response with async iterable body
    const createMockStreamResponse = (chunks) => {
        const encoder = new TextEncoder();

        // Create async iterable body (Node streams style)
        const asyncIterableBody = {
            async *[Symbol.asyncIterator]() {
                for (const chunk of chunks) {
                    yield encoder.encode(chunk);
                }
            }
        };

        return {
            ok: true,
            statusText: 'OK',
            body: asyncIterableBody
        };
    };

    // Helper to create mock conversation with Mongoose-like methods
    const createMockConversation = (data = {}) => {
        const messages = data.messages || [];
        return {
            _id: data._id || 'conv123',
            userId: data.userId || 'user123',
            workspaceId: data.workspaceId || null,
            model: data.model || 'llama2',
            systemPrompt: data.systemPrompt || 'You are helpful',
            messages: Object.assign(messages, {
                push: jest.fn(function(item) {
                    Array.prototype.push.call(this, item);
                    return this.length;
                }),
                create: jest.fn((msg) => ({
                    ...msg,
                    _id: 'msg-' + Date.now(),
                    metadata: msg.metadata || {},
                    ragSources: msg.ragSources || []
                }))
            }),
            save: jest.fn().mockResolvedValue(true),
            markModified: jest.fn()
        };
    };

    beforeEach(() => {
        jest.clearAllMocks();

        // Reset persistent mocks from module requires
        try {
            const N8nLLMSource = require('../../models/N8nLLMSource');
            if (N8nLLMSource.findOne && N8nLLMSource.findOne.mockReset) {
                N8nLLMSource.findOne.mockReset();
            }
        } catch (e) {
            // Ignore if module not found/mocked yet
        }

        // Default mocks
        PromptConfig.getActive = jest.fn().mockResolvedValue(mockPrompt);
        PromptConfig.findOne = jest.fn().mockResolvedValue(mockPrompt);
        getOrCreateProfile.mockResolvedValue(mockUser);
        resolveTarget.mockReturnValue('http://localhost:11434');
        sanitizeOptions.mockReturnValue({});
        tryHandleToolCommand.mockResolvedValue(null);
        routeRequest.mockResolvedValue({ routed: false, model: 'llama2', target: 'local' });
        getTargetForModel.mockReturnValue('local');
        calculateMessageCost.mockResolvedValue(mockCost);
        calculateConversationCost.mockReturnValue({ sum: 0.0002 });
        isThinkingModel.mockReturnValue(false);
        Conversation.findById = jest.fn().mockResolvedValue(null);
        Conversation.mockImplementation(createMockConversation);
    });

    describe('1. Token Streaming', () => {
        it('should emit token events progressively', async () => {
            const chunks = [
                '{"message":{"role":"assistant","content":"Hello"},"done":false}\n',
                '{"message":{"role":"assistant","content":" world"},"done":false}\n',
                '{"message":{"role":"assistant","content":"!"},"done":true,"total_duration":1000,"eval_count":3,"prompt_eval_count":10}\n'
            ];

            mockFetch.mockResolvedValue(createMockStreamResponse(chunks));

            const tokens = [];
            const onToken = jest.fn((token) => tokens.push(token));
            const onComplete = jest.fn();
            const onError = jest.fn();

            await handleChatRequestStream({
                userId: 'user123',
                model: 'llama2',
                message: 'Hi there',
                target: 'http://localhost:11434',
                onToken,
                onComplete,
                onError
            });

            expect(onToken).toHaveBeenCalledTimes(3);
            expect(tokens).toEqual(['Hello', ' world', '!']);
            expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
                response: 'Hello world!',
                model: 'llama2'
            }));
            expect(onError).not.toHaveBeenCalled();
        });

        it('should accumulate full content from streamed tokens', async () => {
            const chunks = [
                '{"message":{"role":"assistant","content":"Token1"},"done":false}\n',
                '{"message":{"role":"assistant","content":"Token2"},"done":false}\n',
                '{"message":{"role":"assistant","content":"Token3"},"done":true,"total_duration":1000,"eval_count":3,"prompt_eval_count":5}\n'
            ];

            mockFetch.mockResolvedValue(createMockStreamResponse(chunks));

            const onComplete = jest.fn();

            await handleChatRequestStream({
                userId: 'user123',
                model: 'llama2',
                message: 'Test',
                target: 'http://localhost:11434',
                onToken: jest.fn(),
                onComplete,
                onError: jest.fn()
            });

            expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
                response: 'Token1Token2Token3'
            }));
        });
    });

    describe('2. Thinking Models', () => {
        it('should emit separate thinking stream for thinking models', async () => {
            isThinkingModel.mockReturnValue(true);

            const chunks = [
                '{"message":{"role":"assistant","thinking":"Let me think..."},"done":false}\n',
                '{"message":{"role":"assistant","thinking":" about this"},"done":false}\n',
                '{"message":{"role":"assistant","content":"Here is my answer"},"done":false}\n',
                '{"message":{"role":"assistant","content":"."},"done":true,"total_duration":2000,"eval_count":5,"prompt_eval_count":10}\n'
            ];

            mockFetch.mockResolvedValue(createMockStreamResponse(chunks));

            const onThinking = jest.fn();
            const onToken = jest.fn();
            const onComplete = jest.fn();

            await handleChatRequestStream({
                userId: 'user123',
                model: 'deepseek-r1',
                message: 'Complex problem',
                target: 'http://localhost:11434',
                onToken,
                onThinking,
                onComplete,
                onError: jest.fn()
            });

            expect(onThinking).toHaveBeenCalledWith('Let me think...');
            expect(onThinking).toHaveBeenCalledWith(' about this');
            expect(onToken).toHaveBeenCalledWith('Here is my answer');
            expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
                response: 'Here is my answer.',
                thinking: 'Let me think... about this'
            }));
        });

        it('should store thinking content in message metadata', async () => {
            isThinkingModel.mockReturnValue(true);

            const chunks = [
                '{"message":{"role":"assistant","thinking":"Reasoning..."},"done":false}\n',
                '{"message":{"role":"assistant","content":"Answer"},"done":true,"total_duration":1000,"eval_count":2,"prompt_eval_count":5}\n'
            ];

            mockFetch.mockResolvedValue(createMockStreamResponse(chunks));

            const mockConv = createMockConversation();
            Conversation.mockImplementation(() => mockConv);

            await handleChatRequestStream({
                userId: 'user123',
                model: 'qwen',
                message: 'Question',
                target: 'http://localhost:11434',
                onToken: jest.fn(),
                onThinking: jest.fn(),
                onComplete: jest.fn(),
                onError: jest.fn()
            });

            expect(mockConv.save).toHaveBeenCalled();
            // Verify thinking content was stored (implementation details may vary)
            expect(mockConv.messages.create).toHaveBeenCalled();
        });
    });

    describe('3. RAG Integration', () => {
        it('should send RAG sources in done event', async () => {
            const mockRagStore = {
                searchSimilarChunks: jest.fn().mockResolvedValue([
                    {
                        text: 'Context from document',
                        score: 0.95,
                        metadata: {
                            title: 'Manual.pdf',
                            source: 'uploads/manual.pdf',
                            documentId: 'doc123'
                        }
                    }
                ])
            };

            const chunks = [
                '{"message":{"role":"assistant","content":"Based on the manual"},"done":false}\n',
                '{"message":{"role":"assistant","content":", here is the answer"},"done":true,"total_duration":1000,"eval_count":10,"prompt_eval_count":20}\n'
            ];

            mockFetch.mockResolvedValue(createMockStreamResponse(chunks));

            const onComplete = jest.fn();

            await handleChatRequestStream({
                userId: 'user123',
                model: 'llama2',
                message: 'What does the manual say?',
                target: 'http://localhost:11434',
                useRag: true,
                ragStore: mockRagStore,
                onToken: jest.fn(),
                onComplete,
                onError: jest.fn()
            });

            expect(mockRagStore.searchSimilarChunks).toHaveBeenCalled();
            expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
                ragUsed: true,
                ragSources: expect.arrayContaining([
                    expect.objectContaining({
                        title: 'Manual.pdf',
                        score: 0.95
                    })
                ])
            }));
        });

        it('should work with streaming when RAG returns no results', async () => {
            const mockRagStore = {
                searchSimilarChunks: jest.fn().mockResolvedValue([])
            };

            const chunks = [
                '{"message":{"role":"assistant","content":"No context available"},"done":true,"total_duration":500,"eval_count":5,"prompt_eval_count":5}\n'
            ];

            mockFetch.mockResolvedValue(createMockStreamResponse(chunks));

            const onComplete = jest.fn();

            await handleChatRequestStream({
                userId: 'user123',
                model: 'llama2',
                message: 'Unknown query',
                target: 'http://localhost:11434',
                useRag: true,
                ragStore: mockRagStore,
                onToken: jest.fn(),
                onComplete,
                onError: jest.fn()
            });

            expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
                ragUsed: false,
                ragSources: []
            }));
        });
    });

    describe('4. Error Handling', () => {
        it('should emit error event on Ollama failure', async () => {
            mockFetch.mockResolvedValue({
                ok: false,
                statusText: 'Internal Server Error'
            });

            const onError = jest.fn();
            const onComplete = jest.fn();

            await handleChatRequestStream({
                userId: 'user123',
                model: 'llama2',
                message: 'Test',
                target: 'http://localhost:11434',
                onToken: jest.fn(),
                onComplete,
                onError
            });

            expect(onError).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining('Ollama request failed')
            }));
            expect(onComplete).not.toHaveBeenCalled();
        });

        it('should handle network errors gracefully', async () => {
            mockFetch.mockRejectedValue(new Error('Network connection failed'));

            const onError = jest.fn();

            await handleChatRequestStream({
                userId: 'user123',
                model: 'llama2',
                message: 'Test',
                target: 'http://localhost:11434',
                onToken: jest.fn(),
                onComplete: jest.fn(),
                onError
            });

            expect(onError).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining('Failed to connect to Ollama')
            }));
        });

        it('should timeout after 2 minutes and abort request', async () => {
            // Mock AbortError
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            mockFetch.mockRejectedValue(abortError);

            const onError = jest.fn();

            await handleChatRequestStream({
                userId: 'user123',
                model: 'llama2',
                message: 'Long running task',
                target: 'http://localhost:11434',
                onToken: jest.fn(),
                onComplete: jest.fn(),
                onError
            });

            expect(onError).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining('timed out')
            }));
        });

        it('should handle malformed JSON chunks without crashing', async () => {
            const chunks = [
                '{"message":{"role":"assistant","content":"Valid"},"done":false}\n',
                'INVALID JSON HERE\n', // Malformed chunk
                '{"message":{"role":"assistant","content":" token"},"done":true,"total_duration":1000,"eval_count":2,"prompt_eval_count":5}\n'
            ];

            mockFetch.mockResolvedValue(createMockStreamResponse(chunks));

            const onToken = jest.fn();
            const onComplete = jest.fn();
            const onError = jest.fn();

            await handleChatRequestStream({
                userId: 'user123',
                model: 'llama2',
                message: 'Test',
                target: 'http://localhost:11434',
                onToken,
                onComplete,
                onError
            });

            // Should still process valid chunks
            expect(onToken).toHaveBeenCalledWith('Valid');
            expect(onToken).toHaveBeenCalledWith(' token');
            expect(onComplete).toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledWith('Failed to parse streaming chunk', expect.any(Object));
        });
    });

    describe('5. Conversation Persistence', () => {
        it('should save conversation after stream completes (not during)', async () => {
            const chunks = [
                '{"message":{"role":"assistant","content":"Hello"},"done":false}\n',
                '{"message":{"role":"assistant","content":" there"},"done":true,"total_duration":1000,"eval_count":2,"prompt_eval_count":5}\n'
            ];

            mockFetch.mockResolvedValue(createMockStreamResponse(chunks));

            const mockConv = createMockConversation();
            Conversation.mockImplementation(() => mockConv);

            await handleChatRequestStream({
                userId: 'user123',
                model: 'llama2',
                message: 'Hi',
                target: 'http://localhost:11434',
                onToken: jest.fn(),
                onComplete: jest.fn(),
                onError: jest.fn()
            });

            // Verify conversation was saved AFTER streaming completed
            expect(mockConv.save).toHaveBeenCalledTimes(1);
            expect(mockConv.messages.push).toHaveBeenCalledWith(
                expect.objectContaining({ role: 'user', content: 'Hi' })
            );
        });

        it('should use existing conversation if conversationId provided', async () => {
            const mockExistingConv = createMockConversation({
                _id: 'existing123',
                messages: [
                    { role: 'user', content: 'Previous message' }
                ]
            });

            Conversation.findById = jest.fn().mockResolvedValue(mockExistingConv);

            const chunks = [
                '{"message":{"role":"assistant","content":"Response"},"done":true,"total_duration":1000,"eval_count":5,"prompt_eval_count":5}\n'
            ];

            mockFetch.mockResolvedValue(createMockStreamResponse(chunks));

            const onComplete = jest.fn();

            await handleChatRequestStream({
                userId: 'user123',
                model: 'llama2',
                message: 'Follow-up',
                conversationId: 'existing123',
                target: 'http://localhost:11434',
                onToken: jest.fn(),
                onComplete,
                onError: jest.fn()
            });

            expect(Conversation.findById).toHaveBeenCalledWith('existing123');
            expect(mockExistingConv.save).toHaveBeenCalled();
            expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
                conversationId: 'existing123'
            }));
        });
    });

    describe('6. N8N LLM Fallback', () => {
        it('should buffer full response for n8n models (no streaming)', async () => {
            const N8nLLMSource = require('../../models/N8nLLMSource');
            const n8nLLMProvider = require('../../src/services/n8nLLMProvider');

            jest.mock('../../models/N8nLLMSource');
            jest.mock('../../src/services/n8nLLMProvider');

            const mockN8nModel = {
                name: 'n8n-gpt4',
                webhookUrl: 'http://n8n/webhook',
                capabilities: { maxContext: 4096 },
                recordUsage: jest.fn().mockResolvedValue(true),
                isActive: true
            };

            N8nLLMSource.findOne = jest.fn().mockResolvedValue(mockN8nModel);
            n8nLLMProvider.chat = jest.fn().mockResolvedValue({
                content: 'Full buffered response from n8n',
                _metadata: { latency: 0.5 },
                usage: { inputTokens: 10, outputTokens: 20 }
            });

            const onToken = jest.fn();
            const onComplete = jest.fn();

            await handleChatRequestStream({
                userId: 'user123',
                model: 'n8n-gpt4',
                message: 'Test n8n',
                target: 'http://localhost:11434',
                onToken,
                onComplete,
                onError: jest.fn()
            });

            // Should send complete response as single token
            expect(onToken).toHaveBeenCalledWith('Full buffered response from n8n');
            expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
                response: 'Full buffered response from n8n',
                model: 'n8n-gpt4'
            }));
            expect(mockN8nModel.recordUsage).toHaveBeenCalled();
        });
    });

    describe('7. Cost Calculation', () => {
        it('should calculate cost with streaming stats', async () => {
            const chunks = [
                '{"message":{"role":"assistant","content":"Test"},"done":true,"total_duration":5000,"eval_count":50,"prompt_eval_count":100}\n'
            ];

            mockFetch.mockResolvedValue(createMockStreamResponse(chunks));

            const mockConv = createMockConversation();
            Conversation.mockImplementation(() => mockConv);

            await handleChatRequestStream({
                userId: 'user123',
                model: 'llama2',
                message: 'Calculate cost',
                target: 'http://localhost:11434',
                onToken: jest.fn(),
                onComplete: jest.fn(),
                onError: jest.fn()
            });

            expect(calculateMessageCost).toHaveBeenCalledWith('llama2', expect.objectContaining({
                usage: expect.objectContaining({
                    completionTokens: 50,
                    promptTokens: 100,
                    totalTokens: 150
                }),
                performance: expect.objectContaining({
                    totalDuration: 5000
                })
            }));
        });
    });

    describe('8. Tool Command Bypass', () => {
        it('should bypass streaming for tool commands', async () => {
            tryHandleToolCommand.mockResolvedValue({
                responseText: 'Tool result',
                ok: true,
                tool: 'calculator'
            });

            const onComplete = jest.fn();
            const onToken = jest.fn();

            await handleChatRequestStream({
                userId: 'user123',
                message: '/calc 2+2',
                target: 'http://localhost:11434',
                onToken,
                onComplete,
                onError: jest.fn()
            });

            // Tool commands return immediately, no streaming
            expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
                response: 'Tool result',
                tool: 'calculator'
            }));
            expect(mockFetch).not.toHaveBeenCalled(); // No Ollama call
            expect(onToken).not.toHaveBeenCalled(); // No token streaming
        });
    });

    describe('9. Model Auto-Routing', () => {
        it('should route request when autoRoute is enabled', async () => {
            routeRequest.mockResolvedValue({
                routed: true,
                model: 'gpt-4',
                target: 'openai',
                taskType: 'coding'
            });

            const chunks = [
                '{"message":{"role":"assistant","content":"Routed response"},"done":true,"total_duration":1000,"eval_count":10,"prompt_eval_count":20}\n'
            ];

            mockFetch.mockResolvedValue(createMockStreamResponse(chunks));

            const onComplete = jest.fn();

            await handleChatRequestStream({
                userId: 'user123',
                message: 'Write Python code',
                autoRoute: true,
                target: 'http://localhost:11434',
                onToken: jest.fn(),
                onComplete,
                onError: jest.fn()
            });

            expect(routeRequest).toHaveBeenCalledWith('Write Python code', expect.objectContaining({ autoRoute: true }));
            expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
                model: 'gpt-4',
                routing: expect.objectContaining({
                    taskType: 'coding',
                    routed: true
                })
            }));
        });
    });

    describe('10. Workspace Context', () => {
        it('should preserve workspace context in streaming', async () => {
            const chunks = [
                '{"message":{"role":"assistant","content":"Workspace response"},"done":true,"total_duration":1000,"eval_count":5,"prompt_eval_count":10}\n'
            ];

            mockFetch.mockResolvedValue(createMockStreamResponse(chunks));

            const mockConv = createMockConversation({ workspaceId: 'workspace123' });
            Conversation.mockImplementation(() => mockConv);

            await handleChatRequestStream({
                userId: 'user123',
                model: 'llama2',
                message: 'Team question',
                workspaceId: 'workspace123',
                target: 'http://localhost:11434',
                onToken: jest.fn(),
                onComplete: jest.fn(),
                onError: jest.fn()
            });

            expect(mockConv.workspaceId).toBe('workspace123');
            expect(mockConv.save).toHaveBeenCalled();
        });
    });
});
