/**
 * Cache Management Routes
 *
 * Monitoring and management for Redis/Memory cache
 */

const express = require('express');
const router = express.Router();
const { getCacheService } = require('../src/services/cacheService');
const { requireAuth, requireAdmin } = require('../src/middleware/auth');
const logger = require('../config/logger');

/**
 * GET /api/cache/stats
 * Get cache statistics
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const cache = getCacheService();
    const stats = cache.getStats();

    res.json({
      status: 'success',
      data: stats
    });
  } catch (error) {
    logger.error('Get cache stats error', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * POST /api/cache/clear
 * Clear all cache (admin only)
 */
router.post('/clear', requireAuth, requireAdmin, async (req, res) => {
  try {
    const cache = getCacheService();
    const success = await cache.clear();

    if (success) {
      logger.info('Cache cleared by admin', {
        userId: res.locals.user?.userId,
        username: res.locals.user?.name
      });

      res.json({
        status: 'success',
        message: 'Cache cleared successfully'
      });
    } else {
      res.status(500).json({
        status: 'error',
        message: 'Failed to clear cache'
      });
    }
  } catch (error) {
    logger.error('Clear cache error', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * DELETE /api/cache/pattern/:pattern
 * Delete keys matching pattern (admin only)
 */
router.delete('/pattern/:pattern', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { pattern } = req.params;
    const cache = getCacheService();
    const deletedCount = await cache.delPattern(pattern);

    logger.info('Cache pattern deleted', {
      pattern,
      deletedCount,
      userId: res.locals.user?.userId
    });

    res.json({
      status: 'success',
      message: `Deleted ${deletedCount} keys matching pattern: ${pattern}`,
      data: {
        pattern,
        deletedCount
      }
    });
  } catch (error) {
    logger.error('Delete cache pattern error', {
      pattern: req.params.pattern,
      error: error.message
    });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * POST /api/cache/reset-stats
 * Reset cache statistics (admin only)
 */
router.post('/reset-stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const cache = getCacheService();
    cache.resetStats();

    logger.info('Cache stats reset', {
      userId: res.locals.user?.userId
    });

    res.json({
      status: 'success',
      message: 'Cache statistics reset'
    });
  } catch (error) {
    logger.error('Reset cache stats error', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * GET /api/cache/health
 * Check cache service health
 */
router.get('/health', requireAuth, async (req, res) => {
  try {
    const cache = getCacheService();
    const stats = cache.getStats();

    const health = {
      status: stats.enabled ? 'healthy' : 'degraded',
      backend: stats.backend,
      enabled: stats.enabled,
      message: stats.enabled
        ? 'Redis cache operational'
        : 'Fallback to memory cache (Redis unavailable)'
    };

    res.json({
      status: 'success',
      data: health
    });
  } catch (error) {
    logger.error('Cache health check error', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message,
      data: {
        status: 'unhealthy',
        enabled: false
      }
    });
  }
});

module.exports = router;
