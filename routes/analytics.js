/**
 * V4 Analytics Routes
 * Provides metrics endpoints for prompt performance tracking
 * Contract: specs/V4_ANALYTICS_ARCHITECTURE.md § 2
 */

const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const { requireAuth } = require('../src/middleware/auth');
const logger = require('../config/logger');

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
    // In requireAuth middleware, user is attached to res.locals.user
    
    // Parse date range (default: last 7 days)
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Remove userId filter for now to see all data
    const dateFilter = {
      createdAt: { $gte: fromDate, $lte: toDate }
    };

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
    logger.error('Analytics usage error', { error: err.message, stack: err.stack });
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

    // Remove userId filter for now
    const dateFilter = {
      createdAt: { $gte: fromDate, $lte: toDate }
    };

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
    } else if (groupBy === 'promptAndModel') {
      // Combined grouping: shows performance of each prompt version on each model
      breakdown = await Conversation.aggregate([
        { $match: dateFilter },
        { $unwind: '$messages' },
        { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
        { $group: {
            _id: {
              name: '$promptName',
              version: '$promptVersion',
              model: '$model'
            },
            total: { $sum: 1 },
            positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
          }
        },
        { $project: {
            _id: 0,
            promptName: '$_id.name',
            promptVersion: '$_id.version',
            model: '$_id.model',
            total: 1,
            positive: 1,
            negative: 1,
            positiveRate: { $cond: [{ $gt: ['$total', 0] }, { $divide: ['$positive', '$total'] }, 0] }
          }
        },
        { $sort: { promptName: 1, promptVersion: -1, model: 1 } }
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
    logger.error('Analytics feedback error', { error: err.message, stack: err.stack });
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

    // Remove userId filter for now
    const dateFilter = {
      createdAt: { $gte: fromDate, $lte: toDate }
    };

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
    logger.error('Analytics RAG stats error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/stats
 * Returns aggregated usage and performance statistics
 * Query params:
 *   - from (ISO date, default: 7 days ago)
 *   - to (ISO date, default: now)
 *   - groupBy (optional: 'model', default: 'model')
 * Response: { totalTokens, avgDuration, breakdown: [...] }
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const { from, to, groupBy = 'model' } = req.query;
    const userId = res.locals.user.userId;

    // Parse date range
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const dateFilter = {
      createdAt: { $gte: fromDate, $lte: toDate },
      userId: userId // Ensure user isolation
    };

    // Grouping key selection
    let groupKey = '$model'; // Default to model
    if (groupBy === 'day') {
      groupKey = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
    }

    const statsAgg = await Conversation.aggregate([
      { $match: dateFilter },
      { $unwind: '$messages' },
      // Only assistant messages have generation stats
      { $match: {
          'messages.role': 'assistant',
          'messages.stats': { $exists: true }
        }
      },
      { $group: {
          _id: groupKey,
          messageCount: { $sum: 1 },
          totalPromptTokens: { $sum: '$messages.stats.usage.promptTokens' },
          totalCompletionTokens: { $sum: '$messages.stats.usage.completionTokens' },
          totalTokens: { $sum: '$messages.stats.usage.totalTokens' },
          totalDuration: { $sum: '$messages.stats.performance.totalDuration' }, // nanoseconds
          avgTokensPerSecond: { $avg: '$messages.stats.performance.tokensPerSecond' }
        }
      },
      { $project: {
          _id: 0,
          key: '$_id',
          messageCount: 1,
          usage: {
            promptTokens: '$totalPromptTokens',
            completionTokens: '$totalCompletionTokens',
            totalTokens: '$totalTokens'
          },
          performance: {
            totalDurationSec: { $divide: ['$totalDuration', 1e9] }, // Convert ns to seconds
            avgDurationSec: {
              $cond: [
                { $gt: ['$messageCount', 0] },
                { $divide: [{ $divide: ['$totalDuration', 1e9] }, '$messageCount'] },
                0
              ]
            },
            avgTokensPerSecond: '$avgTokensPerSecond'
          },
          // Cost estimation placeholder (can be expanded with a real price map)
          estimatedCost: { $literal: 0 }
        }
      },
      { $sort: { 'usage.totalTokens': -1 } }
    ]);

    // Calculate global totals
    const totals = statsAgg.reduce((acc, curr) => {
      acc.promptTokens += curr.usage.promptTokens;
      acc.completionTokens += curr.usage.completionTokens;
      acc.totalTokens += curr.usage.totalTokens;
      acc.durationSec += curr.performance.totalDurationSec;
      acc.messages += curr.messageCount;
      return acc;
    }, { promptTokens: 0, completionTokens: 0, totalTokens: 0, durationSec: 0, messages: 0 });

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        totals: {
            ...totals,
            avgDurationSec: totals.messages > 0 ? totals.durationSec / totals.messages : 0
        },
        breakdown: statsAgg
      }
    });
  } catch (err) {
    logger.error('Analytics stats error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/feedback/summary
 * Enhanced feedback aggregation for self-improving loop
 * Returns overall metrics, per-model, per-prompt-version, and low performers
 * Query params:
 *   - from (ISO date, default: 30 days)
 *   - to (ISO date, default: now)
 *   - threshold (number, default: 0.7 - flag prompts below this)
 */
router.get('/feedback/summary', requireAuth, async (req, res) => {
  try {
    const { from, to, threshold = 0.7 } = req.query;
    const userId = res.locals.user.userId;
    const minPositiveRate = parseFloat(threshold);

    // Default to 30 days for summary
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    const dateFilter = {
      createdAt: { $gte: fromDate, $lte: toDate },
      userId: userId
    };

    // Overall feedback metrics
    const overallAgg = await Conversation.aggregate([
      { $match: dateFilter },
      { $unwind: '$messages' },
      { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
      { $group: {
          _id: null,
          totalFeedback: { $sum: 1 },
          positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
          negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
        }
      }
    ]);

    const overall = {
      totalFeedback: overallAgg[0]?.totalFeedback || 0,
      positive: overallAgg[0]?.positive || 0,
      negative: overallAgg[0]?.negative || 0,
      positiveRate: overallAgg[0] ? overallAgg[0].positive / overallAgg[0].totalFeedback : 0
    };

    // By model
    const byModel = await Conversation.aggregate([
      { $match: dateFilter },
      { $unwind: '$messages' },
      { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
      { $group: {
          _id: '$model',
          positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
          negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
        }
      },
      { $project: {
          _id: 0,
          model: '$_id',
          positive: 1,
          negative: 1,
          total: { $add: ['$positive', '$negative'] },
          rate: { $cond: [{ $gt: [{ $add: ['$positive', '$negative'] }, 0] }, 
                          { $divide: ['$positive', { $add: ['$positive', '$negative'] }] }, 0] }
        }
      },
      { $sort: { total: -1 } }
    ]);

    // By prompt version
    const byPromptVersion = await Conversation.aggregate([
      { $match: dateFilter },
      { $unwind: '$messages' },
      { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
      { $group: {
          _id: { name: '$promptName', version: '$promptVersion' },
          positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
          negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
        }
      },
      { $project: {
          _id: 0,
          promptName: '$_id.name',
          promptVersion: '$_id.version',
          positive: 1,
          negative: 1,
          total: { $add: ['$positive', '$negative'] },
          rate: { $cond: [{ $gt: [{ $add: ['$positive', '$negative'] }, 0] }, 
                          { $divide: ['$positive', { $add: ['$positive', '$negative'] }] }, 0] }
        }
      },
      { $sort: { promptName: 1, promptVersion: -1 } }
    ]);

    // Identify low performers (below threshold)
    const lowPerformingPrompts = byPromptVersion.filter(p => p.rate < minPositiveRate && p.total >= 5);

    // A/B comparison: group by promptName and compare versions
    const promptGroups = {};
    byPromptVersion.forEach(p => {
      if (!promptGroups[p.promptName]) promptGroups[p.promptName] = [];
      promptGroups[p.promptName].push(p);
    });

    const abComparisons = Object.entries(promptGroups)
      .filter(([name, versions]) => versions.length > 1)
      .map(([name, versions]) => {
        const sorted = versions.sort((a, b) => b.rate - a.rate);
        return {
          promptName: name,
          bestVersion: sorted[0],
          versions: sorted,
          recommendation: sorted[0].rate > minPositiveRate 
            ? `Keep version ${sorted[0].promptVersion}` 
            : 'All versions underperforming - needs prompt revision'
        };
      });

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        threshold: minPositiveRate,
        overall,
        byModel,
        byPromptVersion,
        lowPerformingPrompts,
        abComparisons
      }
    });
  } catch (err) {
    logger.error('Analytics feedback summary error', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/prompt-metrics
 * Returns prompt performance metrics with model breakdown
 * Optimized for Performance Metrics Dashboard display
 * Query params:
 *   - days (number, default: 7)
 *   - model (string, optional) - Filter by specific model
 * Response: { prompts: [{ name, version, overall, byModel: [...] }] }
 */
router.get('/prompt-metrics', requireAuth, async (req, res) => {
  try {
    const { days = 7, model: filterModel } = req.query;

    // Date range
    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - parseInt(days) * 24 * 60 * 60 * 1000);

    const dateFilter = {
      createdAt: { $gte: fromDate, $lte: toDate }
    };

    // Add model filter if specified
    if (filterModel) {
      dateFilter.model = filterModel;
    }

    // Get all prompt-model combinations with feedback
    const rawData = await Conversation.aggregate([
      { $match: dateFilter },
      { $unwind: '$messages' },
      { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
      { $group: {
          _id: {
            name: '$promptName',
            version: '$promptVersion',
            model: '$model'
          },
          total: { $sum: 1 },
          positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
          negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
        }
      },
      { $project: {
          _id: 0,
          promptName: '$_id.name',
          promptVersion: '$_id.version',
          model: '$_id.model',
          total: 1,
          positive: 1,
          negative: 1,
          positiveRate: { $cond: [{ $gt: ['$total', 0] }, { $divide: ['$positive', '$total'] }, 0] }
        }
      },
      { $sort: { promptName: 1, promptVersion: -1, model: 1 } }
    ]);

    // Group by prompt and calculate overall + per-model breakdown
    const promptMap = {};

    rawData.forEach(item => {
      const key = `${item.promptName}_v${item.promptVersion}`;

      if (!promptMap[key]) {
        promptMap[key] = {
          promptName: item.promptName,
          promptVersion: item.promptVersion,
          overall: {
            total: 0,
            positive: 0,
            negative: 0,
            positiveRate: 0
          },
          byModel: []
        };
      }

      // Aggregate overall stats
      promptMap[key].overall.total += item.total;
      promptMap[key].overall.positive += item.positive;
      promptMap[key].overall.negative += item.negative;

      // Add model-specific data
      promptMap[key].byModel.push({
        model: item.model || 'unknown',
        total: item.total,
        positive: item.positive,
        negative: item.negative,
        positiveRate: item.positiveRate
      });
    });

    // Calculate overall positive rates
    Object.values(promptMap).forEach(prompt => {
      if (prompt.overall.total > 0) {
        prompt.overall.positiveRate = prompt.overall.positive / prompt.overall.total;
      }

      // Sort models by total feedback descending
      prompt.byModel.sort((a, b) => b.total - a.total);
    });

    // Convert to array and sort by prompt name/version
    const prompts = Object.values(promptMap).sort((a, b) => {
      if (a.promptName !== b.promptName) {
        return a.promptName.localeCompare(b.promptName);
      }
      return b.promptVersion - a.promptVersion;
    });

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        days: parseInt(days),
        filterModel: filterModel || null,
        prompts
      }
    });
  } catch (err) {
    logger.error('Analytics prompt metrics error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/trending
 * Get trending data by comparing current period vs previous period
 * Query params:
 *   - days: number of days for current period (default: 7)
 *   - model: filter by specific model (optional)
 */
router.get('/trending', requireAuth, async (req, res) => {
  try {
    const { days = 7, model: filterModel } = req.query;
    const daysNum = parseInt(days);

    // Current period
    const currentTo = new Date();
    const currentFrom = new Date(currentTo.getTime() - daysNum * 24 * 60 * 60 * 1000);

    // Previous period (same duration, ending at currentFrom)
    const previousTo = currentFrom;
    const previousFrom = new Date(previousTo.getTime() - daysNum * 24 * 60 * 60 * 1000);

    // Helper function to get metrics for a time period
    const getMetricsForPeriod = async (fromDate, toDate) => {
      const dateFilter = {
        createdAt: { $gte: fromDate, $lte: toDate }
      };

      if (filterModel) {
        dateFilter.model = filterModel;
      }

      const data = await Conversation.aggregate([
        { $match: dateFilter },
        { $unwind: '$messages' },
        { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
        { $group: {
            _id: {
              name: '$promptName',
              version: '$promptVersion'
            },
            total: { $sum: 1 },
            positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
          }
        }
      ]);

      const metrics = {};
      data.forEach(item => {
        const key = `${item._id.name}_v${item._id.version}`;
        const positiveRate = item.total > 0 ? item.positive / item.total : 0;
        metrics[key] = {
          promptName: item._id.name,
          promptVersion: item._id.version,
          total: item.total,
          positive: item.positive,
          negative: item.negative,
          positiveRate
        };
      });

      return metrics;
    };

    // Get metrics for both periods
    const [currentMetrics, previousMetrics] = await Promise.all([
      getMetricsForPeriod(currentFrom, currentTo),
      getMetricsForPeriod(previousFrom, previousTo)
    ]);

    // Calculate trending for each prompt
    const trending = {};
    const allKeys = new Set([...Object.keys(currentMetrics), ...Object.keys(previousMetrics)]);

    allKeys.forEach(key => {
      const current = currentMetrics[key];
      const previous = previousMetrics[key];

      if (current && previous) {
        // Both periods have data - calculate trend
        const delta = current.positiveRate - previous.positiveRate;
        const percentChange = previous.positiveRate > 0
          ? (delta / previous.positiveRate) * 100
          : 0;

        trending[key] = {
          promptName: current.promptName,
          promptVersion: current.promptVersion,
          current: {
            total: current.total,
            positiveRate: current.positiveRate
          },
          previous: {
            total: previous.total,
            positiveRate: previous.positiveRate
          },
          delta,
          percentChange,
          trend: delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'stable',
          status: delta > 0.05 ? 'improving' : delta < -0.05 ? 'declining' : 'stable'
        };
      } else if (current) {
        // New prompt (no previous data)
        trending[key] = {
          promptName: current.promptName,
          promptVersion: current.promptVersion,
          current: {
            total: current.total,
            positiveRate: current.positiveRate
          },
          previous: null,
          delta: null,
          percentChange: null,
          trend: 'new',
          status: 'new'
        };
      }
    });

    // Convert to array and sort by absolute delta (biggest changes first)
    const trendingArray = Object.values(trending).sort((a, b) => {
      const deltaA = Math.abs(a.delta || 0);
      const deltaB = Math.abs(b.delta || 0);
      return deltaB - deltaA;
    });

    res.json({
      status: 'success',
      data: {
        periods: {
          current: {
            from: currentFrom.toISOString(),
            to: currentTo.toISOString()
          },
          previous: {
            from: previousFrom.toISOString(),
            to: previousTo.toISOString()
          }
        },
        days: daysNum,
        filterModel: filterModel || null,
        trending: trendingArray
      }
    });
  } catch (err) {
    logger.error('Analytics trending error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
