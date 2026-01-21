const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const Workspace = require('../models/Workspace');
const ConfigVariant = require('../models/ConfigVariant');
const { resolveTarget } = require('../src/utils');
const { optionalAuth } = require('../src/middleware/auth');
const { attachWorkspace } = require('../src/middleware/workspace');
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

// DEBUG: Temporary endpoint to inspect conversation
// SECURITY: Disabled in production, requires authentication
router.get('/debug/conversation/:id', async (req, res) => {
    try {
        // SECURITY: Disable in production
        if (process.env.NODE_ENV === 'production') {
            return res.status(404).json({ error: 'Not found' });
        }

        const mongoose = require('mongoose');

        // SECURITY: Validate ObjectId format
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ error: 'Invalid conversation ID format' });
        }

        // SECURITY: Cast to ObjectId to prevent NoSQL injection
        const conv = await Conversation.findOne({ _id: mongoose.Types.ObjectId(req.params.id) });
        if (!conv) return res.status(404).json({ error: 'Not found' });

        const userId = getUserId(res);
        const workspaceId = req.workspace ? req.workspace._id : null;

        res.json({
            status: 'success',
            conversation: conv,
            context: {
                reqUserId: userId,
                reqWorkspaceId: workspaceId,
                matchUser: conv.userId === userId,
                matchWorkspace: conv.workspaceId?.toString() === workspaceId?.toString()
            }
        });
    } catch (err) {
        logger.error('Debug endpoint error', { error: err.message });
        res.status(500).json({ error: 'Internal server error' });
    }
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
router.post('/chat', optionalAuth, attachWorkspace, async (req, res) => {
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
    taskType = null,    // Override task classification (code_generation, deep_reasoning, etc.)
    agentId = null      // AgentX: Unified agent context
  } = req.body;

  // Defensive fix for workspace context
  if (!req.workspace && req.query.workspace) {
        try {
        const ws = await Workspace.findOne({ slug: req.query.workspace });
        if (ws) req.workspace = ws;
        } catch (e) { /* ignore */ }
  }

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
        taskType,
        workspaceId: req.workspace ? req.workspace._id : null,
        agentId  // AgentX: Pass agent context
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

const decodeStreamPayload = (payload) => {
  if (!payload) return null;
  try {
    const raw = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(raw);
  } catch (err) {
    logger.warn('Failed to decode stream payload', { error: err.message });
    return null;
  }
};

const safeJsonParse = (value, fallback) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    logger.warn('Failed to parse stream query JSON', { error: err.message });
    return fallback;
  }
};

const handleChatStreamRequest = async (req, res, payload) => {
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
  } = payload || {};

  // Debug log for context
  const userId = getUserId(res);
  const workspaceId = req.workspace ? req.workspace._id : null;
  const workspaceSlug = req.workspace ? req.workspace.slug : (req.query.workspace || 'unknown');
  
  logger.info('DEBUG_STREAM: handleChatStreamRequest', { 
    userId, 
    workspaceId,
    workspaceSlug,
    model 
  });

  if (!target) {
    return res.status(500).json({ status: 'error', message: 'OLLAMA_HOST not configured and no target provided' });
  }

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
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const abortController = new AbortController();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
    }
  }, 15000);

  const handleClose = () => {
    clearInterval(heartbeat);
    abortController.abort();
    logger.info('Client disconnected from streaming');
  };

  req.on('close', handleClose);

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
      workspaceId: workspaceId,
      abortSignal: abortController.signal,
      onToken: (token) => {
        sendEvent('token', { content: token });
      },
      onThinking: (thinking) => {
        sendEvent('thinking', { content: thinking });
      },
      onComplete: (result) => {
        if (abortController.signal.aborted) return;
        sendEvent('done', result);
        clearInterval(heartbeat);
        res.end();
      },
      onError: (error) => {
        if (abortController.signal.aborted) return;
        sendEvent('error', { message: error.message });
        clearInterval(heartbeat);
        res.end();
      }
    });

  } catch (err) {
    logger.error('Chat streaming error', { error: err.message, stack: err.stack });
    sendEvent('error', { message: err.message });
    clearInterval(heartbeat);
    res.end();
  }
};

// CHAT STREAMING: SSE endpoint for real-time token streaming
router.post('/chat/stream', optionalAuth, attachWorkspace, async (req, res) => {
    // Defensive fix for workspace context
    if (!req.workspace && req.query.workspace) {
         try {
            const ws = await Workspace.findOne({ slug: req.query.workspace });
            if (ws) req.workspace = ws;
         } catch (e) { /* ignore */ }
    }
  await handleChatStreamRequest(req, res, req.body);
});

router.get('/chat/stream', optionalAuth, attachWorkspace, async (req, res) => {
  logger.info('DEBUG_STREAM: GET request', { 
      workspaceQuery: req.query.workspace, 
      workspaceId: req.workspace ? req.workspace._id : 'missing' 
  });
  
  // Defensive fix: If middleware missed it but query param exists, try to load it
  let workspaceId = req.workspace ? req.workspace._id : null;
  if (!workspaceId && req.query.workspace) {
      try {
          const ws = await Workspace.findOne({ slug: req.query.workspace });
          if (ws) {
              workspaceId = ws._id;
              req.workspace = ws; // Attach for downstream use
              logger.info('DEBUG_STREAM: Manually loaded workspace', { slug: req.query.workspace, id: ws._id });
          }
      } catch (err) {
          logger.error('DEBUG_STREAM: Failed to manually load workspace', { error: err.message });
      }
  }

  const payload = decodeStreamPayload(req.query.payload) || {
    target: req.query.target,
    model: req.query.model,
    message: req.query.message,
    messages: safeJsonParse(req.query.messages, []),
    system: req.query.system,
    persona: req.query.persona,
    options: safeJsonParse(req.query.options, {}),
    conversationId: req.query.conversationId,
    useRag: req.query.useRag === 'true',
    ragTopK: req.query.ragTopK ? parseInt(req.query.ragTopK, 10) : undefined,
    ragFilters: safeJsonParse(req.query.ragFilters, undefined),
    ragCompress: req.query.ragCompress === 'true',
    autoRoute: req.query.autoRoute === 'true',
    taskType: req.query.taskType
  };

  await handleChatStreamRequest(req, res, payload);
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

// Config Variants - Get all config presets
router.get('/config-variants', async (req, res) => {
    try {
        const variants = await ConfigVariant.find()
            .sort({ isSystem: -1, name: 1 }); // System configs first, then alphabetically

        res.json({
            status: 'success',
            data: {
                variants,
                count: variants.length
            }
        });
    } catch (err) {
        logger.error('Failed to fetch config variants', { error: err.message });
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
});

// Config Variants - Get specific config by ID
router.get('/config-variants/:id', async (req, res) => {
    try {
        const variant = await ConfigVariant.findById(req.params.id);

        if (!variant) {
            return res.status(404).json({
                status: 'error',
                message: 'Config variant not found'
            });
        }

        res.json({
            status: 'success',
            data: { variant }
        });
    } catch (err) {
        logger.error('Failed to fetch config variant', { error: err.message, id: req.params.id });
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
});

module.exports = router;
