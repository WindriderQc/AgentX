#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function studioSettings(settings, coreUrl, contextSize) {
  const origin = new URL(coreUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('Invalid Core origin');
  if (!(Number.isSafeInteger(contextSize) && contextSize > 0)) throw new Error('Principal context is unavailable');
  return { ...settings,
    'llm-pi-ai': { ...settings['llm-pi-ai'], providers: {
      // Studio uses Core for every local inference. The original settings file
      // is retained; only the private Studio copy changes its local provider.
      'agentx-core': { displayName: 'AgentX principal model', api: 'openai-completions',
        apiKeyEnv: 'AGENTX_CORE_API_KEY', compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens', thinkingFormat: 'deepseek' },
        baseURL: `${origin.origin}/api/hermes-openai/v1`,
        models: [{ id: 'agentx-primary', contextWindow: contextSize, maxTokens: 32768,
          reasoningEfforts: { off: null, high: 'high' } }] }
    } },
    'agent-default-model': { provider: 'agentx-core', model: 'agentx-primary' }
  };
}

async function main() {
  const [source, destination, coreUrl] = process.argv.slice(2);
  const dshRoot = process.env.DSH_STUDIO_DSH_ROOT || path.join(process.env.HOME, 'dsh');
  const yaml = require(require.resolve('js-yaml', { paths: [dshRoot] }));
  const response = await fetch(`${new URL(coreUrl).origin}/api/nerve-center/principal-model`, { signal: AbortSignal.timeout(30000) });
  const reply = await response.json();
  if (!response.ok || !reply.data?.available) throw new Error('Core principal model is unavailable');
  const settings = yaml.load(fs.readFileSync(source, 'utf8')) || {};
  fs.writeFileSync(destination, yaml.dump(studioSettings(settings, coreUrl, reply.data.contextSize)), { mode: 0o600 });
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { studioSettings };
