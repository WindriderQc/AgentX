/**
 * Voice Service
 * Handles Speech-to-Text (STT) and Text-to-Speech (TTS)
 * 
 * Supports:
 * - Local Whisper via faster-whisper-server or whisper.cpp
 * - OpenAI Whisper API as fallback
 * - Browser-native TTS (Web Speech API) for frontend
 * - Future: Local TTS via Coqui/Piper
 */

const logger = require('../../config/logger');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

// Use dynamic import wrapped in a function that can be mocked
let fetchImpl = null;
async function getFetch() {
    if (!fetchImpl) {
        fetchImpl = (await import('node-fetch')).default;
    }
    return fetchImpl;
}

// Wrapper function for fetch calls (allows test mocking)
async function fetch(...args) {
    const fetchFn = await getFetch();
    return fetchFn(...args);
}

// Configuration
const WHISPER_LOCAL_URL = process.env.WHISPER_URL || 'http://192.168.2.99:8000';  // faster-whisper-server
const OPENAI_WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

// TTS Configuration
const TTS_PROVIDER = process.env.TTS_PROVIDER || 'browser';  // browser, openai, local
const TTS_LOCAL_URL = process.env.TTS_URL || 'http://192.168.2.99:5002';  // Coqui/Piper

// Helper to get API key dynamically (allows tests to override)
function getOpenAIKey() {
    return process.env.OPENAI_API_KEY || null;
}

/**
 * Transcribe audio to text using Whisper
 * @param {Buffer} audioBuffer - Audio file buffer
 * @param {Object} options - Transcription options
 * @param {string} options.language - Language code (e.g., 'en', 'fr')
 * @param {string} options.provider - 'local' or 'openai'
 * @returns {Promise<{text: string, language: string, duration: number, provider: string}>}
 */
async function transcribe(audioBuffer, options = {}) {
    const { language = 'en', provider = 'local' } = options;

    // Try local first, fall back to OpenAI
    if (provider === 'local' || !getOpenAIKey()) {
        try {
            return await transcribeLocal(audioBuffer, language);
        } catch (err) {
            logger.warn('Local Whisper failed, trying OpenAI fallback', { error: err.message });
            if (getOpenAIKey()) {
                return await transcribeOpenAI(audioBuffer, language);
            }
            throw err;
        }
    }

    return await transcribeOpenAI(audioBuffer, language);
}

/**
 * Transcribe using local faster-whisper-server
 */
