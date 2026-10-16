'use strict';

// Consumers opting into this stable name follow Core's daily operator route,
// only while that route serves its host's pin: an unpinned route would load
// another runner over the resident one. Concrete model names keep their
// existing explicit-selection semantics.
const PRINCIPAL_MODEL_ALIAS = 'agentx-primary';
function resolvePrincipalAlias(snapshot, model) {
  if (model !== PRINCIPAL_MODEL_ALIAS) return null;
  const task = snapshot.tasks?.daily_operator;
  if (!task?.model || !task.hostUrl || !(task.contextSize > 0) || task.pinAligned !== true) {
    throw Object.assign(new Error('The principal route needs a model pinned on its host with a context'), {
      code: 'PRINCIPAL_MODEL_UNAVAILABLE', statusCode: 409
    });
  }
  return { ...task, numCtx: task.contextSize, exclusiveHost: false };
}
module.exports = { PRINCIPAL_MODEL_ALIAS, resolvePrincipalAlias };
