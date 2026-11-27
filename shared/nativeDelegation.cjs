'use strict';

// OpenClaw's delegation controls carry no Core source payload.
const names = new Set(['agents_list', 'sessions_spawn', 'sessions_yield']);
const isDelegationTool = name => names.has(name);
module.exports = { isDelegationTool };
