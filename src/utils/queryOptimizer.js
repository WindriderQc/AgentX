/**
 * Query Optimization Utilities
 * 
 * Helper functions for optimizing MongoDB queries
 * Best practices and performance patterns
 */

const logger = require('../../config/logger');

/**
 * Optimize a Mongoose query with common best practices
 * @param {Query} query - Mongoose query object
 * @param {Object} options - Optimization options
 * @returns {Query} Optimized query
 */
function optimizeQuery(query, options = {}) {
  const {
    limit = 100,
    lean = true,
    select = null,
    timeout = 5000
  } = options;

  // Apply limit to prevent large result sets
  if (limit) {
    query = query.limit(limit);
  }

  // Use lean() for read-only operations (faster, returns plain objects)
  if (lean) {
    query = query.lean();
  }

  // Apply field projection if specified
  if (select) {
    query = query.select(select);
  }

  // Set query timeout
  query = query.maxTimeMS(timeout);

  return query;
}

/**
 * Create optimized pagination query
 * @param {Model} model - Mongoose model
 * @param {Object} filter - Query filter
 * @param {Object} options - Pagination options
 * @returns {Promise<{data: Array, total: number, page: number, pages: number}>}
 */
async function paginatedQuery(model, filter = {}, options = {}) {
  const {
    page = 1,
    limit = 20,
    sort = { createdAt: -1 },
    select = null,
    populate = null
  } = options;

  const skip = (page - 1) * limit;

  // Run count and find in parallel
  const [total, data] = await Promise.all([
    model.countDocuments(filter),
    (async () => {
      let query = model.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean();

      if (select) {
        query = query.select(select);
      }

      if (populate) {
        query = query.populate(populate);
      }

      return query.exec();
    })()
  ]);

  return {
    data,
    total,
    page,
    pages: Math.ceil(total / limit),
    hasMore: page * limit < total
  };
}

/**
 * Query with caching
 * Simple in-memory cache for frequently accessed data
 */
class QueryCache {
  constructor(ttlSeconds = 60) {
    this.cache = new Map();
    this.ttl = ttlSeconds * 1000;
  }

  /**
   * Get or fetch data with caching
   * @param {string} key - Cache key
   * @param {Function} fetchFn - Function to fetch data if not cached
   * @returns {Promise<any>} Cached or fresh data
   */
  async getOrFetch(key, fetchFn) {
    const cached = this.cache.get(key);
    
    if (cached && Date.now() - cached.timestamp < this.ttl) {
      return cached.data;
    }

    const data = await fetchFn();
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });

    return data;
  }

  /**
   * Invalidate cache entry
   * @param {string} key - Cache key to invalidate
   */
  invalidate(key) {
    this.cache.delete(key);
  }

  /**
   * Clear entire cache
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getStats() {
    return {
      size: this.cache.size,
      ttl: this.ttl / 1000
    };
  }
}

/**
 * Batch query operations for efficiency
 * @param {Array<Function>} queryFns - Array of query functions
 * @returns {Promise<Array>} Results of all queries
 */
async function batchQueries(queryFns) {
  return Promise.all(queryFns.map(fn => fn()));
}

/**
 * Find with retry logic for transient errors
 * @param {Model} model - Mongoose model
 * @param {Object} filter - Query filter
 * @param {Object} options - Query options
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise} Query result
 */
async function findWithRetry(model, filter, options = {}, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await model.find(filter, null, options).exec();
    } catch (err) {
      lastError = err;
      
      // Only retry on transient errors
      if (err.name === 'MongoNetworkError' || err.name === 'MongoTimeoutError') {
        if (attempt < maxRetries) {
          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
          continue;
        }
      }
      
      // Non-transient error or max retries reached
      throw err;
    }
  }
  
  throw lastError;
}

/**
 * Query performance monitoring decorator
 * @param {string} queryName - Name of the query for logging
 * @param {Function} queryFn - Query function to monitor
 * @returns {Function} Wrapped query function
 */
function monitorQuery(queryName, queryFn) {
  return async function(...args) {
    const startTime = Date.now();
    
    try {
      const result = await queryFn(...args);
      const duration = Date.now() - startTime;
      
      if (duration > 1000) {
        logger.warn('Slow query detected', { queryName, duration });
      }
      
      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      logger.error('Query failed', { queryName, duration, error: err.message });
      throw err;
    }
  };
}

// Export utilities
module.exports = {
  optimizeQuery,
  paginatedQuery,
  QueryCache,
  batchQueries,
  findWithRetry,
  monitorQuery
};

// Example usage:
/*
const { optimizeQuery, paginatedQuery, QueryCache } = require('./queryOptimizer');

// 1. Optimize a single query
const conversations = await optimizeQuery(
  Conversation.find({ userId: 'user123' }),
  { limit: 50, select: 'title messages createdAt' }
);

// 2. Paginated query
const result = await paginatedQuery(
  Conversation,
  { userId: 'user123' },
  { page: 1, limit: 20, sort: { updatedAt: -1 } }
);

// 3. Query caching
const cache = new QueryCache(60); // 60 second TTL
const activePrompt = await cache.getOrFetch(
  'active-prompt',
  () => PromptConfig.findOne({ isActive: true }).lean()
);

// 4. Batch queries
const [users, conversations, prompts] = await batchQueries([
  () => UserProfile.find().lean(),
  () => Conversation.find().limit(10).lean(),
  () => PromptConfig.find({ isActive: true }).lean()
]);
*/
