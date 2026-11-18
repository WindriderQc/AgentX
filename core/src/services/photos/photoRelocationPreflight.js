'use strict';
const { createHash } = require('node:crypto');
const { validateSelection } = require('./photoPortableRegistry');
const SHA = /^[a-f0-9]{64}$/;
// Conservative collisions across case-insensitive/Unicode-normalizing volumes.
// False positives are safer than treating this plan as native filesystem proof.
const targetKey = value => value.normalize('NFC').split(String.fromCharCode(92)).join('/')
  .split('/').map(p => p.replace(/[ .]+$/, '').toLowerCase()).join('/');
const fail = (code, message) => Object.assign(new Error(message), { code });
const BLOCKERS = Object.freeze([
  'INDEPENDENT_BACKUP_AND_RESTORE_NOT_VERIFIED',
  'PHOTO_WRITERS_AND_IMMICH_JOBS_NOT_FENCED',
  'DESTINATION_AUDIENCE_AND_PERMISSIONS_NOT_ATTESTED',
  'IMMICH_METADATA_AND_RELATIONS_NOT_FULLY_CAPTURED',
  'IMPORT_RECEIPT_AND_SIDECAR_READERS_NOT_RELOCATION_AWARE',
  'IMMICH_REINDEX_AND_ASSET_REBIND_NOT_QUALIFIED',
  'DURABLE_MOVE_AND_ROLLBACK_EXECUTOR_NOT_QUALIFIED',
]);
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
// An internal operator plan, not an authorization gate or a migration executor.
// No default NAS resolver: production paths and sidecar identities must come from
// the configured native receipt capability, never from a public request.
function createPhotoRelocationPreflight({ registry, resolve, inspect } = {}) {
  async function planSelection(input) {
    const ids = validateSelection(input);
    if (!registry?.exportSelection || typeof resolve !== 'function' || typeof inspect !== 'function')
      throw fail('PHOTO_RELOCATION_NOT_CONFIGURED', 'A trusted registry, receipt resolver and inventory inspector are required');
    const snapshot = await registry.exportSelection({ sha256s: ids, audience: 'owner' });
    if (!SHA.test(snapshot?.manifestSha256 || '') || snapshot.audience !== 'owner'
      || snapshot.entries?.length !== ids.length || snapshot.selection?.join(',') !== ids.join(','))
      throw fail('PHOTO_RELOCATION_REGISTRY_MISMATCH', 'Registry selection differs from the requested content');
    const items = [], targets = new Set();
    for (const sha256 of ids) {
      const entry = snapshot.entries.find(item => item.sha256 === sha256), card = entry?.card;
      if (card?._id !== sha256 || card.pendingDecision || card.metadata?.type !== 'IMAGE'
        || typeof card.assetId !== 'string' || !card.assetId || typeof card.libraryId !== 'string' || !card.libraryId
        || card.frame?.selected !== true || card.projection?.sha256 !== sha256
        || !Number.isSafeInteger(card.projection.size) || card.projection.size < 1)
        throw fail('PHOTO_RELOCATION_CARD_NOT_READY', 'Only selected, settled image records with verified projection identities can be planned');
      const request = await resolve(entry);
      if (request?.image?.sha256 !== sha256 || request.image.size !== card.projection.size)
        throw fail('PHOTO_RELOCATION_CONTENT_MISMATCH', 'Native receipt content differs from the registry');
      const observed = await inspect(request);
      if (observed?.migrationReady !== false || observed.audience !== 'owner'
        || observed.image?.sha256 !== sha256 || observed.image.size !== card.projection.size
        || observed.image.source !== request.image.source || observed.image.destination !== request.image.destination
        || observed.xmp?.source !== request.xmp?.source || observed.xmp?.destination !== request.xmp?.destination
        || observed.xmp?.sha256 !== request.xmp?.sha256 || observed.xmp?.size !== request.xmp?.size)
        throw fail('PHOTO_RELOCATION_INVENTORY_MISMATCH', 'Inventory does not match the requested pair');
      for (const target of [observed.image.destination, observed.xmp.destination]) {
        if (typeof target !== 'string' || targets.has(targetKey(target))) throw fail('PHOTO_RELOCATION_TARGET_COLLISION', 'Selected pairs have colliding destinations');
        targets.add(targetKey(target));
      }
      items.push({ sha256, registryAssetId: card.assetId, registryLibraryId: card.libraryId, inventory: structuredClone(observed) });
    }
    // Detect observed changes, without claiming this is a transactional lock.
    const after = await registry.exportSelection({ sha256s: ids, audience: 'owner' });
    if (after?.manifestSha256 !== snapshot.manifestSha256)
      throw fail('PHOTO_RELOCATION_REGISTRY_CHANGED', 'Registry changed while inventory was collected');
    const plan = { schema: 'agentx.photo-relocation-preflight/v1', audience: 'owner',
      migrationReady: false, executable: false, consistency: 'non-atomic-observation',
      registryManifestSha256: snapshot.manifestSha256, selection: ids, items, blockers: [...BLOCKERS],
      immichCopyOptions: { albums: false, sidecar: false, sharedLinks: false, stack: false, favorite: false },
      effects: { databaseWrites: 0, fileWrites: 0, scans: 0, modelCalls: 0 } };
    return freeze({ ...plan, planSha256: createHash('sha256').update(JSON.stringify(plan)).digest('hex') });
  }
  return { planSelection };
}
module.exports = { createPhotoRelocationPreflight, BLOCKERS };
