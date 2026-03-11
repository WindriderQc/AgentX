const express = require('express');
const logger = require('../config/logger');
const { requireAuth, optionalAuth } = require('../src/middleware/auth');
const { optionalWorkspaceContext } = require('../src/middleware/workspace');
const PatchProposal = require('../models/PatchProposal');
const {
  approvePatchProposal,
  rejectPatchProposal
} = require('../src/services/patchProposalService');

const router = express.Router();

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function isLoopbackIp(ip) {
  const value = String(ip || '').toLowerCase();
  return value === '127.0.0.1'
    || value === '::1'
    || value === '::ffff:127.0.0.1';
}

function requireProposalBridgeAccess(req, res, next) {
  if (res.locals.user || req.authSource === 'api-key' || req.authSource === 'api-key-v2' || isLoopbackIp(req.ip)) {
    return next();
  }

  return res.status(401).json({
    status: 'error',
    message: 'Authentication required'
  });
}

function getActorSource(req) {
  const requestedSource = String(req.body?.source || req.query?.source || '').trim().toLowerCase();
  if (requestedSource === 'telegram') {
    return 'telegram';
  }
  if (requestedSource === 'api' || req.authSource === 'api-key' || req.authSource === 'api-key-v2' || !req.user) {
    return 'api';
  }
  return 'console';
}

router.get('/', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const workspaceId = req.workspace?._id || null;
    const status = req.query.status ? String(req.query.status) : null;
    const limit = parsePositiveInt(req.query.limit, 20);
    const page = parsePositiveInt(req.query.page, 1);
    const skip = (page - 1) * limit;

    const query = {};
    if (workspaceId) {
      query.workspaceId = workspaceId;
    }
    if (status) {
      query.status = status;
    }

    const [proposals, total] = await Promise.all([
      PatchProposal.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('targetFile diffSummary blastRadius status expiresAt approvedAt appliedAt rejectedAt createdAt sourceTaskId applyTaskId')
        .lean(),
      PatchProposal.countDocuments(query)
    ]);

    res.json({
      status: 'success',
      data: {
        proposals,
        total,
        page,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    logger.error('Failed to list patch proposals', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve patch proposals'
    });
  }
});

router.get('/:id', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const workspaceId = req.workspace?._id || null;
    const query = { _id: req.params.id };
    if (workspaceId) {
      query.workspaceId = workspaceId;
    }

    const proposal = await PatchProposal.findOne(query)
      .populate('sourceTaskId', 'type status completedAt')
      .populate('applyTaskId', 'type status completedAt')
      .lean();

    if (!proposal) {
      return res.status(404).json({
        status: 'error',
        message: 'Patch proposal not found'
      });
    }

    return res.json({
      status: 'success',
      data: proposal
    });
  } catch (error) {
    logger.error('Failed to get patch proposal detail', {
      error: error.message,
      proposalId: req.params.id
    });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve patch proposal'
    });
  }
});

router.post('/:id/approve', optionalAuth, optionalWorkspaceContext, requireProposalBridgeAccess, async (req, res) => {
  try {
    const result = await approvePatchProposal(req.params.id, {
      actorSource: getActorSource(req),
      actorUserId: res.locals.user?.userId || req.user?.userId || null,
      workspaceId: req.workspace?._id || null
    });

    return res.json({
      status: 'success',
      data: {
        proposal: result.proposal,
        applyTask: result.applyTask
      }
    });
  } catch (error) {
    logger.error('Failed to approve patch proposal', {
      error: error.message,
      proposalId: req.params.id
    });
    return res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || 'Failed to approve patch proposal'
    });
  }
});

router.post('/:id/reject', optionalAuth, optionalWorkspaceContext, requireProposalBridgeAccess, async (req, res) => {
  try {
    const proposal = await rejectPatchProposal(req.params.id, {
      actorSource: getActorSource(req),
      actorUserId: res.locals.user?.userId || req.user?.userId || null,
      workspaceId: req.workspace?._id || null
    });

    return res.json({
      status: 'success',
      data: proposal
    });
  } catch (error) {
    logger.error('Failed to reject patch proposal', {
      error: error.message,
      proposalId: req.params.id
    });
    return res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || 'Failed to reject patch proposal'
    });
  }
});

module.exports = router;
