'use strict';
/**
 * Chat-lane cost analytics: GET /api/analytics/costs.
 * Mounted by routes/analytics.js.
 */

const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const logger = require('../config/logger');
const { activeMessageStages, parseAnalyticsRange } = require('../src/services/conversationActivityAnalytics');
const { rankingSignal, serializeSignal } = require('../../shared/signalEvidence');

// Same freshness contract as the rest of the chat lane (routes/analytics.js).
const CHAT_LANE_TTL_MS = 5 * 60 * 1000;

/**
 * GET /api/analytics/costs
 * Dedicated cost analytics endpoint with flexible grouping
 * Query params:
 *   - from (ISO date, default: 7 days ago)
 *   - to (ISO date, default: now)
 *   - groupBy (optional: 'model' | 'day' | 'promptVersion', default: 'model')
 *   - minCost (number, default: 0) - Filter out entries below this cost
 * Response: { summary: {...}, breakdown: [...] }
 */
router.get('/costs', async (req, res) => {
  try {
    const { from, to, groupBy = 'model' } = req.query;
    const minCost = Number.isFinite(parseFloat(req.query.minCost)) ? Math.max(0, parseFloat(req.query.minCost)) : 0;

    // Parse date range
    const range = parseAnalyticsRange({ from, to });
    if (range.error) return res.status(400).json({ status: 'error', message: range.error });
    const { fromDate, toDate } = range;

    // Determine grouping key
    let groupKey;
    if (groupBy === 'day') {
      // Day of the message, not of the conversation's first turn.
      groupKey = { $dateToString: { format: '%Y-%m-%d', date: { $ifNull: ['$messages.timestamp', '$messages.createdAt'] } } };
    } else if (groupBy === 'promptVersion') {
      groupKey = { name: '$promptName', version: '$promptVersion' };
    } else {
      groupKey = '$model';
    }

    // Aggregate cost data
    // Assistant messages observed in the window: a long conversation started
    // before the window still counts its in-window spend.
    const costAgg = await Conversation.aggregate([
      ...activeMessageStages(fromDate, toDate),
      { $match: { 'messages.role': 'assistant' } },
      { $group: {
          _id: groupKey,
          messageCount: { $sum: 1 },
          conversationCount: { $addToSet: '$_id' },
          totalPromptTokens: { $sum: { $ifNull: ['$messages.stats.usage.promptTokens', 0] } },
          totalCompletionTokens: { $sum: { $ifNull: ['$messages.stats.usage.completionTokens', 0] } },
          totalTokens: { $sum: { $ifNull: ['$messages.stats.usage.totalTokens', 0] } },
          totalCost: { $sum: '$messages.cost.totalCost' },
          promptTokenCost: { $sum: { $ifNull: ['$messages.cost.promptTokenCost', 0] } },
          completionTokenCost: { $sum: { $ifNull: ['$messages.cost.completionTokenCost', 0] } }
        }
      },
      { $project: {
          _id: 0,
          key: '$_id',
          messageCount: 1,
          conversationCount: { $size: '$conversationCount' },
          tokens: {
            prompt: '$totalPromptTokens',
            completion: '$totalCompletionTokens',
            total: '$totalTokens'
          },
          cost: {
            total: '$totalCost',
            prompt: '$promptTokenCost',
            completion: '$completionTokenCost',
            avgPerMessage: {
              $cond: [
                { $gt: ['$messageCount', 0] },
                { $divide: ['$totalCost', '$messageCount'] },
                0
              ]
            },
            avgPerConversation: {
              $cond: [
                { $gt: [{ $size: '$conversationCount' }, 0] },
                { $divide: ['$totalCost', { $size: '$conversationCount' }] },
                0
              ]
            },
            per1kTokens: {
              $cond: [
                { $gt: ['$totalTokens', 0] },
                { $divide: ['$totalCost', { $divide: ['$totalTokens', 1000] }] },
                0
              ]
            }
          }
        }
      },
      { $match: { 'cost.total': { $gte: minCost } } },
      { $sort: { 'cost.total': -1 } }
    ]);

    // Calculate summary statistics
    const summary = costAgg.reduce((acc, curr) => {
      acc.totalCost += curr.cost.total;
      acc.totalMessages += curr.messageCount;
      acc.totalConversations += curr.conversationCount;
      acc.totalTokens += curr.tokens.total;
      acc.promptTokenCost += curr.cost.prompt;
      acc.completionTokenCost += curr.cost.completion;
      return acc;
    }, {
      totalCost: 0,
      totalMessages: 0,
      totalConversations: 0,
      totalTokens: 0,
      promptTokenCost: 0,
      completionTokenCost: 0
    });

    // Calculate averages
    summary.avgCostPerMessage = summary.totalMessages > 0
      ? summary.totalCost / summary.totalMessages
      : 0;
    summary.avgCostPerConversation = summary.totalConversations > 0
      ? summary.totalCost / summary.totalConversations
      : 0;
    summary.costPer1kTokens = summary.totalTokens > 0
      ? summary.totalCost / (summary.totalTokens / 1000)
      : 0;

    // Format all cost values to 6 decimal places
    const formatCost = (cost) => parseFloat((cost || 0).toFixed(6));

    summary.totalCost = formatCost(summary.totalCost);
    summary.promptTokenCost = formatCost(summary.promptTokenCost);
    summary.completionTokenCost = formatCost(summary.completionTokenCost);
    summary.avgCostPerMessage = formatCost(summary.avgCostPerMessage);
    summary.avgCostPerConversation = formatCost(summary.avgCostPerConversation);
    summary.costPer1kTokens = formatCost(summary.costPer1kTokens);

    // Format breakdown items. A row is `priced` only when it carries a real
    // cost over real tokens; local models have no per-token price and must
    // never be ranked as the cheapest just because their cost is 0.
    const formattedBreakdown = costAgg.map(item => ({
      ...item,
      priced: (item.cost?.total || 0) > 0 && (item.tokens?.total || 0) > 0,
      cost: {
        ...item.cost,
        total: formatCost(item.cost.total),
        prompt: formatCost(item.cost.prompt),
        completion: formatCost(item.cost.completion),
        avgPerMessage: formatCost(item.cost.avgPerMessage),
        avgPerConversation: formatCost(item.cost.avgPerConversation),
        per1kTokens: formatCost(item.cost.per1kTokens)
      }
    }));

    // Signal Evidence Contract: a "Best" needs at least two priced rows and
    // no tie; otherwise the ranking reports why no winner can be named.
    const groupLabel = (key) => (key && typeof key === 'object'
      ? `${key.name || 'prompt'}@${key.version ?? '-'}`
      : String(key ?? 'unknown'));
    const costEfficiencyRanking = rankingSignal({
      id: 'analytics.cost.efficiency_ranking',
      scope: { from: fromDate.toISOString(), to: toDate.toISOString(), groupBy },
      source: 'conversations',
      observedAt: toDate,
      ttlMs: CHAT_LANE_TTL_MS,
      unit: 'usd_per_1k_tokens',
      direction: 'asc',
      candidates: formattedBreakdown.map((row) => ({
        key: groupLabel(row.key),
        value: row.cost.per1kTokens,
        comparable: row.priced,
        reason: row.priced ? null : 'no_price'
      }))
    });

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        currency: process.env.COST_CURRENCY || 'USD',
        groupBy,
        minCost,
        summary,
        signals: {
          costEfficiencyRanking: serializeSignal(costEfficiencyRanking)
        },
        breakdown: formattedBreakdown
      }
    });
  } catch (err) {
    logger.error('Analytics costs error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
