'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { preservationAcceptanceArchive } = require('./historyPreservationAcceptanceArchive');
const { SecretaryMailControl } = require('../../integrations/runtime-bridges/secretary-mail-control');
const { SecretaryPreservationControl } = require('../../integrations/runtime-bridges/secretary-preservation-control');
async function semanticReviewArchive() {
  const fixture = await preservationAcceptanceArchive();
  const program = ['import sys', 'from pathlib import Path', 'sys.path.insert(0,sys.argv[1])',
    'import archive_preservation as native', 'native.MACHINE_ID_FILE=Path(sys.argv[2])',
    'import secretary_mail_desk as desk', 'raise SystemExit(desk.main(["--evidence-root",sys.argv[3],*sys.argv[4:]]))'].join('\n');
  const semanticCalls = [];
  const reader = copy => new SecretaryMailControl({ sshTarget: copy + '.example.invalid', remoteRoot: '/opt/product',
    sshRunner: async (host, command) => {
      semanticCalls.push({ copy, host, command }); const args = command.split(' ');
      if (args[0] !== '/usr/bin/python3' || args[1] !== '/opt/product/integrations/secretary/secretary_mail_desk.py' || args[2] !== 'semantic-review') throw new Error('Unexpected semantic native command');
      return promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
        path.resolve(__dirname, '../../../integrations/secretary'), fixture.machines[copy], fixture.roots[copy], ...args.slice(2)],
      { timeout: 15000, maxBuffer: 512 * 1024, env: { ...process.env, TMPDIR: fixture.temporaryRoot,
        OPENCLAW_CONFIG_PATH: path.join(fixture.temporaryRoot, 'no-runtime-config.json') } });
    } });
  const control = new SecretaryPreservationControl({ primary: reader('primary'), mirror: reader('mirror') });
  fixture.control.probeSemanticReview = control.probeSemanticReview.bind(control);
  return { ...fixture, semanticCalls };
}
module.exports = { semanticReviewArchive };
