/**
 * Ollama VRAM Routes
 * Fetches NVIDIA VRAM usage for each configured Ollama host via SSH + nvidia-smi.
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { requireAuth } = require('../src/middleware/auth');
const ollamaVramService = require('../src/services/ollamaVramService');

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
 * Returns VRAM usage per configured Ollama host.
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

module.exports = router;
