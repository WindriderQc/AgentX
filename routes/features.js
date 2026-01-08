/**
 * Feature Dashboard API Routes
 *
 * Provides endpoints for Feature Inventory, API Telemetry, Usage Analytics, and Feature Flags
 */

const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const FeatureInventory = require('../models/FeatureInventory');
const ApiTelemetry = require('../models/ApiTelemetry');
const FeatureUsage = require('../models/FeatureUsage');
const FeatureFlag = require('../models/FeatureFlag');
const ActivityLog = require('../models/ActivityLog');
const { requireAuth } = require('../src/middleware/auth');
const logger = require('../config/logger');

const featureAlignmentScanner = require('../src/services/featureAlignmentScanner');
const { calculatePriority } = require('../src/services/featureAlignmentPriority');

// ========================================
// Feature Inventory Endpoints
// ========================================

/**
 * GET /api/features/reports/latest
 * Serve the latest JSON scan report from disk
 */
router.get('/reports/latest', (req, res) => {
  const reportPath = path.join(process.cwd(), 'reports', 'feature-alignment.json');
  if (fs.existsSync(reportPath)) {
    res.sendFile(reportPath);
  } else {
    res.status(404).json({ 
      status: 'error', 
      message: 'Report not found. Please run a scan first.' 
    });
  }
});


/**
 * GET /api/features/inventory
 * Get all features in inventory
 */
router.get('/inventory', async (req, res) => {
  try {
    const features = await FeatureInventory.find({}).sort({ name: 1 });

    res.json({
      status: 'success',
      data: features,
      total: features.length
    });

  } catch (error) {
    logger.error('Failed to get feature inventory', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch feature inventory',
      error: error.message
    });
  }
});

/**
 * GET /api/features/inventory/alignment
 * Get alignment report (grouping by status)
 */
router.get('/inventory/alignment', async (req, res) => {
  try {
    const report = await FeatureInventory.getAlignmentReport();

    res.json({
      status: 'success',
      data: report
    });

  } catch (error) {
    logger.error('Failed to get alignment report', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate alignment report',
      error: error.message
    });
  }
});

/**
 * POST /api/features/inventory/scan
 * Trigger codebase scan (placeholder - requires featureInventoryService)
 */
router.post('/inventory/scan', requireAuth, async (req, res) => {
  try {
    // Implement codebase scanning logic
    const scanResult = featureAlignmentScanner.scanWorkspace(process.cwd());

    // Update DB with results
    const results = {
      updated: 0,
      created: 0,
      errors: 0
    };

    // Process each detected feature
    for (const detectedFeature of scanResult.features) {
      try {
        const query = { name: detectedFeature.key };
        
        let feature = await FeatureInventory.findOne(query);
        
        const updateData = {
          name: detectedFeature.key,
          // Map to enum core/analytics/operations/experimental/deprecated based on keyword checks or default to 'experimental'
          category: detectedFeature.key.includes('analytic') ? 'analytics' : 
                   detectedFeature.key.includes('op') || detectedFeature.key.includes('monitor') ? 'operations' : 
                   detectedFeature.key.includes('core') || detectedFeature.key.includes('chat') ? 'core' : 'experimental',
          
          status: detectedFeature.status, // already matches 'complete'|'partial'|'missing' etc.
          
          frontend: {
            exists: detectedFeature.present.frontend,
            pages: detectedFeature.frontend.map(p => p.split('/').pop()), // simplify path
            lastVerified: new Date()
          },
          
          backend: {
            exists: detectedFeature.present.backend,
            endpoints: detectedFeature.backendHits.map(e => `${e.method} ${e.path}`),
            services: detectedFeature.backendServices.map(s => s.split('/').pop()),
            lastVerified: new Date()
          },
          
          documentation: {
            exists: detectedFeature.present.docs,
            files: detectedFeature.docs.map(d => d.split('/').pop()),
            completeness: detectedFeature.score, // Use score as proxy for completeness
            lastVerified: new Date()
          },
          
          metadata: {
             description: `Auto-detected from ${detectedFeature.frontend.length} UI files and ${detectedFeature.backendHits.length} API endpoints`,
             updatedBy: 'system-scanner'
          }
        };

        if (feature) {
          // preserve existing category/roadmap info if manually set
          if (feature.roadmap && feature.roadmap.status !== 'planned') {
             updateData.roadmap = feature.roadmap;
          }
          if (feature.category) {
             updateData.category = feature.category;
          }
          
          Object.assign(feature, updateData);
          await feature.save();
          results.updated++;
        } else {
          await FeatureInventory.create(updateData);
          results.created++;
        }
      } catch (err) {
        logger.warn(`Failed to sync feature ${detectedFeature.key}`, { error: err.message });
        results.errors++;
      }
    }

    logger.info('Feature scan completed', { 
      user: req.user?.username,
      stats: results,
      summary: scanResult.summary.counts
    });

    res.json({
      status: 'success',
      message: 'Codebase scan completed successfully',
      data: {
        scanned: {
          features: scanResult.summary.counts.features,
          files: scanResult.summary.counts.frontendFiles + scanResult.summary.counts.routeFiles
        },
        db: results,
        timestamp: new Date()
      }
    });

  } catch (error) {
    logger.error('Failed to scan codebase', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to scan codebase',
      error: error.message
    });
  }
});

