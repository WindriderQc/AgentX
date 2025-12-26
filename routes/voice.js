/**
 * Voice Routes
 * Endpoints for Speech-to-Text, Text-to-Speech, and Voice Chat
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { optionalAuth } = require('../src/middleware/auth');
const { getUserId } = require('../src/helpers/userHelpers');
const { transcribe, synthesize, checkHealth } = require('../src/services/voiceService');
const { handleChatRequest } = require('../src/services/chatService');
const { getRagStore } = require('../src/services/ragStore');
const logger = require('../config/logger');

// Configure multer for audio uploads (in memory)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 25 * 1024 * 1024  // 25MB max (Whisper limit)
    },
    fileFilter: (req, file, cb) => {
        const allowedMimes = [
            'audio/wav', 'audio/wave', 'audio/x-wav',
            'audio/mpeg', 'audio/mp3',
            'audio/webm', 'audio/ogg',
            'audio/flac', 'audio/m4a', 'audio/mp4'
        ];
        if (allowedMimes.includes(file.mimetype) || file.mimetype.startsWith('audio/')) {
            cb(null, true);
        } else {
            cb(new Error(`Invalid file type: ${file.mimetype}. Audio files only.`), false);
        }
    }
});

// RAG Store for voice chat
const ragStore = getRagStore({
    vectorStoreType: process.env.VECTOR_STORE_TYPE || 'memory',
    url: process.env.QDRANT_URL,
    collection: process.env.QDRANT_COLLECTION
});

/**
 * GET /api/voice/health
 * Check voice service availability
 */
router.get('/health', async (req, res) => {
    try {
        const health = await checkHealth();
        res.json({
            status: 'success',
            data: health
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/voice/transcribe
 * Transcribe audio file to text
 * 
 * Body: multipart/form-data with 'audio' file
 * Query params:
 *   - language: ISO language code (default: 'en')
 *   - provider: 'local' or 'openai' (default: 'local')
 */
router.post('/transcribe', upload.single('audio'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'No audio file provided. Use form field "audio".' 
        });
    }
    
    const { language = 'en', provider = 'local' } = req.query;
    
    try {
        const result = await transcribe(req.file.buffer, { language, provider });
        
        res.json({
            status: 'success',
            data: {
                text: result.text,
                language: result.language,
                duration: result.duration,
                provider: result.provider
            }
        });
        
    } catch (err) {
        logger.error('Transcription failed', { error: err.message });
        res.status(500).json({ 
            status: 'error', 
            message: err.message 
        });
    }
});

/**
 * POST /api/voice/synthesize
 * Convert text to speech
 * 
 * Body JSON:
 *   - text: string (required)
 *   - voice: string (optional, default: 'alloy' for OpenAI)
 *   - provider: 'browser', 'openai', 'local' (default: 'browser')
 */
router.post('/synthesize', express.json(), async (req, res) => {
    const { text, voice = 'alloy', provider = 'browser' } = req.body;
    
    if (!text) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Text is required' 
        });
    }
    
    try {
        const result = await synthesize(text, { voice, provider });
        
        if (result.audio) {
            // Return audio file
            res.set({
                'Content-Type': result.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
                'Content-Length': result.audio.length
            });
            res.send(result.audio);
        } else {
            // Browser TTS - return instructions
            res.json({
                status: 'success',
                data: {
                    text: result.text,
                    provider: result.provider,
                    message: result.message
                }
            });
        }
        
    } catch (err) {
        logger.error('TTS failed', { error: err.message });
        res.status(500).json({ 
            status: 'error', 
            message: err.message 
        });
    }
});

/**
 * POST /api/voice/chat
 * Full voice conversation flow: transcribe → chat → (optional) synthesize
 * 
 * Body: multipart/form-data
 *   - audio: audio file (required)
 *   - model: Ollama model (optional, uses autoRoute if not provided)
 *   - persona: Agent persona (optional)
 *   - conversationId: Continue existing conversation (optional)
 *   - useRag: Enable RAG (optional, default: false)
 *   - tts: Enable TTS response (optional, default: false)
 *   - ttsProvider: 'browser', 'openai', 'local' (optional)
 *   - language: STT language (optional, default: 'en')
 */
router.post('/chat', optionalAuth, upload.single('audio'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'No audio file provided' 
        });
    }
    
    const userId = getUserId(res);
    const {
        model,
        persona = 'default_chat',
        conversationId,
        useRag = 'false',
        tts = 'false',
        ttsProvider = 'browser',
        language = 'en'
    } = req.body;
    
    try {
        // Step 1: Transcribe audio
        logger.info('Voice chat: transcribing...');
        const transcription = await transcribe(req.file.buffer, { language });
        
        if (!transcription.text || transcription.text.trim().length === 0) {
            return res.json({
                status: 'success',
                data: {
                    transcription: '',
                    response: 'I could not understand the audio. Please try again.',
                    sttProvider: transcription.provider
                }
            });
        }
        
        // Step 2: Send to chat
        logger.info('Voice chat: sending to AI...', { text: transcription.text.substring(0, 50) });
        const chatResult = await handleChatRequest({
            userId,
            model: model || null,
            message: transcription.text,
            messages: [],
            options: { persona },
            conversationId: conversationId || null,
            useRag: useRag === 'true',
            ragTopK: 5,
            target: null,
            ragStore,
            autoRoute: !model,  // Auto-route if no model specified
            taskType: null
        });
        
        // Step 3: Optionally synthesize response
        let ttsResult = null;
        if (tts === 'true' && ttsProvider !== 'browser') {
            logger.info('Voice chat: synthesizing response...');
            ttsResult = await synthesize(chatResult.response, { 
                provider: ttsProvider 
            });
        }
        
        // Build response
        const responseData = {
            transcription: transcription.text,
            response: chatResult.response,
            conversationId: chatResult.conversationId,
            messageId: chatResult.messageId,
            model: chatResult.model,
            sttProvider: transcription.provider,
            sttDuration: transcription.duration,
            ragUsed: chatResult.ragUsed
        };
        
        if (ttsResult?.audio) {
            // Return audio response
            res.set({
                'Content-Type': 'audio/mpeg',
                'X-Transcription': encodeURIComponent(transcription.text),
                'X-Response-Text': encodeURIComponent(chatResult.response.substring(0, 500)),
                'X-Conversation-Id': chatResult.conversationId || ''
            });
            res.send(ttsResult.audio);
        } else {
            // Return JSON response
            res.json({
                status: 'success',
                data: responseData
            });
        }
        
    } catch (err) {
        logger.error('Voice chat failed', { error: err.message, stack: err.stack });
        res.status(500).json({ 
            status: 'error', 
            message: err.message 
        });
    }
});

module.exports = router;
