#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { settingsPatch } = require('./dsh-settings-patch.cjs');

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

function studioPatch(settings, coreUrl, contextSize, browserExecutable, memoryEnabled = false) {
  const managed = studioSettings(settings, coreUrl, contextSize);
  const patch = settingsPatch(Object.fromEntries(['llm-pi-ai', 'agent-default-model'].map(id => [id, managed[id]])));
  if (browserExecutable) patch.push({ insert: [
    { id: 'agentx-browser-use', name: '@deepseek-ai/dsh-browser-use' },
    { id: 'agentx-browser-playwright', name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
      config: { mode: 'launch', headless: true, executablePath: browserExecutable } },
  ] });
  if (memoryEnabled) patch.push(
    { id: 'session-query-sqlite', config: { path: ':memory:', openAt: 'first-search' } },
    { insert: [
      { id: 'agentx-session-query', name: '@deepseek-ai/dsh-tool-session-query',
        config: { maxSearchResults: 10, searchTimeoutMs: 10000 } },
      { id: 'agentx-memory', name: '@deepseek-ai/dsh-mcp-client', config: {
        serverName: 'agentx_memory', transport: 'streamable-http',
        url: `${new URL(coreUrl).origin}/mcp/memory`, failOnStartupError: true,
      } },
    ] },
  );
  return patch;
}

async function main() {
  const [source, destination, coreUrl] = process.argv.slice(2);
  const dshRoot = process.env.DSH_STUDIO_DSH_ROOT || path.join(process.env.HOME, 'dsh');
  const yaml = require(require.resolve('js-yaml', { paths: [dshRoot] }));
  const response = await fetch(`${new URL(coreUrl).origin}/api/nerve-center/principal-model`, { signal: AbortSignal.timeout(30000) });
  const reply = await response.json();
  if (!response.ok || !reply.data?.available) throw new Error('Core principal model is unavailable');
  const settings = yaml.load(fs.readFileSync(source, 'utf8')) || {};
  const memory = process.env.DSH_STUDIO_MEMORY_ENABLED || 'false';
  if (!['true', 'false'].includes(memory)) throw new Error('DSH_STUDIO_MEMORY_ENABLED must be true or false');
  if (memory === 'true') require.resolve('@deepseek-ai/dsh-tool-session-query', {
    paths: [path.join(path.dirname(destination), 'profiles/web')],
  });
  const patch = studioPatch(settings, coreUrl, reply.data.contextSize, process.env.DSH_STUDIO_BROWSER_EXECUTABLE, memory === 'true');
  fs.writeFileSync(destination, JSON.stringify(patch, null, 2) + '\n', { mode: 0o600 });
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { studioSettings, settingsPatch, studioPatch };
