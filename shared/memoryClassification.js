'use strict';

// Existing Memory Policy V2 vocabulary, shared by review and storage. These
// labels describe information; they are not authentication or an access grant.
const MEMORY_SCOPES = Object.freeze(['project', 'ecosystem', 'workflow', 'owner', 'household', 'private_domain']);
const SENSITIVITY_LEVELS = Object.freeze(['normal', 'private', 'highly_private']);

function memoryClassification(input = {}) {
  if (input.scope === undefined && input.sensitivity === undefined) return {};
  if (!MEMORY_SCOPES.includes(input.scope) || !SENSITIVITY_LEVELS.includes(input.sensitivity)) {
    throw Object.assign(new Error('scope and sensitivity must both use the memory policy vocabulary'), {
      code: 'INVALID_MEMORY_CLASSIFICATION', statusCode: 400,
    });
  }
  return { scope: input.scope, sensitivity: input.sensitivity };
}

module.exports = { MEMORY_SCOPES, SENSITIVITY_LEVELS, memoryClassification };
