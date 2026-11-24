'use strict';

// The instance chooses one Immich directory. Browser requests cannot widen it.
const fs = require('node:fs');
const path = require('node:path');
const { createImmichClient, photoError } = require('./immichClient');
const { UUID, fold } = require('./photoFilters');
// Same marker and normalization as PhotoService.
const REVIEW_PENDING_TAG = fold('AgentX/Relecture/à relire');
const canonicalId = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
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
  if (raw?.version !== 1 || typeof prefix !== 'string' || prefix.length > 1024
    || !prefix.startsWith('/') || prefix === '/' || prefix.includes('\\') || prefix.includes('\0')
    || path.posix.normalize(prefix) !== prefix || prefix.endsWith('/')) throw fail();
  const seconds = (value, fallback, min) => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < min || value > 3600) throw fail();
    return value;
  };
  if (raw.albumId !== undefined && !UUID.test(raw.albumId)) throw fail();
  if (raw.source !== undefined && !['directory-and-album', 'album'].includes(raw.source)) throw fail();
  if (raw.source === 'album' && !raw.albumId) throw fail();
  // A malformed or absent conversation grant must not alter the existing frame.
  const grant = raw.conversationLookup;
  const conversationLookup = grant?.enabled === true && canonicalId(grant.albumId)
    ? { enabled: true, albumId: canonicalId(grant.albumId) } : null;
  return { ...(conversationLookup && { conversationLookup }), prefix, ...(raw.albumId ? { albumId: raw.albumId } : {}),
    ...(raw.source ? { source: raw.source } : {}),
    idleSeconds: seconds(raw.idleSeconds, 120, 30), intervalSeconds: seconds(raw.intervalSeconds, 30, 5) };
}

