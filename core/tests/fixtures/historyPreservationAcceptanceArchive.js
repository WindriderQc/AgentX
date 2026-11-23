'use strict';
const { storageArchive } = require('./historyStorageArchive');
const { manifestArchive } = require('./historyReviewManifestArchive');
const { recordedFindings } = require('./historyDecisionAcceptanceArchive');

async function preservationAcceptanceArchive() {
  const fixture = await storageArchive();
  try {
    fixture.control.probeReviewRestoration = fixture.reviewControl.probeReviewRestoration.bind(fixture.reviewControl);
    return await recordedFindings(await manifestArchive({ reviewFixture: fixture }));
  } catch (error) { await fixture.cleanup(); throw error; }
}

module.exports = { preservationAcceptanceArchive };
