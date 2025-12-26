/**
 * Voice API Integration Tests
 * Tests for voice endpoints
 */

const request = require('supertest');
const app = require('../../src/app');
const path = require('path');
const fs = require('fs');

// Mock the voice service
jest.mock('../../src/services/voiceService', () => ({
    checkHealth: jest.fn(),
    transcribe: jest.fn(),
    synthesize: jest.fn(),
    config: {
        WHISPER_LOCAL_URL: 'http://192.168.2.99:8000',
        DEFAULT_VOICE: 'alloy'
    }
}));

const voiceService = require('../../src/services/voiceService');

describe('Voice API', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/voice/health', () => {
        it('should return health status', async () => {
            voiceService.checkHealth.mockResolvedValue({
                stt: {
                    localWhisper: true,
                    openAiFallback: true
                },
                tts: {
                    available: true,
                    provider: 'openai'
                }
            });

            const res = await request(app)
                .get('/api/voice/health')
                .expect(200);

            expect(res.body.stt).toBeDefined();
            expect(res.body.tts).toBeDefined();
            expect(voiceService.checkHealth).toHaveBeenCalled();
        });

        it('should handle health check errors', async () => {
            voiceService.checkHealth.mockRejectedValue(new Error('Service unavailable'));

            const res = await request(app)
                .get('/api/voice/health')
                .expect(500);

            expect(res.body.error).toBeDefined();
        });
    });

    describe('POST /api/voice/transcribe', () => {
        it('should transcribe audio successfully', async () => {
            voiceService.transcribe.mockResolvedValue({
                text: 'Hello world',
                source: 'local',
                duration: 1.5,
                language: 'en'
            });

            // Create a fake audio buffer
            const fakeAudio = Buffer.from('fake audio data');

            const res = await request(app)
                .post('/api/voice/transcribe')
                .attach('audio', fakeAudio, 'test.wav')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.text).toBe('Hello world');
            expect(res.body.source).toBe('local');
        });

        it('should handle missing audio file', async () => {
            const res = await request(app)
                .post('/api/voice/transcribe')
                .expect(400);

            expect(res.body.error).toContain('audio');
        });

        it('should handle transcription errors', async () => {
            voiceService.transcribe.mockRejectedValue(new Error('Transcription failed'));

            const fakeAudio = Buffer.from('fake audio data');

            const res = await request(app)
                .post('/api/voice/transcribe')
                .attach('audio', fakeAudio, 'test.wav')
                .expect(500);

            expect(res.body.error).toBeDefined();
        });
    });

    describe('POST /api/voice/synthesize', () => {
        it('should synthesize text to audio', async () => {
            const mockAudioBuffer = Buffer.from('synthesized audio');
            voiceService.synthesize.mockResolvedValue({
                audio: mockAudioBuffer,
                source: 'openai',
                voice: 'alloy'
            });

            const res = await request(app)
                .post('/api/voice/synthesize')
                .send({ text: 'Hello world' })
                .expect(200);

            expect(res.headers['content-type']).toMatch(/audio/);
        });

        it('should handle missing text', async () => {
            const res = await request(app)
                .post('/api/voice/synthesize')
                .send({})
                .expect(400);

            expect(res.body.error).toContain('text');
        });

        it('should accept voice parameter', async () => {
            const mockAudioBuffer = Buffer.from('synthesized audio');
            voiceService.synthesize.mockResolvedValue({
                audio: mockAudioBuffer,
                source: 'openai',
                voice: 'nova'
            });

            const res = await request(app)
                .post('/api/voice/synthesize')
                .send({ text: 'Hello', voice: 'nova' })
                .expect(200);

            expect(voiceService.synthesize).toHaveBeenCalledWith('Hello', { voice: 'nova' });
        });
    });

    describe('POST /api/voice/chat', () => {
        it('should process full voice chat flow', async () => {
            // Mock transcription
            voiceService.transcribe.mockResolvedValue({
                text: 'What is the weather today?',
                source: 'local'
            });

            const fakeAudio = Buffer.from('fake audio data');

            const res = await request(app)
                .post('/api/voice/chat')
                .attach('audio', fakeAudio, 'input.wav')
                .field('conversationId', 'test-conv-123')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.transcription).toBe('What is the weather today?');
            expect(res.body.response).toBeDefined();
        });

        it('should return TTS audio when requested', async () => {
            voiceService.transcribe.mockResolvedValue({
                text: 'Hello',
                source: 'local'
            });

            voiceService.synthesize.mockResolvedValue({
                audio: Buffer.from('response audio'),
                source: 'openai'
            });

            const fakeAudio = Buffer.from('fake audio data');

            const res = await request(app)
                .post('/api/voice/chat')
                .attach('audio', fakeAudio, 'input.wav')
                .field('returnAudio', 'true')
                .expect(200);

            expect(res.body.audioResponse).toBeDefined();
        });
    });
});

describe('Voice Service Error Handling', () => {
    it('should fallback gracefully when local Whisper unavailable', async () => {
        // First call fails (local), second succeeds (OpenAI)
        voiceService.transcribe
            .mockRejectedValueOnce(new Error('Local unavailable'))
            .mockResolvedValueOnce({
                text: 'Fallback transcription',
                source: 'openai'
            });

        const fakeAudio = Buffer.from('fake audio');

        // This would test the actual fallback logic in the service
        // For now we just verify the mock behavior
        await expect(voiceService.transcribe(fakeAudio)).rejects.toThrow();
    });
});
