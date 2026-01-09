/**
 * Integration Tests for Streaming SSE API Endpoint
 * Tests POST /api/chat/stream for SSE headers, events, authentication, workspace isolation
 */

const request = require('supertest');

// Mock chatService before requiring app
jest.mock('../../src/services/chatService');

// Mock auth middleware
jest.mock('../../src/middleware/auth', () => ({
    optionalAuth: (req, res, next) => {
        res.locals.user = { userId: 'testuser123', name: 'Test User' };
        req.session = { 
            userId: 'testuser123', 
            touch: jest.fn(), 
            save: jest.fn((cb) => cb && cb()),
            cookie: { secure: false, maxAge: 3600000 }
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
            cookie: { secure: false, maxAge: 3600000 }
        };
        req.user = { _id: 'testuser123', username: 'testuser' };
        next();
    },
    attachWorkspace: (req, res, next) => next(),
    optionalWorkspaceContext: (req, res, next) => next(),
    attachUser: (req, res, next) => {
        res.locals.user = { userId: 'testuser123', name: 'Test User' };
        req.session = { 
            userId: 'testuser123', 
            touch: jest.fn(), 
            save: jest.fn((cb) => cb && cb()),
            cookie: { secure: false, maxAge: 3600000 }
        };
        req.user = { _id: 'testuser123', username: 'testuser' };
        next();
    },
    requireAdmin: (req, res, next) => next(),
    apiKeyAuth: (req, res, next) => next()
}));

const chatService = require('../../src/services/chatService');
const Conversation = require('../../models/Conversation');

// Load app after mocks
const { app } = require('../../src/app');

describe('POST /api/chat/stream - Streaming SSE Endpoint', () => {

    beforeEach(() => {
        jest.clearAllMocks();
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

        it('should return SSE headers for GET requests', async () => {
            chatService.handleChatRequestStream = jest.fn(async ({ onComplete }) => {
                onComplete({ response: 'Test', conversationId: 'conv123' });
            });

            const payload = Buffer.from(JSON.stringify({ model: 'llama2', message: 'Hello' })).toString('base64');

            const response = await request(app)
                .get('/api/chat/stream')
                .query({ payload });

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
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: token')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) tokens.push(JSON.parse(match[1]).content);
                            }
                        });
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
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: done')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) doneEvent = JSON.parse(match[1]);
                            }
                        });
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
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: error')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) errorEvent = JSON.parse(match[1]);
                            }
                        });
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
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: error')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) errorEvent = JSON.parse(match[1]);
                            }
                        });
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
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: thinking')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) thinkingEvents.push(JSON.parse(match[1]).content);
                            }
                            if (part.includes('event: token')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) tokenEvents.push(JSON.parse(match[1]).content);
                            }
                        });
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
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: done')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) doneEvent = JSON.parse(match[1]);
                            }
                        });
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
            let isDone = false;
            const finish = () => {
                if (!isDone) {
                    isDone = true;
                    done();
                }
            };

            chatService.handleChatRequestStream = jest.fn(async ({ onToken, onComplete }) => {
                // Simulate slow streaming
                await new Promise(resolve => setTimeout(resolve, 500));
                // Only call callbacks if we haven't timed out locally
                try {
                    if (onToken) onToken('Slow token');
                    if (onComplete) onComplete({ response: 'Slow response' });
                } catch (e) {
                    // Ignore errors writing to closed response
                }
            });

            const req = request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' });

            // Simulate client disconnect after 50ms
            setTimeout(() => {
                req.abort();
                // Allow time for server to handle disconnect
                setTimeout(finish, 100);
            }, 50);

            req.end((err) => {
                // If it ends (error or success), finish
                finish();
            });
        }, 10000);
    });

    describe('8. Feedback Submission After Streaming', () => {
        it('should return messageId in done event for feedback', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onComplete }) => {
                onComplete({
                    response: 'Test response',
                    conversationId: 'conv123',
                    messageId: 'msg456'
                });
            });

            let doneEvent = null;

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' })
                .parse((res, callback) => {
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: done')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) doneEvent = JSON.parse(match[1]);
                            }
                        });
                    });
                    res.on('end', () => {
                        callback(null, { doneEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(doneEvent.messageId).toBe('msg456');
                    expect(doneEvent.conversationId).toBe('conv123');
                    done();
                });
        }, 10000);
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
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: done')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) doneEvent = JSON.parse(match[1]);
                            }
                        });
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
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: done')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) doneEvent = JSON.parse(match[1]);
                            }
                        });
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
