'use strict';

// The instance chooses one Immich directory. Browser requests cannot widen it.
const fs = require('node:fs');
const path = require('node:path');
const { createImmichClient, photoError } = require('./immichClient');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = () => photoError(503, 'PHOTO_FRAME_NOT_CONFIGURED', 'Photo frame is not configured');

function loadFrameConfig(env = process.env) {
  if (!env.AGENTX_INSTANCE_ROOT) return null;
  const file = path.join(env.AGENTX_INSTANCE_ROOT, 'config/photo-frame.json');
  let raw;
  try {
    if (fs.statSync(file).size > 4096) throw fail();
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw fail();
  }
  const prefix = raw?.originalPathPrefix;
  if (raw.version !== 1 || typeof prefix !== 'string' || prefix.length > 1024
    || !prefix.startsWith('/') || prefix === '/' || prefix.includes('\\') || prefix.includes('\0')
    || path.posix.normalize(prefix) !== prefix || prefix.endsWith('/')) throw fail();
  const seconds = (value, fallback, min) => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < min || value > 3600) throw fail();
    return value;
  };
  return { prefix, idleSeconds: seconds(raw.idleSeconds, 120, 30), intervalSeconds: seconds(raw.intervalSeconds, 30, 5) };
}

function createPhotoFrameService({ client = createImmichClient(), config = () => loadFrameConfig() } = {}) {
  function settings() {
    const value = config();
    if (!value || !client.settings().enabled) throw fail();
    return value;
  }
  // Also verify upstream results: a prefix without its slash must not match a sibling.
  function allowed(asset, value) {
    return asset && UUID.test(String(asset.id)) && asset.type === 'IMAGE'
      && asset.visibility === 'timeline' && !asset.isTrashed && !asset.isOffline
      && typeof asset.originalPath === 'string' && asset.originalPath.startsWith(value.prefix + '/')
      && path.posix.normalize(asset.originalPath) === asset.originalPath;
  }
  return {
    status() {
      try {
        const value = settings();
        return { enabled: true, idleSeconds: value.idleSeconds, intervalSeconds: value.intervalSeconds };
      } catch { return { enabled: false }; }
    },
    async next(exclude) {
      const value = settings();
      if (exclude !== undefined && !UUID.test(String(exclude))) throw photoError(400, 'PHOTOS_BAD_REQUEST', 'Invalid previous image');
      const filter = { originalPath: { startsWith: value.prefix + '/' }, type: { eq: 'IMAGE' },
        visibility: { eq: 'timeline' }, isOffline: { eq: false }, trashedAt: { eq: null } };
      if (exclude) filter.id = { ne: exclude };
      const rows = await client.json('/search/random', { method: 'POST', body: { size: 1, filter } });
      if (!Array.isArray(rows) || rows.some(asset => !allowed(asset, value))) {
        throw photoError(502, 'PHOTO_FRAME_INVALID_RESULT', 'Photo frame received an invalid image');
      }
      const asset = rows[0];
      return asset ? { id: asset.id, src: '/api/photos/frame/' + asset.id + '/image' } : null;
    },
    async image(id) {
      const value = settings();
      if (!UUID.test(String(id))) throw photoError(400, 'PHOTOS_BAD_REQUEST', 'Invalid image');
      const asset = await client.json('/assets/' + id);
      if (String(asset?.id).toLowerCase() !== String(id).toLowerCase() || !allowed(asset, value)) {
        throw photoError(404, 'PHOTOS_NOT_FOUND', 'Photo frame has no such image');
      }
      return client.image('/assets/' + id + '/thumbnail?size=preview');
    },
  };
}

module.exports = { createPhotoFrameService, loadFrameConfig };
