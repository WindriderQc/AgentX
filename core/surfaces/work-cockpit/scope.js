'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readScope(env, logger) {
  if (!env.AGENTX_INSTANCE_ROOT) return null;
  const file = path.join(env.AGENTX_INSTANCE_ROOT, 'config', 'work-cockpit.json');
  try {
    if (fs.statSync(file).size > 4096) throw new Error('Oversized scope');
    const {service, additionalServices = []} = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(additionalServices) || additionalServices.length > 15) throw new Error('Invalid service scope');
    const services = [service, ...additionalServices];
    if (!services.every(name => typeof name === 'string' && name.length <= 80 &&
      /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/.test(name))) throw new Error('Invalid service scope');
    return {services:[...new Set(services)]};
  } catch (error) {
    if (error.code !== 'ENOENT') logger?.warn?.('Work cockpit disabled: invalid instance scope');
    return null;
  }
}

module.exports = {readScope};
