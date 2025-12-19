const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const { getUserId } = require('../src/helpers/userHelpers');
const { optionalAuth } = require('../src/middleware/auth');

// HISTORY: Get list
router.get('/', async (req, res) => {
    try {
        const conversations = await Conversation.find({ userId: 'default' })
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

// HISTORY: Get single
router.get('/:id', async (req, res) => {
    try {
        const conversation = await Conversation.findById(req.params.id);
        if(!conversation) return res.status(404).json({status: 'error', message: 'Not found'});
        res.json({ status: 'success', data: conversation });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Route aliases for backwards compatibility
router.get('/conversations', optionalAuth, async (req, res) => {
    try {
        const userId = getUserId(res);
        const conversations = await Conversation.find({ userId })
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

router.get('/conversations/:id', optionalAuth, async (req, res) => {
    try {
        const userId = getUserId(res);
        const conversation = await Conversation.findById(req.params.id);
        if (!conversation) return res.status(404).json({ status: 'error', message: 'Not found' });
        // Verify user owns this conversation
        if (conversation.userId !== userId && userId !== 'default') {
            return res.status(403).json({ status: 'error', message: 'Access denied' });
        }
        res.json({ status: 'success', data: conversation });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// LOGS - Get latest conversation messages
router.get('/logs', async (req, res) => {
    try {
        const conversation = await Conversation.findOne({ userId: 'default' })
            .sort({ updatedAt: -1 });

        if (!conversation) {
            return res.json({ status: 'success', data: { messages: [] } });
        }
        res.json({ status: 'success', data: { messages: conversation.messages } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
