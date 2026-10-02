'use strict';

// Render the actual Compose model: never connect to an engine or start a service.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-compose-check-'));
const envFile = path.join(temp, 'external instance.env');
const env = { ...process.env };
for (const key of ['COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'AGENTX_PROJECT_NAME', 'CORE_PORT', 'BENCHMARK_PORT', 'RAG_PORT', 'DATA_PORT', 'PSYX_ACCESS_TOKEN']) delete env[key];
fs.writeFileSync(envFile, 'COMPOSE_PROFILES=data\nAGENTX_PROFILE=full\nCORE_PORT=43180\nBENCHMARK_PORT=43181\nRAG_PORT=43182\nDATA_PORT=43183\nPSYX_ACCESS_TOKEN=synthetic-config-check\n');
const render = project => JSON.parse(execFileSync('docker', ['compose', '--project-name', project, '--env-file', envFile,
  '-f', 'docker-compose.yml', '-f', 'docker-compose.ollama.yml', 'config', '--format', 'json'],
{ cwd: root, env, encoding: 'utf8', windowsHide: true }));
try {
  const primary = render('agentx'), canary = render('agentx-canary');
  for (const config of [primary, canary]) {
    for (const service of Object.values(config.services)) assert.equal(service.container_name, undefined);
    for (const volume of Object.values(config.volumes)) assert.ok(volume.name.startsWith(`${config.name}_canonical_`));
    assert.equal(config.services.core.environment.PSYX_ACCESS_TOKEN, 'synthetic-config-check');
    for (const [service, port] of Object.entries({core:43180, benchmark:43181, rag:43182, data:43183})) {
      assert.equal(config.services[service].ports[0].host_ip, '127.0.0.1');
      assert.equal(Number(config.services[service].ports[0].published), port);
    }
  }
  const primaryVolumes = new Set(Object.values(primary.volumes).map(volume => volume.name));
  assert.equal(primary.volumes.mongo_data.name, 'agentx_canonical_mongo_data');
  assert.equal(primary.volumes.qdrant_data.name, 'agentx_canonical_qdrant_data');
  assert.ok(Object.values(canary.volumes).every(volume => !primaryVolumes.has(volume.name)));
  assert.notEqual(primary.networks.default.name, canary.networks.default.name);
  console.log('Compose projects have distinct networks/volumes; default volumes are preserved; external ports/private settings are honored.');
} finally {
  fs.unlinkSync(envFile);
  fs.rmdirSync(temp);
}
