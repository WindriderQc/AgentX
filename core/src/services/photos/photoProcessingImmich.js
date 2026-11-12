'use strict';
const path = require('node:path'), crypto = require('node:crypto');
const { fail } = require('./importFiles');
const { UUID } = require('./photoProcessingConfig');
function createPhotoProcessingImmich({ client, config, bridge = require('./photoProcessingBridge').createPhotoProcessingBridge({ config }), ...deps }) {
  const tags = require('./photoProcessingTags').createPhotoProcessingTags({ client, config, bridge, ...deps });
  async function validateLibrary() {
    const fixed = config();
    const value = await client.json('/libraries/' + fixed.libraryId);
    if (value?.id !== fixed.libraryId || !Array.isArray(value.importPaths)
      || value.importPaths.length !== 1 || value.importPaths[0] !== fixed.originalPathPrefix
      || !Array.isArray(value.exclusionPatterns) || value.exclusionPatterns.length)
      throw fail('PHOTO_LIBRARY_CHANGED', 'The managed Immich library must contain exactly the configured projection root');
    return value;
  }
  async function asset(projection) {
    const fixed = config();
    const originalPath = fixed.originalPathPrefix + '/' + projection.relativePath;
    if (path.posix.normalize(originalPath) !== originalPath || !originalPath.startsWith(fixed.originalPathPrefix + '/'))
      throw fail('INVALID_PROJECTION', 'Projection path is invalid');
    const result = await client.json('/search/metadata', { method: 'POST', body: { size: 2, withExif: true, withPeople: true,
      filter: { libraryId: { eq: fixed.libraryId }, originalPath: { eq: originalPath } } } });
    const items = result?.assets?.items;
    if (!Array.isArray(items) || items.length > 1) throw fail('PHOTO_ASSET_AMBIGUOUS', 'Immich returned an ambiguous projection');
    if (!items.length) return null;
    const value = await client.json('/assets/' + items[0].id);
    // External-library checksums may identify paths. NAS projection verifies
    // canonical SHA-256 bytes and the same-inode link before this lookup.
    const pathChecksum = crypto.createHash('sha1').update('path:'+originalPath).digest('base64');
    if (!UUID.test(value?.id || '') || value.libraryId !== fixed.libraryId || value.originalPath !== originalPath
      || value.isOffline || value.isTrashed
      || typeof value.checksum !== 'string' || ![projection.immichChecksum, pathChecksum].includes(value.checksum))
      throw fail('PHOTO_ASSET_MISMATCH', 'Immich asset does not match the verified projection');
    // Full asset DTOs can report hasMetadata before extraction creates EXIF.
    if (!value.hasMetadata || value.exifInfo?.fileSizeInByte == null) return null;
    if (value.exifInfo?.fileSizeInByte !== projection.size)
      throw fail('PHOTO_ASSET_MISMATCH', 'Immich asset byte count differs from the verified projection');
    return value;
  }
  return { validateLibrary, asset, pendingTag: tags.pending, syncReview: tags.review,
    scan: () => client.json('/libraries/' + config().libraryId + '/scan', { method: 'POST' }) };
}
function metadata(asset, ocr = null) {
  const fields = ['dateTimeOriginal', 'timeZone', 'make', 'model', 'lensModel', 'fNumber', 'exposureTime', 'iso',
    'latitude', 'longitude', 'city', 'state', 'country', 'description', 'exifImageWidth', 'exifImageHeight', 'fileSizeInByte'];
  const truncatedFields = [];
  function bounded(value, maximum, field) {
    if (typeof value !== 'string' || Buffer.byteLength(value) <= maximum) return value;
    truncatedFields.push(field);
    return Buffer.from(value).subarray(0, maximum).toString('utf8').replace(/\uFFFD$/, '');
  }
  const exif = Object.fromEntries(fields.filter(k => asset.exifInfo?.[k] !== undefined)
    .map(k => [k, bounded(asset.exifInfo[k], k === 'description' ? 4096 : 256, 'exif.'+k)]));
  return { source: 'immich-extraction', observedAt: new Date().toISOString(), exif,
    fileCreatedAt: asset.fileCreatedAt || null, localDateTime: asset.localDateTime || null,
    people: (asset.people || []).filter(p => !p.isHidden && p.name).slice(0, 20).map(p => ({ id: p.id, name: bounded(p.name, 128, 'people') })),
    tags: (asset.tags || []).slice(0, 50).map(t => bounded(t.value, 128, 'tags')),
    ocr: bounded(ocr, 8000, 'ocr'), type: asset.type,
    truncatedFields: [...new Set(truncatedFields)],
    peopleTruncated: (asset.people || []).filter(p => !p.isHidden && p.name).length > 20, tagsTruncated: (asset.tags || []).length > 50 };
}
module.exports = { createPhotoProcessingImmich, metadata };