/**
 * POST /api/features/inventory
 * Create or update feature in inventory
 */
router.post('/inventory', requireAuth, async (req, res) => {
  try {
    const { name, category, status, frontend, backend, documentation, roadmap, metadata } = req.body;

    // Check if feature already exists
    let feature = await FeatureInventory.findOne({ name });

    if (feature) {
      // Update existing
      feature.category = category || feature.category;
      feature.status = status || feature.status;
      feature.frontend = frontend || feature.frontend;
      feature.backend = backend || feature.backend;
      feature.documentation = documentation || feature.documentation;
      feature.roadmap = roadmap || feature.roadmap;
      feature.metadata = metadata || feature.metadata;

      await feature.save();
    } else {
      // Create new
      feature = new FeatureInventory({
        name,
        category,
        status,
        frontend,
        backend,
        documentation,
        roadmap,
        metadata
      });

      await feature.save();
    }

    logger.info('Feature inventory updated', { name, user: req.user?.username });

    res.json({
      status: 'success',
      data: feature,
      message: `Feature "${name}" ${feature.isNew ? 'created' : 'updated'} successfully`
    });

  } catch (error) {
    logger.error('Failed to update feature inventory', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to update feature inventory',
      error: error.message
    });
  }
});

/**
 * DELETE /api/features/inventory/:name
 * Remove feature from inventory
 */
router.delete('/inventory/:name', requireAuth, async (req, res) => {
  try {
    const { name } = req.params;

    const feature = await FeatureInventory.findOneAndDelete({ name });

    if (!feature) {
      return res.status(404).json({
        status: 'error',
        message: 'Feature not found',
        name
      });
    }

    logger.info('Feature deleted from inventory', { name, user: req.user?.username });

    res.json({
      status: 'success',
      message: `Feature "${name}" deleted from inventory`
    });

  } catch (error) {
    logger.error('Failed to delete feature', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete feature',
      error: error.message
    });
  }
});

// ========================================
// API Telemetry Endpoints
// ========================================

/**
 * GET /api/features/telemetry
 * Get API telemetry data
 * Query params: ?period=24h&endpoint=/api/chat
 */
router.get('/telemetry', async (req, res) => {
  try {
    const { period, endpoint } = req.query;

    // Calculate time window
    const now = new Date();
    let startTime = new Date();

    switch (period) {
      case '1h':
        startTime.setHours(now.getHours() - 1);
        break;
      case '24h':
        startTime.setHours(now.getHours() - 24);
        break;
      case '7d':
        startTime.setDate(now.getDate() - 7);
        break;
      case '30d':
        startTime.setDate(now.getDate() - 30);
        break;
      default:
        startTime.setHours(now.getHours() - 24); // Default 24h
    }

    const query = {
      timestamp: { $gte: startTime }
    };

    if (endpoint) {
      query.endpoint = endpoint;
    }

    const telemetryData = await ApiTelemetry.find(query).sort({ timestamp: -1 });

    res.json({
      status: 'success',
      data: telemetryData,
      total: telemetryData.length,
      period,
      startTime,
      endTime: now
    });

  } catch (error) {
    logger.error('Failed to get API telemetry', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch API telemetry',
      error: error.message
    });
  }
});

