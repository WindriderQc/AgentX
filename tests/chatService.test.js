// chatService.test.js

const { handleChatRequest } = require('../src/services/chatService');
const Conversation = require('../models/Conversation');
const PromptConfig = require('../models/PromptConfig');
const { getOrCreateProfile } = require('../src/helpers/userHelpers');
const { extractResponse, buildOllamaPayload } = require('../src/helpers/ollamaResponseHandler');
const { sanitizeOptions, resolveTarget } = require('../src/utils');
const { tryHandleToolCommand } = require('../src/services/toolService');
const { executeTool, parseToolCalls } = require('../src/services/toolExecutor');
const { routeRequest, getTargetForModel } = require('../src/services/modelRouter');
const { calculateMessageCost, calculateConversationCost } = require('../src/services/costCalculator');
const logger = require('../config/logger');

// Mock dependencies with factories
jest.mock('../models/Conversation', () => {
    const mockSave = jest.fn().mockResolvedValue(true);
    // Use a factory function for the constructor
    const MockModel = jest.fn((data) => ({
        ...data,
        _id: data && data._id ? data._id : 'conv123',
        // Mock messages as an array with Mongoose-like methods
        messages: Object.assign(data && data.messages ? [...data.messages] : [], {
            create: jest.fn((msg) => ({ ...msg, _id: 'msg-' + Date.now(), metadata: {} })),
            push: jest.fn(function(item) { return Array.prototype.push.call(this, item); })
        }),
        save: mockSave,
        markModified: jest.fn()
    }));
    
    // Attach static methods
    MockModel.findById = jest.fn();
    MockModel.findOne = jest.fn();
    
    return MockModel;
});

jest.mock('../models/PromptConfig', () => {
    const MockPromptConfig = jest.fn().mockImplementation((data) => ({
        ...data,
        save: jest.fn().mockResolvedValue(true)
    }));
    MockPromptConfig.getActive = jest.fn();
    MockPromptConfig.findOne = jest.fn();
    MockPromptConfig.find = jest.fn();
    return MockPromptConfig;
});

jest.mock('../src/helpers/userHelpers');
jest.mock('../src/helpers/ollamaResponseHandler');
jest.mock('../src/utils');
jest.mock('../src/services/toolService');
jest.mock('../src/services/toolExecutor');
jest.mock('../src/services/modelRouter');
jest.mock('../src/services/costCalculator');
jest.mock('../config/logger');

// Mock node-fetch - must return a jest mock function directly
jest.mock('node-fetch', () => jest.fn());

