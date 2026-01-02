/**
 * Voice Service Tests
 * Tests for STT (Whisper) and TTS functionality
 */

const voiceService = require('../../src/services/voiceService');

// Create a mock fetch function
const mockFetch = jest.fn();

describe('Voice Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Inject our mock fetch function
        voiceService.__setMockFetch(mockFetch);
    });

    afterEach(() => {
        // Reset fetch to allow clean state
        voiceService.__resetFetch();
    });

    describe('checkHealth', () => {
        it('should return healthy when local Whisper is available', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ status: 'ok' })
            });

            const health = await voiceService.checkHealth();
            expect(health.stt).toBeDefined();
            expect(health.tts).toBeDefined();
        });

        it('should indicate fallback when local Whisper is unavailable', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

            const health = await voiceService.checkHealth();
            expect(health.stt.local).toBe(false);
        });
    });

    describe('transcribe', () => {
        it('should transcribe audio buffer successfully', async () => {
            const mockAudio = Buffer.from('fake audio data');

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({
                    text: 'Hello world',
                    language: 'en',
                    duration: 1.5
                })
            });

            const result = await voiceService.transcribe(mockAudio);
            expect(result.text).toBe('Hello world');
            expect(result.provider).toBeDefined();
        });

        it('should fallback to OpenAI when local fails', async () => {
            const mockAudio = Buffer.from('fake audio data');

            // Set OPENAI_API_KEY for this test
            const originalKey = process.env.OPENAI_API_KEY;
            process.env.OPENAI_API_KEY = 'test-key';

            // Local fails
            mockFetch.mockRejectedValueOnce(new Error('Local unavailable'));

            // OpenAI succeeds
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({ text: 'Hello from OpenAI' })
            });

            const result = await voiceService.transcribe(mockAudio);
            expect(result.text).toBe('Hello from OpenAI');
            expect(result.provider).toBe('openai');

            // Restore original key
            process.env.OPENAI_API_KEY = originalKey;
        });

        it('should throw error when all sources fail', async () => {
            const mockAudio = Buffer.from('fake audio data');

            // Both local and OpenAI fail
            mockFetch.mockRejectedValueOnce(new Error('Local failed'));
            mockFetch.mockRejectedValueOnce(new Error('OpenAI failed'));

            await expect(voiceService.transcribe(mockAudio))
                .rejects.toThrow();
        });
    });

    describe('synthesize', () => {
        it('should synthesize text to audio with OpenAI provider', async () => {
            // Set API key for test
            const originalKey = process.env.OPENAI_API_KEY;
            process.env.OPENAI_API_KEY = 'test-key';

            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(100))
            });

            const result = await voiceService.synthesize('Hello world', { provider: 'openai' });
            expect(result.audio).toBeDefined();
            expect(result.provider).toBe('openai');

            process.env.OPENAI_API_KEY = originalKey;
        });

        it('should use specified voice', async () => {
            const originalKey = process.env.OPENAI_API_KEY;
            process.env.OPENAI_API_KEY = 'test-key';

            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(100))
            });

            const result = await voiceService.synthesize('Hello', { voice: 'alloy', provider: 'openai' });
            expect(result.audio).toBeDefined();

            process.env.OPENAI_API_KEY = originalKey;
        });

        it('should handle TTS failure gracefully', async () => {
            const originalKey = process.env.OPENAI_API_KEY;
            process.env.OPENAI_API_KEY = 'test-key';

            mockFetch.mockRejectedValueOnce(new Error('TTS unavailable'));

            await expect(voiceService.synthesize('Hello', { provider: 'openai' }))
                .rejects.toThrow('TTS unavailable');

            process.env.OPENAI_API_KEY = originalKey;
        });
    });

    describe('Configuration', () => {
        it('should have WHISPER_LOCAL_URL defined', () => {
            expect(voiceService.WHISPER_LOCAL_URL).toBeDefined();
        });

        it('should have default TTS provider', () => {
            expect(voiceService.TTS_PROVIDER).toBeDefined();
        });
    });
});

describe('Voice Service Integration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        voiceService.__setMockFetch(mockFetch);
    });

    afterEach(() => {
        voiceService.__resetFetch();
    });

    describe('Full chat flow', () => {
        it('should process audio input and return response', async () => {
            const mockAudio = Buffer.from('fake audio');

            // Mock transcription
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({ text: 'What is the weather?' })
            });

            // This would need more mocking for the full chat flow
            // For now, test the transcription part
            const transcription = await voiceService.transcribe(mockAudio);
            expect(transcription.text).toBe('What is the weather?');
        });
    });
});
