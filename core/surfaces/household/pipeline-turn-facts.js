'use strict';

const { pipelineTurn } = require('./native-pipeline-policy');
const spoken = require('../../src/services/pipelineSpokenFacts');

// Read the Pipeline only for a Pipeline turn (#924). A failed read leaves the
// turn as it was: the model still has its own tools, Core adds no sentence.
async function factsFor(text, presentation, { read = spoken.read } = {}) {
  if (!pipelineTurn(text, presentation)) return null;
  try { return await read({ taskIds: String(text || '').match(/\b\d{3,4}\b/g) || [] }); } catch { return null; }
}

function answerFor(facts, catalog, language) {
  if (!facts) return null;
  return block => {
    const target = catalog?.parse?.(block.body);
    return target?.page === 'pipeline' ? spoken.sentence(facts, target.focus, language) : '';
  };
}

module.exports = { factsFor, answerFor };
