const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const logger = require('../config/logger');

/**
 * Handle n8n callback for Deep Research completion
 * POST /api/n8n/callback/deep-research
 */
router.post('/deep-research', async (req, res) => {
    try {
        // Validate API Key
        const apiKey = req.header('x-api-key');
        const expectedKey = process.env.N8N_CALLBACK_API_KEY;

        // Strict validation: Env var must be set, and key must match
        if (!expectedKey || apiKey !== expectedKey) {
            logger.warn('Unauthorized callback attempt', { ip: req.ip });
            return res.status(401).json({ status: 'error', message: 'Unauthorized' });
        }

        const { conversationId, messageId, result, status, error } = req.body;

        logger.info(`Received deep-research callback`, { conversationId, status });

        if (!conversationId || !messageId) {
            return res.status(400).json({ status: 'error', message: 'conversationId and messageId are required' });
        }

        if (status === 'completed' && result && result.finalAnswer) {
            const conversation = await Conversation.findById(conversationId);
            if (conversation && conversation.messages) {
                const msg = conversation.messages.id(messageId);
                if (msg) {
                    // Append result to the message content
                    msg.content += `\n\n--- 🧠 Deep Research Result ---\n${result.finalAnswer}`;

                    // Update metadata
                    msg.metadata = msg.metadata || {};
                    msg.metadata.deepJobStatus = 'completed';
                    if (result.evidence) {
                        msg.metadata.deepResearchEvidence = result.evidence;
                    }

                    conversation.markModified('messages');
                    await conversation.save();
                    logger.info(`Conversation ${conversation._id} updated with research results.`);
                    return res.json({ status: 'success', message: 'Conversation updated' });
                } else {
                    logger.warn(`Message ${messageId} not found in conversation ${conversationId}`);
                    return res.status(404).json({ status: 'error', message: 'Message not found' });
                }
            } else {
                logger.warn(`Conversation ${conversationId} not found`);
                return res.status(404).json({ status: 'error', message: 'Conversation not found' });
            }
        }

        res.json({ status: 'success', message: 'Callback received (no update needed)' });

    } catch (err) {
        logger.error('Error in deep-research callback', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
