/**
 * V4 Dataset Routes
 * Provides conversation exports and prompt creation for n8n workflows
 * Contract: specs/V4_ANALYTICS_ARCHITECTURE.md § 3
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const PromptConfig = require('../models/PromptConfig');
const { apiKeyAuth } = require('../src/middleware/auth');
const logger = require('../config/logger');
const { requireAuth } = require('../src/middleware/auth');

/**
 * GET /api/dataset/conversations
 * Export conversations for training/evaluation datasets
 * Query params:
 *   - limit (number, default: 50, max: 500)
 *   - cursor (conversationId for pagination)
 *   - minFeedback (1 = positive only, -1 = negative only, 0 = any feedback)
 *   - promptName (string, filter by prompt name)
 *   - promptVersion (number, filter by specific version)
 *   - model (string, filter by model)
 * Response: { data: [...conversations], nextCursor: <id> | null }
 */
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    const {
      limit = 50,
      cursor,
      minFeedback,
      promptName,
      promptVersion,
      model
    } = req.query;

    // Parse and validate limit (clamp to positive integers, max 500)
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);

    // Build filter
    const filter = {};

    // Validate cursor as ObjectId before using in query
    if (cursor) {
      if (!mongoose.Types.ObjectId.isValid(cursor)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid cursor format. Must be a valid ObjectId.'
        });
      }
      filter._id = { $gt: new mongoose.Types.ObjectId(cursor) };
    }

    if (minFeedback !== undefined) {
      const rating = parseInt(minFeedback, 10);
      if (rating === 1 || rating === -1) {
        filter['messages.feedback.rating'] = rating;
      } else if (rating === 0) {
        filter['messages.feedback.rating'] = { $exists: true };
      }
    }

    // Filter by prompt name
    if (promptName) {
      filter.promptName = promptName;
    }

    // Only apply promptVersion filter if it parses to a valid integer
    if (promptVersion !== undefined) {
      const parsedVersion = parseInt(promptVersion, 10);
      if (!isNaN(parsedVersion)) {
        filter.promptVersion = parsedVersion;
      }
    }

    if (model) {
      filter.model = model;
    }

    // Fetch conversations
    const conversations = await Conversation.find(filter)
      .sort({ _id: 1 })
      .limit(parsedLimit + 1)
      .lean();

    // Check if there's a next page
    const hasMore = conversations.length > parsedLimit;
    const results = hasMore ? conversations.slice(0, parsedLimit) : conversations;
    const nextCursor = hasMore ? results[results.length - 1]._id.toString() : null;

    // Transform to dataset format
    const dataset = results.map(conv => {
      // Extract first user message as input
      const firstUserMsg = conv.messages.find(m => m.role === 'user');
      const input = firstUserMsg ? firstUserMsg.content : '';

      // Extract first assistant message as output
      const firstAssistantMsg = conv.messages.find(m => m.role === 'assistant');
      const output = firstAssistantMsg ? firstAssistantMsg.content : '';

      // Aggregate feedback from all messages
      const feedbackMessages = conv.messages.filter(m => m.feedback && m.feedback.rating);
      const feedback = feedbackMessages.length > 0 ? feedbackMessages[0].feedback : null;

      return {
        id: conv._id,
        model: conv.model,
        promptName: conv.promptName,
        promptVersion: conv.promptVersion,
        ragUsed: conv.ragUsed || false,
        input,
        output,
        feedback: feedback ? {
          rating: feedback.rating,
          comment: feedback.comment || null,
          timestamp: feedback.timestamp
        } : null,
        metadata: {
          conversationLength: conv.messages.length,
          createdAt: conv.createdAt,
          ragSourceCount: conv.ragSources ? conv.ragSources.length : 0
        }
      };
    });

    res.json({
      status: 'success',
      data: dataset,
      nextCursor
    });
  } catch (err) {
    logger.error('Dataset conversations error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/dataset/prompts
 * Create new prompt configuration (typically from n8n auto-generation)
 * Body:
 *   - name (string, e.g., "default_chat")
 *   - version (number, incremental)
 *   - systemPrompt (string, the prompt text)
 *   - description (string, reason for this version)
 *   - status (optional, default: 'proposed')
 *   - author (optional, default: 'n8n')
 * Response: { data: <created PromptConfig> }
 */
router.post('/prompts', requireAuth, async (req, res) => {
  try {
    const {
      name,
      version,
      systemPrompt,
      description,
      status = 'proposed',
      author = 'n8n'
    } = req.body;

    // Validation
    if (!name || !version || !systemPrompt) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: name, version, systemPrompt'
      });
    }

    // Check if this version already exists
    const existing = await PromptConfig.findOne({ name, version });
    if (existing) {
      return res.status(409).json({
        status: 'error',
        message: `Prompt ${name} v${version} already exists`
      });
    }

    // Create new prompt config
    const promptConfig = new PromptConfig({
      name,
      version,
      systemPrompt,
      description: description || `Auto-generated version ${version}`,
      status,
      author
    });

    await promptConfig.save();

    res.json({
      status: 'success',
      data: promptConfig
    });
  } catch (err) {
    logger.error('Dataset prompts error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/dataset/prompts
 * List all prompt configurations with optional filtering
 * Query params:
 *   - name (string, filter by prompt name)
 *   - status (string, filter by status: 'active', 'deprecated', 'proposed')
 * Response: { data: [...prompts] }
 */
router.get('/prompts', requireAuth, async (req, res) => {
  try {
    const { name, status } = req.query;

    const filter = {};
    if (name) filter.name = name;
    if (status) filter.status = status;

    const prompts = await PromptConfig.find(filter)
      .sort({ name: 1, version: -1 })
      .lean();

    res.json({
      status: 'success',
      data: prompts
    });
  } catch (err) {
    logger.error('Dataset prompts list error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * PATCH /api/dataset/prompts/:id/activate
 * Activate a prompt configuration (sets status='active', deprecates others)
 * Response: { data: <activated PromptConfig> }
 * Auth: Required - prevents unauthorized prompt version changes
 */
router.patch('/prompts/:id/activate', apiKeyAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const activatedPrompt = await PromptConfig.activate(id);

    res.json({
      status: 'success',
      data: activatedPrompt
    });
  } catch (err) {
    logger.error('Dataset prompts activate error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