/**
 * GET /api/features/telemetry/summary
 * Get telemetry summary statistics
 */
router.get('/telemetry/summary', async (req, res) => {
  try {
    const { period = '24h' } = req.query;

    // Calculate time window
    const now = new Date();
    let startTime = new Date();

    switch (period) {
      case '1h':
        startTime.setHours(now.getHours() - 1);
        break;
      case '24h':
        startTime.setHours(now.getHours() - 24);
        break;
      case '7d':
        startTime.setDate(now.getDate() - 7);
        break;
      case '30d':
        startTime.setDate(now.getDate() - 30);
        break;
      default:
        startTime.setHours(now.getHours() - 24);
    }

    const summary = await ApiTelemetry.aggregate([
      { $match: { timestamp: { $gte: startTime } } },
      {
        $group: {
          _id: '$endpoint',
          totalHits: { $sum: 1 },
          avgLatency: { $avg: '$latencyMs' },
          errorCount: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
          successCount: { $sum: { $cond: [{ $lt: ['$statusCode', 400] }, 1, 0] } }
        }
      },
      { $sort: { totalHits: -1 } }
    ]);

    res.json({
      status: 'success',
      data: summary,
      period,
      startTime,
      endTime: now
    });

  } catch (error) {
    logger.error('Failed to get telemetry summary', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate telemetry summary',
      error: error.message
    });
  }
});

// ========================================
// Feature Usage Endpoints
// ========================================

/**
 * GET /api/features/adoption
 * Get adoption statistics for all features
 */
router.get('/adoption', async (req, res) => {
  try {
    const { period = '30d' } = req.query;

    // Calculate time window
    const now = new Date();
    let startTime = new Date();
    const days = parseInt(period.replace('d', '')) || 30;
    startTime.setDate(now.getDate() - days);

    // 1. Get all documented features
    const inventory = await FeatureInventory.find({}).lean();
    
    // 2. Get Total User Count (using UserProfile as User model)
    // Note: Assuming UserProfile is the main user model registered as 'User' or we use raw collection
    // We'll rely on Mongoose to find the 'users' collection count if possible, or count UserProfile
    // But since we don't have 'User' model imported, we'll try to find it via mongoose or just use a placeholder
    // Safe approach: Count unique users in FeatureUsage + buffer? 
    // Ideally we'd import UserProfile. 
    // Let's assume UserProfile is the canonical user list.
    const UserProfile = mongoose.models.User || mongoose.models.UserProfile;
    if (!UserProfile) {
      throw new Error('User model is not registered');
    }
    const totalUsers = await UserProfile.countDocuments({});

    // 3. Aggregate Usage by Feature
    const usageStats = await FeatureUsage.aggregate([
      { 
        $match: { 'metadata.timestamp': { $gte: startTime } } 
      },
      { 
        $group: { 
          _id: "$feature", 
          uniqueUsers: { $addToSet: "$userId" } 
        } 
      },
      { 
        $project: { 
          feature: "$_id", 
          activeUsers: { $size: "$uniqueUsers" } 
        } 
      }
    ]);

    // Map stats to a lookup object
    const statsMap = {};
    usageStats.forEach(stat => {
      statsMap[stat.feature] = stat.activeUsers;
    });

    // 4. Merge Inventory with Stats
    const adoptionData = inventory.map(feat => {
      const activeUsers = statsMap[feat.name] || 0;
      const adoptionRate = totalUsers > 0 ? Math.round((activeUsers / totalUsers) * 100) : 0;
      
      let status = 'unused';
      if (adoptionRate > 50) status = 'strong';
      else if (adoptionRate >= 20) status = 'moderate';
      else if (activeUsers > 0) status = 'weak';

      return {
        name: feat.name,
        category: feat.category,
        users: activeUsers,
        adoptionRate: adoptionRate,
        status: status,
        totalUsers: totalUsers, // Include for frontend context
        trend: 0 // Placeholder for trend calculation (requires comparing two periods)
      };
    });

    res.json({
      status: 'success',
      data: adoptionData,
      totalUsers,
      period
    });

  } catch (error) {
    logger.error('Failed to get feature adoption stats', { error: error.message });
    // Fallback if User model issues
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate adoption stats',
      error: error.message
    });
  }
});

