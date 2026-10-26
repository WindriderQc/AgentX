'use strict';

// Core tools a Famille conversation on the AgentX engine may call.
//
// The tools that can ever reach Famille are listed here, in reviewed code; the
// instance turns them on with HOUSEHOLD_FAMILY_TOOLS (comma-separated names).
// Each call runs the same handler as Core's /mcp bus, so Famille, Hermes and
// OpenClaw read one implementation. Unset: Famille is offered no tool.

const { TOOLS, callTool } = require('../../src/services/mcpSkillBus');

// Each eligible tool with the arguments Famille may not set: iss_passes always
// answers for the household location, never for coordinates a model supplies.
const FAMILY_TOOL_VIEWS = Object.freeze({ iss_passes: Object.freeze({ omit: Object.freeze(['lat', 'lon']) }) });
const FAMILY_ELIGIBLE_TOOLS = Object.freeze(Object.keys(FAMILY_TOOL_VIEWS));
const MAX_TOOL_ROUNDS = 2;
const MAX_CALLS_PER_ROUND = 3;
const MAX_RESULT_CHARACTERS = 8000;

function familyToolNames(env = process.env) {
  const requested = String(env.HOUSEHOLD_FAMILY_TOOLS || '').split(',').map(name => name.trim()).filter(Boolean);
  return [...new Set(requested)].filter(name => FAMILY_ELIGIBLE_TOOLS.includes(name) && TOOLS.some(tool => tool.name === name));
}

function familyParameters(tool) {
  const omit = FAMILY_TOOL_VIEWS[tool.name]?.omit || [];
  const schema = tool.inputSchema || { type: 'object', properties: {} };
  const properties = Object.fromEntries(Object.entries(schema.properties || {}).filter(([key]) => !omit.includes(key)));
  return { ...schema, properties, ...(Array.isArray(schema.required) ? { required: schema.required.filter(key => !omit.includes(key)) } : {}) };
}

function functionDefinition(tool) {
  const omitted = FAMILY_TOOL_VIEWS[tool.name]?.omit || [];
  const note = omitted.length ? ` In this conversation it always uses the household location.` : '';
  return { type: 'function', function: { name: tool.name, description: tool.description + note, parameters: familyParameters(tool) } };
}

function parseArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }
  return value === undefined || value === null || value === '' ? {} : null;
}

/**
 * The tools offered to this turn, or null when none is on.
 * execute(call) answers a model tool call with the Ollama tool message and a receipt.
 */
function familyToolset(env = process.env, deps = {}) {
  const names = familyToolNames(env);
  if (!names.length) return null;
  const tools = TOOLS.filter(tool => names.includes(tool.name));
  const run = deps.callTool || callTool;
  const now = deps.now || (() => new Date());
  return {
    names,
    maxRounds: MAX_TOOL_ROUNDS,
    maxCallsPerRound: MAX_CALLS_PER_ROUND,
    definitions: tools.map(functionDefinition),
    instructions: [
      `This turn uses AgentX inference with the supplied context and these Core tools: ${names.join(', ')}.`,
      'Call a tool when the question needs its data, then answer only from what it returned; never invent a tool result, a time or a number.',
      'If a tool fails, say plainly that the information is unavailable right now.',
      'When a tool result carries a view address, you may offer it in a link show block.',
      'No other tool, skill or action is available here. A note is saved only when the supplied context explicitly confirms it.',
    ].join(' '),
    async execute(call) {
      const name = call?.function?.name;
      const at = now().toISOString();
      const message = (content) => ({ role: 'tool', tool_name: String(name || ''), content });
      if (!names.includes(name)) {
        return { message: message(JSON.stringify({ error: 'UNKNOWN_TOOL', message: `${String(name || '').slice(0, 60)} is not available here` })),
          receipt: { tool: String(name || '').slice(0, 60), status: 'refused', at } };
      }
      const args = parseArguments(call.function.arguments);
      if (args === null) {
        return { message: message(JSON.stringify({ error: 'INVALID_ARGUMENTS', message: 'arguments must be a JSON object' })),
          receipt: { tool: name, status: 'refused', at } };
      }
      const omit = FAMILY_TOOL_VIEWS[name]?.omit || [];
      const allowed = Object.fromEntries(Object.entries(args).filter(([key]) => !omit.includes(key)));
      const result = await run({ name, arguments: allowed }, deps.toolDeps || {}, tools);
      const content = JSON.stringify(result.structuredContent ?? null).slice(0, MAX_RESULT_CHARACTERS);
      return { message: message(content), receipt: { tool: name, status: result.isError ? 'failed' : 'completed', at,
        ...(result.isError ? { error: String(result.structuredContent?.error || 'TOOL_ERROR') } : {}) } };
    },
  };
}

module.exports = { FAMILY_ELIGIBLE_TOOLS, familyToolNames, familyToolset, parseArguments };
