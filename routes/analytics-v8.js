'use strict';
/**
 * Analytics — V8 Usage & Compression Routes
 *
 * Sub-router mounted at root by routes/analytics.js.
 * All paths are relative to /api/analytics.
 *
 * Routes:
 *   GET /usage/summary           — total usage summary
 *   GET /usage/by-model          — usage breakdown by model
 *   GET /usage/daily             — daily usage trend
 *   GET /usage/top-conversations — most expensive conversations
 *   GET /compression             — RAG contextual compression stats
 */

const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const { getUsageAnalytics } = require('../src/services/usageAnalyticsService');
const { optionalAuth } = require('../src/middleware/auth');
const { optionalWorkspaceContext } = require('../src/middleware/workspace');
const logger = require('../config/logger');

// ── Helpers ───────────────────────────────────────────────────────────────

function parsePeriod(period) {
  const endDate = new Date();
  let startDate;
  if (period === '7d') {
    startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === '30d') {
    startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else if (period === '90d') {
    startDate = new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000);
  } else {
    startDate = new Date(0); // All time
  }
  return { startDate, endDate };
}

function getUserId(res) {
  return res.locals.user ? res.locals.user.userId : null;
}

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * GET /api/analytics/usage/summary
 * Total conversations, messages, tokens, cost
 */
router.get('/usage/summary', optionalAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const userId = getUserId(res);
    const workspaceId = req.workspace ? req.workspace._id : null;
    const { startDate, endDate } = parsePeriod(req.query.period);

    const analytics = getUsageAnalytics();
    const result = await analytics.getUsageSummary(userId, workspaceId, startDate, endDate);

    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('Failed to get usage summary', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/usage/by-model
 * Usage breakdown by model
 */
router.get('/usage/by-model', optionalAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const userId = getUserId(res);
    const workspaceId = req.workspace ? req.workspace._id : null;
    const { startDate, endDate } = parsePeriod(req.query.period);

    const analytics = getUsageAnalytics();
    const result = await analytics.getUsageByModel(userId, workspaceId, startDate, endDate);

    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('Failed to get model usage', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/usage/daily
 * Daily usage trend
 */
router.get('/usage/daily', optionalAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const userId = getUserId(res);
    const workspaceId = req.workspace ? req.workspace._id : null;
    const days = parseInt(req.query.days || '30', 10);

    const analytics = getUsageAnalytics();
    const result = await analytics.getDailyUsage(userId, workspaceId, days);

    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('Failed to get daily usage', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/usage/top-conversations
 * Most expensive conversations
 */
router.get('/usage/top-conversations', optionalAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const userId = getUserId(res);
    const workspaceId = req.workspace ? req.workspace._id : null;
    const limit = parseInt(req.query.limit || '10', 10);

    const analytics = getUsageAnalytics();
    const result = await analytics.getTopConversations(userId, workspaceId, limit);

    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('Failed to get top conversations', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/compression
 * RAG Contextual Compression Stats
 */
router.get('/compression', optionalAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const userId = getUserId(res);
    const workspaceId = req.workspace ? req.workspace._id : null;
    const { startDate, endDate } = parsePeriod(req.query.period);

    const match = { createdAt: { $gte: startDate, $lte: endDate } };
    if (userId) match.userId = userId;
    if (workspaceId) match.workspaceId = workspaceId;

    const stats = await Conversation.aggregate([
      { $match: match },
      { $unwind: '$messages' },
      { $unwind: '$messages.ragSources' },
      { $match: { 'messages.ragSources.wasCompressed': true } },
      {
        $group: {
          _id: null,
          totalCompressedChunks: { $sum: 1 },
          avgCompressionRatio: { $avg: '$messages.ragSources.compressionRatio' }
        }
      }
    ]);

    const result = stats.length > 0
      ? stats[0]
      : { totalCompressedChunks: 0, avgCompressionRatio: 0 };

    // Estimate tokens: 4 chars/token, avg chunk ~500 chars
    const estimatedOriginalChars = result.totalCompressedChunks * 500;
    const savedChars = estimatedOriginalChars * (result.avgCompressionRatio / 100);
    const savedTokens = Math.round(savedChars / 4);

    res.json({
      status: 'success',
      data: {
        totalCompressedChunks: result.totalCompressedChunks,
        avgCompressionRatio: parseFloat((result.avgCompressionRatio || 0).toFixed(1)),
        totalTokenSavings: savedTokens
      }
    });
  } catch (err) {
    logger.error('Failed to get compression stats', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
