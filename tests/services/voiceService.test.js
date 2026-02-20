/**
 * Voice Service Tests
 * Tests for STT (Whisper) and TTS functionality
 */

// Set env vars before requiring (module reads them at import time)
process.env.WHISPER_URL = 'http://test-whisper:8000';
process.env.TTS_URL = 'http://test-tts:5002';

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
        it('should use WHISPER_URL from env', () => {
            expect(voiceService.WHISPER_LOCAL_URL).toBe('http://test-whisper:8000');
        });

        it('should have default TTS provider', () => {
            expect(voiceService.TTS_PROVIDER).toBeDefined();
        });

        it('should export CORE_WHISPER_MODELS list', () => {
            expect(voiceService.CORE_WHISPER_MODELS).toContain('Systran/faster-whisper-small');
            expect(voiceService.CORE_WHISPER_MODELS.length).toBeGreaterThanOrEqual(5);
        });

        it('should export STT_LANGUAGES with en', () => {
            const en = voiceService.STT_LANGUAGES.find(l => l.code === 'en');
            expect(en).toBeDefined();
            expect(en.name).toBe('English');
        });

        it('should export TTS_VOICES', () => {
            expect(voiceService.TTS_VOICES).toContain('alloy');
            expect(voiceService.TTS_VOICES).toContain('shimmer');
        });
    });

    describe('getOpenAIKey fallback', () => {
        it('should fall back to OPENAI_KEY when OPENAI_API_KEY not set', async () => {
            const origApiKey = process.env.OPENAI_API_KEY;
            const origKey = process.env.OPENAI_KEY;
            delete process.env.OPENAI_API_KEY;
            process.env.OPENAI_KEY = 'fallback-key';

            // Health check should show openai available
            mockFetch.mockResolvedValueOnce({ ok: true }); // local whisper
            mockFetch.mockResolvedValueOnce({ ok: false }); // local tts
            const health = await voiceService.checkHealth();
            expect(health.stt.openai).toBe(true);

            process.env.OPENAI_API_KEY = origApiKey;
            process.env.OPENAI_KEY = origKey;
        });
    });

    describe('model passthrough', () => {
        it('should pass custom model to transcribeLocal', async () => {
            const mockAudio = Buffer.from('fake audio data');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({ text: 'Hello', language: 'en' })
            });

            await voiceService.transcribeLocal(mockAudio, 'en', 'Systran/faster-whisper-large-v3');
            const callBody = mockFetch.mock.calls[0][1].body;
            // FormData appends fields — verify model was included
            expect(callBody).toBeDefined();
        });
    });

    describe('getAvailableModels', () => {
        it('should return filtered core models from server', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: jest.fn().mockResolvedValue({
                    data: [
                        { id: 'Systran/faster-whisper-small' },
                        { id: 'Systran/faster-whisper-large-v3' },
                        { id: 'some-community/random-whisper-fork' }
                    ]
                })
            });

            const models = await voiceService.getAvailableModels();
            expect(models).toContain('Systran/faster-whisper-small');
            expect(models).toContain('Systran/faster-whisper-large-v3');
            expect(models).not.toContain('some-community/random-whisper-fork');
        });

        it('should return empty array on server error', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
            const models = await voiceService.getAvailableModels();
            expect(models).toEqual([]);
        });
    });

    describe('enhanced checkHealth', () => {
        it('should include models and languages when includeModels=true', async () => {
            mockFetch
                .mockResolvedValueOnce({ ok: true })  // whisper health
                .mockResolvedValueOnce({ ok: false })  // tts health
                .mockResolvedValueOnce({               // /v1/models
                    ok: true,
                    json: jest.fn().mockResolvedValue({ data: [{ id: 'Systran/faster-whisper-small' }] })
                });

            const health = await voiceService.checkHealth({ includeModels: true });
            expect(health.languages).toBeDefined();
            expect(health.languages.length).toBeGreaterThan(0);
            expect(health.ttsVoices).toContain('alloy');
            expect(health.activeModel).toBeDefined();
            expect(health.models).toBeDefined();
        });

        it('should not include models when includeModels=false', async () => {
            mockFetch.mockResolvedValueOnce({ ok: true });  // whisper health
            mockFetch.mockResolvedValueOnce({ ok: false }); // tts health

            const health = await voiceService.checkHealth();
            expect(health.models).toBeUndefined();
            expect(health.languages).toBeUndefined();
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
