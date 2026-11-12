'use strict';
const Cards = require('../../../models/PhotoProcessingCard');
const Decisions = require('../../../models/PhotoProcessingDecision');
const { id, hash } = require('./phoneLibrary');
const { fail } = require('./importFiles');
const WC = { w: 1, j: true };
function createPhotoProcessingReview({ client, bridge, immich, config, cards = Cards, decisions = Decisions, frameConfig } = {}) {
  async function membership(assetId, albumId) {
    const result = await client.json('/search/metadata', { method: 'POST', body: { size: 1,
      filter: { id: { eq: assetId }, albumIds: { any: [albumId] } } } });
    if (!Array.isArray(result?.assets?.items) || result.assets.items.some(x => x.id !== assetId))
      throw fail('PHOTO_FRAME_UNKNOWN', 'Immich returned no usable album membership');
    return result.assets.items.length === 1;
  }
  async function decide(input, kind) {
    const writeId = id(input.writeId), sha256 = input.sha256;
    if (!/^[a-f0-9]{64}$/.test(sha256 || '') || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
      throw fail('INVALID_REVIEW', 'Expected content identity and review revision');
    let value;
    if (kind === 'frame') {
      if (typeof input.selected !== 'boolean') throw fail('INVALID_REVIEW', 'Select or remove this frame photo explicitly');
      value = { selected: input.selected };
    } else {
      if (typeof input.approved !== 'boolean' || typeof input.description !== 'string' || input.description.length > 2000
        || !Array.isArray(input.tags) || input.tags.length > 20 || input.tags.some(x => typeof x !== 'string' || x.length > 100))
        throw fail('INVALID_REVIEW', 'Invalid human review');
      require('./photoProjectionTags').tagList(input.tags.filter(Boolean));
      value = { approved: input.approved, description: input.description, tags: input.tags };
    }
    const inputHash = hash({ sha256, kind, value, expectedRevision: input.expectedRevision });
    const fixedConfig = config();
    if (!fixedConfig) throw fail('PHOTO_PROCESSING_NOT_CONFIGURED', 'Configure photo processing');
    const scope = hash([fixedConfig.libraryId, fixedConfig.originalPathPrefix, fixedConfig.frameAlbumId || null]);
    let operation = await decisions.findById(writeId).lean();
    if (!operation) {
      try { await decisions.create([{ _id: writeId, sha256, kind, value, inputHash, scope, expectedRevision: input.expectedRevision }], { writeConcern: WC }); }
      catch (error) { if (error.code !== 11000) throw error; }
      operation = await decisions.findById(writeId).lean();
    }
    if (operation.inputHash !== inputHash) throw fail('REQUEST_CONFLICT', 'This review identity has another decision');
    if (operation.scope !== scope) throw fail('PHOTO_PROCESSING_CONFIG_CHANGED', 'Observe the original decision before changing its library or album');
    if (operation.state === 'completed') {
      await cards.updateOne({ _id: sha256, pendingDecision: writeId }, { $unset: { pendingDecision: 1 } }, { writeConcern: WC });
      return operation.response;
    }
    let card = await cards.findById(sha256).lean();
    if (!card) throw fail('PHOTO_PROCESSING_REQUIRED', 'Process this verified image before reviewing it');
    if (card[kind]?.writeId !== writeId) {
      card = await cards.findOneAndUpdate({ _id: sha256, [kind+'.revision']: input.expectedRevision,
        $or: [{ pendingDecision: { $exists: false } }, { pendingDecision: writeId }] },
      { $set: { pendingDecision: writeId } }, { new: true, writeConcern: WC }).lean();
      if (!card) throw fail('REVIEW_CHANGED', 'Another review or frame decision owns this content');
      if (kind === 'review') {
        const projection = await bridge.call({ op: 'projection', sha256 });
        const asset = projection && await immich.asset(projection);
        if (!asset || asset.id !== card.assetId) throw fail('PHOTO_ASSET_MISMATCH', 'Recheck the original reviewed asset');
        await immich.syncReview(card.assetId, value, { sha256,writeId,revision:input.expectedRevision+1,
          baselineTags:card.metadata?.tags || [],baselineIncomplete:Boolean(card.metadata?.tagsTruncated
            || card.metadata?.truncatedFields?.includes('tags')) });
      }
      if (kind === 'frame') {
        const fixed = config(), frame = frameConfig();
        if (!fixed?.frameAlbumId || frame?.albumId !== fixed.frameAlbumId)
          throw fail('PHOTO_FRAME_NOT_CONFIGURED', 'Configure the same reviewed album in the frame and processing settings');
        const projection = await bridge.call({ op: 'projection', sha256 });
        const asset = projection && await immich.asset(projection);
        if (!asset || asset.id !== card.assetId || asset.type !== 'IMAGE' || asset.visibility !== 'timeline')
          throw fail('PHOTO_FRAME_INVALID', 'Only a verified available image can join the frame');
        if (await membership(asset.id, fixed.frameAlbumId) !== value.selected) {
          const result = await client.json('/albums/' + fixed.frameAlbumId + '/assets', {
            method: value.selected ? 'PUT' : 'DELETE', body: { ids: [asset.id] } });
          if (!Array.isArray(result) || !result.some(x => x.id === asset.id && (x.success || (value.selected && x.error === 'duplicate'))))
            throw fail('PHOTO_FRAME_UNKNOWN', 'The original album decision needs reconciliation');
        }
        if (await membership(asset.id, fixed.frameAlbumId) !== value.selected)
          throw fail('PHOTO_FRAME_UNKNOWN', 'Immich did not confirm the requested frame membership');
      }
      const decision = { revision: input.expectedRevision + 1, writeId, ...value };
      const updated = await cards.findOneAndUpdate({ _id: sha256, pendingDecision: writeId, [kind+'.revision']: input.expectedRevision },
        { $set: { [kind]: decision } }, { new: true, writeConcern: WC }).lean();
      if (!updated) throw fail('REVIEW_CHANGED', 'Observe the original review before another edit');
      card = updated;
    }
    const response = card[kind];
    // Human corrections have their own portable version; originals and model
    // observations remain immutable. A lost export reuses this write identity.
    await bridge.call({ op: 'exportCard', sha256, analysisId: writeId,
      card: { schema: 'agentx.photo-human-'+kind+'/v1', analysisId: writeId, sourceSha256: sha256, [kind]: response } });
    await decisions.updateOne({ _id: writeId }, { $set: { state: 'completed', response } }, { writeConcern: WC });
    await cards.updateOne({ _id: sha256, pendingDecision: writeId }, { $unset: { pendingDecision: 1 } }, { writeConcern: WC });
    return response;
  }
  return { review: input => decide(input, 'review'), frame: input => decide(input, 'frame') };
}
module.exports = { createPhotoProcessingReview };
