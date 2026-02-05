const request = require('supertest');

// 1. Mock ragStore before requiring app/routes
const mockSearchSimilarChunks = jest.fn();
const mockListDocuments = jest.fn();

jest.mock('../../src/services/ragStore', () => ({
    getRagStore: () => ({
        searchSimilarChunks: mockSearchSimilarChunks,
        addDocument: jest.fn(),
        listDocuments: mockListDocuments
    })
}));

// 2. Mock ragCompression
const mockCompressChunks = jest.fn();
jest.mock('../../src/services/ragCompression', () => ({
    getCompressionService: () => ({
        compressChunks: mockCompressChunks,
        clearCache: jest.fn()
    })
}));

// 3. Mock Models

// Mock Conversation
const mockConversationInstance = {
    _id: 'conv_123',
    messages: [], 
    save: jest.fn()
};
// Add custom create method to messages array to simulate Mongoose subdoc array
mockConversationInstance.messages.create = jest.fn().mockReturnValue({ 
    _id: 'msg_456', 
    metadata: {} 
});
mockConversationInstance.messages.push = Array.prototype.push.bind(mockConversationInstance.messages);

const MockConversation = jest.fn().mockImplementation(() => mockConversationInstance);
MockConversation.findById = jest.fn().mockResolvedValue(mockConversationInstance);
MockConversation.findOne = jest.fn().mockResolvedValue(mockConversationInstance);
// Mock create to return the instance or a new one
MockConversation.create = jest.fn().mockResolvedValue(mockConversationInstance);
MockConversation.findOneAndUpdate = jest.fn();

jest.mock('../../models/Conversation', () => MockConversation);

// Mock PromptConfig
jest.mock('../../models/PromptConfig', () => ({
    getActive: jest.fn().mockResolvedValue({ 
        systemPrompt: 'sys',
        _id: 'prompt_1',
        name: 'default',
        version: '1'
    })
}));

// Mock UserProfile
jest.mock('../../models/UserProfile', () => ({
    findOne: jest.fn().mockResolvedValue({ about: "User info" }),
    create: jest.fn().mockResolvedValue({ about: "User info" }), // Fix: Add create
    findOneAndUpdate: jest.fn()
}));

// Mock N8nLLMSource
jest.mock('../../models/N8nLLMSource', () => ({
    findOne: jest.fn().mockResolvedValue(null) 
}));

// 4. Mock node-fetch (used only inside chatService for Ollama calls, or N8n)
const mockFetch = jest.fn();
jest.mock('node-fetch', () => mockFetch);

// 5. Mock auth middleware
jest.mock('../../src/middleware/auth', () => ({
    optionalAuth: (req, res, next) => {
        res.locals.user = { userId: 'testuser123', name: 'Test User' };
        req.user = { _id: 'testuser123', username: 'testuser' };
        next();
    },
    requireAuth: (req, res, next) => next(),
    attachUser: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
    apiKeyAuth: (req, res, next) => next()
}));

// 6. Mock workspace middleware
jest.mock('../../src/middleware/workspace', () => ({
    attachWorkspace: (req, res, next) => {
        req.workspace = { _id: 'workspace123', slug: 'test-workspace' };
        req.workspaceSlug = 'test-workspace';
        next();
    },
    requireWorkspaceAccess: () => (req, res, next) => next(),
    requirePermission: () => (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
    requireOwner: (req, res, next) => next(),
    optionalWorkspace: (req, res, next) => next(),
    optionalWorkspaceContext: (req, res, next) => next()
}));

// Now import app
const { app } = require('../../src/app');

describe('Integration: RAG Compression', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Reset message array for each test to avoid residual state
        mockConversationInstance.messages.length = 0;

        // Default mocks
        mockSearchSimilarChunks.mockResolvedValue([
            { text: "Long chunk with irrelevant info. Key info.", metadata: { source: "test.txt", title: "Test Doc" }, score: 0.8 }
        ]);

        mockCompressChunks.mockResolvedValue([
            { compressedText: "Key info.", originalText: "Long chunk...", score: 0.9, metadata: { source: "test.txt", title: "Test Doc" } }
        ]);

        mockListDocuments.mockResolvedValue([]);

        // Mock Ollama response success
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                response: "This is the final answer based on Key info.",
                done: true,
                eval_count: 10,
                eval_duration: 100
            })
        });
    });

    it('should trigger compression when ragCompress is true', async () => {
        const payload = {
            message: "What is the key info?",
            model: "llama2",
            target: "localhost",
            useRag: true,
            ragCompress: true,
            options: {}
        };

        const res = await request(app)
            .post('/api/chat')
            .send(payload);

        // Expect success
        expect(res.status).toBe(200);
        
        // Expect RAG retrieval
        expect(mockSearchSimilarChunks).toHaveBeenCalled();
        
        // Expect Compression Service to be called
        expect(mockCompressChunks).toHaveBeenCalledTimes(1);
        expect(mockCompressChunks).toHaveBeenCalledWith(
            expect.stringContaining("What is the key info?"),
            expect.any(Array),
            expect.objectContaining({ minRelevanceScore: expect.any(Number) })
        );
    });

    it('should NOT trigger compression when ragCompress is false', async () => {
        const payload = {
            message: "What is the key info?",
            model: "llama2",
            target: "localhost",
            useRag: true,
            ragCompress: false,
            options: {}
        };

        const res = await request(app)
            .post('/api/chat')
            .send(payload);

        expect(res.status).toBe(200);
        expect(mockSearchSimilarChunks).toHaveBeenCalled();
        expect(mockCompressChunks).not.toHaveBeenCalled();
    });

    it('should handle compression service failure by proceeding with original chunks', async () => {
        // Force compression to fail
        mockCompressChunks.mockRejectedValue(new Error("Compression failed"));

        const payload = {
            message: "failure test",
            model: "llama2",
            target: "localhost",
            useRag: true,
            ragCompress: true 
        };

        // Suppress error logging during this test
        const originalError = console.error;
        // console.error = jest.fn(); 

        const res = await request(app)
            .post('/api/chat')
            .send(payload);

        // console.error = originalError;

        // Should still succeed, just without compression
        expect(res.status).toBe(200);
        expect(mockCompressChunks).toHaveBeenCalled();
    });
});
