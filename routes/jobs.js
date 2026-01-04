const express = require('express');
const router = express.Router();
const DeepJob = require('../models/DeepJob');
const Conversation = require('../models/Conversation');
const logger = require('../config/logger');
const { requireAuth } = require('../src/middleware/auth');

/**
 * Get DeepJob status
 * GET /api/jobs/:jobId
 */
router.get('/:jobId', requireAuth, async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await DeepJob.findOne({ jobId });

        if (!job) {
            return res.status(404).json({ status: 'error', message: 'Job not found' });
        }

        // Security: Check ownership via Conversation
        // If conversation is missing, we might return 404 or just the job if we trust the ID knowledge.
        // Better to check ownership.
        const conversation = await Conversation.findById(job.conversationId);

        if (conversation) {
            const requestUserId = res.locals.user ? res.locals.user.userId : null;
            if (requestUserId && conversation.userId !== requestUserId && requestUserId !== 'admin') {
                 logger.warn(`User ${requestUserId} attempted to access job ${jobId} owned by ${conversation.userId}`);
                 return res.status(403).json({ status: 'error', message: 'Forbidden' });
            }
        }

        res.json({
            status: 'success',
            data: {
                jobId: job.jobId,
                status: job.status,
                result: job.result,
                error: job.error,
                createdAt: job.createdAt,
                completedAt: job.completedAt
            }
        });
    } catch (err) {
        logger.error(`Error fetching job ${req.params.jobId}`, { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
