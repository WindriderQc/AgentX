/**
 * Voice Service Tests
 * Tests for STT (Whisper) and TTS functionality
 */

const voiceService = require('../../src/services/voiceService');

// Mock fetch for external API calls
jest.mock('node-fetch', () => jest.fn());
const fetch = require('node-fetch');

describe('Voice Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('checkHealth', () => {
        it('should return healthy when local Whisper is available', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ status: 'ok' })
            });

            const health = await voiceService.checkHealth();
            expect(health.stt).toBeDefined();
            expect(health.tts).toBeDefined();
        });

        it('should indicate fallback when local Whisper is unavailable', async () => {
            fetch.mockRejectedValueOnce(new Error('Connection refused'));

            const health = await voiceService.checkHealth();
            expect(health.stt.localWhisper).toBe(false);
        });
    });

    describe('transcribe', () => {
        it('should transcribe audio buffer successfully', async () => {
            const mockAudio = Buffer.from('fake audio data');
            
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    text: 'Hello world',
                    language: 'en',
                    duration: 1.5
                })
            });

            const result = await voiceService.transcribe(mockAudio);
            expect(result.text).toBe('Hello world');
            expect(result.source).toBeDefined();
        });

        it('should fallback to OpenAI when local fails', async () => {
            const mockAudio = Buffer.from('fake audio data');
            
            // Local fails
            fetch.mockRejectedValueOnce(new Error('Local unavailable'));
            
            // OpenAI succeeds
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'Hello from OpenAI' })
            });

            const result = await voiceService.transcribe(mockAudio);
            expect(result.text).toBe('Hello from OpenAI');
            expect(result.source).toBe('openai');
        });

        it('should throw error when all sources fail', async () => {
            const mockAudio = Buffer.from('fake audio data');
            
            fetch.mockRejectedValue(new Error('All sources failed'));

            await expect(voiceService.transcribe(mockAudio))
                .rejects.toThrow();
        });
    });

    describe('synthesize', () => {
        it('should synthesize text to audio', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                buffer: async () => Buffer.from('audio output')
            });

            const result = await voiceService.synthesize('Hello world');
            expect(result.audio).toBeDefined();
            expect(result.source).toBeDefined();
        });

        it('should use specified voice', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                buffer: async () => Buffer.from('audio output')
            });

            const result = await voiceService.synthesize('Hello', { voice: 'alloy' });
            expect(result.audio).toBeDefined();
        });

        it('should handle TTS failure gracefully', async () => {
            fetch.mockRejectedValueOnce(new Error('TTS unavailable'));

            await expect(voiceService.synthesize('Hello'))
                .rejects.toThrow('TTS unavailable');
        });
    });

    describe('Configuration', () => {
        it('should have WHISPER_LOCAL_URL defined', () => {
            expect(voiceService.config.WHISPER_LOCAL_URL).toBeDefined();
        });

        it('should have default TTS voice', () => {
            expect(voiceService.config.DEFAULT_VOICE).toBeDefined();
        });
    });
});

describe('Voice Service Integration', () => {
    describe('Full chat flow', () => {
        it('should process audio input and return response', async () => {
            const mockAudio = Buffer.from('fake audio');
            
            // Mock transcription
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'What is the weather?' })
            });

            // This would need more mocking for the full chat flow
            // For now, test the transcription part
            const transcription = await voiceService.transcribe(mockAudio);
            expect(transcription.text).toBe('What is the weather?');
        });
    });
});
