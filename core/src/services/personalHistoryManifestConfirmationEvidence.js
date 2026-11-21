'use strict';

const { randomUUID } = require('node:crypto');
const manifest = require('./personalHistoryReviewManifest');
const core = require('./personalHistoryCoreRestoration');
const { digest } = require('./personalHistorySourceReviewSources');
const contract = require('./personalHistoryManifestConfirmationContract');

async function observe(selected, deps) {
  const reviewed = await manifest.discover({ ...selected, observationId: randomUUID() }, deps);
  const downstream = reviewed.snapshot.downstream.snapshot;
  const bindings = { sources: downstream.sources, sourceSetSha256: downstream.sourceSetSha256,
    members: downstream.members.map(row => ({ reference: row.reference,
      coreScope: row.snapshot.findingScope.snapshot.coreScope, entries: row.snapshot.entries })) };
  const restored = await core.discover({ sources: downstream.sources,
    expectedBindingsSha256: digest(bindings), observationId: randomUUID() }, deps.findings);
  // These are bounded native observations, not an atomic cross-service snapshot.
  // The last component performs the full final source/index fence. A later human
  // confirmation must repeat this same composition and match both fingerprints.
  const manifestSha256 = digest(reviewed.snapshot), coreRestorationSha256 = digest(restored.snapshot);
  return { manifestSha256, coreRestorationSha256,
    bindingSha256: contract.binding(manifestSha256, coreRestorationSha256),
    preview: { manifest: reviewed.snapshot, coreRestoration: restored.snapshot } };
}

async function assertCurrent(preview, deps) {
  await core.assertCurrentSnapshot(preview.coreRestoration, deps.findings);
}

module.exports = { observe, assertCurrent };
