const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const router = express.Router();

const { optionalAuth } = require('../src/middleware/auth');
const { getUserId } = require('../src/helpers/userHelpers');

function isNotFoundError(err) {
  return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (isNotFoundError(err)) return null;
    return null;
  }
}

function getUserGalleryKey(res) {
  const raw = res.locals.user?.userId || getUserId(res);
  return String(raw || 'default').replace(/\0/g, '').replace(/[\\/]/g, '_');
}

router.get('/images', optionalAuth, async (req, res) => {
  const userKey = getUserGalleryKey(res);
  const generatedRoot = path.join(__dirname, '..', 'public', 'generated', userKey);

  try {
    const entries = await fs.readdir(generatedRoot, { withFileTypes: true });
    const imageFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /\.(png|jpe?g|webp|gif)$/i.test(name));

    const items = await Promise.all(imageFiles.map(async (filename) => {
      const filePath = path.join(generatedRoot, filename);
      const stat = await fs.stat(filePath);
      const base = filename.replace(/\.[^.]+$/, '');
      const metaPath = path.join(generatedRoot, `${base}.json`);
      const meta = await readJsonIfExists(metaPath);

      return {
        id: meta?.id || base,
        url: `/generated/${encodeURIComponent(userKey)}/${encodeURIComponent(filename)}`,
        prompt: meta?.prompt || meta?.input || '',
        model: meta?.model || meta?.meta?.model || '',
        timestamp: meta?.timestamp || stat.mtime.toISOString(),
        metadata: meta?.metadata || meta?.meta || null
      };
    }));

    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const limitRaw = Number.parseInt(String(req.query.limit ?? '200'), 10);
    const offsetRaw = Number.parseInt(String(req.query.offset ?? '0'), 10);
    const limit = Math.max(0, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 200));
    const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

    return res.json(items.slice(offset, offset + limit));
  } catch (err) {
    if (isNotFoundError(err)) {
      return res.json([]);
    }
    return res.status(500).json({ error: 'Failed to load images' });
  }
});

module.exports = router;
