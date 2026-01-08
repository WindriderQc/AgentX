/**
 * Integration Tests for Non-Streaming Chat API Endpoint
 * Tests POST /api/chat for standard JSON responses (fallback mode)
 */

const request = require('supertest');

// Mock dependencies before requiring app
jest.mock('../../models/Conversation');
jest.mock('../../models/PromptConfig');
jest.mock('../../models/UserProfile');
jest.mock('../../models/Workspace');
jest.mock('../../models/WorkspaceMember');
jest.mock('../../models/N8nLLMSource');
jest.mock('../../src/helpers/userHelpers');
jest.mock('../../src/services/chatService');
jest.mock('../../src/services/ragStore');
jest.mock('../../config/logger');

// Mock auth middleware
jest.mock('../../src/middleware/auth', () => ({
    optionalAuth: (req, res, next) => {
        res.locals.user = { userId: 'testuser123', name: 'Test User' };
        req.session = { userId: 'testuser123' };
        req.user = { _id: 'testuser123', username: 'testuser' };
        next();
    },
    requireAuth: (req, res, next) => {
        res.locals.user = { userId: 'testuser123', name: 'Test User' };
        req.session = { userId: 'testuser123' };
        req.user = { _id: 'testuser123', username: 'testuser' };
        next();
    }
}));

const PromptConfig = require('../../models/PromptConfig');
const UserProfile = require('../../models/UserProfile');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');
const chatService = require('../../src/services/chatService');
const { getRagStore } = require('../../src/services/ragStore');

// Load app after mocks
const { app } = require('../../src/app');

describe('POST /api/chat - Non-Streaming Endpoint', () => {

    const mockRagStore = {
        searchSimilarChunks: jest.fn(),
        listDocuments: jest.fn()
    };

    beforeAll(() => {
        getRagStore.mockReturnValue(mockRagStore);
    });

    beforeEach(() => {
        jest.clearAllMocks();

        // Default mocks
        PromptConfig.getActive = jest.fn().mockResolvedValue({
            _id: 'prompt123',
            systemPrompt: 'You are helpful',
            name: 'default_chat',
            version: 'v1'
        });

        UserProfile.findOne = jest.fn().mockResolvedValue({
            _id: 'profile123',
            userId: 'testuser123',
            about: 'Test user',
            preferences: {}
        });

        Workspace.findById = jest.fn().mockResolvedValue(null);
        WorkspaceMember.findOne = jest.fn().mockResolvedValue(null);
    });

    it('should return a standard JSON response', async () => {
        chatService.handleChatRequest = jest.fn().mockResolvedValue({
            response: 'Hello from non-streaming',
            conversationId: 'conv123',
            messageId: 'msg456',
            model: 'llama2',
            target: 'http://localhost:11434'
        });

        const response = await request(app)
            .post('/api/chat')
            .send({ model: 'llama2', message: 'Hello' });

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('success');
        expect(response.body.data.response).toBe('Hello from non-streaming');
    });

    it('should reject missing message in non-streaming mode', async () => {
        const response = await request(app)
            .post('/api/chat')
            .send({ model: 'llama2' });

        expect(response.status).toBe(400);
        expect(response.body.message).toContain('Message is required');
    });
});
