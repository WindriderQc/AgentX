const Redis = require('ioredis');
const logger = require('../../config/logger');

const COOLDOWN_TTL_SECONDS = 7 * 24 * 60 * 60;
const EVAL_LOCK_KEY = 'self_healing:evaluation_lock';
const THROTTLE_KEY = 'self_healing:throttle_state';

class SelfHealingStateStore {
  constructor() {
    this.redis = null;
    this.redisReady = false;
    this.memoryCooldowns = new Map();
    this.memoryThrottleState = null;
    this.memoryEvalLock = null;
    this.memoryEvalLockExpiresAt = 0;
    this.throttleCache = null;
    this.throttleCacheAt = 0;
    this.throttleCacheTtlMs = 1000;

    const redisUrl = process.env.SELF_HEALING_REDIS_URL || process.env.REDIS_URL;
    if (!redisUrl) {
      logger.info('Self-healing state store using in-memory fallback (no Redis URL configured)');
      return;
    }

    try {
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        enableReadyCheck: true,
        maxRetriesPerRequest: 1
      });

      this.redis.on('ready', () => {
        this.redisReady = true;
        logger.info('Self-healing state store connected to Redis');
      });

      this.redis.on('error', (error) => {
        this.redisReady = false;
        logger.warn('Self-healing Redis error, falling back to in-memory state', {
          error: error.message
        });
      });

      this.redis.connect().catch((error) => {
        this.redisReady = false;
        logger.warn('Failed to connect Self-healing Redis, using in-memory fallback', {
          error: error.message
        });
      });
    } catch (error) {
      this.redis = null;
      this.redisReady = false;
      logger.warn('Failed to initialize Self-healing Redis client, using in-memory fallback', {
        error: error.message
      });
    }
  }

  _cooldownKey(ruleName) {
    return `self_healing:cooldown:${ruleName}`;
  }

  async setLastExecution(ruleName, timestampMs) {
    this.memoryCooldowns.set(ruleName, timestampMs);

    if (!this.redis || !this.redisReady) return;

    try {
      await this.redis.set(this._cooldownKey(ruleName), String(timestampMs), 'EX', COOLDOWN_TTL_SECONDS);
    } catch (error) {
      logger.warn('Failed to persist self-healing cooldown to Redis', {
        ruleName,
        error: error.message
      });
    }
  }

  async getLastExecution(ruleName) {
    if (this.redis && this.redisReady) {
      try {
        const value = await this.redis.get(this._cooldownKey(ruleName));
        if (value) {
          const parsed = parseInt(value, 10);
          if (Number.isFinite(parsed)) {
            this.memoryCooldowns.set(ruleName, parsed);
            return parsed;
          }
        }
      } catch (error) {
        logger.warn('Failed to read self-healing cooldown from Redis', {
          ruleName,
          error: error.message
        });
      }
    }

    return this.memoryCooldowns.get(ruleName) || null;
  }

  async setThrottleState(state, durationMs) {
    this.memoryThrottleState = state;
    this.throttleCache = state;
    this.throttleCacheAt = Date.now();

    if (!this.redis || !this.redisReady) return;

    try {
      const ttlSeconds = Math.max(1, Math.ceil(durationMs / 1000));
      await this.redis.set(THROTTLE_KEY, JSON.stringify(state), 'EX', ttlSeconds);
    } catch (error) {
      logger.warn('Failed to persist self-healing throttle state to Redis', {
        error: error.message
      });
    }
  }

  async getThrottleState() {
    const now = Date.now();
    if (this.throttleCache && (now - this.throttleCacheAt) < this.throttleCacheTtlMs) {
      return this.throttleCache;
    }

    let state = this.memoryThrottleState;

    if (this.redis && this.redisReady) {
      try {
        const value = await this.redis.get(THROTTLE_KEY);
        if (value) {
          state = JSON.parse(value);
          this.memoryThrottleState = state;
        } else {
          state = null;
          this.memoryThrottleState = null;
        }
      } catch (error) {
        logger.warn('Failed to read self-healing throttle state from Redis', {
          error: error.message
        });
      }
    }

    this.throttleCache = state;
    this.throttleCacheAt = now;
    return state;
  }

  async clearThrottleState() {
    this.memoryThrottleState = null;
    this.throttleCache = null;
    this.throttleCacheAt = 0;

    if (!this.redis || !this.redisReady) return;

    try {
      await this.redis.del(THROTTLE_KEY);
    } catch (error) {
      logger.warn('Failed to clear self-healing throttle state from Redis', {
        error: error.message
      });
    }
  }

  async acquireEvaluationLock(ttlMs = 55000) {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    if (this.redis && this.redisReady) {
      try {
        const result = await this.redis.set(EVAL_LOCK_KEY, token, 'PX', ttlMs, 'NX');
        return {
          acquired: result === 'OK',
          token
        };
      } catch (error) {
        logger.warn('Failed to acquire Redis self-healing evaluation lock', {
          error: error.message
        });
      }
    }

    const now = Date.now();
    if (!this.memoryEvalLock || now >= this.memoryEvalLockExpiresAt) {
      this.memoryEvalLock = token;
      this.memoryEvalLockExpiresAt = now + ttlMs;
      return { acquired: true, token };
    }

    return { acquired: false, token };
  }

  async releaseEvaluationLock(token) {
    if (this.redis && this.redisReady) {
      try {
        const currentToken = await this.redis.get(EVAL_LOCK_KEY);
        if (currentToken === token) {
          await this.redis.del(EVAL_LOCK_KEY);
        }
        return;
      } catch (error) {
        logger.warn('Failed to release Redis self-healing evaluation lock', {
          error: error.message
        });
      }
    }

    if (this.memoryEvalLock === token) {
      this.memoryEvalLock = null;
      this.memoryEvalLockExpiresAt = 0;
    }
  }
}

let singleton = null;
function getSelfHealingStateStore() {
  if (!singleton) {
    singleton = new SelfHealingStateStore();
  }
  return singleton;
}

module.exports = {
  SelfHealingStateStore,
  getSelfHealingStateStore
};
