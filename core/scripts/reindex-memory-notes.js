'use strict';

/**
 * Rebuild the meaning index of the memory notes: every note that has no
 * vector, a vector of another embedding model, or a vector of an older text.
 * Only derived fields are written; no note text, label or date changes.
 *
 *   node scripts/reindex-memory-notes.js
 */

const mongoose = require('mongoose');
const { createIndex } = require('../src/services/memoryNoteIndex');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const result = await createIndex().rebuild({});
    console.log(JSON.stringify(result));
    process.exitCode = result.failed ? 1 : 0;
  } finally {
    await mongoose.disconnect();
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
