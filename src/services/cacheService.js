/**
 * Redis Cache Service
 *
 * Distributed caching layer for PM2 cluster mode
 * Gracefully degrades to memory cache if Redis unavailable
 */

const Redis = require('ioredis');
const logger = require('../../config/logger');

class CacheService {
  constructor() {
    this.redis = null;
    this.enabled = false;
    this.fallbackCache = new Map(); // In-memory fallback
    this.stats = {
      hits: 0,
      misses: 0,
      errors: 0,
      fallbackHits: 0
    };

    // Initialize Redis if configured
    this.initialize();
  }

  /**
   * Initialize Redis connection
   */
  initialize() {
    const redisEnabled = process.env.REDIS_ENABLED === 'true';
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    if (!redisEnabled) {
      logger.info('Redis caching disabled (REDIS_ENABLED=false)');
      return;
    }

    try {
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          const delay = Math.min(times * 100, 3000);
          return delay;
        },
        reconnectOnError: (err) => {
          const targetError = 'READONLY';
          if (err.message.includes(targetError)) {
            // Reconnect on READONLY errors
            return true;
          }
          return false;
        },
        lazyConnect: true // Don't connect immediately
      });

      // Event handlers
      this.redis.on('connect', () => {
        this.enabled = true;
        logger.info('Redis cache connected', { url: redisUrl });
      });

      this.redis.on('error', (err) => {
        this.stats.errors++;
        logger.error('Redis cache error', {
          error: err.message,
          fallbackActive: !this.enabled
        });
      });

      this.redis.on('close', () => {
        this.enabled = false;
        logger.warn('Redis cache disconnected, falling back to memory cache');
      });

      this.redis.on('reconnecting', () => {
        logger.info('Redis cache reconnecting...');
      });

      // Attempt connection
      this.redis.connect().catch((err) => {
        logger.warn('Redis cache connection failed, using memory fallback', {
          error: err.message
        });
      });
    } catch (error) {
      logger.warn('Redis cache initialization failed, using memory fallback', {
        error: error.message
      });
    }
  }

  /**
   * Get value from cache
   * @param {string} key - Cache key
   * @returns {Promise<any|null>} - Cached value or null
   */
  async get(key) {
    try {
      if (this.enabled && this.redis) {
        const value = await this.redis.get(key);
        if (value) {
          this.stats.hits++;
          return JSON.parse(value);
        }
        this.stats.misses++;
        return null;
      }

      // Fallback to memory cache
      const value = this.fallbackCache.get(key);
      if (value) {
        // Check TTL
        if (value.expiresAt && value.expiresAt < Date.now()) {
          this.fallbackCache.delete(key);
          this.stats.misses++;
          return null;
        }
        this.stats.fallbackHits++;
        return value.data;
      }

      this.stats.misses++;
      return null;
    } catch (error) {
      this.stats.errors++;
      logger.error('Cache get error', { key, error: error.message });
      return null;
    }
  }

  /**
   * Set value in cache
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttl - Time to live in seconds (default: 3600)
   * @returns {Promise<boolean>} - Success status
   */
  async set(key, value, ttl = 3600) {
    try {
      if (this.enabled && this.redis) {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
        return true;
      }

      // Fallback to memory cache
      this.fallbackCache.set(key, {
        data: value,
        expiresAt: Date.now() + (ttl * 1000)
      });

      // Limit memory cache size (LRU eviction)
      if (this.fallbackCache.size > 1000) {
        const firstKey = this.fallbackCache.keys().next().value;
        this.fallbackCache.delete(firstKey);
      }

      return true;
    } catch (error) {
      this.stats.errors++;
      logger.error('Cache set error', { key, error: error.message });
      return false;
    }
  }

  /**
   * Delete key from cache
   * @param {string} key - Cache key
   * @returns {Promise<boolean>} - Success status
   */
  async del(key) {
    try {
      if (this.enabled && this.redis) {
        await this.redis.del(key);
        return true;
      }

      // Fallback to memory cache
      this.fallbackCache.delete(key);
      return true;
    } catch (error) {
      this.stats.errors++;
      logger.error('Cache delete error', { key, error: error.message });
      return false;
    }
  }

  /**
   * Delete keys matching pattern
   * @param {string} pattern - Key pattern (e.g., "embedding:*")
   * @returns {Promise<number>} - Number of keys deleted
   */
  async delPattern(pattern) {
    try {
      if (this.enabled && this.redis) {
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
        return keys.length;
      }

      // Fallback to memory cache
      let count = 0;
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      for (const key of this.fallbackCache.keys()) {
        if (regex.test(key)) {
          this.fallbackCache.delete(key);
          count++;
        }
      }
      return count;
    } catch (error) {
      this.stats.errors++;
      logger.error('Cache delete pattern error', { pattern, error: error.message });
      return 0;
    }
  }

  /**
   * Check if key exists
   * @param {string} key - Cache key
   * @returns {Promise<boolean>} - True if exists
   */
  async exists(key) {
    try {
      if (this.enabled && this.redis) {
        const result = await this.redis.exists(key);
        return result === 1;
      }

      // Fallback to memory cache
      return this.fallbackCache.has(key);
    } catch (error) {
      this.stats.errors++;
      logger.error('Cache exists error', { key, error: error.message });
      return false;
    }
  }

  /**
   * Increment numeric value
   * @param {string} key - Cache key
   * @param {number} amount - Amount to increment (default: 1)
   * @returns {Promise<number>} - New value
   */
  async incr(key, amount = 1) {
    try {
      if (this.enabled && this.redis) {
        const result = await this.redis.incrby(key, amount);
        return result;
      }

      // Fallback to memory cache
      const current = this.fallbackCache.get(key);
      const newValue = (current?.data || 0) + amount;
      this.fallbackCache.set(key, {
        data: newValue,
        expiresAt: current?.expiresAt || (Date.now() + 3600000)
      });
      return newValue;
    } catch (error) {
      this.stats.errors++;
      logger.error('Cache incr error', { key, error: error.message });
      return 0;
    }
  }

  /**
   * Get multiple keys at once
   * @param {Array<string>} keys - Array of cache keys
   * @returns {Promise<Array<any|null>>} - Array of values
   */
  async mget(keys) {
    try {
      if (this.enabled && this.redis) {
        const values = await this.redis.mget(...keys);
        return values.map(v => v ? JSON.parse(v) : null);
      }

      // Fallback to memory cache
      return keys.map(key => {
        const value = this.fallbackCache.get(key);
        if (value && (!value.expiresAt || value.expiresAt >= Date.now())) {
          return value.data;
        }
        return null;
      });
    } catch (error) {
      this.stats.errors++;
      logger.error('Cache mget error', { keys, error: error.message });
      return keys.map(() => null);
    }
  }

  /**
   * Set multiple keys at once
   * @param {Object} keyValues - Object with key-value pairs
   * @param {number} ttl - Time to live in seconds (default: 3600)
   * @returns {Promise<boolean>} - Success status
   */
  async mset(keyValues, ttl = 3600) {
    try {
      if (this.enabled && this.redis) {
        const pipeline = this.redis.pipeline();
        for (const [key, value] of Object.entries(keyValues)) {
          pipeline.set(key, JSON.stringify(value), 'EX', ttl);
        }
        await pipeline.exec();
        return true;
      }

      // Fallback to memory cache
      const expiresAt = Date.now() + (ttl * 1000);
      for (const [key, value] of Object.entries(keyValues)) {
        this.fallbackCache.set(key, { data: value, expiresAt });
      }
      return true;
    } catch (error) {
      this.stats.errors++;
      logger.error('Cache mset error', { error: error.message });
      return false;
    }
  }

  /**
   * Clear all cache keys
   * @returns {Promise<boolean>} - Success status
   */
  async clear() {
    try {
      if (this.enabled && this.redis) {
        await this.redis.flushdb();
        logger.info('Redis cache cleared');
        return true;
      }

      // Fallback to memory cache
      this.fallbackCache.clear();
      logger.info('Memory cache cleared');
      return true;
    } catch (error) {
      this.stats.errors++;
      logger.error('Cache clear error', { error: error.message });
      return false;
    }
  }

  /**
   * Get cache statistics
   * @returns {Object} - Cache stats
   */
  getStats() {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? (this.stats.hits / totalRequests * 100).toFixed(2) : 0;

    return {
      enabled: this.enabled,
      backend: this.enabled ? 'redis' : 'memory',
      hits: this.stats.hits,
      misses: this.stats.misses,
      errors: this.stats.errors,
      fallbackHits: this.stats.fallbackHits,
      totalRequests,
      hitRate: `${hitRate}%`,
      memoryCacheSize: this.fallbackCache.size
    };
  }

  /**
   * Reset cache statistics
   */
  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      errors: 0,
      fallbackHits: 0
    };
  }

  /**
   * Close Redis connection
   */
  async close() {
    if (this.redis) {
      await this.redis.quit();
      logger.info('Redis cache connection closed');
    }
  }
}

// Singleton instance
let cacheServiceInstance = null;

/**
 * Get cache service singleton
 * @returns {CacheService}
 */
function getCacheService() {
  if (!cacheServiceInstance) {
    cacheServiceInstance = new CacheService();
  }
  return cacheServiceInstance;
}

module.exports = { CacheService, getCacheService };
