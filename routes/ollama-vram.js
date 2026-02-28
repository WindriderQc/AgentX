/**
 * Ollama VRAM Routes
 * Fetches NVIDIA VRAM usage for each configured Ollama host via SSH + nvidia-smi.
 * Supports manual VRAM overrides for hosts where SSH detection fails (e.g. Windows).
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { requireAuth } = require('../src/middleware/auth');
const ollamaVramService = require('../src/services/ollamaVramService');
const HostVramOverride = require('../models/HostVramOverride');

function getConfiguredHosts() {
  const hosts = [];

  const normalizeHostUrl = (raw) => {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `http://${trimmed}`;
  };

  const envFirst = (...keys) => {
    for (const key of keys) {
      const v = process.env[key];
      if (v && String(v).trim()) return String(v).trim();
    }
    return null;
  };

  const primaryRaw = envFirst('OLLAMA_HOST', 'OLLAMA_HOST_1', 'OLLAMA_HOST_PRIMARY');
  const primaryUrl = normalizeHostUrl(primaryRaw);
  if (primaryUrl) {
    hosts.push({ id: 'primary', name: 'Primary', url: primaryUrl, priority: 1 });
  }

  const secondaryRaw = envFirst('OLLAMA_HOST_2', 'OLLAMA_HOST_HEAVY', 'OLLAMA_HOST_SECONDARY');
  const secondaryUrl = normalizeHostUrl(secondaryRaw);
  if (secondaryUrl) {
    hosts.push({ id: 'secondary', name: 'Secondary', url: secondaryUrl, priority: 2 });
  }

  const tertiaryRaw = envFirst('OLLAMA_HOST_3', 'OLLAMA_HOST_TERTIARY');
  const tertiaryUrl = normalizeHostUrl(tertiaryRaw);
  if (tertiaryUrl) {
    hosts.push({ id: 'tertiary', name: 'Tertiary', url: tertiaryUrl, priority: 3 });
  }

  return hosts;
}

/**
 * GET /api/ollama-vram
 * Returns VRAM usage per configured Ollama host (includes _source and actionRequired fields).
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const configuredHosts = getConfiguredHosts();
    const hosts = await ollamaVramService.getVramForHosts(configuredHosts);

    res.json({
      status: 'success',
      data: {
        hosts,
        total: hosts.length,
        ok: hosts.filter(h => h.ok).length
      }
    });
  } catch (err) {
    logger.error('Failed to fetch Ollama VRAM metrics', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch VRAM metrics',
      error: err.message
    });
  }
});

/**
 * POST /api/ollama-vram/override
 * Set a manual VRAM override for a host (highest priority in fallback chain).
 * Body: { hostIp: string, vramMiB: number }
 */
router.post('/override', requireAuth, async (req, res) => {
  try {
    const { hostIp, vramMiB } = req.body || {};
    if (!hostIp || typeof hostIp !== 'string') {
      return res.status(400).json({ status: 'error', message: 'hostIp is required' });
    }
    const vram = Number.parseInt(vramMiB, 10);
    if (!Number.isFinite(vram) || vram <= 0) {
      return res.status(400).json({ status: 'error', message: 'vramMiB must be a positive integer' });
    }

    const normalizedIp = hostIp.trim().toLowerCase();
    const doc = await HostVramOverride.findOneAndUpdate(
      { hostIp: normalizedIp },
      { hostIp: normalizedIp, vramMiB: vram, updatedBy: 'ui', updatedAt: new Date() },
      { upsert: true, new: true }
    );

    // Invalidate VRAM cache for this host so next sync picks up the override
    ollamaVramService.cache.delete(normalizedIp);

    logger.info('VRAM override set via UI', { hostIp: normalizedIp, vramMiB: vram });

    res.json({ status: 'success', data: { hostIp: doc.hostIp, vramMiB: doc.vramMiB } });
  } catch (err) {
    logger.error('Failed to set VRAM override', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * DELETE /api/ollama-vram/override/:hostIp
 * Clear a manual VRAM override for a host.
 */
router.delete('/override/:hostIp', requireAuth, async (req, res) => {
  try {
    const normalizedIp = (req.params.hostIp || '').trim().toLowerCase();
    if (!normalizedIp) {
      return res.status(400).json({ status: 'error', message: 'hostIp is required' });
    }

    const result = await HostVramOverride.deleteOne({ hostIp: normalizedIp });

    // Invalidate cache
    ollamaVramService.cache.delete(normalizedIp);

    logger.info('VRAM override cleared', { hostIp: normalizedIp, deleted: result.deletedCount });

    res.json({ status: 'success', deleted: result.deletedCount > 0 });
  } catch (err) {
    logger.error('Failed to clear VRAM override', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