function createPhotoFrameService({ client = createImmichClient(), config = () => loadFrameConfig(), processingConfig = () => require('./photoProcessingConfig').loadProcessingConfig() } = {}) {
  function settings() {
    const value = config();
    if (!value || !client.settings().enabled) throw fail();
    return value;
  }
  // Also verify upstream results: a prefix without its slash must not match a sibling.
  function eligible(asset) {
    return asset && typeof asset.id === 'string' && UUID.test(asset.id) && asset.type === 'IMAGE'
      && asset.visibility === 'timeline' && !asset.isTrashed && !asset.isOffline;
  }
  async function allowed(asset, value) {
    if (!eligible(asset)) return false;
    if (value.source !== 'album' && typeof asset.originalPath === 'string' && asset.originalPath.startsWith(value.prefix + '/')
      && path.posix.normalize(asset.originalPath) === asset.originalPath) return true;
    if (!value.albumId) return false;
    const result = await client.json('/search/metadata', { method: 'POST', body: { size: 1,
      filter: { id: { eq: asset.id }, albumIds: { any: [value.albumId] },
        type: { eq: 'IMAGE' }, visibility: { eq: 'timeline' }, isOffline: { eq: false }, trashedAt: { eq: null } } } });
    const items = result?.assets?.items;
    return Array.isArray(items) && items.length === 1 && items[0].id === asset.id && eligible(items[0]);
  }
  function lookupSettings() {
    const value = settings();
    // The independently designated album is the complete authority. Never
    // inherit the frame's source, prefix, or album even in mixed mode.
    const grant = value.conversationLookup;
    const albumId = canonicalId(grant?.albumId);
    const privateLibraryId = canonicalId(processingConfig()?.libraryId);
    if (grant?.enabled !== true || !albumId || !privateLibraryId) throw fail();
    return { source: 'album', albumId, privateLibraryId };
  }
  function lookupFilter(value) {
    return { albumIds: { any: [value.albumId] }, type: { eq: 'IMAGE' },
      visibility: { eq: 'timeline' }, isOffline: { eq: false }, trashedAt: { eq: null },
      ...(value.privateLibraryId ? { libraryId: { ne: value.privateLibraryId } } : {}) };
  }
  function lookupEligible(asset, value) {
    const libraryId = canonicalId(asset?.libraryId);
    return eligible(asset) && asset.isOffline === false && asset.isTrashed === false
      && Boolean(libraryId) && libraryId !== value.privateLibraryId;
  }
  function reviewed(asset, value) {
    // Explicit album inclusion is the positive curation decision; current
    // review-pending metadata can still veto it. Missing tags fail closed.
    return lookupEligible(asset, value) && Array.isArray(asset.tags)
      && asset.tags.every(tag => typeof tag?.value === 'string' && fold(tag.value) !== REVIEW_PENDING_TAG);
  }
  async function lookupMetadata(filter) {
    const result = await client.json('/search/metadata', { method: 'POST', body: { size: 1, filter } });
    const items = result?.assets?.items;
    if (!Array.isArray(items) || items.length > 1) throw photoError(502, 'PHOTO_FRAME_INVALID_RESULT', 'Photo lookup received an invalid result');
    return items[0] || null;
  }
  return {
    status() {
      try {
        const value = settings();
        return { enabled: true, idleSeconds: value.idleSeconds, intervalSeconds: value.intervalSeconds };
      } catch { return { enabled: false }; }
    },
    async next(exclude, recent) {
      const value = settings();
      if (exclude !== undefined && (typeof exclude !== 'string' || !UUID.test(exclude))) throw photoError(400, 'PHOTOS_BAD_REQUEST', 'Invalid previous image');
      if (recent !== undefined && (typeof recent !== 'string' || recent.length > 7400))
        throw photoError(400, 'PHOTOS_BAD_REQUEST', 'Invalid recent images');
      const seen = recent ? recent.split(',') : [];
      if (seen.length > 200 || seen.some(id => !UUID.test(id)))
        throw photoError(400, 'PHOTOS_BAD_REQUEST', 'Invalid recent images');
      const ordered = [...new Set(seen.map(id => id.toLowerCase()))];
      // A native random sample larger than the recent set contains an unseen
      // candidate when one exists. Exhausted small pools use least-recently seen.
      const size = ordered.length + 1;
      const scope = value.source === 'album' ? { albumIds: { any: [value.albumId] } }
        : value.albumId ? { or: [{ originalPath: { startsWith: value.prefix + '/' } }, { albumIds: { any: [value.albumId] } }] }
        : { originalPath: { startsWith: value.prefix + '/' } };
      const filter = { ...scope, type: { eq: 'IMAGE' },
        visibility: { eq: 'timeline' }, isOffline: { eq: false }, trashedAt: { eq: null } };
      if (exclude) filter.id = { ne: exclude };
      const rows = await client.json('/search/random', { method: 'POST', body: { size, filter } });
      if (!Array.isArray(rows) || rows.length > size || rows.some(row => !eligible(row))
        || new Set(rows.map(row => row.id.toLowerCase())).size !== rows.length
        || rows.some(row => exclude && row.id.toLowerCase() === exclude.toLowerCase())) {
        throw photoError(502, 'PHOTO_FRAME_INVALID_RESULT', 'Photo frame received an invalid image');
      }
      const rank = new Map(ordered.map((id, index) => [id, index]));
      const asset = rows.find(row => !rank.has(row.id.toLowerCase()))
        || rows.reduce((oldest, row) => !oldest || rank.get(row.id.toLowerCase()) < rank.get(oldest.id.toLowerCase()) ? row : oldest, null);
      if (asset && !await allowed(asset, value)) {
        throw photoError(502, 'PHOTO_FRAME_INVALID_RESULT', 'Photo frame received an invalid image');
      }
      return asset ? { id: asset.id, src: '/api/photos/frame/' + asset.id + '/image' } : null;
    },
    async lookup(fileName) {
      const value = lookupSettings();
      if (typeof fileName !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} '\-]{0,79}$/u.test(fileName)) {
        throw photoError(400, 'PHOTOS_BAD_REQUEST', 'Invalid photo search');
      }
      const asset = await lookupMetadata({ ...lookupFilter(value), originalFileName: { like: fileName } });
      if (!lookupEligible(asset, value) || typeof asset.originalFileName !== 'string'
        || !asset.originalFileName.toLowerCase().includes(fileName.toLowerCase())) return null;
      const current = await client.json('/assets/' + asset.id);
      if (!reviewed(current, value) || current.id.toLowerCase() !== asset.id.toLowerCase()
        || typeof current.originalFileName !== 'string' || !current.originalFileName.toLowerCase().includes(fileName.toLowerCase())
        || !await allowed(current, value)) return null;
      return { id: asset.id };
    },
    async lookupImage(id) {
      const value = lookupSettings();
      if (!UUID.test(String(id))) throw photoError(400, 'PHOTOS_BAD_REQUEST', 'Invalid image');
      // Recheck direct metadata too: an index row may predate an asset becoming hidden/offline.
      const asset = await client.json('/assets/' + id);
      if (!reviewed(asset, value) || asset.id.toLowerCase() !== id.toLowerCase()) {
        throw photoError(404, 'PHOTOS_NOT_FOUND', 'No such approved photo');
      }
      const member = await lookupMetadata({ ...lookupFilter(value), id: { eq: id } });
      if (!lookupEligible(member, value) || member.id.toLowerCase() !== id.toLowerCase()) {
        throw photoError(404, 'PHOTOS_NOT_FOUND', 'No such approved photo');
      }
      return client.image('/assets/' + id + '/thumbnail?size=preview');
    },
    async image(id) {
      const value = settings();
      if (!UUID.test(String(id))) throw photoError(400, 'PHOTOS_BAD_REQUEST', 'Invalid image');
      const asset = await client.json('/assets/' + id);
      if (String(asset?.id).toLowerCase() !== String(id).toLowerCase() || !await allowed(asset, value)) {
        throw photoError(404, 'PHOTOS_NOT_FOUND', 'Photo frame has no such image');
      }
      return client.image('/assets/' + id + '/thumbnail?size=preview');
    },
  };
}

module.exports = { createPhotoFrameService, loadFrameConfig };
