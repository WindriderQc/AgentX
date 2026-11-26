'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readScope(env, logger) {
  if (!env.AGENTX_INSTANCE_ROOT) return null;
  const file = path.join(env.AGENTX_INSTANCE_ROOT, 'config', 'work-cockpit.json');
  try {
    if (fs.statSync(file).size > 4096) throw new Error('Oversized scope');
    const {pipelineId, service, label, intent} = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof pipelineId !== 'string' || !/^\d{4}$/.test(pipelineId) ||
        typeof service !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(service) ||
        typeof label !== 'string' || !label.trim() || label.length > 140 ||
        typeof intent !== 'string' || !intent.trim() || intent.length > 400) throw new Error('Invalid scope');
    return {pipelineId, service, label, intent};
  } catch (error) {
    if (error.code !== 'ENOENT') logger?.warn?.('Work cockpit disabled: invalid instance scope');
    return null;
  }
}

module.exports = {readScope};
