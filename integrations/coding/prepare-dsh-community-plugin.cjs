#!/usr/bin/env node
'use strict';

// Prepare unpacked upstream artifacts; never edit an installed pnpm package.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const adapters = {
  'dsh-client-ui-explorer': {
    version: '0.1.0', file: 'lib/client.js',
    sha256: 'a5bbeb6f70a0259fbbb19aba65f2983d042b4779f4d422262279f90e462af45a',
  },
  '@1e0zj/dsh-plugin-mall': {
    version: '0.4.17', file: 'src/client.js',
    sha256: 'ca13ef4ba2a7201dc5c31462391f8158c76004265b709d4ff02ca1431ac96950',
    hostFile: 'src/index.js',
    hostSha256: 'f14d47aad69c4ada788e05c3b0d4cdb84380b41f4dca77898607920f24862d29',
  },
};

function adaptHost(source) {
  const original = 'connectionCtx.connection.rpc.handle("/market",';
  if (!source.includes(original)) throw new Error('Expected marketplace RPC registration was not found');
  const imports = 'import { clientRequestSchema as agentxRpcSchema } from "@deepseek-ai/dsh-client-connection";\nimport { registerFetchRpc as agentxRegisterFetchRpc } from "./agentx-connection-fetch-rpc.mjs";\n';
  const wrapper = `function agentxRegisterMarket(ctx, handler) {
  return agentxRegisterFetchRpc(ctx, {
    channel: "market",
    endpoints: ["search", "verify", "compat", "updates", "info", "installed", "togglePlugin", "preflight", "install", "uninstall", "job", "jobs", "restart", "jobCancel", "jobDismiss"],
    parse: value => agentxRpcSchema.safeParse(value), handler,
  });
}\n`;
  return imports + wrapper + source.replace(original, 'agentxRegisterMarket(connectionCtx,');
}
const iconNames = {
  IconChevronLeftOutline14: 'IconChevronLeftOutlineRegular',
  IconChevronRightOutline14: 'IconChevronRightOutlineRegular',
  IconCloseOutline16: 'IconCloseOutlineRegular',
  IconFolderClose16: 'IconFolderCloseRegular',
  IconFolderOpen16: 'IconFolderOpenRegular',
  IconRefreshOutline16: 'IconRefreshOutlineRegular',
};

function adaptClient(name, source) {
  if (name === 'dsh-client-ui-explorer') {
    return source.replace(/\bIcon(?:ChevronLeftOutline14|ChevronRightOutline14|CloseOutline16|FolderClose16|FolderOpen16|RefreshOutline16)\b/g,
      name => iconNames[name]);
  }
  if (name === '@1e0zj/dsh-plugin-mall') {
    return source.replaceAll('settings.plugins.tab', 'settings.section')
      .replace('label: "插件市场"', 'label: "Plugin Marketplace"')
      .replaceAll('rpc.call("/market", endpoint, body)', 'rpc.call("/api", "market/" + endpoint, body)');
  }
  throw new Error(`Unsupported upstream plugin: ${name}`);
}

function assertPlainTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Source must be an unpacked archive without symlinks');
    if (entry.isDirectory()) assertPlainTree(path.join(directory, entry.name));
    else if (!entry.isFile()) throw new Error('Source contains a non-regular file');
  }
}

function prepare(source, output) {
  source = fs.realpathSync(source);
  output = path.resolve(output);
  if (output === source || output.startsWith(source + path.sep) || fs.existsSync(output)) {
    throw new Error('Output must be a new directory outside the source');
  }
  assertPlainTree(source);
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const adapter = adapters[manifest.name];
  if (!adapter || manifest.version !== adapter.version) throw new Error('Unsupported upstream plugin version');
  const client = fs.readFileSync(path.join(source, adapter.file));
  const digest = createHash('sha256').update(client).digest('hex');
  if (digest !== adapter.sha256) throw new Error('Upstream client digest differs; review the artifact before adapting it');
  const updated = adaptClient(manifest.name, client.toString('utf8'));
  if (updated === client.toString('utf8')) throw new Error('Expected compatibility edits were not found');
  let host;
  if (adapter.hostFile) {
    const original = fs.readFileSync(path.join(source, adapter.hostFile), 'utf8');
    if (createHash('sha256').update(original).digest('hex') !== adapter.hostSha256) throw new Error('Upstream host digest differs');
    host = adaptHost(original);
  }
  const provenance = {
    schema: 'agentx.dsh-community-plugin-compatibility/v1',
    name: manifest.name, upstreamVersion: manifest.version,
    upstreamClientSha256: digest, targetRuntime: '0.2.0-rc.2',
    scope: manifest.name === '@1e0zj/dsh-plugin-mall' ? 'settings-section-and-authenticated-shared-fetch-rpc' : 'ui-icon-exports',
    ...(adapter.hostSha256 ? { upstreamHostSha256: adapter.hostSha256 } : {}),
  };
  manifest.version += adapter.hostFile ? '-agentx.6' : '-agentx.1';
  if (adapter.hostFile) manifest.peerDependencies['@deepseek-ai/dsh-client-connection'] = '0.2.0-rc.2';
  manifest.files = [...new Set([...(manifest.files || []), 'agentx-compatibility.json'])];
  fs.cpSync(source, output, { recursive: true, errorOnExist: true, force: false });
  fs.writeFileSync(path.join(output, adapter.file), updated);
  if (host) fs.writeFileSync(path.join(output, adapter.hostFile), host);
  if (host) fs.copyFileSync(path.join(__dirname, 'dsh-connection-fetch-rpc.mjs'), path.join(output, 'src/agentx-connection-fetch-rpc.mjs'));
  fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'agentx-compatibility.json'), JSON.stringify(provenance, null, 2) + '\n');
  return { ...provenance, version: manifest.version };
}

module.exports = { adaptClient, adaptHost, prepare };
if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: prepare-dsh-community-plugin.cjs <unpacked-package> <new-output-directory>');
    console.log(JSON.stringify(prepare(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
