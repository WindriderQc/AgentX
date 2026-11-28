'use strict';

const { UUID, fold } = require('./photoFilters');
const { photoError } = require('./immichClient');

const visible = ['timeline', 'archive', 'hidden'];
const invalid = () => photoError(502, 'PHOTO_FRAME_INVALID_RESULT', 'Invalid photo provider response');

function conversationGrant(grant) {
  if (grant?.enabled !== true) return null;
  if (grant.source === 'owner-library') {
    if (grant.albumId !== undefined || typeof grant.ownerId !== 'string' || !UUID.test(grant.ownerId)) return null;
    return { enabled: true, source: 'owner-library', ownerId: grant.ownerId.toLowerCase() };
  }
  if ((grant.source === undefined || grant.source === 'album') && grant.ownerId === undefined
      && typeof grant.albumId === 'string' && UUID.test(grant.albumId)) {
    return { enabled: true, albumId: grant.albumId.toLowerCase() };
  }
  return null;
}

function owned(row, ownerId) {
  return typeof row?.id === 'string' && UUID.test(row.id) && typeof row.ownerId === 'string' && row.ownerId.toLowerCase() === ownerId
    && row.type === 'IMAGE' && visible.includes(row.visibility) && row.isOffline === false && row.isTrashed === false;
}

async function checkOwner(client, ownerId) {
  const account = await client.json('/users/me');
  if (typeof account?.id !== 'string' || account.id.toLowerCase() !== ownerId) {
    throw photoError(503, 'PHOTO_FRAME_NOT_CONFIGURED', 'The configured photo account is unavailable');
  }
}

async function lookupOwnerPhoto(client, ownerId, name, signal) {
  await checkOwner(client, ownerId);
  const filter = { originalFileName: { like: name }, type: { eq: 'IMAGE' }, visibility: { in: visible },
    isOffline: { eq: false }, trashedAt: { eq: null } };
  // Immich can return partner assets. Use its cursor and verify ownership
  // locally since the v3.3.3 search filter has no ownerId field.
  let cursor;
  const seen = new Set();
  do {
    signal?.throwIfAborted();
    const result = await client.json('/search/metadata', { method: 'POST', body: { size: 50, filter, ...(cursor && { cursor }) } });
    const page = result?.assets;
    if (!Array.isArray(page?.items) || page.items.length > 50) throw invalid();
    for (const row of page.items) {
      if (!owned(row, ownerId) || typeof row.originalFileName !== 'string' || !fold(row.originalFileName).includes(fold(name))) continue;
      const current = await client.json('/assets/' + row.id);
      if (owned(current, ownerId) && current.id.toLowerCase() === row.id.toLowerCase()
          && typeof current.originalFileName === 'string' && fold(current.originalFileName).includes(fold(name))) {
        return { id: current.id };
      }
    }
    cursor = page.nextCursor;
    if (cursor !== null && (typeof cursor !== 'string' || !cursor || seen.has(cursor))) throw invalid();
    if (cursor && seen.size >= 99) throw photoError(503, 'PHOTO_LOOKUP_INCOMPLETE', 'Photo search could not be completed');
    seen.add(cursor);
  } while (cursor);
  return null;
}

async function loadOwnerPhoto(client, ownerId, id) {
  await checkOwner(client, ownerId);
  const current = await client.json('/assets/' + id);
  if (!owned(current, ownerId) || current.id.toLowerCase() !== id.toLowerCase()) {
    throw photoError(404, 'PHOTOS_NOT_FOUND', 'No such approved photo');
  }
  return client.image('/assets/' + id + '/thumbnail?size=preview');
}

module.exports = { conversationGrant, lookupOwnerPhoto, loadOwnerPhoto };
