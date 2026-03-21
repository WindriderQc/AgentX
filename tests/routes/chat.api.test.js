/**
 * Integration Tests for Non-Streaming Chat API Endpoint
 * Tests POST /api/chat for standard JSON responses (fallback mode)
 */

const request = require('supertest');
const Conversation = require('../../models/Conversation');

// Mock dependencies before requiring app
jest.mock('../../models/Conversation', () => {
    const mockInstance = {
        save: jest.fn().mockResolvedValue(true),
        toObject: jest.fn().mockReturnValue({ _id: 'mock_conv_id' })
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
        req.session = {
            userId: 'testuser123',
            touch: jest.fn(),
            save: jest.fn((cb) => cb && cb()),
            cookie: { maxAge: 3600000 }
        };
        req.user = { _id: 'testuser123', username: 'testuser' };
        next();
    },
    requireAuth: (req, res, next) => {
        res.locals.user = { userId: 'testuser123', name: 'Test User' };
        req.session = {
            userId: 'testuser123',
            touch: jest.fn(),
            save: jest.fn((cb) => cb && cb()),
            cookie: { maxAge: 3600000 }
        };
        req.user = { _id: 'testuser123', username: 'testuser' };
        next();
    },
    attachUser: (req, res, next) => {
        res.locals.user = { userId: 'testuser123', name: 'Test User' };
        req.user = { _id: 'testuser123', username: 'testuser' };
        next();
    },
    requireAdmin: (req, res, next) => next()
}));

// Mock workspace middleware
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

const PromptConfig = require('../../models/PromptConfig');
const UserProfile = require('../../models/UserProfile');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');
const chatService = require('../../src/services/chatService');
const userHelpers = require('../../src/helpers/userHelpers');
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
        userHelpers.getUserId.mockReturnValue('testuser123');
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

describe('POST /api/feedback', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should save feedback only for a conversation in the caller scope', async () => {
        const message = { _id: 'msg123', feedback: null };
        const conversation = {
            messages: {
                id: jest.fn().mockReturnValue(message)
            },
            save: jest.fn().mockResolvedValue(true)
        };

        Conversation.findOne.mockResolvedValue(conversation);

        const response = await request(app)
            .post('/api/feedback')
            .send({ conversationId: 'conv123', messageId: 'msg123', rating: 1, comment: 'Useful' });

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('success');
        expect(Conversation.findOne).toHaveBeenCalledWith({
            _id: 'conv123',
            userId: 'testuser123',
            workspaceId: 'workspace123'
        });
        expect(message.feedback).toEqual({ rating: 1, comment: 'Useful' });
        expect(conversation.save).toHaveBeenCalled();
    });

    it('should reject feedback updates for conversations outside the caller scope', async () => {
        Conversation.findOne.mockResolvedValue(null);

        const response = await request(app)
            .post('/api/feedback')
            .send({ conversationId: 'foreign123', messageId: 'msg123', rating: -1 });

        expect(response.status).toBe(404);
        expect(response.body.message).toContain('Conversation not found');
        expect(Conversation.findOne).toHaveBeenCalledWith({
            _id: 'foreign123',
            userId: 'testuser123',
            workspaceId: 'workspace123'
        });
    });
});
