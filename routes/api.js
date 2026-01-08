const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const { resolveTarget } = require('../src/utils');
const { optionalAuth } = require('../src/middleware/auth');
const { getUserId } = require('../src/helpers/userHelpers');
const logger = require('../config/logger');
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));

// Import Service Logic
const { getRoutingStatus, classifyQuery, HOSTS, MODEL_ROUTING, TASK_MODELS, getModelHealth, getAllModelsHealth } = require('../src/services/modelRouter');

// V3: Import RAG Store
const { getRagStore } = require('../src/services/ragStore');
const ragStore = getRagStore({
  vectorStoreType: process.env.VECTOR_STORE_TYPE || 'memory',
  url: process.env.QDRANT_URL,
  collection: process.env.QDRANT_COLLECTION
});

// PROXY: Models List
router.get('/ollama/models', async (req, res) => {
    const target = req.query.target || process.env.OLLAMA_HOST;
    if (!target) {
        return res.status(500).json({ status: 'error', message: 'OLLAMA_HOST not configured and no target provided' });
    }
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

router.get('/models/health', async (req, res) => {
    try {
        const { host, model } = req.query;

        if (host && model) {
            const health = await getModelHealth(host, model);
            return res.json({ status: 'success', data: { health } });
        }

        const allHealth = await getAllModelsHealth();
        res.json({ status: 'success', data: { models: allHealth } });
    } catch (err) {
        logger.error('Failed to get model health', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// QDRANT HEALTH: Dedicated endpoint for Qdrant vector database health check
router.get('/health/qdrant', async (req, res) => {
    const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
    const VECTOR_STORE_TYPE = process.env.VECTOR_STORE_TYPE;

    if (VECTOR_STORE_TYPE !== 'qdrant') {
        return res.json({
            status: 'not_configured',
            message: 'Qdrant not configured as vector store',
            vectorStoreType: VECTOR_STORE_TYPE || 'memory',
            healthy: false
        });
    }

    try {
        const response = await fetch(`${QDRANT_URL}/healthz`);
        if (response.ok) {
            res.json({
                status: 'connected',
                message: 'Vector database operational',
                url: QDRANT_URL,
                vectorStoreType: VECTOR_STORE_TYPE,
                healthy: true,
                lastCheck: new Date().toISOString()
            });
        } else {
            res.json({
                status: 'error',
                message: `HTTP ${response.status}`,
                url: QDRANT_URL,
                vectorStoreType: VECTOR_STORE_TYPE,
                healthy: false,
                lastCheck: new Date().toISOString()
            });
        }
    } catch (err) {
        logger.error('Qdrant health check failed', { error: err.message, url: QDRANT_URL });
        res.json({
            status: 'error',
            message: err.message,
            url: QDRANT_URL,
            vectorStoreType: VECTOR_STORE_TYPE,
            healthy: false,
            lastCheck: new Date().toISOString()
        });
    }
});

// CHAT: Delegated to chatService
router.post('/chat', optionalAuth, async (req, res) => {
  const { 
    target = process.env.OLLAMA_HOST, 
    model, 
    message, 
    messages = [], 
    system, 
        persona,
    options = {}, 
    conversationId, 
    useRag, 
    ragTopK, 
    ragFilters,
    ragCompress,
    autoRoute = false,  // Enable smart model routing
    taskType = null     // Override task classification (code_generation, deep_reasoning, etc.)
  } = req.body;

  if (!target) {
      return res.status(500).json({ status: 'error', message: 'OLLAMA_HOST not configured and no target provided' });
  }
  const userId = getUserId(res);

  // Model is optional if autoRoute or taskType is enabled
  if (!model && !autoRoute && !taskType) return res.status(400).json({ status: 'error', message: 'Model is required (or enable autoRoute/taskType)' });
  if (!message) return res.status(400).json({ status: 'error', message: 'Message is required' });

  // Merge ragCompress into options
  if (ragCompress !== undefined) {
      options.ragCompress = ragCompress === true;
  }

  try {
        const { handleChatRequest } = require('../src/services/chatService');
    const result = await handleChatRequest({
        userId,
        model,
        message,
        messages,
        system,
            persona,
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

// CHAT STREAMING: SSE endpoint for real-time token streaming
router.post('/chat/stream', optionalAuth, async (req, res) => {
  const {
    target = process.env.OLLAMA_HOST,
    model,
    message,
    messages = [],
    system,
    persona,
    options = {},
    conversationId,
    useRag,
    ragTopK,
    ragFilters,
    ragCompress,
    autoRoute = false,
    taskType = null
  } = req.body;

  if (!target) {
    return res.status(500).json({ status: 'error', message: 'OLLAMA_HOST not configured and no target provided' });
  }
  const userId = getUserId(res);

  if (!model && !autoRoute && !taskType) {
    return res.status(400).json({ status: 'error', message: 'Model is required (or enable autoRoute/taskType)' });
  }
  if (!message) {
    return res.status(400).json({ status: 'error', message: 'Message is required' });
  }

  // Merge ragCompress into options
  if (ragCompress !== undefined) {
      options.ragCompress = ragCompress === true;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering

  // Helper to send SSE event
  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { handleChatRequestStream } = require('../src/services/chatService');

    // Stream handler receives tokens progressively
    await handleChatRequestStream({
      userId,
      model,
      message,
      messages,
      system,
      persona,
      options,
      conversationId,
      useRag,
      ragTopK,
      ragFilters,
      target,
      ragStore,
      autoRoute,
      taskType,
      onToken: (token) => {
        sendEvent('token', { content: token });
      },
      onThinking: (thinking) => {
        sendEvent('thinking', { content: thinking });
      },
      onComplete: (result) => {
        sendEvent('done', result);
        res.end();
      },
      onError: (error) => {
        sendEvent('error', { message: error.message });
        res.end();
      }
    });

  } catch (err) {
    logger.error('Chat streaming error', { error: err.message, stack: err.stack });
    sendEvent('error', { message: err.message });
    res.end();
  }

  // Handle client disconnect
  req.on('close', () => {
    logger.info('Client disconnected from streaming');
  });
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
