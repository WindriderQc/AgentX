'use strict';
// Execution fixtures explicitly accept the request through the same guarded
// domain operation as the UI. This is not an execution or budget grant.
module.exports = async function acceptEngineeringTask(pipelineId) {
  const task = await require('../../models/PipelineTask').findOne({ pipelineId }).lean();
  const view = require('../../src/services/taskIntakePolicy').view(task);
  if (view.state === 'native_domain') return;
  return require('../../src/services/taskIntakeService').decide(pipelineId, {
    state: 'accepted', reason: 'Synthetic request scope reviewed for an execution fixture.', by: 'fixture-operator',
    requestId: require('node:crypto').randomUUID(), expectedRevision: view.revision,
    expectedScopeFingerprint: view.scopeFingerprint, confirm: true,
  });
};
