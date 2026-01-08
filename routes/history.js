const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const { getUserId } = require('../src/helpers/userHelpers');
const { optionalAuth } = require('../src/middleware/auth');
const { attachWorkspace } = require('../src/middleware/workspace');
const conversationSearchService = require('../src/services/conversationSearchService');
const logger = require('../config/logger');

// HISTORY: Get list (workspace-aware)
router.get('/', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        const userId = getUserId(res);
        const query = { userId };

        // Week 4: Multi-tenancy - Filter by workspace if available
        if (req.workspace) {
            query.workspaceId = req.workspace._id;
        }

        const conversations = await Conversation.find(query)
            .sort({ updatedAt: -1 })
            .limit(50)
            .select('title updatedAt model messages');

        // Transform for frontend preview
        const previews = conversations.map(c => ({
            id: c._id,
            title: c.title,
            date: c.updatedAt,
            model: c.model,
            preview: c.messages[c.messages.length - 1]?.content.substring(0, 60) + '...'
        }));

        res.json({ status: 'success', data: previews });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// HISTORY: Get single (workspace-aware)
router.get('/:id', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        const mongoose = require('mongoose');

        // Validate ObjectId format first
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ status: 'error', message: 'Invalid conversation ID format' });
        }

        const userId = getUserId(res);

        // Build query with security filters FIRST
        const query = { _id: req.params.id, userId };

        // Add workspace filter if in workspace context
        if (req.workspace) {
            query.workspaceId = req.workspace._id;
        }

        const conversation = await Conversation.findOne(query);

        if (!conversation) {
            return res.status(404).json({ status: 'error', message: 'Conversation not found' });
        }

        res.json({ status: 'success', data: conversation });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Route aliases for backwards compatibility (workspace-aware)
router.get('/conversations', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        const userId = getUserId(res);
        const query = { userId };

        // Week 4: Multi-tenancy - Filter by workspace if available
        if (req.workspace) {
            query.workspaceId = req.workspace._id;
        }

        const conversations = await Conversation.find(query)
            .sort({ updatedAt: -1 })
            .limit(50)
            .select('title updatedAt model messages');

        const previews = conversations.map(c => ({
            id: c._id,
            title: c.title,
            date: c.updatedAt,
            model: c.model,
            messageCount: c.messages.length
        }));

        res.json({ status: 'success', data: previews });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/conversations/:id', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        const mongoose = require('mongoose');

        // Validate ObjectId format first
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ status: 'error', message: 'Invalid conversation ID format' });
        }

        const userId = getUserId(res);

        // Build query with security filters FIRST
        const query = { _id: req.params.id, userId };

        // Add workspace filter if in workspace context
        if (req.workspace) {
            query.workspaceId = req.workspace._id;
        }

        const conversation = await Conversation.findOne(query);

        if (!conversation) {
            return res.status(404).json({ status: 'error', message: 'Conversation not found' });
        }

        res.json({ status: 'success', data: conversation });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// LOGS - Get latest conversation messages (workspace-aware)
