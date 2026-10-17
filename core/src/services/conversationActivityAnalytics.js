'use strict';

/**
 * The window of a chat-lane analytics request: `to` defaults to now and `from`
 * to seven days earlier. An unparseable or reversed range is refused instead of
 * reaching MongoDB as an Invalid Date.
 */
function parseAnalyticsRange({ from, to } = {}) {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(toDate.getTime()) || Number.isNaN(fromDate.getTime())) return { error: 'from and to must be valid dates.' };
  if (fromDate > toDate) return { error: 'from must be before to.' };
  return { fromDate, toDate };
}

function messageObservedAtExpression(variable = '$$message') {
  return { $ifNull: [`${variable}.timestamp`, `${variable}.createdAt`] };
}

function conversationActivityFilter(fromDate, toDate) {
  const range = { $gte: fromDate, $lte: toDate };
  return {
    $or: [
      { 'messages.timestamp': range },
      { 'messages.createdAt': range }
    ]
  };
}

function activeMessagesExpression(fromDate, toDate) {
  const observedAt = messageObservedAtExpression();
  return {
    $filter: {
      input: { $ifNull: ['$messages', []] },
      as: 'message',
      cond: {
        $and: [
          { $gte: [observedAt, fromDate] },
          { $lte: [observedAt, toDate] }
        ]
      }
    }
  };
}

/**
 * Aggregation stages that keep one row per message observed in the window
 * (`$messages` after the unwind). Chat-lane costs, feedback and RAG cohorts
 * use them so they count the same activity as the Conversations tile, not
 * only conversations created inside the window.
 */
function activeMessageStages(fromDate, toDate, conversationMatch = null) {
  const activity = conversationActivityFilter(fromDate, toDate);
  const observedAt = { $ifNull: ['$messages.timestamp', '$messages.createdAt'] };
  return [
    { $match: conversationMatch ? { $and: [conversationMatch, activity] } : activity },
    { $unwind: '$messages' },
    { $match: { $expr: { $and: [
      { $gte: [observedAt, fromDate] },
      { $lte: [observedAt, toDate] }
    ] } } }
  ];
}

function activeMessageCostExpression(input = '$activeMessages') {
  return {
    $sum: {
      $map: {
        input,
        as: 'message',
        in: {
          $cond: [
            { $eq: ['$$message.role', 'assistant'] },
            { $ifNull: ['$$message.cost.totalCost', 0] },
            0
          ]
        }
      }
    }
  };
}

function activityDayPipeline(fromDate, toDate) {
  const observedAt = { $ifNull: ['$messages.timestamp', '$messages.createdAt'] };
  return [
    { $match: conversationActivityFilter(fromDate, toDate) },
    { $unwind: '$messages' },
    { $match: { $expr: { $and: [
      { $gte: [observedAt, fromDate] },
      { $lte: [observedAt, toDate] }
    ] } } },
    { $group: {
      _id: { $dateToString: { format: '%Y-%m-%d', date: observedAt } },
      conversationIds: { $addToSet: '$_id' },
      messages: { $sum: 1 },
      totalCost: {
        $sum: {
          $cond: [
            { $eq: ['$messages.role', 'assistant'] },
            { $ifNull: ['$messages.cost.totalCost', 0] },
            0
          ]
        }
      }
    } },
    { $project: {
      _id: 0,
      date: '$_id',
      conversations: { $size: '$conversationIds' },
      messages: 1,
      totalCost: 1,
      avgCostPerConversation: {
        $cond: [
          { $gt: [{ $size: '$conversationIds' }, 0] },
          { $divide: ['$totalCost', { $size: '$conversationIds' }] },
          0
        ]
      }
    } },
    { $sort: { date: 1 } }
  ];
}

module.exports = {
  parseAnalyticsRange,
  activeMessageCostExpression,
  activeMessageStages,
  activeMessagesExpression,
  activityDayPipeline,
  conversationActivityFilter,
  messageObservedAtExpression
};
