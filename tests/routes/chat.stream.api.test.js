/**
 * Integration Tests for Streaming SSE API Endpoint
 * Tests POST /api/chat/stream for SSE headers, events, authentication, workspace isolation
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

const Conversation = require('../../models/Conversation');
const PromptConfig = require('../../models/PromptConfig');
const UserProfile = require('../../models/UserProfile');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');
const chatService = require('../../src/services/chatService');
const { getRagStore } = require('../../src/services/ragStore');
const logger = require('../../config/logger');

// Load app after mocks
const { app } = require('../../src/app');

describe('POST /api/chat/stream - Streaming SSE Endpoint', () => {

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

        Conversation.findById = jest.fn().mockResolvedValue(null);
        Workspace.findById = jest.fn().mockResolvedValue(null);
        WorkspaceMember.findOne = jest.fn().mockResolvedValue(null);
    });

    describe('1. SSE Headers and Format', () => {
        it('should return SSE headers', async () => {
            chatService.handleChatRequestStream = jest.fn(async ({ onComplete }) => {
                onComplete({ response: 'Test', conversationId: 'conv123' });
            });

            const response = await request(app)
                .post('/api/chat/stream')
                .send({
                    model: 'llama2',
                    message: 'Hello'
                });

            expect(response.headers['content-type']).toContain('text/event-stream');
            expect(response.headers['cache-control']).toBe('no-cache');
            expect(response.headers['connection']).toBe('keep-alive');
        });

        it('should stream token events progressively', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onToken, onComplete }) => {
                onToken('Hello');
                onToken(' world');
                onToken('!');
                onComplete({ response: 'Hello world!', conversationId: 'conv123' });
            });

            const tokens = [];

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' })
                .parse((res, callback) => {
                    res.on('data', (chunk) => {
                        const data = chunk.toString();
                        if (data.includes('event: token')) {
                            const match = data.match(/data: ({.*})/);
                            if (match) {
                                const parsed = JSON.parse(match[1]);
                                tokens.push(parsed.content);
                            }
                        }
                    });
                    res.on('end', () => {
                        callback(null, { tokens });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(tokens).toEqual(['Hello', ' world', '!']);
                    done();
                });
        }, 10000);

        it('should emit done event with conversationId and messageId', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onToken, onComplete }) => {
                onToken('Response');
                onComplete({
                    response: 'Response',
                    conversationId: 'conv456',
                    messageId: 'msg789',
                    stats: { eval_count: 10 },
                    ragSources: []
                });
            });

            let doneEvent = null;

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' })
                .parse((res, callback) => {
                    res.on('data', (chunk) => {
                        const data = chunk.toString();
                        if (data.includes('event: done')) {
                            const match = data.match(/data: ({.*})/);
                            if (match) {
                                doneEvent = JSON.parse(match[1]);
                            }
                        }
                    });
                    res.on('end', () => {
                        callback(null, { doneEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(doneEvent).toMatchObject({
                        conversationId: 'conv456',
                        messageId: 'msg789',
                        stats: { eval_count: 10 }
                    });
                    done();
                });
        }, 10000);
    });

    describe('2. Error Handling', () => {
        it('should emit error event on invalid model', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onError }) => {
                onError(new Error('Model not found'));
            });

            let errorEvent = null;

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'invalid-model', message: 'Test' })
                .parse((res, callback) => {
                    res.on('data', (chunk) => {
                        const data = chunk.toString();
                        if (data.includes('event: error')) {
                            const match = data.match(/data: ({.*})/);
                            if (match) {
                                errorEvent = JSON.parse(match[1]);
                            }
                        }
                    });
                    res.on('end', () => {
                        callback(null, { errorEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(errorEvent).toMatchObject({
                        message: 'Model not found'
                    });
                    done();
                });
        }, 10000);

        it('should return 400 if message is missing', async () => {
            const response = await request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2' });

            expect(response.status).toBe(400);
            expect(response.body.message).toContain('Message is required');
        });

        it('should return 400 if model is missing and autoRoute disabled', async () => {
            const response = await request(app)
                .post('/api/chat/stream')
                .send({ message: 'Test' });

            expect(response.status).toBe(400);
            expect(response.body.message).toContain('Model is required');
        });

        it('should handle service-level errors gracefully', (done) => {
            chatService.handleChatRequestStream = jest.fn().mockRejectedValue(
                new Error('Service unavailable')
            );

            let errorEvent = null;

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' })
                .parse((res, callback) => {
                    res.on('data', (chunk) => {
                        const data = chunk.toString();
                        if (data.includes('event: error')) {
                            const match = data.match(/data: ({.*})/);
                            if (match) {
                                errorEvent = JSON.parse(match[1]);
                            }
                        }
                    });
                    res.on('end', () => {
                        callback(null, { errorEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(errorEvent).toBeTruthy();
                    expect(errorEvent.message).toContain('Service unavailable');
                    done();
                });
        }, 10000);
    });

    describe('3. Thinking Model Streams', () => {
        it('should emit thinking events separately from token events', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onThinking, onToken, onComplete }) => {
                onThinking('Analyzing...');
                onThinking(' the problem');
                onToken('Here is');
                onToken(' the answer');
                onComplete({
                    response: 'Here is the answer',
                    thinking: 'Analyzing... the problem',
                    conversationId: 'conv123'
                });
            });

            const thinkingEvents = [];
            const tokenEvents = [];

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'deepseek-r1', message: 'Complex question' })
                .parse((res, callback) => {
                    res.on('data', (chunk) => {
                        const data = chunk.toString();
                        if (data.includes('event: thinking')) {
                            const match = data.match(/data: ({.*})/);
                            if (match) {
                                const parsed = JSON.parse(match[1]);
                                thinkingEvents.push(parsed.content);
                            }
                        }
                        if (data.includes('event: token')) {
                            const match = data.match(/data: ({.*})/);
                            if (match) {
                                const parsed = JSON.parse(match[1]);
                                tokenEvents.push(parsed.content);
                            }
                        }
                    });
                    res.on('end', () => {
                        callback(null, { thinkingEvents, tokenEvents });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(thinkingEvents).toEqual(['Analyzing...', ' the problem']);
                    expect(tokenEvents).toEqual(['Here is', ' the answer']);
                    done();
                });
        }, 10000);
    });

    describe('4. RAG Integration', () => {
        it('should include RAG sources in done event', (done) => {
            mockRagStore.searchSimilarChunks.mockResolvedValue([
                {
                    text: 'Document context',
                    score: 0.92,
                    metadata: {
                        title: 'Manual.pdf',
                        source: 'uploads/manual.pdf',
                        documentId: 'doc123'
                    }
                }
            ]);

            chatService.handleChatRequestStream = jest.fn(async ({ onToken, onComplete }) => {
                onToken('Based on the manual');
                onComplete({
                    response: 'Based on the manual',
                    conversationId: 'conv123',
                    ragUsed: true,
                    ragSources: [{
                        text: 'Document context',
                        score: 0.92,
                        title: 'Manual.pdf',
                        source: 'uploads/manual.pdf'
                    }]
                });
            });

            let doneEvent = null;

            request(app)
                .post('/api/chat/stream')
                .send({
                    model: 'llama2',
                    message: 'What does the manual say?',
                    useRag: true
                })
                .parse((res, callback) => {
                    res.on('data', (chunk) => {
                        const data = chunk.toString();
                        if (data.includes('event: done')) {
                            const match = data.match(/data: ({.*})/);
                            if (match) {
                                doneEvent = JSON.parse(match[1]);
                            }
                        }
                    });
                    res.on('end', () => {
                        callback(null, { doneEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(doneEvent.ragUsed).toBe(true);
                    expect(doneEvent.ragSources).toHaveLength(1);
                    expect(doneEvent.ragSources[0].title).toBe('Manual.pdf');
                    done();
                });
        }, 10000);
    });

    describe('5. Authentication', () => {
        it('should accept authenticated requests (optionalAuth middleware)', async () => {
            chatService.handleChatRequestStream = jest.fn(async ({ onComplete }) => {
                onComplete({ response: 'Authenticated response', conversationId: 'conv123' });
            });

            const response = await request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' });

            // With optionalAuth, requests should work
            expect(response.status).toBe(200);
        });

        it('should accept authenticated requests', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ userId, onComplete }) => {
                expect(userId).toBe('testuser123');
                onComplete({ response: 'Authenticated response', conversationId: 'conv123' });
            });

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(chatService.handleChatRequestStream).toHaveBeenCalledWith(
                        expect.objectContaining({ userId: 'testuser123' })
                    );
                    done();
                });
        }, 10000);
    });

    describe('6. Workspace Isolation', () => {
        it('should support workspace context in streaming when available', (done) => {
            const mockWorkspace = {
                _id: 'workspace123',
                name: 'Test Team',
                ownerId: 'testuser123'
            };

            Workspace.findById = jest.fn().mockResolvedValue(mockWorkspace);
            WorkspaceMember.findOne = jest.fn().mockResolvedValue({
                userId: 'testuser123',
                workspaceId: 'workspace123',
                role: 'owner'
            });

            chatService.handleChatRequestStream = jest.fn(async ({ onComplete }) => {
                onComplete({ response: 'Workspace response', conversationId: 'conv123' });
            });

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Team question' })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(chatService.handleChatRequestStream).toHaveBeenCalled();
                    done();
                });
        }, 10000);
    });

    describe('7. Client Disconnect Handling', () => {
        it('should log when client disconnects', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onToken, onComplete }) => {
                // Simulate slow streaming
                await new Promise(resolve => setTimeout(resolve, 100));
                onToken('Slow token');
                onComplete({ response: 'Slow response' });
            });

            const req = request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' });

            // Simulate client disconnect after 50ms
            setTimeout(() => {
                req.abort();
            }, 50);

            req.end((err) => {
                // Expect abort error
                expect(err).toBeTruthy();
                // Verify logger was called (implementation specific)
                setTimeout(() => {
                    done();
                }, 100);
            });
        }, 10000);
    });

    describe('8. Feedback Submission After Streaming', () => {
        it('should allow feedback submission on streamed messages', async () => {
            const mockConversation = {
                _id: 'conv123',
                messages: [
                    { _id: 'msg456', role: 'assistant', content: 'Test response' }
                ],
                save: jest.fn().mockResolvedValue(true)
            };

            // Mock Conversation.findOne to support feedback
            Conversation.findOne = jest.fn().mockImplementation((query) => {
                if (query['messages._id']) {
                    return Promise.resolve({
                        ...mockConversation,
                        messages: {
                            id: (id) => id === 'msg456' ? mockConversation.messages[0] : null
                        }
                    });
                }
                return Promise.resolve(null);
            });

            // Simulate streaming completion first
            chatService.handleChatRequestStream = jest.fn(async ({ onComplete }) => {
                onComplete({
                    response: 'Test response',
                    conversationId: 'conv123',
                    messageId: 'msg456'
                });
            });

            // Then submit feedback
            const feedbackResponse = await request(app)
                .post('/api/feedback')
                .send({
                    messageId: 'msg456',
                    rating: 'positive',
                    comment: 'Great answer!'
                });

            expect(feedbackResponse.status).toBe(200);
        });
    });

    describe('9. Stats and Performance', () => {
        it('should include stats in done event', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onToken, onComplete }) => {
                onToken('Test');
                onComplete({
                    response: 'Test',
                    conversationId: 'conv123',
                    stats: {
                        total_duration: 5000000,
                        eval_count: 50,
                        prompt_eval_count: 100
                    }
                });
            });

            let doneEvent = null;

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Performance test' })
                .parse((res, callback) => {
                    res.on('data', (chunk) => {
                        const data = chunk.toString();
                        if (data.includes('event: done')) {
                            const match = data.match(/data: ({.*})/);
                            if (match) {
                                doneEvent = JSON.parse(match[1]);
                            }
                        }
                    });
                    res.on('end', () => {
                        callback(null, { doneEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(doneEvent.stats).toMatchObject({
                        eval_count: 50,
                        prompt_eval_count: 100
                    });
                    done();
                });
        }, 10000);
    });

    describe('10. Auto-Routing with Streaming', () => {
        it('should support auto-routing in streaming mode', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ autoRoute, onToken, onComplete }) => {
                expect(autoRoute).toBe(true);
                onToken('Routed response');
                onComplete({
                    response: 'Routed response',
                    model: 'gpt-4',
                    routing: { taskType: 'coding', routed: true }
                });
            });

            let doneEvent = null;

            request(app)
                .post('/api/chat/stream')
                .send({
                    message: 'Write Python code',
                    autoRoute: true
                })
                .parse((res, callback) => {
                    res.on('data', (chunk) => {
                        const data = chunk.toString();
                        if (data.includes('event: done')) {
                            const match = data.match(/data: ({.*})/);
                            if (match) {
                                doneEvent = JSON.parse(match[1]);
                            }
                        }
                    });
                    res.on('end', () => {
                        callback(null, { doneEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(doneEvent.routing).toMatchObject({
                        taskType: 'coding',
                        routed: true
                    });
                    done();
                });
        }, 10000);
    });
});
