const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { requireAuth, optionalAuth } = require('../src/middleware/auth');
const { optionalWorkspaceContext } = require('../src/middleware/workspace');
const SpecialX = require('../models/SpecialX');
const AutomationTask = require('../models/AutomationTask');
const AutomationRun = require('../models/AutomationRun');
const { getAutomationRunnerService } = require('../src/services/automationRunnerService');
const { HOSTS, getRoutingStatus, getFailoverStatus, switchHost, resetToPrimary } = require('../src/services/modelRouter');

function requireSessionOrApiKey(req, res, next) {
  if (res.locals.user || req.authSource === 'api-key' || req.authSource === 'api-key-v2') {
    return next();
  }

  return res.status(401).json({
    status: 'error',
    message: 'Authentication required'
  });
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

// Dashboard status
router.get('/status', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const service = getAutomationRunnerService();
    const status = await service.getStatus();
    res.json(status);
  } catch (error) {
    logger.error('Failed to get SpecialX status', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve SpecialX status'
    });
  }
});

// Routing state and host options for UI/operator controls
router.get('/routing', requireAuth, async (_req, res) => {
  try {
    const [routingStatus, failoverStatus] = await Promise.all([
      getRoutingStatus(),
      Promise.resolve(getFailoverStatus())
    ]);

    const hostOptions = [
      { id: 'primary', label: 'Primary', url: HOSTS.primary || null },
      { id: 'secondary', label: 'Secondary', url: HOSTS.secondary || null }
    ].filter((h) => Boolean(h.url));

    res.json({
      status: 'success',
      data: {
        hostOptions,
        activeHost: failoverStatus.currentHost || HOSTS.primary || null,
        failover: failoverStatus,
        routing: routingStatus
      }
    });
  } catch (error) {
    logger.error('Failed to get SpecialX routing status', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve routing status'
    });
  }
});

// Switch active host used by model router (runtime failover control)
router.post('/routing/active-host', requireAuth, async (req, res) => {
  try {
    const { host } = req.body || {};
    const requested = typeof host === 'string' ? host.trim() : '';

    if (!requested) {
      return res.status(400).json({
        status: 'error',
        message: 'host is required (primary | secondary | reset | host url)'
      });
    }

    if (requested === 'reset' || requested === 'primary') {
      resetToPrimary('specialx_manual_switch');
    } else if (requested === 'secondary') {
      if (!HOSTS.secondary) {
        return res.status(400).json({
          status: 'error',
          message: 'Secondary host is not configured'
        });
      }
      switchHost(HOSTS.secondary, 'specialx_manual_switch');
    } else if (/^https?:\/\//i.test(requested)) {
      switchHost(requested, 'specialx_manual_switch_custom');
    } else {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid host value. Use primary, secondary, reset, or full URL.'
      });
    }

    const failover = getFailoverStatus();
    res.json({
      status: 'success',
      data: {
        activeHost: failover.currentHost,
        failover
      }
    });
  } catch (error) {
    logger.error('Failed to switch SpecialX active host', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to switch active host'
    });
  }
});

// Runner controls (manual ops)
router.post('/runner/start', requireAuth, async (_req, res) => {
  try {
    const service = getAutomationRunnerService();
    await service.start();
    const status = await service.getStatus();
    res.json(status);
  } catch (error) {
    logger.error('Failed to start SpecialX runner', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to start runner'
    });
  }
});

router.post('/runner/stop', requireAuth, async (_req, res) => {
  try {
    const service = getAutomationRunnerService();
    service.stop();
    const status = await service.getStatus();
    res.json(status);
  } catch (error) {
    logger.error('Failed to stop SpecialX runner', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to stop runner'
    });
  }
});

router.post('/runner/tick', requireAuth, async (_req, res) => {
  try {
    const service = getAutomationRunnerService();
    await service.tick();
    const status = await service.getStatus();
    res.json(status);
  } catch (error) {
    logger.error('Failed to tick SpecialX runner', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to tick runner'
    });
  }
});

// List SpecialX profiles
router.get('/agents', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const workspaceId = req.workspace?._id || null;
    const agents = await SpecialX.getActive(workspaceId);
    res.json({
      status: 'success',
      data: agents
    });
  } catch (error) {
    logger.error('Failed to get SpecialX agents', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve agents'
    });
  }
});

// Create or update SpecialX profile
router.post('/agents', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const workspaceId = req.workspace?._id || null;
    const {
      id,
      name,
      displayName,
      purpose,
      description,
      promptProfile,
      toolPolicy,
      modelPolicy,
      taskTypes,
      schedule,
      isActive
    } = req.body || {};

    if (!name || !displayName || !purpose) {
      return res.status(400).json({
        status: 'error',
        message: 'name, displayName and purpose are required'
      });
    }

    const payload = {
      workspaceId,
      name: String(name).trim(),
      displayName: String(displayName).trim(),
      purpose: String(purpose).trim(),
      description: description || '',
      promptProfile: promptProfile || {},
      toolPolicy: toolPolicy || {},
      modelPolicy: modelPolicy || {},
      taskTypes: Array.isArray(taskTypes) ? taskTypes : [],
      schedule: schedule || {},
      isActive: typeof isActive === 'boolean' ? isActive : true
    };

    const profile = id
      ? await SpecialX.findOneAndUpdate({ _id: id, workspaceId }, payload, { new: true, runValidators: true })
      : await SpecialX.create(payload);

    if (!profile) {
      return res.status(404).json({
        status: 'error',
        message: 'SpecialX profile not found'
      });
    }

    res.json({
      status: 'success',
      data: profile
    });
  } catch (error) {
    logger.error('Failed to upsert SpecialX profile', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.code === 11000 ? 'SpecialX profile name already exists' : 'Failed to save profile'
    });
  }
});