async function transcribeLocal(audioBuffer, language = 'en') {
    const startTime = Date.now();
    
    // Create form data with audio file
    const formData = new FormData();
    formData.append('file', audioBuffer, {
        filename: 'audio.wav',
        contentType: 'audio/wav'
    });
    formData.append('language', language);
    formData.append('response_format', 'json');
    
    try {
        const response = await fetch(`${WHISPER_LOCAL_URL}/v1/audio/transcriptions`, {
            method: 'POST',
            body: formData,
            headers: formData.getHeaders()
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Local Whisper error: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        const duration = Date.now() - startTime;
        
        logger.info('Local transcription complete', { 
            duration, 
            textLength: data.text?.length,
            language: data.language || language
        });
        
        return {
            text: data.text || '',
            language: data.language || language,
            duration,
            provider: 'local'
        };
        
    } catch (err) {
        logger.error('Local Whisper transcription failed', { error: err.message });
        throw err;
    }
}

/**
 * Transcribe using OpenAI Whisper API
 */
async function transcribeOpenAI(audioBuffer, language = 'en') {
    const apiKey = getOpenAIKey();
    if (!apiKey) {
        throw new Error('OpenAI API key not configured');
    }

    const startTime = Date.now();

    const formData = new FormData();
    formData.append('file', audioBuffer, {
        filename: 'audio.wav',
        contentType: 'audio/wav'
    });
    formData.append('model', 'whisper-1');
    formData.append('language', language);
    formData.append('response_format', 'json');

    try {
        const response = await fetch(OPENAI_WHISPER_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                ...formData.getHeaders()
            },
            body: formData
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenAI Whisper error: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        const duration = Date.now() - startTime;
        
        logger.info('OpenAI transcription complete', { 
            duration, 
            textLength: data.text?.length 
        });
        
        return {
            text: data.text || '',
            language,
            duration,
            provider: 'openai'
        };
        
    } catch (err) {
        logger.error('OpenAI Whisper transcription failed', { error: err.message });
        throw err;
    }
}

/**
 * Generate speech from text (TTS)
 * @param {string} text - Text to convert to speech
 * @param {Object} options - TTS options
 * @param {string} options.voice - Voice ID
 * @param {string} options.provider - 'browser', 'openai', 'local'
 * @returns {Promise<{audio: Buffer|null, provider: string, format: string}>}
 */
async function synthesize(text, options = {}) {
    const { voice = 'default', provider = TTS_PROVIDER } = options;
    
    switch (provider) {
        case 'openai':
            return await synthesizeOpenAI(text, voice);
        case 'local':
            return await synthesizeLocal(text, voice);
        case 'browser':
        default:
            // Browser TTS is handled client-side
            return {
                audio: null,
                provider: 'browser',
                format: 'none',
                text,
                message: 'Use Web Speech API on client'
            };
    }
}

/**
 * Generate speech using OpenAI TTS
 */
async function synthesizeOpenAI(text, voice = 'alloy') {
    const apiKey = getOpenAIKey();
    if (!apiKey) {
        throw new Error('OpenAI API key not configured');
    }

    const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
    const selectedVoice = validVoices.includes(voice) ? voice : 'alloy';

    try {
        const response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'tts-1',
                input: text,
                voice: selectedVoice,
                response_format: 'mp3'
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenAI TTS error: ${response.status} - ${errorText}`);
        }
        
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        
        logger.info('OpenAI TTS complete', { 
            textLength: text.length, 
            audioSize: audioBuffer.length 
        });
        
        return {
            audio: audioBuffer,
            provider: 'openai',
            format: 'mp3'
        };
        
    } catch (err) {
        logger.error('OpenAI TTS failed', { error: err.message });
        throw err;
    }
}

/**
 * Generate speech using local TTS (Coqui/Piper)
 */
async function synthesizeLocal(text, voice = 'default') {
    try {
        const response = await fetch(`${TTS_LOCAL_URL}/api/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice })
        });
        
        if (!response.ok) {
            throw new Error(`Local TTS error: ${response.status}`);
        }
        
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        
        return {
            audio: audioBuffer,
            provider: 'local',
            format: 'wav'
        };
        
    } catch (err) {
        logger.error('Local TTS failed', { error: err.message });
        throw err;
    }
}

/**
 * Check voice service health
 */
async function checkHealth() {
    const health = {
        stt: { local: false, openai: !!getOpenAIKey() },
        tts: { browser: true, openai: !!getOpenAIKey(), local: false }
    };
    
    // Check local Whisper
    try {
        const response = await fetch(`${WHISPER_LOCAL_URL}/health`, { timeout: 3000 });
        health.stt.local = response.ok;
    } catch (err) {
        health.stt.local = false;
        health.stt.localError = err.message;
    }
    
    // Check local TTS
    try {
        const response = await fetch(`${TTS_LOCAL_URL}/api/health`, { timeout: 3000 });
        health.tts.local = response.ok;
    } catch (err) {
        health.tts.local = false;
    }
    
    return health;
}

// Test helper to inject mock fetch
function __setMockFetch(mockFn) {
    fetchImpl = mockFn;
}

// Test helper to reset fetch
function __resetFetch() {
    fetchImpl = null;
}

module.exports = {
    transcribe,
    transcribeLocal,
    transcribeOpenAI,
    synthesize,
    synthesizeOpenAI,
    synthesizeLocal,
    checkHealth,
    WHISPER_LOCAL_URL,
    TTS_PROVIDER,
    __setMockFetch,  // For testing only
    __resetFetch     // For testing only
};
