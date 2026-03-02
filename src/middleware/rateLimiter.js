/**
 * Rate Limiting Middleware
 * Protects API endpoints from abuse and excessive requests
 */

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const crypto = require('crypto');
const logger = require('../../config/logger');
const SelfHealingEngine = require('../services/selfHealingEngine');

function getClientKey(req) {
  // In tests, allow callers to isolate rate limit buckets deterministically.
  if (process.env.NODE_ENV === 'test') {
    const testKey = req.get('x-test-client');
    if (testKey) return `test:${testKey}`;
  }

  // Default: key by IP (IPv6-aware)
  return ipKeyGenerator(req.ip);
}

function getGeneralApiKey(req) {
  // In tests, preserve deterministic bucketing.
  if (process.env.NODE_ENV === 'test') {
    return getClientKey(req);
  }

  // Prefer authenticated identity to avoid NAT/proxy IP collisions.
  if (req.session?.userId) {
    return `user:${req.session.userId}`;
  }

  // API-key clients may share egress IPs; isolate by key prefix.
  const apiKey = req.get('x-api-key');
  if (apiKey) {
    const digest = crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
    return `api:${digest}`;
  }

  // Fallback for unauthenticated requests.
  return ipKeyGenerator(req.ip);
}

/**
 * General API rate limiter
 * 100 requests per 15 minutes
 */
const baseApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: {
    status: 'error',
    message: 'Too many requests. Please try again after 15 minutes.'
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  keyGenerator: getGeneralApiKey,
  validate: { ip: false }, // key can be user/session/api-key based
  skip: (req) => (
    req.originalUrl.startsWith('/api/benchmark')
    || req.originalUrl.startsWith('/api/specialx')
    || req.originalUrl.startsWith('/api/roundtable')
    || req.originalUrl.startsWith('/api/hosts')
    || req.originalUrl === '/api/rag/watcher/status'
    || req.originalUrl === '/api/dashboard/rag-sync/status'
  ), // Skip benchmark + specialx + roundtable + host-monitor routes (handled by dedicated limiters) and dashboard polling endpoints
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      path: req.path,
      method: req.method
    });
    res.status(429).json({
      status: 'error',
      message: 'Too many requests. Please slow down and try again later.',
      retryAfter: req.rateLimit.resetTime
    });
  }
});

const throttledApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: {
    status: 'error',
    message: 'API temporarily throttled by self-healing safeguards'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientKey
});

/**
 * Benchmark rate limiter
 * Higher limits for polling and batch testing
 * 5000 requests per 15 minutes
 */
const benchmarkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5000, // 5000 requests per window (allows ~5.5 request/sec avg)
  message: {
    status: 'error',
    message: 'Benchmark rate limit exceeded'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientKey
});

/**
 * SpecialX dashboard/automation limiter
 * Allows frequent operational polling without tripping global API limits.
 * 1200 requests per 15 minutes (~1.3 req/sec average)
 */
const specialXLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1200,
  message: {
    status: 'error',
    message: 'SpecialX rate limit exceeded'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    if (process.env.NODE_ENV === 'test') {
      return getClientKey(req);
    }
    if (req.session?.userId) {
      return `specialx:${req.session.userId}`;
    }
    return `specialx:${ipKeyGenerator(req.ip)}`;
  },
  validate: { ip: false }
});

/**
 * Chat endpoint rate limiter
 * 20 requests per minute (prevents spam/abuse)
 * Key by user session if available, otherwise IP
 */
const baseChatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute
  message: {
    status: 'error',
    message: 'Too many chat requests. Please wait a moment.'
  },
  keyGenerator: (req) => {
    if (process.env.NODE_ENV === 'test') {
      return getClientKey(req);
    }
    // Use session user ID if authenticated, otherwise IP
    if (req.session?.userId) {
      return req.session.userId;
    }
    return ipKeyGenerator(req.ip);
  },
  validate: { ip: false }, // We're using ipKeyGenerator helper for IPv6 support
  handler: (req, res) => {
    logger.warn('Chat rate limit exceeded', {
      userId: req.session?.userId,
      ip: req.ip
    });
    res.status(429).json({
      status: 'error',
      message: 'You are sending messages too quickly. Please wait a moment.',
      retryAfter: Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
    });
  }
});

const throttledChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: {
    status: 'error',
    message: 'Chat temporarily throttled by self-healing safeguards'
  },
  keyGenerator: (req) => {
    if (process.env.NODE_ENV === 'test') {
      return getClientKey(req);
    }
    if (req.session?.userId) {
      return req.session.userId;
    }
    return ipKeyGenerator(req.ip);
  },
  validate: { ip: false }
});

async function isSelfHealingThrottleActive() {
  try {
    const state = await SelfHealingEngine.getThrottleState();
    if (!state || !state.enabled) return false;
    const expiresAt = Number(state.expiresAt) || 0;
    return expiresAt > Date.now();
  } catch (error) {
    logger.debug('Failed to read self-healing throttle state; defaulting to normal limits', {
      error: error.message
    });
    return false;
  }
}

const apiLimiter = async (req, res, next) => {
  if (await isSelfHealingThrottleActive()) {
    return throttledApiLimiter(req, res, next);
  }
  return baseApiLimiter(req, res, next);
};

const chatLimiter = async (req, res, next) => {
  if (await isSelfHealingThrottleActive()) {
    return throttledChatLimiter(req, res, next);
  }
  return baseChatLimiter(req, res, next);
};

/**
 * Strict rate limiter for expensive operations
 * 10 requests per minute
 * Used for: RAG ingestion, analysis, etc.
 */
const strictLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: {
    status: 'error',
    message: 'This operation is rate-limited. Please try again in a minute.'
  },
  keyGenerator: (req) => {
    if (process.env.NODE_ENV === 'test') {
      return getClientKey(req);
    }
    if (req.session?.userId) {
      return req.session.userId;
    }
    return ipKeyGenerator(req.ip);
  },
  validate: { ip: false }, // We're using ipKeyGenerator helper for IPv6 support
  handler: (req, res) => {
    logger.warn('Strict rate limit exceeded', {
      userId: req.session?.userId,
      ip: req.ip,
      path: req.path
    });
    res.status(429).json({
      status: 'error',
      message: 'This operation is temporarily rate-limited. Please try again shortly.',
      retryAfter: Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
    });
  }
});

/**
 * Authentication rate limiter
 * Protects login/register endpoints from brute force
 * 5 attempts per 15 minutes
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  skipSuccessfulRequests: true, // Don't count successful logins
  skip: (req) => req.path === '/me', // /api/auth/me is a session check, not a login attempt
  message: {
    status: 'error',
    message: 'Too many authentication attempts. Please try again later.'
  },
  keyGenerator: getClientKey,
  handler: (req, res) => {
    logger.warn('Auth rate limit exceeded', {
      ip: req.ip,
      path: req.path
    });
    res.status(429).json({
      status: 'error',
      message: 'Too many failed authentication attempts. Please try again in 15 minutes.',
      retryAfter: req.rateLimit.resetTime
    });
  }
});

/**
 * Roundtable rate limiter
 * Moderate limits — roundtables are expensive (multi-agent, sequential)
 * 200 requests per 15 minutes
 */
const roundtableLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: {
    status: 'error',
    message: 'Roundtable rate limit exceeded'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientKey
});

module.exports = {
  apiLimiter,
  benchmarkLimiter,
  roundtableLimiter,
  specialXLimiter,
  chatLimiter,
  strictLimiter,
  authLimiter
};