// Enqueue task (supports session auth and API-key auth for automation)
router.post('/tasks', optionalAuth, optionalWorkspaceContext, requireSessionOrApiKey, async (req, res) => {
  try {
    const service = getAutomationRunnerService();
    const workspaceId = req.workspace?._id || null;
    const userId = res.locals.user?.userId || req.user?.userId || null;
    const authSource = req.authSource || 'session';

    const {
      type,
      source,
      priority,
      input,
      runAt,
      maxAttempts,
      specialXId,
      constraints,
      tags,
      idempotencyKey
    } = req.body || {};

    if (!type) {
      return res.status(400).json({
        status: 'error',
        message: 'Task type is required'
      });
    }

    const task = await service.enqueueTask({
      type,
      source,
      priority: priority ? Number(priority) : 5,
      input: input || {},
      runAt,
      maxAttempts: maxAttempts ? Number(maxAttempts) : 3,
      specialXId: specialXId || null,
      constraints: constraints || {},
      tags: Array.isArray(tags) ? tags : [],
      idempotencyKey: idempotencyKey || null
    }, {
      workspaceId,
      userId,
      authSource
    });

    res.status(201).json({
      status: 'success',
      data: task
    });
  } catch (error) {
    logger.error('Failed to enqueue SpecialX task', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.code === 11000 ? 'Duplicate idempotency key' : 'Failed to enqueue task'
    });
  }
});

// Task list
router.get('/tasks', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 20);
    const skip = parsePositiveInt(req.query.skip, 0);
    const workspaceId = req.workspace?._id || null;
    const status = req.query.status ? String(req.query.status) : null;

    const query = {};
    if (workspaceId) {
      query.workspaceId = workspaceId;
    }
    if (status) {
      query.status = status;
    }

    const [tasks, total] = await Promise.all([
      AutomationTask.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('specialXId', 'name displayName')
        .populate('resultRunId', 'status summary finishedAt')
        .lean(),
      AutomationTask.countDocuments(query)
    ]);

    res.json({
      status: 'success',
      data: {
        tasks,
        total,
        page: Math.floor(skip / limit) + 1,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    logger.error('Failed to get SpecialX tasks', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve tasks'
    });
  }
});

router.get('/tasks/:id', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const workspaceId = req.workspace?._id || null;
    const query = { _id: req.params.id };
    if (workspaceId) {
      query.workspaceId = workspaceId;
    }

    const task = await AutomationTask.findOne(query)
      .populate('specialXId', 'name displayName purpose')
      .populate('resultRunId')
      .lean();

    if (!task) {
      return res.status(404).json({
        status: 'error',
        message: 'Task not found'
      });
    }

    const runs = await AutomationRun.find({ taskId: task._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    res.json({
      status: 'success',
      data: { task, runs }
    });
  } catch (error) {
    logger.error('Failed to get SpecialX task detail', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve task detail'
    });
  }
});

router.post('/tasks/:id/cancel', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const workspaceId = req.workspace?._id || null;
    const query = {
      _id: req.params.id,
      status: { $in: ['queued', 'leased'] }
    };
    if (workspaceId) {
      query.workspaceId = workspaceId;
    }

    const task = await AutomationTask.findOneAndUpdate(
      query,
      {
        $set: {
          status: 'cancelled',
          completedAt: new Date(),
          lease: {
            owner: null,
            leasedAt: null,
            leaseExpiresAt: null,
            heartbeatAt: null
          }
        }
      },
      { new: true }
    );

    if (!task) {
      return res.status(404).json({
        status: 'error',
        message: 'Queued or leased task not found'
      });
    }

    res.json({
      status: 'success',
      data: task
    });
  } catch (error) {
    logger.error('Failed to cancel SpecialX task', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to cancel task'
    });
  }
});

// Runs list
router.get('/runs', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 20);
    const skip = parsePositiveInt(req.query.skip, 0);
    const workspaceId = req.workspace?._id || null;
    const status = req.query.status ? String(req.query.status) : null;

    const query = {};
    if (workspaceId) {
      query.workspaceId = workspaceId;
    }
    if (status) {
      query.status = status;
    }

    const [runs, total] = await Promise.all([
      AutomationRun.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('taskId', 'type status priority')
        .populate('specialXId', 'name displayName')
        .lean(),
      AutomationRun.countDocuments(query)
    ]);

    res.json({
      status: 'success',
      data: {
        runs,
        total,
        page: Math.floor(skip / limit) + 1,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    logger.error('Failed to get SpecialX runs', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve runs'
    });
  }
});

router.get('/runs/:id', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const workspaceId = req.workspace?._id || null;
    const query = { _id: req.params.id };
    if (workspaceId) {
      query.workspaceId = workspaceId;
    }

    const run = await AutomationRun.findOne(query)
      .populate('taskId')
      .populate('specialXId', 'name displayName purpose')
      .lean();

    if (!run) {
      return res.status(404).json({
        status: 'error',
        message: 'Run not found'
      });
    }

    res.json({
      status: 'success',
      data: run
    });
  } catch (error) {
    logger.error('Failed to get SpecialX run detail', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve run detail'
    });
  }
});

module.exports = router;