describe('chatService', () => {
    let mockFetch;
    
    const mockUser = {
        _id: 'user123',
        username: 'testuser',
        about: 'I am a test user',
        preferences: { customInstructions: 'Be concise' }
    };

    const mockPrompt = {
        _id: 'prompt123',
        systemPrompt: 'You are a helpful assistant.',
        name: 'default_chat',
        version: 'v1'
    };

    const mockStats = {
        total_duration: 1000,
        eval_count: 50,
        prompt_eval_count: 20
    };

    const mockCost = {
        totalCost: 0.0001,
        inputCost: 0.00005,
        outputCost: 0.00005,
        currency: 'USD',
        pricingSource: { source: 'mock' }
    };

    const mockRagStore = {
        searchSimilarChunks: jest.fn(),
        listDocuments: jest.fn()
    };

    beforeEach(() => {
        jest.clearAllMocks();

        // Setup successful fetch mock - get the mocked module
        mockFetch = require('node-fetch');
        mockFetch.mockResolvedValue({
            ok: true,
            statusText: 'OK',
            json: jest.fn().mockResolvedValue({
                response: 'Test response',
                done: true,
                ...mockStats
            })
        });

        // Setup default mock implementations
        PromptConfig.getActive.mockResolvedValue(mockPrompt);
        PromptConfig.findOne.mockResolvedValue(mockPrompt); // Ensure findOne is also mocked
        
        getOrCreateProfile.mockResolvedValue(mockUser);
        resolveTarget.mockReturnValue('http://localhost:11434');
        buildOllamaPayload.mockReturnValue({ model: 'llama2', messages: [] });
        extractResponse.mockReturnValue({ 
            content: 'Test response', 
            thinking: null, 
            warning: null, 
            stats: mockStats 
        });
        
        // Routing defaults
        routeRequest.mockResolvedValue({ routed: false, model: 'llama2', target: 'local' });
        getTargetForModel.mockReturnValue('local');

        // Tool defaults
        tryHandleToolCommand.mockResolvedValue(null);
        parseToolCalls.mockReturnValue(null);
        executeTool.mockResolvedValue({ status: 'success', data: 'tool result' });

        // Cost calculation defaults
        calculateMessageCost.mockResolvedValue(mockCost);
        calculateConversationCost.mockReturnValue({ sum: 0.0002 });

        // Conversation Mock Defaults (handled by factory, but ensure scoped lookups return null by default for new chats)
        Conversation.findById.mockResolvedValue(null);
        Conversation.findOne.mockResolvedValue(null);
    });

    describe('Standard Chat Flow', () => {
        it('should handle a basic chat request from a user', async () => {
            const request = {
                userId: 'user123',
                model: 'llama2',
                message: 'Hello world'
            };

            const result = await handleChatRequest(request);

            expect(result).toBeDefined();
            expect(result.response).toBe('Test response');
            expect(result.model).toBe('llama2');
            
            // Verify dependencies called
            expect(PromptConfig.getActive).toHaveBeenCalledWith('default_chat', null);
            expect(getOrCreateProfile).toHaveBeenCalledWith('user123');
            expect(resolveTarget).toHaveBeenCalled();
            expect(mockFetch).toHaveBeenCalled();
            expect(calculateMessageCost).toHaveBeenCalled();
            expect(Conversation).toHaveBeenCalled(); // New conversation created
        });

        it('should use existing conversation if conversationId is provided', async () => {
            // Mock an existing conversation instance
            const mockExistingConvInstance = {
                _id: 'existing123',
                userId: 'user123',
                messages: [], // Real array
                save: jest.fn().mockResolvedValue(true)
            };
            
            // Allow push and create (if used)
            mockExistingConvInstance.messages.push = jest.fn((item) => mockExistingConvInstance.messages.length + 1);
            mockExistingConvInstance.messages.create = jest.fn((msg) => ({ ...msg, _id: 'newmsg', metadata: {} }));

            Conversation.findOne.mockResolvedValue(mockExistingConvInstance);

            const request = {
                userId: 'user123',
                workspaceId: 'workspace123',
                model: 'llama2',
                message: 'Continue chat',
                conversationId: 'existing123'
            };

            const result = await handleChatRequest(request);

            expect(result.conversationId).toBe('existing123');
            expect(Conversation.findOne).toHaveBeenCalledWith({
                _id: 'existing123',
                userId: 'user123',
                workspaceId: 'workspace123'
            });
            expect(mockExistingConvInstance.messages.push).toHaveBeenCalled();
            expect(mockExistingConvInstance.save).toHaveBeenCalled();
        });

        it('should create a new conversation when the provided ID is outside the caller scope', async () => {
            const request = {
                userId: 'user123',
                workspaceId: 'workspace123',
                model: 'llama2',
                message: 'Continue chat',
                conversationId: 'foreign123'
            };

            const result = await handleChatRequest(request);

            expect(result.conversationId).toBe('conv123');
            expect(Conversation.findOne).toHaveBeenCalledWith({
                _id: 'foreign123',
                userId: 'user123',
                workspaceId: 'workspace123'
            });
            expect(Conversation).toHaveBeenCalledWith(expect.objectContaining({
                userId: 'user123',
                workspaceId: 'workspace123'
            }));
        });
    });

    describe('Model Routing', () => {
        it('should perform auto-routing when autoRoute is true', async () => {
            routeRequest.mockResolvedValue({ 
                routed: true, 
                model: 'gpt-4', 
                target: 'openai', 
                taskType: 'coding' 
            });

            const request = {
                userId: 'user123',
                message: 'Write code',
                autoRoute: true
            };

            const result = await handleChatRequest(request);

            expect(routeRequest).toHaveBeenCalledWith('Write code', expect.objectContaining({ autoRoute: true }));
            expect(result.model).toBe('gpt-4');
            expect(result.routing).toEqual({ taskType: 'coding', routed: true });
        });

        it('should fallback to effective target resolution when no auto-route', async () => {
            getTargetForModel.mockReturnValue('remote-host');
            
            const request = {
                userId: 'user123',
                model: 'mistral' // manual model
            };

            await handleChatRequest(request);

            expect(getTargetForModel).toHaveBeenCalledWith('mistral');
        });
    });

    describe('RAG Integration', () => {
        it('should perform semantic search when useRag is true', async () => {
            mockRagStore.searchSimilarChunks.mockResolvedValue([
                { text: 'context1', score: 0.9, metadata: { title: 'doc1', source: 'file1', documentId: 'd1' } }
            ]);

            const request = {
                userId: 'user123',
                message: 'What is in doc1?',
                useRag: true,
                ragStore: mockRagStore
            };

            const result = await handleChatRequest(request);

            expect(mockRagStore.searchSimilarChunks).toHaveBeenCalled();
            expect(result.ragUsed).toBe(true);
            expect(result.ragSources).toHaveLength(1);
            expect(result.ragSources[0].title).toBe('doc1');
        });

        it('should handle file listing intent', async () => {
            mockRagStore.listDocuments.mockResolvedValue([
                { title: 'manual.pdf', source: 'uploads/manual.pdf' }
            ]);

            const request = {
                userId: 'user123',
                message: 'List available files', // Trigger regex
                useRag: true,
                ragStore: mockRagStore
            };

            const result = await handleChatRequest(request);

            expect(mockRagStore.listDocuments).toHaveBeenCalled();
            expect(result.ragUsed).toBe(true);
            // System prompt construction is internal, but we can verify execution flow didn't crash
        });

        it('should gracefully handle RAG errors', async () => {
            mockRagStore.searchSimilarChunks.mockRejectedValue(new Error('DB Error'));

            const request = {
                userId: 'user123',
                message: 'Search',
                useRag: true,
                ragStore: mockRagStore
            };

            const result = await handleChatRequest(request);

            // Should expect no crash, but ragUsed false
            expect(result.ragUsed).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('RAG retrieval error'), expect.any(Object));
        });
    });

    describe('Tool Execution', () => {
        it('should handle command-line style tools (tryHandleToolCommand)', async () => {
            tryHandleToolCommand.mockResolvedValue({
                responseText: 'Command executed',
                ok: true,
                tool: 'calculator'
            });

            const request = {
                userId: 'user123',
                message: '/calc 2+2'
            };

            const result = await handleChatRequest(request);

            expect(tryHandleToolCommand).toHaveBeenCalledWith('/calc 2+2');
            expect(result.response).toBe('Command executed');
            expect(result.toolOk).toBe(true);
            // Verify normal chat flow (ollama fetch) was SKIPPED
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should handle LLM-initiated tool calls', async () => {
            parseToolCalls.mockReturnValue({ tool: 'weather', params: { city: 'London' } });
            executeTool.mockResolvedValue({ status: 'success', data: { temp: 20 } });

            const request = {
                userId: 'user123',
                message: 'Check weather'
            };

            const result = await handleChatRequest(request);

            expect(parseToolCalls).toHaveBeenCalledWith('Test response');
            expect(executeTool).toHaveBeenCalledWith('weather', { city: 'London' });
            expect(result.response).toContain('Tool Execution');
        });
    });

    describe('Error Handling', () => {
        it('should throw error when Ollama request fails', async () => {
            mockFetch.mockResolvedValue({
                ok: false,
                statusText: 'Internal Server Error'
            });

            const request = {
                userId: 'user123',
                message: 'Hi'
            };

            await expect(handleChatRequest(request)).rejects.toThrow('Ollama request failed: Internal Server Error');
        });

        it('should handle fetch network errors', async () => {
            mockFetch.mockRejectedValue(new Error('Network error'));

            const request = {
                userId: 'user123',
                message: 'Hi'
            };

            await expect(handleChatRequest(request)).rejects.toThrow('Failed to connect to Ollama');
        });

        it('should handle AbortError (timeout)', async () => {
             const error = new Error('The operation was aborted');
             error.name = 'AbortError';
             mockFetch.mockRejectedValue(error);

             const request = {
                 userId: 'user123',
                 message: 'Hi'
             };

             await expect(handleChatRequest(request)).rejects.toThrow('Ollama request timed out');
        });
    });
    
    describe('Cost Calculation', () => {
        it('should calculate costs and attach to conversation message', async () => {
             const request = { userId: 'user123', message: 'test', model: 'llama2' };
             await handleChatRequest(request);

             expect(calculateMessageCost).toHaveBeenCalled();
             // We can check if logger was called with 'Message cost calculated' to verify internal flow
             expect(logger.debug).toHaveBeenCalledWith('Message cost calculated', expect.any(Object));
        });
    });

});
