'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { reviewArchive } = require('./historyReviewArchive');
const { control: findingControl } = require('./historyFindingArchive');
const { SecretaryMailControl } = require('../../integrations/runtime-bridges/secretary-mail-control');
const { SecretaryMailboxControl } = require('../../integrations/runtime-bridges/secretary-mailbox-control');

const DRIVER = ['import sys,json,subprocess', 'from unittest.mock import patch', 'sys.path.insert(0,sys.argv[1])',
  'import secretary_mail_desk as desk', 'reply=json.loads(sys.argv[2])',
  'def fake(command,**kwargs):',
  ' assert command==["fake-gog","--readonly","--gmail-no-send","--no-input","--json","--enable-commands-exact=gmail.get","--account=synthetic@example.invalid","gmail","get",reply["data"]["message"]["id"],"--format=raw"]',
  ' assert kwargs["timeout"]==25',
  ' return subprocess.CompletedProcess(command,reply["code"],json.dumps(reply["data"]),reply["stderr"])',
  'with patch.object(desk,"native_settings",return_value={}), patch.object(desk,"gmail_environment",return_value={}), patch.object(desk.subprocess,"run",side_effect=fake):',
  ' desk.main(["--account","synthetic@example.invalid","--keyring-password-file","/unused/synthetic-key","--gog","fake-gog",*sys.argv[3:]])'].join('\n');

async function manifestArchive({ reviewFixture } = {}) {
  const fixture = reviewFixture || await reviewArchive();
  try {
    const receipt = JSON.parse(await fs.readFile(path.join(fixture.roots.primary, 'raw-receipts', fixture.source.messageId + '.json')));
    const raw = await fs.readFile(path.join(fixture.roots.primary, receipt.path));
    const calls = [], reply = { code: 0, stderr: '', data: { message: { id: fixture.source.messageId, threadId: fixture.source.threadId,
      internalDate: '1000', historyId: '99999999999999999999', labelIds: ['SENT', 'INBOX'], raw: raw.toString('base64url') } } };
    const mailbox = new SecretaryMailboxControl({ reader: new SecretaryMailControl({ sshTarget: 'native.example.invalid', remoteRoot: '/opt/product',
      sshRunner: async (host, command) => {
        calls.push({ host, command });
        const args = command.split(' ');
        if (args[0] !== '/usr/bin/python3' || args[1] !== '/opt/product/integrations/secretary/secretary_mail_desk.py'
          || args[2] !== 'mailbox-scope') throw new Error('Unexpected native command');
        return promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', DRIVER,
          path.resolve(__dirname, '../../../integrations/secretary'), JSON.stringify(reply), ...args.slice(2)], { timeout: 10000, maxBuffer: 128 * 1024 });
      } }) });
    const findings = findingControl(fixture.roots.primary, path.join(fixture.roots.primary, 'no-runtime-config.json'));
    return { ...fixture, findings, mailbox, mailboxCalls: calls, reply };
  } catch (error) { await fixture.cleanup(); throw error; }
}

module.exports = { manifestArchive };
