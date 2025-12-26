const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const { resolveTarget } = require('../src/utils');
const { optionalAuth } = require('../src/middleware/auth');
const { getUserId } = require('../src/helpers/userHelpers');
const logger = require('../config/logger');
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));

// Import Service Logic
const { handleChatRequest } = require('../src/services/chatService');

// V3: Import RAG Store
const { getRagStore } = require('../src/services/ragStore');
const ragStore = getRagStore({
  vectorStoreType: process.env.VECTOR_STORE_TYPE || 'memory',
  url: process.env.QDRANT_URL,
  collection: process.env.QDRANT_COLLECTION
});

// PROXY: Models List
router.get('/ollama/models', async (req, res) => {
    const target = req.query.target || process.env.OLLAMA_HOST || 'localhost:11434';
    try {
        const url = `${resolveTarget(target)}/api/tags`;
        const response = await fetch(url);
        const data = await response.json();
        const models = Array.isArray(data?.models)
            ? data.models.map((model) => ({
                name: model.name,
                size: model.size,
                modified_at: model.modified_at,
            }))
            : [];
        res.json({ status: 'success', data: models });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// CHAT: Delegated to chatService
router.post('/chat', optionalAuth, async (req, res) => {
  const { target = process.env.OLLAMA_HOST || 'localhost:11434', model, message, messages = [], system, options = {}, conversationId, useRag, ragTopK, ragFilters } = req.body;
  const userId = getUserId(res);

  if (!model) return res.status(400).json({ status: 'error', message: 'Model is required' });
  if (!message) return res.status(400).json({ status: 'error', message: 'Message is required' });

  try {
    const result = await handleChatRequest({
        userId,
        model,
        message,
        messages,
        system,
        options,
        conversationId,
        useRag,
        ragTopK,
        ragFilters,
        target,
        ragStore
    });

    res.json({
        status: 'success',
        data: result,
        // Top-level fields for backward compatibility or cleaner API response
        ragUsed: result.ragUsed,
        ragSources: result.ragSources,
        warning: result.warning
    });

  } catch (err) {
    logger.error('Chat error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// FEEDBACK
router.post('/feedback', async (req, res) => {
    const { conversationId, messageId, rating, comment } = req.body;
    try {
        let conversation;
        
        if (conversationId) {
            conversation = await Conversation.findById(conversationId);
        } else if (messageId) {
            conversation = await Conversation.findOne({ 'messages._id': messageId });
        }
        
        if (!conversation) return res.status(404).json({ status: 'error', message: 'Conversation not found' });

        const msg = conversation.messages.id(messageId);
        if (!msg) return res.status(404).json({ status: 'error', message: 'Message not found' });

        msg.feedback = { rating, comment };
        await conversation.save();

        res.json({ status: 'success', message: 'Feedback saved' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
