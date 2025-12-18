const express = require('express');
const n8nAuth = require('../src/middleware/n8nAuth');
const { triggerWebhook, triggers } = require('../src/utils/n8nWebhook');
const logger = require('../config/logger');

const router = express.Router();

/**
 * n8n-specific routes for AgentX
 * These routes bypass session-based authentication and use API key authentication instead.
 * All routes in this file are protected by the n8nAuth middleware.
 * 
 * AgentX focuses on AI orchestration events:
 * - RAG document ingestion
 * - Chat session events
 * - Analytics events
 */

/**
 * Diagnostic endpoint for testing n8n connectivity
 * GET /api/n8n/diagnostic
 */
router.get('/diagnostic', n8nAuth, (req, res) => {
  const startTime = Date.now();
  
  res.json({
    status: 'success',
    message: 'n8n diagnostic endpoint responding from AgentX',
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      nodeVersion: process.version
    },
    timing: {
      responseTime: Date.now() - startTime
    },
    timestamp: new Date().toISOString()
  });
});

/**
 * Health check endpoint for n8n
 * GET /api/n8n/health
 */
router.get('/health', n8nAuth, (req, res) => {
  res.json({ 
    status: 'success',
    message: 'AgentX n8n API is healthy',
    timestamp: new Date().toISOString(),
    source: 'agentx'
  });
});

/**
 * Trigger RAG ingestion webhook
 * POST /api/n8n/rag/ingest
 * 
 * Body: {
 *   documents: Array of document metadata,
 *   source: String (data source),
 *   metadata: Object (additional metadata)
 * }
 */
router.post('/rag/ingest', n8nAuth, async (req, res, next) => {
  try {
    const { documents, source, metadata } = req.body;

    if (!documents || !Array.isArray(documents)) {
      return res.status(400).json({
        status: 'error',
        message: 'documents must be an array'
      });
    }

    const ingestData = {
      documentsProcessed: documents.length,
      source: source || 'unknown',
      metadata: metadata || {},
      timestamp: new Date().toISOString()
    };

    const result = await triggers.ragIngest(ingestData);

    if (result.success) {
      return res.json({
        status: 'success',
        message: 'RAG ingestion webhook triggered',
        data: result.data
      });
    } else {
      return res.status(502).json({
        status: 'error',
        message: 'Failed to trigger RAG ingestion webhook',
        error: result.error
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * Trigger chat completion webhook
 * POST /api/n8n/chat/complete
 * 
 * Body: {
 *   sessionId: String,
 *   messages: Number (message count),
 *   model: String (AI model used),
 *   metadata: Object
 * }
 */
router.post('/chat/complete', n8nAuth, async (req, res, next) => {
  try {
    const { sessionId, messages, model, metadata } = req.body;

    const chatData = {
      sessionId: sessionId || 'unknown',
      messages: messages || 0,
      model: model || 'unknown',
      metadata: metadata || {},
      timestamp: new Date().toISOString()
    };

    const result = await triggers.chatComplete(chatData);

    if (result.success) {
      return res.json({
        status: 'success',
        message: 'Chat completion webhook triggered',
        data: result.data
      });
    } else {
      return res.status(502).json({
        status: 'error',
        message: 'Failed to trigger chat completion webhook',
        error: result.error
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * Trigger analytics webhook
 * POST /api/n8n/analytics
 * 
 * Body: {
 *   type: String (event type),
 *   data: Object (analytics data),
 *   userId: String (optional),
 *   metadata: Object
 * }
 */
router.post('/analytics', n8nAuth, async (req, res, next) => {
  try {
    const { type, data, userId, metadata } = req.body;

    if (!type) {
      return res.status(400).json({
        status: 'error',
        message: 'type is required'
      });
    }

    const analyticsData = {
      type,
      data: data || {},
      userId: userId || 'anonymous',
      metadata: metadata || {},
      timestamp: new Date().toISOString()
    };

    const result = await triggers.analytics(analyticsData);

    if (result.success) {
      return res.json({
        status: 'success',
        message: 'Analytics webhook triggered',
        data: result.data
      });
    } else {
      return res.status(502).json({
        status: 'error',
        message: 'Failed to trigger analytics webhook',
        error: result.error
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * Trigger n8n webhook manually
 * POST /api/n8n/trigger/:webhookId
 * 
 * Body: Any JSON payload to send to n8n
 */
router.post('/trigger/:webhookId', n8nAuth, async (req, res, next) => {
  try {
    const { webhookId } = req.params;
    const payload = req.body;

    const result = await triggerWebhook(webhookId, payload);

    if (result.success) {
      return res.json({
        status: 'success',
        message: `Triggered n8n webhook: ${webhookId}`,
        data: result.data
      });
    } else {
      return res.status(502).json({
        status: 'error',
        message: `Failed to trigger n8n webhook: ${webhookId}`,
        error: result.error
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * Trigger predefined event webhooks
 * POST /api/n8n/event/:eventType
 * 
 * Event types: rag_ingest, chat_complete, analytics, custom
 */
router.post('/event/:eventType', n8nAuth, async (req, res, next) => {
  try {
    const { eventType } = req.params;
    const eventData = req.body;

    let result;
    switch (eventType) {
      case 'rag_ingest':
        result = await triggers.ragIngest(eventData);
        break;
      case 'chat_complete':
        result = await triggers.chatComplete(eventData);
        break;
      case 'analytics':
        result = await triggers.analytics(eventData);
        break;
      case 'custom':
        result = await triggers.event(eventData.event, eventData.data);
        break;
      default:
        return res.status(400).json({
          status: 'error',
          message: `Unknown event type: ${eventType}. Valid types: rag_ingest, chat_complete, analytics, custom`
        });
    }

    if (result.success) {
      return res.json({
        status: 'success',
        message: `Triggered ${eventType} webhook`,
        data: result.data
      });
    } else {
      return res.status(502).json({
        status: 'error',
        message: `Failed to trigger ${eventType} webhook`,
        error: result.error
      });
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;
