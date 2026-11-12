'use strict';
// Operator-only provisioning, invoked inside Core. No general Immich admin
// route is exposed, and its credential never leaves the existing Core client.
const path = require('node:path');
const Setup = require('../../../models/PhotoProcessingSetup');
const { createImmichClient } = require('./immichClient');
const { id, hash } = require('./phoneLibrary');
const { fail } = require('./importFiles');
const WC = { w: 1, j: true };
async function provision(input, { client = createImmichClient(), setups = Setup } = {}) {
  const operationId = id(input.operationId);
  if (typeof input.originalPathPrefix !== 'string' || !input.originalPathPrefix.startsWith('/')
    || input.originalPathPrefix === '/' || /[\\\x00-\x1f]/.test(input.originalPathPrefix)
    || path.posix.normalize(input.originalPathPrefix) !== input.originalPathPrefix || input.originalPathPrefix.endsWith('/')
    || [input.libraryName, input.albumName].some(x => typeof x !== 'string' || !x.trim() || x.length > 120))
    throw fail('INVALID_SETUP', 'Select bounded managed library/album names and one exact gallery mount');
  const user = await client.json('/users/me');
  const ownerId = id(user?.id);
  const value = { ownerId, libraryName: input.libraryName, albumName: input.albumName, originalPathPrefix: input.originalPathPrefix };
  let state = await setups.findById(operationId).lean();
  if (!state) {
    try { await setups.create([{ _id: operationId, inputHash: hash(value), input: value }], { writeConcern: WC }); }
    catch (error) { if (error.code !== 11000) throw error; }
    state = await setups.findById(operationId).lean();
  }
  if (state.inputHash !== hash(value)) throw fail('REQUEST_CONFLICT', 'This provisioning identity already selects another library, album or owner');
  const libraries = await client.json('/libraries');
  if (!Array.isArray(libraries)) throw fail('PHOTO_SETUP_UNKNOWN', 'Immich returned no library inventory');
  const matches = libraries.filter(x => x.name === value.libraryName && x.ownerId === ownerId);
  if (matches.length > 1) throw fail('PHOTO_SETUP_AMBIGUOUS', 'Several libraries use the managed name');
  let library = matches[0];
  if (!library) {
    const claimed = await setups.findOneAndUpdate({ _id: operationId, libraryDispatched: { $ne: true } },
      { $set: { libraryDispatched: true } }, { new: true, writeConcern: WC }).lean();
    if (!claimed) throw fail('PHOTO_SETUP_UNKNOWN', 'Observe the original library creation before retrying');
    library = await client.json('/libraries', { method: 'POST', body: { ownerId, name: value.libraryName,
      importPaths: [value.originalPathPrefix], exclusionPatterns: [] } });
  }
  if (!library || id(library.id) !== library.id || library.ownerId !== ownerId || library.importPaths?.length !== 1
    || library.importPaths[0] !== value.originalPathPrefix || !Array.isArray(library.exclusionPatterns) || library.exclusionPatterns.length
    || (state.libraryId && state.libraryId !== library.id))
    throw fail('PHOTO_LIBRARY_CHANGED', 'Managed library ownership or path differs');
  await setups.updateOne({ _id: operationId }, { $set: { libraryId: library.id } }, { writeConcern: WC });
  const albums = await client.json('/albums');
  if (!Array.isArray(albums)) throw fail('PHOTO_SETUP_UNKNOWN', 'Immich returned no album inventory');
  const matchingAlbums = albums.filter(x => x.albumName === value.albumName);
  if (matchingAlbums.length > 1) throw fail('PHOTO_SETUP_AMBIGUOUS', 'Several albums use the managed name');
  let album = matchingAlbums[0];
  if (!album) {
    const claimed = await setups.findOneAndUpdate({ _id: operationId, albumDispatched: { $ne: true } },
      { $set: { albumDispatched: true } }, { new: true, writeConcern: WC }).lean();
    if (!claimed) throw fail('PHOTO_SETUP_UNKNOWN', 'Observe the original album creation before retrying');
    album = await client.json('/albums', { method: 'POST', body: { albumName: value.albumName, assetIds: [], albumUsers: [] } });
  }
  if (!album || id(album.id) !== album.id || album.shared !== false || album.hasSharedLink === true || (state.albumId && state.albumId !== album.id))
    throw fail('PHOTO_FRAME_NOT_CONFIGURED', 'The managed frame album must remain private in Immich');
  await setups.updateOne({ _id: operationId }, { $set: { albumId: album.id } }, { writeConcern: WC });
  return { operationId, libraryId: library.id, frameAlbumId: album.id, scanStarted: false };
}
module.exports = { provision };