/**
 * GET /api/features/usage
 * Get feature usage statistics
 */
router.get('/usage', async (req, res) => {
  try {
    const { featureName, period = '30d' } = req.query;

    // Calculate time window
    const now = new Date();
    let startTime = new Date();

    switch (period) {
      case '7d':
        startTime.setDate(now.getDate() - 7);
        break;
      case '30d':
        startTime.setDate(now.getDate() - 30);
        break;
      case '90d':
        startTime.setDate(now.getDate() - 90);
        break;
      default:
        startTime.setDate(now.getDate() - 30);
    }

    const query = {
      date: { $gte: startTime }
    };

    if (featureName) {
      query.featureName = featureName;
    }

    const usageData = await FeatureUsage.find(query).sort({ date: -1 });

    res.json({
      status: 'success',
      data: usageData,
      total: usageData.length,
      period,
      startTime,
      endTime: now
    });

  } catch (error) {
    logger.error('Failed to get feature usage', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch feature usage',
      error: error.message
    });
  }
});

// ========================================
// Feature Flags Endpoints
// ========================================

/**
 * GET /api/features/flags
 * Get all feature flags
 */
router.get('/flags', async (req, res) => {
  try {
    const flags = await FeatureFlag.find({}).sort({ name: 1 });

    res.json({
      status: 'success',
      data: flags,
      total: flags.length
    });

  } catch (error) {
    logger.error('Failed to get feature flags', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch feature flags',
      error: error.message
    });
  }
});

/**
 * GET /api/features/flags/:name
 * Get specific feature flag
 */
router.get('/flags/:name', async (req, res) => {
  try {
    const flag = await FeatureFlag.findOne({ name: req.params.name });

    if (!flag) {
      return res.status(404).json({
        status: 'error',
        message: 'Feature flag not found',
        name: req.params.name
      });
    }

    res.json({
      status: 'success',
      data: flag
    });

  } catch (error) {
    logger.error('Failed to get feature flag', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch feature flag',
      error: error.message
    });
  }
});

/**
 * POST /api/features/flags
 * Create or update feature flag
 */
router.post('/flags', requireAuth, async (req, res) => {
  try {
    const { name, enabled, description, rolloutPercentage } = req.body;

    let flag = await FeatureFlag.findOne({ name });

    if (flag) {
      // Update existing
      flag.enabled = enabled !== undefined ? enabled : flag.enabled;
      flag.description = description || flag.description;
      flag.rolloutPercentage = rolloutPercentage !== undefined ? rolloutPercentage : flag.rolloutPercentage;

      await flag.save();
    } else {
      // Create new
      flag = new FeatureFlag({
        name,
        enabled: enabled !== undefined ? enabled : false,
        description,
        rolloutPercentage: rolloutPercentage || 100
      });

      await flag.save();
    }

    logger.info('Feature flag updated', { name, enabled: flag.enabled, user: req.user?.username });

    res.json({
      status: 'success',
      data: flag,
      message: `Feature flag "${name}" ${flag.isNew ? 'created' : 'updated'} successfully`
    });

  } catch (error) {
    logger.error('Failed to update feature flag', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to update feature flag',
      error: error.message
    });
  }
});

/**
 * PUT /api/features/flags/:name/toggle
 * Toggle feature flag on/off
 */
router.put('/flags/:name/toggle', requireAuth, async (req, res) => {
  try {
    const flag = await FeatureFlag.findOne({ name: req.params.name });

    if (!flag) {
      return res.status(404).json({
        status: 'error',
        message: 'Feature flag not found',
        name: req.params.name
      });
    }

    flag.enabled = !flag.enabled;
    await flag.save();

    logger.info('Feature flag toggled', { name: flag.name, enabled: flag.enabled, user: req.user?.username });

    res.json({
      status: 'success',
      data: flag,
      message: `Feature flag "${flag.name}" is now ${flag.enabled ? 'enabled' : 'disabled'}`
    });

  } catch (error) {
    logger.error('Failed to toggle feature flag', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to toggle feature flag',
      error: error.message
    });
  }
});

