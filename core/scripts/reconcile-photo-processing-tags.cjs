#!/usr/bin/env node
'use strict';
// Bounded operator repair. No inference, review approval or frame selection is
// created. Keep the same explicit content plan after an uncertain response.
const fs = require('node:fs/promises');
const mongoose = require('mongoose');
async function main() {
  const plan = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  if (!Array.isArray(plan.sha256s) || !plan.sha256s.length || plan.sha256s.length > 24
    || plan.sha256s.some(s=>!/^[a-f0-9]{64}$/.test(s))) throw Error('Supply at most twenty-four content SHA-256 identities');
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const config = require('../src/services/photos/photoProcessingConfig').loadProcessingConfig;
    const client = require('../src/services/photos/immichClient').createImmichClient();
    const bridge = require('../src/services/photos/photoProcessingBridge').createPhotoProcessingBridge({config});
    const immich = require('../src/services/photos/photoProcessingImmich').createPhotoProcessingImmich({config,client,bridge});
    await immich.validateLibrary();
    const results = [];
    for (const sha256 of [...new Set(plan.sha256s)]) {
      try {
        const card = await require('../models/PhotoProcessingCard').findById(sha256).lean();
        if (!card || card.libraryId !== config().libraryId || card.metadata?.type !== 'IMAGE'
          || !['completed','failed'].includes(card.analysis?.state) || card.pendingDecision)
          throw Error('Content is absent, still analyzing or held by an owner decision');
        const projection = await bridge.call({op:'projection',sha256});
        const asset = projection && await immich.asset(projection);
        if (!asset || asset.id !== card.assetId) throw Error('Original asset identity differs');
        const context = {sha256,baselineTags:card.metadata.tags || [],baselineIncomplete:Boolean(card.metadata.tagsTruncated
          || card.metadata.truncatedFields?.includes('tags'))};
        const result = card.review?.revision
          ? await immich.syncReview(card.assetId,card.review,{...context,writeId:card.review.writeId,revision:card.review.revision})
          : await immich.pendingTag(card.assetId,context);
        results.push({sha256,...result});
      } catch (error) { results.push({sha256,error:error.code || 'PHOTO_TAG_RECONCILIATION_REQUIRED',message:error.message}); }
    }
    console.log(JSON.stringify({results,inferenceCalls:0,ownerDecisionsCreated:0,phoneAccess:false}));
    if (results.some(r=>r.error)) process.exitCode=1;
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports = {main};
