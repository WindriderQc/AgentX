'use strict';

const mongoose = require('mongoose');
const store = require('./transcriptStore');
const queries = require('./transcriptQueries');

function plugin(schema) {
  schema.add({ transcript: { type: mongoose.Schema.Types.Mixed, default: undefined } });
  schema.set('optimisticConcurrency', true);
  schema.set('writeConcern', { w: 'majority', j: true });
  schema.pre(['find', 'findOne', 'countDocuments'], queries.prepareRead);
  schema.post(['find', 'findOne', 'findOneAndUpdate'], queries.finishRead);
  require('./transcriptMutations').install(schema);

  schema.pre('aggregate', async function() {
    const pipeline = this.pipeline();
    const expression = pipeline[0]?.$match?.$text;
    if (expression) {
      const search = require('./transcriptSearch');
      // Search callers reuse their match object for the count query.
      pipeline[0] = { ...pipeline[0], $match: { ...pipeline[0].$match } };
      delete pipeline[0].$match.$text;
      const scores = await search.resolveTextMatches(this._model, expression, queries.rootFilter(pipeline[0].$match));
      pipeline[0].$match = { $and: [pipeline[0].$match, { _id: { $in: scores.map(row => row._id) } }] };
      pipeline.splice(0, pipeline.length, ...search.replaceTextScore(pipeline, scores));
    }
    if (queries.hasMessages(pipeline)) {
      const candidateFilter = queries.rootFilter(pipeline[0]?.$match || {});
      await queries.verifyRoots(this._model, candidateFilter,
        pipeline.filter(stage => stage.$match).map(stage => stage.$match));
      pipeline.unshift({ $match: candidateFilter }, ...store.transcriptStages());
    }
  });
  schema.post('aggregate', async function(rows) {
    for (const row of rows) {
      if (Array.isArray(row.messages)) row.messages = await store.expandMessages(row._id, row.messages);
    }
  });
}

module.exports = plugin;
