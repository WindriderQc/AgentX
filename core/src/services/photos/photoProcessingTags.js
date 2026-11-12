'use strict';
const crypto = require('node:crypto');
const { fail } = require('./importFiles');
const { UUID } = require('./photoProcessingConfig');
const PENDING = 'AgentX/Relecture/à relire', REVIEWED = 'AgentX/Téléphone/Relu', PREFIX = 'AgentX/Téléphone/Étiquette/';
const managed = value => [PENDING, REVIEWED].includes(value) || value.startsWith(PREFIX);
function pendingWriteId(sha256) {
  const bytes = crypto.createHash('sha1').update('agentx.photo-pending-tags/v1:'+sha256).digest().subarray(0,16);
  bytes[6] = (bytes[6]&15)|0x50; bytes[8] = (bytes[8]&63)|0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
function createPhotoProcessingTags({ client, bridge, config, pause = ms => new Promise(r=>setTimeout(r,ms)), now = Date.now }) {
  async function current(assetId, relativePath) {
    const asset = await client.json('/assets/'+assetId), fixed = config();
    if (asset?.id !== assetId || asset.libraryId !== fixed.libraryId || asset.isOffline || asset.isTrashed
      || (relativePath && asset.originalPath !== fixed.originalPathPrefix+'/'+relativePath)
      || !Array.isArray(asset.tags) || asset.tags.some(t => typeof t.value !== 'string'))
      throw fail('PHOTO_ASSET_MISMATCH', 'Recheck the original asset before synchronizing tags');
    return asset;
  }
  function queuesIdle(jobs) {
    return ['sidecar','metadataExtraction'].every(name => {
      const q = jobs?.[name];
      return q?.queueStatus?.isActive === false && ['active','waiting','delayed','paused']
        .every(k=>Number.isSafeInteger(q.jobCounts?.[k]) && q.jobCounts[k] === 0);
    });
  }
  async function apply(assetId, state) {
    const asset = await current(assetId,state.relativePath);
    const desired = state.tags, obsolete = asset.tags.filter(t=>managed(t.value) && !desired.includes(t.value));
    const tags = await client.json('/tags', { method:'PUT', body:{tags:desired} });
    if (!Array.isArray(tags) || !desired.every(value=>tags.some(t=>t.value === value && UUID.test(t.id || ''))))
      throw fail('PHOTO_TAG_UNAVAILABLE', 'Immich did not confirm the complete persisted tag set');
    for (const tag of [...tags.filter(t=>desired.includes(t.value)),...obsolete]) {
      const result = await client.json('/tags/'+tag.id+'/assets', { method:desired.includes(tag.value)?'PUT':'DELETE', body:{ids:[assetId]} });
      if (!Array.isArray(result) || !result.some(r=>r.id === assetId && (r.success || r.error === 'duplicate')))
        throw fail('PHOTO_TAG_UNAVAILABLE', 'The original tag decision needs reconciliation');
    }
  }
  async function synchronize(assetId, desired, context) {
    if (!context || !/^[a-f0-9]{64}$/.test(context.sha256 || '') || context.baselineIncomplete)
      throw fail('PHOTO_TAG_BASELINE_UNAVAILABLE', 'A complete original tag snapshot is required');
    const asset = await current(assetId);
    const tags = [...new Set([...asset.tags.map(t=>t.value),...(context.baselineTags || [])].filter(t=>!managed(t)).concat(desired))].sort();
    const command = {op:'syncTags',sha256:context.sha256,writeId:context.writeId,revision:context.revision,tags};
    let state = await bridge.call(command);
    const end = now()+60000;
    for (let attempt=0;attempt<3;attempt++) {
      if (state?.sha256 !== context.sha256 || !Array.isArray(state.tags) || state.tags.some(t=>typeof t !== 'string')
        || !UUID.test(state.writeId || '') || !/^[a-f0-9]{64}$/.test(state.sidecarSha256 || '')
        || !Number.isSafeInteger(state.revision) || state.revision < context.revision
        || (!state.persisted && !state.superseded)) throw fail('PHOTO_TAG_UNAVAILABLE', 'NAS did not confirm a persisted gallery sidecar');
      await apply(assetId,state);
      while (true) {
        if (now() >= end) throw fail('PHOTO_TAG_RECONCILIATION_REQUIRED', 'Observe the original sidecar and tag decision');
        if (queuesIdle(await client.json('/jobs'))) break;
        await pause(250);
      }
      // A newer owner revision can supersede a background pending marker.
      const latest = await bridge.call(command);
      if (latest.writeId !== state.writeId || latest.revision !== state.revision) { state=latest;continue; }
      const final = await current(assetId,state.relativePath), values = final.tags.map(t=>t.value);
      if (!state.tags.every(t=>values.includes(t)) || values.some(t=>managed(t) && !state.tags.includes(t)))
        throw fail('PHOTO_TAG_RECONCILIATION_REQUIRED', 'Immich did not retain the persisted review tags after extraction');
      return { revision:state.revision,writeId:state.writeId,persisted:true,superseded:state.writeId !== context.writeId };
    }
    throw fail('PHOTO_TAGS_CHANGED', 'Observe the newest owner tag revision');
  }
  return {
    pending: (assetId,context) => synchronize(assetId,[PENDING],{...context,writeId:pendingWriteId(context?.sha256),revision:0}),
    review: async (assetId,review,context) => {
      const result = await synchronize(assetId,review.approved ? [REVIEWED,...review.tags.filter(Boolean).map(t=>PREFIX+t)] : [PENDING],context);
      if (result.superseded) throw fail('PHOTO_TAGS_CHANGED','A newer review owns the gallery sidecar');
      return result;
    }
  };
}
module.exports = { createPhotoProcessingTags, pendingWriteId, managed };
