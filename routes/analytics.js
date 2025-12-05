/**
 * V4 Analytics Routes
 * Provides metrics endpoints for prompt performance tracking
 * Contract: specs/V4_ANALYTICS_ARCHITECTURE.md § 2
 */

const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const { requireAuth } = require('../src/middleware/auth');

/**
 * GET /api/analytics/usage
 * Returns conversation and message counts with optional grouping
 * Query params:
 *   - from (ISO date, default: 7 days ago)
 *   - to (ISO date, default: now)
 *   - groupBy (optional: 'model' | 'promptVersion' | 'day')
 * Response: { totalConversations, totalMessages, breakdown: [...] }
 */
router.get('/usage', requireAuth, async (req, res) => {
  try {
    const { from, to, groupBy } = req.query;

    // Parse date range (default: last 7 days)
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const dateFilter = { createdAt: { $gte: fromDate, $lte: toDate } };

    // Total counts
    const totalConversations = await Conversation.countDocuments(dateFilter);
    
    const messageAgg = await Conversation.aggregate([
      { $match: dateFilter },
      { $project: { messageCount: { $size: '$messages' } } },
      { $group: { _id: null, total: { $sum: '$messageCount' } } }
    ]);
    const totalMessages = messageAgg.length > 0 ? messageAgg[0].total : 0;

    // Optional grouping
    let breakdown = [];
    if (groupBy === 'model') {
      breakdown = await Conversation.aggregate([
        { $match: dateFilter },
        { $group: {
            _id: '$model',
            conversations: { $sum: 1 },
            messages: { $sum: { $size: '$messages' } }
          }
        },
        { $project: {
            _id: 0,
            model: '$_id',
            conversations: 1,
            messages: 1
          }
        },
        { $sort: { conversations: -1 } }
      ]);
    } else if (groupBy === 'promptVersion') {
      breakdown = await Conversation.aggregate([
        { $match: dateFilter },
        { $group: {
            _id: { name: '$promptName', version: '$promptVersion' },
            conversations: { $sum: 1 },
            messages: { $sum: { $size: '$messages' } }
          }
        },
        { $project: {
            _id: 0,
            promptName: '$_id.name',
            promptVersion: '$_id.version',
            conversations: 1,
            messages: 1
          }
        },
        { $sort: { promptVersion: -1 } }
      ]);
    } else if (groupBy === 'day') {
      breakdown = await Conversation.aggregate([
        { $match: dateFilter },
        { $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
            },
            conversations: { $sum: 1 },
            messages: { $sum: { $size: '$messages' } }
          }
        },
        { $project: {
            _id: 0,
            date: '$_id',
            conversations: 1,
            messages: 1
          }
        },
        { $sort: { date: 1 } }
      ]);
    }

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        totalConversations,
        totalMessages,
        breakdown
      }
    });
  } catch (err) {
    console.error('[Analytics Usage] Error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/feedback
 * Returns feedback metrics (positive/negative counts and rates)
 * Query params:
 *   - from (ISO date, default: 7 days ago)
 *   - to (ISO date, default: now)
 *   - groupBy (optional: 'promptVersion' | 'model')
 * Response: { totalFeedback, positive, negative, positiveRate, breakdown: [...] }
 */
router.get('/feedback', requireAuth, async (req, res) => {
  try {
    const { from, to, groupBy } = req.query;

    // Parse date range
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const dateFilter = { createdAt: { $gte: fromDate, $lte: toDate } };

    // Total feedback counts
    const feedbackAgg = await Conversation.aggregate([
      { $match: dateFilter },
      { $unwind: '$messages' },
      { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
      { $group: {
          _id: null,
          total: { $sum: 1 },
          positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
          negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
        }
      }
    ]);

    const totalFeedback = feedbackAgg.length > 0 ? feedbackAgg[0].total : 0;
    const positive = feedbackAgg.length > 0 ? feedbackAgg[0].positive : 0;
    const negative = feedbackAgg.length > 0 ? feedbackAgg[0].negative : 0;
    const positiveRate = totalFeedback > 0 ? positive / totalFeedback : 0;

    // Optional grouping
    let breakdown = [];
    if (groupBy === 'promptVersion') {
      breakdown = await Conversation.aggregate([
        { $match: dateFilter },
        { $unwind: '$messages' },
        { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
        { $group: {
            _id: { name: '$promptName', version: '$promptVersion' },
            total: { $sum: 1 },
            positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
          }
        },
        { $project: {
            _id: 0,
            promptName: '$_id.name',
            promptVersion: '$_id.version',
            total: 1,
            positive: 1,
            negative: 1,
            positiveRate: { $cond: [{ $gt: ['$total', 0] }, { $divide: ['$positive', '$total'] }, 0] }
          }
        },
        { $sort: { promptVersion: -1 } }
      ]);
    } else if (groupBy === 'model') {
      breakdown = await Conversation.aggregate([
        { $match: dateFilter },
        { $unwind: '$messages' },
        { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
        { $group: {
            _id: '$model',
            total: { $sum: 1 },
            positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
          }
        },
        { $project: {
            _id: 0,
            model: '$_id',
            total: 1,
            positive: 1,
            negative: 1,
            positiveRate: { $cond: [{ $gt: ['$total', 0] }, { $divide: ['$positive', '$total'] }, 0] }
          }
        },
        { $sort: { total: -1 } }
      ]);
    }

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        totalFeedback,
        positive,
        negative,
        positiveRate,
        breakdown
      }
    });
  } catch (err) {
    console.error('[Analytics Feedback] Error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/rag-stats
 * Returns RAG usage and performance metrics
 * Query params:
 *   - from (ISO date, default: 7 days ago)
 *   - to (ISO date, default: now)
 * Response: { ragUsageRate, ragPositiveRate, noRagPositiveRate, ... }
 */
router.get('/rag-stats', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;

    // Parse date range
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const dateFilter = { createdAt: { $gte: fromDate, $lte: toDate } };

    // RAG usage counts
    const totalConversations = await Conversation.countDocuments(dateFilter);
    const ragConversations = await Conversation.countDocuments({ ...dateFilter, ragUsed: true });
    const noRagConversations = totalConversations - ragConversations;
    const ragUsageRate = totalConversations > 0 ? ragConversations / totalConversations : 0;

    // Feedback for RAG vs non-RAG conversations
    const ragFeedback = await Conversation.aggregate([
      { $match: { ...dateFilter, ragUsed: true } },
      { $unwind: '$messages' },
      { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
      { $group: {
          _id: null,
          total: { $sum: 1 },
          positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } }
        }
      }
    ]);

    const noRagFeedback = await Conversation.aggregate([
      { $match: { ...dateFilter, ragUsed: { $ne: true } } },
      { $unwind: '$messages' },
      { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
      { $group: {
          _id: null,
          total: { $sum: 1 },
          positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } }
        }
      }
    ]);

    const ragTotal = ragFeedback.length > 0 ? ragFeedback[0].total : 0;
    const ragPositive = ragFeedback.length > 0 ? ragFeedback[0].positive : 0;
    const ragPositiveRate = ragTotal > 0 ? ragPositive / ragTotal : 0;

    const noRagTotal = noRagFeedback.length > 0 ? noRagFeedback[0].total : 0;
    const noRagPositive = noRagFeedback.length > 0 ? noRagFeedback[0].positive : 0;
    const noRagPositiveRate = noRagTotal > 0 ? noRagPositive / noRagTotal : 0;

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        totalConversations,
        ragConversations,
        noRagConversations,
        ragUsageRate,
        feedback: {
          rag: {
            total: ragTotal,
            positive: ragPositive,
            positiveRate: ragPositiveRate
          },
          noRag: {
            total: noRagTotal,
            positive: noRagPositive,
            positiveRate: noRagPositiveRate
          }
        }
      }
    });
  } catch (err) {
    console.error('[Analytics RAG Stats] Error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
