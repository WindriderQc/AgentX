'use strict';

const Task = require('../../models/PipelineTask');
const workerScope = require('../../src/helpers/workerTaskScope');
const limit = 250;

async function readPipeline({service}) {
  // Intersect the native engineering boundary with the installed service scope.
  // The database returns only display metadata, never specs, feedback or artifacts.
  const tasks = await Task.aggregate([
    {$match: {$and: [workerScope(), {service}]}},
    {$sort: {updatedAt:-1, pipelineId:-1}},
    {$limit: limit + 1},
    {$project: {_id:0, pipelineId:1, title:1, status:1, service:1, createdAt:1, updatedAt:1,
      intake:{$ifNull:['$intake.state', null]},
      assigned:{$ne:[{$ifNull:['$assignee', null]}, null]},
      attempts:{$ifNull:['$automationAttemptCount', null]},
      relationships:{$cond:[{$isArray:'$workLinks.entries'}, {$size:'$workLinks.entries'}, null]},
      transitions:{$map:{input:{$slice:[{$ifNull:['$transitions', []]}, -10]}, as:'event',
        in:{at:'$$event.at', to:'$$event.to'}}}
    }}
  ]).option({maxTimeMS:3500});
  return {service, hasMore:tasks.length > limit, observedAt:new Date().toISOString(), records:tasks.slice(0, limit)};
}

module.exports = {readPipeline};
