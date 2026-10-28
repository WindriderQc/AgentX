'use strict';
// Select existing read handlers; family never receives an owner tool catalogue.
const bus = require('../../src/services/mcpSkillBus');
const web = require('../../src/services/mcpOwnerTools');
const network = require('./secretary-mcp');
const Ajv = require('ajv');
const TOOLS = [...bus.TOOLS.filter(t => t.name === 'iss_passes'),
  ...web.TOOLS.filter(t => t.name === 'web_search'),
  ...network.SECRETARY_TOOLS.filter(t => t.name === 'network_devices')];
const ajv = new Ajv({ strict: false, validateFormats: false });
const validators = new Map(TOOLS.map(t => [t.name, ajv.compile(t.inputSchema)]));
async function callTool(params, deps, tools) {
  if (!validators.get(params.name)?.(params.arguments || {})) return { isError: true,
    structuredContent: { error: 'INVALID_ARGUMENTS', message: 'Unknown family read or invalid arguments.' } };
  if (params.name === 'web_search') {
    const reply = await web.handleOwnerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }, deps);
    return reply.result;
  }
  if (params.name === 'network_devices') return network.callSecretaryTool(params.name, params.arguments, deps);
  return bus.callTool(params, deps, tools);
}
module.exports = { TOOLS, callTool };
