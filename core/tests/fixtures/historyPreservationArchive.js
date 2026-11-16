'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { SecretaryMailControl } = require('../../integrations/runtime-bridges/secretary-mail-control');
const { SecretaryPreservationControl } = require('../../integrations/runtime-bridges/secretary-preservation-control');
const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');

async function archive({ command: expectedCommand = 'preservation' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'history-preservation-'));
  const temporaryRoot = path.join(directory, 'restoration-temporary');
  await fs.mkdir(temporaryRoot, { mode: 0o700 });
  const messageId = '1234567890abcdef', threadId = '1234567890abcdea';
  const attachment = Buffer.from('Synthetic original attachment bytes');
  const raw = Buffer.from(['Message-ID: <preservation@example.invalid>', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="synthetic-scope"', '', '--synthetic-scope',
    'Content-Type: text/plain; charset=UTF-8', '', 'Synthetic complete body', '--synthetic-scope',
    'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="sample.bin"',
    'Content-Transfer-Encoding: base64', '', attachment.toString('base64'), '--synthetic-scope--', ''].join('\r\n'));
  const source = { system: 'gmail', messageId, threadId, sourceSha256: hash(raw), findingId: 'b'.repeat(64) };
  const roots = {}, machines = {}, attachmentPaths = {}, calls = [];
  for (const copy of ['primary', 'mirror']) {
    roots[copy] = path.join(directory, copy);
    const receipt = { messageId, threadId, path: `raw/${source.sourceSha256}.eml`, sha256: source.sourceSha256, bytes: raw.length };
    const attached = { partId: '1', path: `files/${hash(attachment)}.bin`, sha256: hash(attachment), bytes: attachment.length };
    for (const [relative, value] of [
      [receipt.path, raw], [attached.path, attachment],
      [`raw-receipts/${messageId}.json`, JSON.stringify(receipt)],
      [`threads/${threadId}/manifest.json`, JSON.stringify({ threadId, messages: [
        { id: messageId, headers: { 'message-id': '<preservation@example.invalid>' }, attachments: [attached] },
        { id: '1234567890abcdff', attachments: [{ path: '../unrelated-never-read' }] },
      ] })],
    ]) {
      const file = path.join(roots[copy], relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value);
    }
    machines[copy] = path.join(directory, copy + '-machine-id');
    await fs.writeFile(machines[copy], (copy === 'primary' ? '1' : '2').repeat(32) + '\n');
    attachmentPaths[copy] = path.join(roots[copy], attached.path);
  }
  // No SSH, provider or runtime is contacted. Only the machine identities are
  // simulated; the archive reader and desk command are the production Python.
  const python = [
    'import sys', 'from pathlib import Path', 'sys.path.insert(0,sys.argv[1])',
    'import archive_preservation as native', 'native.MACHINE_ID_FILE=Path(sys.argv[2])',
    'import secretary_mail_desk as desk',
    'raise SystemExit(desk.main(["--evidence-root",sys.argv[3],*sys.argv[4:]]))',
  ].join('\n');
  const reader = copy => new SecretaryMailControl({ sshTarget: copy + '.example.invalid', remoteRoot: '/opt/product',
    sshRunner: async (target, command) => {
      calls.push({ copy, target, command });
      const args = command.split(' ');
      if (args[0] !== '/usr/bin/python3' || !args[1].endsWith('/secretary_mail_desk.py') || args[2] !== expectedCommand) throw new Error('Unexpected native command');
      return exec(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', python,
        path.resolve(__dirname, '../../../integrations/secretary'), machines[copy], roots[copy], ...args.slice(2)], {
        timeout: 10000, maxBuffer: 1024 * 1024,
        env: { ...process.env, TMPDIR: temporaryRoot, OPENCLAW_CONFIG_PATH: path.join(directory, 'no-runtime-config.json') },
      });
    } });
  return { source, roots, machines, attachmentPaths, calls, temporaryRoot,
    control: new SecretaryPreservationControl({ primary: reader('primary'), mirror: reader('mirror') }),
    rewriteRaw: async raw => {
      const sha256 = hash(raw);
      for (const root of Object.values(roots)) {
        await fs.writeFile(path.join(root, 'raw', sha256 + '.eml'), raw);
        await fs.writeFile(path.join(root, 'raw-receipts', messageId + '.json'), JSON.stringify({
          messageId, threadId, path: `raw/${sha256}.eml`, sha256, bytes: raw.length }));
        await fs.writeFile(path.join(root, 'threads', threadId, 'manifest.json'), JSON.stringify({ threadId,
          messages: [{ id: messageId, headers: { 'message-id': '<preservation@example.invalid>' }, attachments: [] }] }));
      }
      source.sourceSha256 = sha256;
    },
    cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

module.exports = { archive };