/**
 * DELETE /api/features/flags/:name
 * Delete feature flag
 */
router.delete('/flags/:name', requireAuth, async (req, res) => {
  try {
    const flag = await FeatureFlag.findOneAndDelete({ name: req.params.name });

    if (!flag) {
      return res.status(404).json({
        status: 'error',
        message: 'Feature flag not found',
        name: req.params.name
      });
    }

    logger.info('Feature flag deleted', { name: flag.name, user: req.user?.username });

    res.json({
      status: 'success',
      message: `Feature flag "${flag.name}" deleted successfully`
    });

  } catch (error) {
    logger.error('Failed to delete feature flag', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete feature flag',
      error: error.message
    });
  }
});

// ========================================
// Admin Activity Log Endpoints (Tab 4)
// ========================================

/**
 * GET /api/features/activity
 * Get recent admin activity log
 */
router.get('/activity', async (req, res) => {
  try {
    const { limit = 50, action, userId } = req.query;

    const filters = {};
    if (action) filters.action = action;
    if (userId) filters.userId = userId;

    const logs = await ActivityLog.getRecentActivity(parseInt(limit), filters);

    res.json({
      status: 'success',
      data: logs,
      total: logs.length
    });

  } catch (error) {
    logger.error('Failed to get activity log', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch activity log',
      error: error.message
    });
  }
});

/**
 * POST /api/features/system-actions
 * Execute system actions (scan, clear telemetry, export, sync)
 */
router.post('/system-actions', requireAuth, async (req, res) => {
  try {
    const { action } = req.body;

    // Log the activity
    await ActivityLog.logActivity({
      action: 'system_action',
      userId: req.user?._id,
      username: req.user?.username,
      target: action,
      details: { action, timestamp: new Date() },
      status: 'pending'
    });

    let result = {};
    let message = '';

    switch (action) {
      case 'scan':
        // Trigger codebase scan (placeholder - implement actual scan logic)
        result = { scanned: 0, found: 0, updated: 0 };
        message = 'Codebase scan initiated (placeholder)';
        logger.info('Codebase scan triggered', { user: req.user?.username });
        break;

      case 'clear_telemetry':
        // Clear telemetry data
        const deleteResult = await ApiTelemetry.deleteMany({});
        result = { deleted: deleteResult.deletedCount };
        message = `Cleared ${deleteResult.deletedCount} telemetry records`;
        logger.warn('Telemetry data cleared', { user: req.user?.username, count: deleteResult.deletedCount });
        break;

      case 'export':
        // Export alignment report (placeholder)
        const features = await FeatureInventory.find({});
        result = { exported: features.length, format: 'csv' };
        message = 'Export prepared (download not implemented)';
        logger.info('Alignment report exported', { user: req.user?.username, count: features.length });
        break;

      case 'sync_roadmap':
        // Sync roadmap (placeholder - implement actual sync logic)
        result = { synced: 0, updated: 0 };
        message = 'Roadmap sync initiated (placeholder)';
        logger.info('Roadmap sync triggered', { user: req.user?.username });
        break;

      default:
        return res.status(400).json({
          status: 'error',
          message: 'Invalid action',
          validActions: ['scan', 'clear_telemetry', 'export', 'sync_roadmap']
        });
    }

    // Update activity log with success
    await ActivityLog.logActivity({
      action: 'system_action',
      userId: req.user?._id,
      username: req.user?.username,
      target: action,
      details: { action, result },
      status: 'success'
    });

    res.json({
      status: 'success',
      message,
      data: result
    });

  } catch (error) {
    // Log failure
    await ActivityLog.logActivity({
      action: 'system_action',
      userId: req.user?._id,
      username: req.user?.username,
      target: req.body.action,
      details: { action: req.body.action, error: error.message },
      status: 'failure',
      errorMessage: error.message
    });

    logger.error('System action failed', { action: req.body.action, error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'System action failed',
      error: error.message
    });
  }
});

module.exports = router;
