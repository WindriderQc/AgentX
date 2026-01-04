const express = require('express');
const router = express.Router();
const DeepJob = require('../models/DeepJob');
const Conversation = require('../models/Conversation');
const logger = require('../config/logger');

/**
 * Handle n8n callback for Deep Research completion
 * POST /api/n8n/callback/deep-research
 */
router.post('/deep-research', async (req, res) => {
    try {
        const { jobId, result, status, error } = req.body;

        logger.info(`Received deep-research callback for job ${jobId}`, { status });

        if (!jobId) {
            return res.status(400).json({ status: 'error', message: 'jobId is required' });
        }

        const job = await DeepJob.findOne({ jobId });
        if (!job) {
            logger.warn(`DeepJob not found: ${jobId}`);
            return res.status(404).json({ status: 'error', message: 'Job not found' });
        }

        // Update Job
        job.status = status || 'completed';

        if (result) {
            job.result = {
                ...job.result, // Preserve existing structure if partial updates
                ...result
            };
        }

        if (error) {
            job.error = error;
            job.status = 'failed';
        }

        if (job.status === 'completed' || job.status === 'failed') {
            job.completedAt = new Date();
        }

        await job.save();
        logger.info(`DeepJob ${jobId} updated successfully`);

        // Update Conversation to reflect completion
        if (job.status === 'completed' && result && result.finalAnswer) {
            try {
                const conversation = await Conversation.findById(job.conversationId);
                if (conversation && conversation.messages) {
                    const msg = conversation.messages.id(job.messageId);
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
                    } else {
                        logger.warn(`Message ${job.messageId} not found in conversation ${job.conversationId}`);
                    }
                } else {
                    logger.warn(`Conversation ${job.conversationId} not found for job ${jobId}`);
                }
            } catch (convErr) {
                logger.error(`Failed to update conversation for job ${jobId}`, { error: convErr.message });
                // Don't fail the request if conversation update fails, the job is already updated
            }
        }

        res.json({ status: 'success', message: 'Job updated successfully' });

    } catch (err) {
        logger.error('Error in deep-research callback', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
