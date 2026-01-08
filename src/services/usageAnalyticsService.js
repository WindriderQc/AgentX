/**
 * Usage Analytics Service
 * 
 * Provides aggregation pipelines for cost and usage tracking.
 * Supports workspace-scoped analytics.
 */

const Conversation = require('../../models/Conversation');
const logger = require('../../config/logger');

class UsageAnalyticsService {
  /**
   * Build base query with date range and scope
   */
  _buildQuery(userId, workspaceId, startDate, endDate) {
    const query = {};
    
    // Auth scope
    if (userId) query.userId = userId;
    if (workspaceId) query.workspaceId = workspaceId;

    // Date range
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = startDate;
      if (endDate) query.createdAt.$lte = endDate;
    }

    // Ensure we only look at conversations that have usage data (or where we want to include them as 0s)
    // Actually, we want all conversations in the period.
    return query;
  }

  /**
   * Get overall usage summary
   */
  async getUsageSummary(userId, workspaceId, startDate, endDate) {
    const query = this._buildQuery(userId, workspaceId, startDate, endDate);

    const pipeline = [
      { $match: query },
      {
        $group: {
          _id: null,
          totalConversations: { $sum: 1 },
          totalMessages: { $sum: { $size: '$messages' } },
          totalPromptTokens: { $sum: '$usage.promptTokens' },
          totalCompletionTokens: { $sum: '$usage.completionTokens' },
          totalTokens: { $sum: '$usage.totalTokens' },
          totalCost: { $sum: '$usage.estimatedCost' }
        }
      }
    ];

    const result = await Conversation.aggregate(pipeline);
    
    return result[0] || {
      totalConversations: 0,
      totalMessages: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCost: 0
    };
  }

  /**
   * Get usage broken down by model
   */
  async getUsageByModel(userId, workspaceId, startDate, endDate) {
    const query = this._buildQuery(userId, workspaceId, startDate, endDate);

    const pipeline = [
      { $match: query },
      {
        $group: {
          _id: '$model',
          conversations: { $sum: 1 },
          tokens: { $sum: '$usage.totalTokens' },
          cost: { $sum: '$usage.estimatedCost' }
        }
      },
      {
        $project: {
          model: '$_id',
          conversations: 1,
          tokens: 1,
          cost: 1,
          avgTokensPerConv: { $divide: ['$tokens', '$conversations'] },
          _id: 0
        }
      },
      { $sort: { cost: -1 } }
    ];

    return await Conversation.aggregate(pipeline);
  }

  /**
   * Get daily usage trend
   */
  async getDailyUsage(userId, workspaceId, days = 30) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const query = this._buildQuery(userId, workspaceId, startDate, endDate);

    const pipeline = [
      { $match: query },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
          },
          conversations: { $sum: 1 },
          messages: { $sum: { $size: '$messages' } },
          tokens: { $sum: '$usage.totalTokens' },
          cost: { $sum: '$usage.estimatedCost' }
        }
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          date: '$_id',
          conversations: 1,
          messages: 1,
          tokens: 1,
          cost: 1,
          _id: 0
        }
      }
    ];

    return await Conversation.aggregate(pipeline);
  }

  /**
   * Get top most expensive conversations
   */
  async getTopConversations(userId, workspaceId, limit = 10) {
    // Basic query (all time)
    const query = this._buildQuery(userId, workspaceId);

    // Only include conversations that have cost > 0
    query['usage.estimatedCost'] = { $gt: 0 };

    return await Conversation.find(query)
      .select('title model usage createdAt lastUsageUpdate')
      .sort({ 'usage.estimatedCost': -1 })
      .limit(limit)
      .lean();
  }
}

// Singleton instance
let instance = null;

function getUsageAnalytics() {
  if (!instance) {
    instance = new UsageAnalyticsService();
  }
  return instance;
}

module.exports = { getUsageAnalytics };
