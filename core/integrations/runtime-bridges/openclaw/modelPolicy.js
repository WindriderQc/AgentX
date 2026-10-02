'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Read the same execution profiles as the dispatcher. Agent names alone do
// not exempt a native cloud route from the normal local-fallback check.
function loadGuardedAgentPolicies(options = {}) {
  const source = 'config/coding-dispatcher.json';
  let config;
  try {
    config = options.dispatcherConfig ?? JSON.parse(fs.readFileSync(options.dispatcherConfigPath || process.env.AGENTX_CODING_CONFIG || path.join(
      options.repoRoot || process.env.AGENTX_INSTANCE_ROOT || process.env.AGENTX_REPO_ROOT || '/etc/agentx', source
    ), 'utf8'));
    if (config.schema !== 'agentx.coding-dispatcher-config/v1' || !config.executionProfiles) {
      throw new Error('Unsupported dispatcher configuration');
    }
  } catch {
    return { source, status: 'unavailable', agents: {} };
  }
  const agents = {};
  for (const [profileId, profile] of Object.entries(config.executionProfiles)) {
    if (profile?.adapter !== 'clawdx-guarded' || !profile.agent || !profile.model) continue;
    const policy = agents[profile.agent] ||= {
      mode: 'guarded_dispatch', fallback: 'forbidden', source, targets: []
    };
    policy.targets.push({ model: profile.model, path: `${source}.executionProfiles.${profileId}.model` });
  }
  return { source, status: 'available', agents };
}

module.exports = { loadGuardedAgentPolicies };
