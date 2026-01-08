/**
 * API Key Management Routes
 *
 * CRUD operations for API keys with scope management
 */

const express = require('express');
const router = express.Router();
const APIKey = require('../models/APIKey');
const { requireAuth } = require('../src/middleware/auth');
const { auditApiKeyOps } = require('../src/middleware/auditLogger');
const { attachWorkspace } = require('../src/middleware/workspace');
const logger = require('../config/logger');

/**
 * GET /api/keys
 * List user's API keys (prefix only, never show full key)
 * Workspace-aware: only shows keys for current workspace
 */
router.get('/', requireAuth, attachWorkspace, async (req, res) => {
  try {
    const userId = res.locals.user.userId;

    // Build query with workspace filter
    const query = { userId };
    if (req.workspace) {
      query.workspaceId = req.workspace._id;
    }

    const keys = await APIKey.find(query)
      .select('_id name keyPrefix scopes revokedAt expiresAt lastUsedAt usageCount createdAt')
      .sort({ createdAt: -1 });

    res.json({
      status: 'success',
      data: keys.map(key => ({
        id: key._id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        scopes: key.scopes,
        revoked: !!key.revokedAt,
        expired: key.expiresAt && key.expiresAt < new Date(),
        lastUsedAt: key.lastUsedAt,
        usageCount: key.usageCount,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt
      }))
    });
  } catch (error) {
    logger.error('List API keys error', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/keys
 * Create new API key
 * Workspace-aware: creates key scoped to current workspace
 */
router.post('/', requireAuth, attachWorkspace, auditApiKeyOps.created, async (req, res) => {
  try {
    const userId = res.locals.user.userId;
    const { name, scopes, expiresInDays } = req.body;

    // Validate inputs
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ status: 'error', message: 'Name is required' });
    }

    if (!Array.isArray(scopes) || scopes.length === 0) {
      return res.status(400).json({ status: 'error', message: 'At least one scope is required' });
    }

    // Calculate expiration
    let expiresAt = null;
    if (expiresInDays && expiresInDays > 0) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiresInDays);
    }

    // Create key with workspace context
    const { key, doc } = await APIKey.createKey({
      userId,
      name: name.trim(),
      scopes,
      expiresAt,
      workspaceId: req.workspace?._id || null
    });

    logger.info('API key created', {
      userId,
      keyId: doc._id,
      name: doc.name,
      scopes: doc.scopes
    });

    // Return full key ONCE (never stored, never shown again)
    res.json({
      status: 'success',
      message: 'API key created. Save this key now - it will not be shown again!',
      data: {
        id: doc._id,
        key, // Full key shown once
        keyPrefix: doc.keyPrefix,
        name: doc.name,
        scopes: doc.scopes,
        expiresAt: doc.expiresAt,
        createdAt: doc.createdAt
      }
    });
  } catch (error) {
    logger.error('Create API key error', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * DELETE /api/keys/:id
 * Revoke API key
 */
router.delete('/:id', requireAuth, auditApiKeyOps.revoked, async (req, res) => {
  try {
    const userId = res.locals.user.userId;
    const { id } = req.params;
    const { reason } = req.body;

    const key = await APIKey.findOne({ _id: id, userId });

    if (!key) {
      return res.status(404).json({ status: 'error', message: 'API key not found' });
    }

    if (key.revokedAt) {
      return res.status(400).json({ status: 'error', message: 'API key already revoked' });
    }

    await key.revoke(reason || 'Manual revocation');

    logger.info('API key revoked', {
      userId,
      keyId: key._id,
      name: key.name,
      reason
    });

    res.json({
      status: 'success',
      message: 'API key revoked',
      data: {
        id: key._id,
        name: key.name,
        revokedAt: key.revokedAt
      }
    });
  } catch (error) {
    logger.error('Revoke API key error', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/keys/:id/rotate
 * Rotate API key (revoke old, create new with same scopes)
 */
router.post('/:id/rotate', requireAuth, auditApiKeyOps.rotated, async (req, res) => {
  try {
    const userId = res.locals.user.userId;
    const { id } = req.params;

    const { key, doc } = await APIKey.rotateKey(id, userId);

    logger.info('API key rotated', {
      userId,
      oldKeyId: id,
      newKeyId: doc._id,
      name: doc.name
    });

    res.json({
      status: 'success',
      message: 'API key rotated. Save this new key now - it will not be shown again!',
      data: {
        id: doc._id,
        key, // Full key shown once
        keyPrefix: doc.keyPrefix,
        name: doc.name,
        scopes: doc.scopes,
        expiresAt: doc.expiresAt,
        createdAt: doc.createdAt
      }
    });
  } catch (error) {
    logger.error('Rotate API key error', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/keys/scopes
 * List available scopes
 */
router.get('/scopes', requireAuth, async (req, res) => {
  res.json({
    status: 'success',
    data: [
      { scope: 'chat:read', description: 'Read chat messages and history' },
      { scope: 'chat:write', description: 'Send chat messages' },
      { scope: 'rag:read', description: 'Search RAG documents' },
      { scope: 'rag:write', description: 'Ingest and manage RAG documents' },
      { scope: 'models:read', description: 'List available models' },
      { scope: 'models:write', description: 'Manage custom models' },
      { scope: 'admin:read', description: 'View admin dashboards and logs' },
      { scope: 'admin:write', description: 'Perform admin operations' },
      { scope: 'admin:*', description: 'Full admin access' },
      { scope: '*:*', description: 'Full system access (use with caution)' }
    ]
  });
});

module.exports = router;
