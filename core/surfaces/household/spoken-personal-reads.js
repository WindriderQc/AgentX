'use strict';

const Ajv = require('ajv');
const { SECRETARY_TOOLS, callSecretaryTool } = require('./secretary-mcp');
const validate = new Ajv({ strict: false, validateFormats: false });
function read(name, keys, description, required = []) {
  const source = SECRETARY_TOOLS.find(tool => tool.name === name).inputSchema.properties;
  const parameters = { type: 'object', properties: Object.fromEntries(keys.map(key => [key, source[key]])),
    required, additionalProperties: false };
  return { definition: { type: 'function', function: { name, description, parameters } }, valid: validate.compile(parameters) };
}
const reads = new Map([
  ['personal_calendar', read('personal_calendar', ['timeMin', 'timeMax', 'query'],
    'Read appointments in an explicit time window, using ISO times with offsets.', ['timeMin', 'timeMax'])],
  ['list_personal_tasks', read('list_personal_tasks', ['scope', 'category', 'offset'],
    'Read a page of personal tasks from the existing task service.')]
]);

// The guarded personal surface already reads these services. Fix the operation
// server-side: the model supplies filters, never an action or a destination.
function personalReads(session, deps, run = callSecretaryTool) {
  if (session.packId !== 'personal_operator' || session.scopeId !== 'personal') return null;
  return { names: [...reads.keys()], definitions: [...reads.values()].map(tool => tool.definition),
    maxRounds: 2, maxCallsPerRound: 2, async execute(call, { signal } = {}) {
      signal?.throwIfAborted();
      const name = call?.function?.name, args = call?.function?.arguments;
      let status = 'refused', content = 'This call is outside the available read permissions.';
      if (reads.get(name)?.valid(args)) {
        const input = name === 'personal_calendar' ? { ...args, action: 'list', limit: 8 } : { ...args, limit: 8 };
        const result = await run(name, input, deps);
        status = result.isError ? 'failed' : 'completed';
        content = JSON.stringify(result.structuredContent ?? result.content);
        if (content.length > 16000) { status = 'partial'; content = 'The result is too large. Request a smaller date window or scope.'; }
      }
      return { message: { role: 'tool', tool_name: name, content }, receipt: { tool: name, status, at: new Date().toISOString() } };
    } };
}
module.exports = { personalReads };
