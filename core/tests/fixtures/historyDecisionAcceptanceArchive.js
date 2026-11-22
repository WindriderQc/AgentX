'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { manifestArchive } = require('./historyReviewManifestArchive');

// Real native readers consume synthetic review files on both disposable copies.
async function decisionArchive() {
  const fixture = await manifestArchive();
  try {
    for (const root of Object.values(fixture.roots)) {
      const file = path.join(root, 'reviews', fixture.source.threadId + '.json');
      const review = JSON.parse(await fs.readFile(file));
      for (const section of ['actions', 'memories', 'deliverables', 'invoices']) {
        review[section] = [{ messageId: fixture.source.messageId, text: `Synthetic recorded ${section}` }];
      }
      review.unresolved = [];
      await fs.writeFile(file, JSON.stringify(review));
    }
    const inventory = await fixture.findings.probe({ ...fixture.source, requestId: randomUUID() });
    return { ...fixture, inventory };
  } catch (error) { await fixture.cleanup(); throw error; }
}

module.exports = { decisionArchive };
