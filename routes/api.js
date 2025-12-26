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
const { getRoutingStatus, classifyQuery, HOSTS, MODEL_ROUTING, TASK_MODELS } = require('../src/services/modelRouter');

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

// MODEL ROUTING: Get routing configuration and status
router.get('/models/routing', async (req, res) => {
    try {
        const status = await getRoutingStatus();
        res.json({
            status: 'success',
            data: status
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// MODEL ROUTING: Classify a query (preview routing decision)
router.post('/models/classify', async (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ status: 'error', message: 'Message is required' });
    }
    try {
        const classification = await classifyQuery(message);
        const recommendation = TASK_MODELS[classification] || TASK_MODELS.general_chat;
        res.json({
            status: 'success',
            data: {
                taskType: classification,
                recommendedModel: recommendation.model,
                recommendedHost: recommendation.host,
                hostUrl: HOSTS[recommendation.host]
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// CHAT: Delegated to chatService
router.post('/chat', optionalAuth, async (req, res) => {
  const { 
    target = process.env.OLLAMA_HOST || 'localhost:11434', 
    model, 
    message, 
    messages = [], 
    system, 
    options = {}, 
    conversationId, 
    useRag, 
    ragTopK, 
    ragFilters,
    autoRoute = false,  // Enable smart model routing
    taskType = null     // Override task classification (code_generation, deep_reasoning, etc.)
  } = req.body;
  const userId = getUserId(res);

  // Model is optional if autoRoute is enabled
  if (!model && !autoRoute) return res.status(400).json({ status: 'error', message: 'Model is required (or enable autoRoute)' });
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
        ragStore,
        autoRoute,
        taskType
    });

    res.json({
        status: 'success',
        data: result,
        // Top-level fields for backward compatibility or cleaner API response
        model: result.model,
        target: result.target,
        routing: result.routing,
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
