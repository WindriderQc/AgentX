'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { archive } = require('./historyPreservationArchive');
const { SecretaryMailControl } = require('../../integrations/runtime-bridges/secretary-mail-control');
const { SecretaryFindingsControl } = require('../../integrations/runtime-bridges/secretary-findings-control');
const exec = promisify(execFile);

function control(root, configPath, calls = []) {
  const python = 'import sys\nsys.path.insert(0,sys.argv[1])\nimport secretary_mail_desk as desk\nraise SystemExit(desk.main(["--evidence-root",sys.argv[2],*sys.argv[3:]]))';
  return new SecretaryFindingsControl({ reader: new SecretaryMailControl({ sshTarget: 'archive.example.invalid', remoteRoot: '/opt/product',
    sshRunner: async (host, command) => {
      calls.push({ host, command });
      const args = command.split(' ');
      if (args[0] !== '/usr/bin/python3' || args[1] !== '/opt/product/integrations/secretary/secretary_mail_desk.py'
        || args[2] !== 'findings') throw new Error('Unexpected native command');
      return exec(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', python,
        path.resolve(__dirname, '../../../integrations/secretary'), root, ...args.slice(2)], {
        timeout: 10000, maxBuffer: 1024 * 1024,
        env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath }
      });
    } }) });
}

async function findingArchive() {
  const fixture = await archive(), root = fixture.roots.primary;
  const manifestPath = path.join(root, 'threads', fixture.source.threadId, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.evidenceHash = 'c'.repeat(64); await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const review = { threadId: fixture.source.threadId, evidenceHash: manifest.evidenceHash,
    memories: [{ messageId: fixture.source.messageId, text: 'Synthetic recorded fact', status: 'historical' }],
    actions: [{ messageId: fixture.source.messageId, text: 'Synthetic recorded action' }],
    deliverables: [], invoices: [], unresolved: ['Synthetic thread question'] };
  const reviewPath = path.join(root, 'reviews', fixture.source.threadId + '.json');
  await fs.mkdir(path.dirname(reviewPath), { recursive: true }); await fs.writeFile(reviewPath, JSON.stringify(review));
  const calls = [], reader = control(root, path.join(root, 'no-runtime-config.json'), calls);
  const inventory = await reader.probe({ requestId: randomUUID(), ...fixture.source });
  fixture.source.findingId = inventory.findings.find(item => item.section === 'memories').findingId;
  calls.length = 0;
  return { ...fixture, root, review, reviewPath, inventory, calls, control: reader };
}

module.exports = { findingArchive, control };
