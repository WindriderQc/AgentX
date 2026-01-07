// n8nLLMProvider.test.js

const n8nProvider = require('../../src/services/n8nLLMProvider');
const fetch = require('node-fetch');
const logger = require('../../config/logger');

// Mock dependencies
jest.mock('node-fetch');
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
}));

const WEBHOOK_URL = 'http://n8n.webhook/test';

describe('N8nLLMProvider', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('chat()', () => {
        it('should call webhook with correct payload', async () => {
            // Mock success response
            fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    response: 'Hello from n8n'
                })
            });

            const messages = [{ role: 'user', content: 'Hi' }];
            const options = { model: 'gpt-4', userId: 'user1' };

            const result = await n8nProvider.chat(WEBHOOK_URL, messages, options);

            expect(result.content).toBe('Hello from n8n');
            expect(result.role).toBe('assistant');
            
            // Validate payload
            expect(fetch).toHaveBeenCalledWith(WEBHOOK_URL, expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"messages"')
            }));
            
            const payload = JSON.parse(fetch.mock.calls[0][1].body);
            expect(payload.model).toBe('gpt-4');
            expect(payload.messages).toEqual(messages);
            expect(payload.metadata.userId).toBe('user1');
        });

        it('should handle webhook errors', async () => {
            fetch.mockResolvedValue({
                ok: false,
                status: 500,
                statusText: 'Server Error'
            });

            await expect(n8nProvider.chat(WEBHOOK_URL, []))
                .rejects.toThrow('n8n webhook returned 500');
        });

        it('should handle fetch failures', async () => {
            fetch.mockRejectedValue(new Error('Network Error'));
            
            await expect(n8nProvider.chat(WEBHOOK_URL, []))
                .rejects.toThrow('n8n LLM request failed');
        });
    });

    describe('Response Normalization', () => {
        it('should normalize OpenAI format', async () => {
             const openAIResponse = {
                 choices: [{
                     message: { role: 'assistant', content: 'OpenAI Content' },
                     finish_reason: 'stop'
                 }],
                 usage: { total_tokens: 10 }
             };
             
             fetch.mockResolvedValue({
                 ok: true,
                 json: () => Promise.resolve(openAIResponse)
             });

             const result = await n8nProvider.chat(WEBHOOK_URL, []);
             expect(result.content).toBe('OpenAI Content');
             expect(result.usage).toEqual({ total_tokens: 10 });
        });

        it('should normalize Anthropic format', async () => {
            const anthropicResponse = {
                content: [{ type: 'text', text: 'Claude Content' }],
                role: 'assistant',
                usage: { input_tokens: 5, output_tokens: 5 }
            };

            fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(anthropicResponse)
            });

            const result = await n8nProvider.chat(WEBHOOK_URL, []);
            expect(result.content).toBe('Claude Content');
        });

        it('should normalize simple text format', async () => {
             fetch.mockResolvedValue({
                 ok: true,
                 json: () => Promise.resolve({ text: 'Simple text' })
             });
             
             const result = await n8nProvider.chat(WEBHOOK_URL, []);
             expect(result.content).toBe('Simple text');
        });
    });

    describe('Health Check', () => {
        it('should return available=true on 200 OK', async () => {
            fetch.mockResolvedValue({
                ok: true,
                status: 200,
                statusText: 'OK'
            });

            const result = await n8nProvider.healthCheck(WEBHOOK_URL);
            expect(result.available).toBe(true);
            expect(result.statusCode).toBe(200);
            expect(result.latency).toBeGreaterThanOrEqual(0);
        });

        it('should return available=false on error', async () => {
            fetch.mockResolvedValue({
                ok: false,
                status: 404
            });

            const result = await n8nProvider.healthCheck(WEBHOOK_URL);
            expect(result.available).toBe(false);
            expect(result.statusCode).toBe(404);
        });

        it('should handle network exceptions', async () => {
            fetch.mockRejectedValue(new Error('Connection refused'));
            
            const result = await n8nProvider.healthCheck(WEBHOOK_URL);
            expect(result.available).toBe(false);
            expect(result.error).toContain('Connection refused');
        });
    });
});
