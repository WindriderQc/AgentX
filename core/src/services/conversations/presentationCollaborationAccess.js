'use strict';

// The optional conversation surface binds a Core-owned, scoped reader. Tools
// only read that capability; they never start a model, research or a new turn.
let reader = null;
function installReader(value) { reader = value; }
async function read(input) {
  if (!reader) return { contract: 'agentx.collaboration-context/v1', status: 'unavailable', reason: 'conversation_surface_not_installed' };
  return reader(input);
}
module.exports = { installReader, read };
