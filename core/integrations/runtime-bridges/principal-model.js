'use strict';

// Consumers opting into this stable name follow Core's daily operator route,
// only while that route serves its host's pin: an unpinned route would load
// another runner over the resident one. Concrete model names keep their
// existing explicit-selection semantics.
const PRINCIPAL_MODEL_ALIAS = 'agentx-primary';
//
// When the principal route names a topology role (#360), the alias follows
// that role in the active mode (for `conversation`, the pooled pin when the
// active mode has no conversation role). A role that does not resolve is
// refused with its reason, never rerouted.
function resolvePrincipalAlias(snapshot, model) {
  if (model !== PRINCIPAL_MODEL_ALIAS) return null;
  const topology = snapshot.principalTopology;
  if (topology) {
    if (!topology.model || !topology.hostUrl || !(topology.contextSize > 0) || topology.pinAligned !== true) {
      const reason = topology.topology?.reason || 'endpoint_has_no_pin_context';
      throw Object.assign(new Error(`The principal role ${topology.topology?.role || ''} does not resolve: ${reason}`), {
        code: 'PRINCIPAL_MODEL_UNAVAILABLE', statusCode: 409, reason
      });
    }
    return { ...topology, numCtx: topology.contextSize, exclusiveHost: false };
  }
  const task = snapshot.tasks?.daily_operator;
  if (!task?.model || !task.hostUrl || !(task.contextSize > 0) || task.pinAligned !== true) {
    throw Object.assign(new Error('The principal route needs a model pinned on its host with a context'), {
      code: 'PRINCIPAL_MODEL_UNAVAILABLE', statusCode: 409
    });
  }
  return { ...task, numCtx: task.contextSize, exclusiveHost: false };
}
module.exports = { PRINCIPAL_MODEL_ALIAS, resolvePrincipalAlias };
