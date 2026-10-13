'use strict';

// Consumers opting into this stable name follow Core's daily operator route.
// Concrete model names keep their existing explicit-selection semantics.
const PRINCIPAL_MODEL_ALIAS = 'agentx-primary';
function resolvePrincipalAlias(snapshot, model) {
  if (model !== PRINCIPAL_MODEL_ALIAS) return null;
  const task = snapshot.tasks?.daily_operator;
  if (!task?.model || !task.hostUrl || !(task.contextSize > 0)) {
    throw Object.assign(new Error('The principal route needs a configured model, host and context'), {
      code: 'PRINCIPAL_MODEL_UNAVAILABLE', statusCode: 409
    });
  }
  return { ...task, numCtx: task.contextSize, exclusiveHost: false };
}
module.exports = { PRINCIPAL_MODEL_ALIAS, resolvePrincipalAlias };