router.get('/logs', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        const userId = getUserId(res);
        const query = { userId };

        // Week 4: Multi-tenancy - Filter by workspace if available
        if (req.workspace) {
            query.workspaceId = req.workspace._id;
        }

        const conversation = await Conversation.findOne(query)
            .sort({ updatedAt: -1 });

        if (!conversation) {
            return res.json({ status: 'success', data: { messages: [] } });
        }

        res.json({ status: 'success', data: { messages: conversation.messages } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ============================================================================
// V7: SEARCH & TAG MANAGEMENT ENDPOINTS (2026-01-08)
// ============================================================================

/**
 * SEARCH: Advanced conversation search with filtering
 * GET /api/history/search
 *
 * Query Parameters:
 * - q: Search query (full-text)
 * - models: Comma-separated model names
 * - dateFrom: ISO 8601 date string
 * - dateTo: ISO 8601 date string
 * - ragOnly: 'true' to filter conversations with RAG
 * - feedbackRating: 1, -1, or 0
 * - tags: Comma-separated tag names
 * - sortBy: 'relevance', 'date_desc', 'date_asc', 'model', 'feedback', 'messages'
 * - page: Page number (default: 1)
 * - limit: Results per page (default: 20, max: 100)
 */
router.get('/search', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        const userId = getUserId(res);

        // Parse query parameters
        const {
            q: query,
            models,
            dateFrom,
            dateTo,
            ragOnly,
            feedbackRating,
            tags,
            sortBy = 'relevance',
            page = '1',
            limit = '20'
        } = req.query;

        // Parse arrays from comma-separated strings
        const modelArray = models ? models.split(',').map(m => m.trim()).filter(m => m) : [];
        const tagArray = tags ? tags.split(',').map(t => t.trim()).filter(t => t) : [];

        // Parse numeric values
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
        const feedbackNum = feedbackRating !== undefined ? parseInt(feedbackRating, 10) : undefined;

        // Parse boolean
        const ragOnlyBool = ragOnly === 'true';

        // Build search options
        const searchOptions = {
            userId,
            workspaceId: req.workspace?._id,
            query,
            models: modelArray,
            dateFrom,
            dateTo,
            ragOnly: ragOnlyBool,
            feedbackRating: feedbackNum,
            tags: tagArray,
            sortBy,
            page: pageNum,
            limit: limitNum
        };

        // Execute search
        const result = await conversationSearchService.searchConversations(searchOptions);

        logger.info('Conversation search executed', {
            userId,
            workspaceId: req.workspace?._id,
            query,
            resultsCount: result.data.results.length,
            totalResults: result.data.pagination.totalResults
        });

        res.json(result);

    } catch (err) {
        logger.error('Conversation search failed', {
            error: err.message,
            userId: getUserId(res),
            query: req.query
        });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * TAGS: Add tags to a conversation
 * POST /api/history/:id/tags
 *
 * Body:
 * - tags: Array of tag strings
 */
router.post('/:id/tags', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        const mongoose = require('mongoose');

        // Validate ObjectId format
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ status: 'error', message: 'Invalid conversation ID format' });
        }

        const userId = getUserId(res);
        const { tags } = req.body;

        // Validate input
        if (!tags || !Array.isArray(tags) || tags.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: 'Tags array is required and must not be empty'
            });
        }

        // Add tags
        const result = await conversationSearchService.addTagsToConversation({
            conversationId: req.params.id,
            userId,
            workspaceId: req.workspace?._id,
            tags
        });

        res.json(result);

    } catch (err) {
        logger.error('Failed to add tags', {
            error: err.message,
            conversationId: req.params.id,
            userId: getUserId(res)
        });

        if (err.message.includes('not found') || err.message.includes('access denied')) {
            return res.status(404).json({ status: 'error', message: err.message });
        }

        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * TAGS: Remove tags from a conversation
 * DELETE /api/history/:id/tags
 *
 * Body:
 * - tags: Array of tag strings to remove
 */
router.delete('/:id/tags', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        const mongoose = require('mongoose');

        // Validate ObjectId format
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ status: 'error', message: 'Invalid conversation ID format' });
        }

        const userId = getUserId(res);
        const { tags } = req.body;

        // Validate input
        if (!tags || !Array.isArray(tags) || tags.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: 'Tags array is required and must not be empty'
            });
        }

        // Remove tags
        const result = await conversationSearchService.removeTagsFromConversation({
            conversationId: req.params.id,
            userId,
            workspaceId: req.workspace?._id,
            tags
        });

        res.json(result);

    } catch (err) {
        logger.error('Failed to remove tags', {
            error: err.message,
            conversationId: req.params.id,
            userId: getUserId(res)
        });

        if (err.message.includes('not found') || err.message.includes('access denied')) {
            return res.status(404).json({ status: 'error', message: err.message });
        }

        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * TAGS: Get all user tags (for autocomplete)
 * GET /api/history/tags
 *
 * Query Parameters:
 * - prefix: Filter tags by prefix (for autocomplete)
 * - limit: Max tags to return (default: 50)
 */
router.get('/tags', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        const userId = getUserId(res);
        const { prefix, limit = '50' } = req.query;

        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));

        const result = await conversationSearchService.getUserTags({
            userId,
            workspaceId: req.workspace?._id,
            prefix,
            limit: limitNum
        });

        res.json(result);

    } catch (err) {
        logger.error('Failed to get user tags', {
            error: err.message,
            userId: getUserId(res)
        });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
