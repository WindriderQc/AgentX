/**
 * Rate Limiting Middleware
 * Protects API endpoints from abuse and excessive requests
 */

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const logger = require('../../config/logger');

/**
 * General API rate limiter
 * 100 requests per 15 minutes
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: {
    status: 'error',
    message: 'Too many requests from this IP, please try again after 15 minutes'
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  skip: (req) => req.originalUrl.startsWith('/api/benchmark'), // Skip benchmark routes (handled separately)
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
  legacyHeaders: false
});

/**
 * Chat endpoint rate limiter
 * 20 requests per minute (prevents spam/abuse)
 * Key by user session if available, otherwise IP
 */
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute
  message: {
    status: 'error',
    message: 'Too many chat requests. Please wait a moment.'
  },
  keyGenerator: (req) => {
    // Use session user ID if authenticated, otherwise IP
    if (req.session?.userId) {
      return req.session.userId;
    }
    return ipKeyGenerator(req);
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
    if (req.session?.userId) {
      return req.session.userId;
    }
    return ipKeyGenerator(req);
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
  message: {
    status: 'error',
    message: 'Too many authentication attempts. Please try again later.'
  },
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

module.exports = {
  apiLimiter,
  benchmarkLimiter,
  chatLimiter,
  strictLimiter,
  authLimiter
};
