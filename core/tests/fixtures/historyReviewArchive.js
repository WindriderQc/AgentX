'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { archive } = require('./historyPreservationArchive');

async function reviewArchive() {
  const fixture = await archive({ command: 'review-restoration' });
  const program = ['import sys,json,shutil', 'sys.path.insert(0,sys.argv[1])', 'sys.path.insert(0,sys.argv[2])',
    'from test_archive_review_restoration import ReviewRestorationTests,MID,TID',
    't=ReviewRestorationTests();t.setUp()', 'try:',
    ' for root in sys.argv[3:]: shutil.rmtree(root);shutil.copytree(t.root,root)',
    ' print(json.dumps({"system":"gmail","messageId":MID,"threadId":TID,"sourceSha256":t.sha,"findingId":"b"*64}))',
    'finally: t.doCleanups()'].join('\n');
  try {
    const result = await promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
      path.resolve(__dirname, '../../../integrations/secretary'), path.resolve(__dirname, '../../../integrations/secretary/tests'),
      fixture.roots.primary, fixture.roots.mirror], { timeout: 10000, maxBuffer: 4096 });
    return { source: JSON.parse(result.stdout), roots: fixture.roots, machines: fixture.machines,
      calls: fixture.calls, control: fixture.control, cleanup: fixture.cleanup, temporaryRoot: fixture.temporaryRoot };
  } catch (error) { await fixture.cleanup(); throw error; }
}
module.exports = { reviewArchive };
