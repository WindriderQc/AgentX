'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRemote } = require('../transport.cjs');
const { createPhotoImportService } = require('../../../core/src/services/photos/photoImportService');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-envelope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const media = path.join(root, 'media'), cache = path.join(root, 'cache'), jobs = path.join(root, 'jobs');
  for (const dir of [media, cache, jobs]) await fs.mkdir(dir);
  const config = path.join(root, 'receiver.json'); await fs.writeFile(config, JSON.stringify({ root: media, transportRoot: jobs }));
  const service = await createPhotoImportService({ root: media });
  const runId = crypto.randomUUID(), requestId = crypto.randomUUID(), sha256 = crypto.createHash('sha256').update('hello').digest('hex');
  await service.begin({ runId, deviceKey: 'a'.repeat(64), coverage: { enumerationComplete: true },
    sources: [{ requestId, key: 'one', name: 'image.jpg', relativePath: 'DCIM/image.jpg', size: 5, modified: null }] });
  const file = path.join(root, 'payload.media'); await fs.writeFile(file, 'hello');
  return { media, cache, jobs, config, service, file, input: { action: 'receive', runId, requestId, size: 5, sha256 } };
}
test('lost response transfers retry the same envelope without replaying the domain publication', async t => {
  const f = await fixture(t), receiver = path.resolve(__dirname, '../receiver.cjs');
  let executions = 0, failed = false; const downloads = [], waits = [];
  const runNative = async (program, args) => {
    if (program === 'scp') {
      assert.equal(args.includes('-n'), false, 'SFTP keeps its private stdin');
      const [from, to] = args.slice(-2);
      if (from.endsWith('/response.json')) {
        downloads.push([from, to]); if (!failed) { failed = true; return 255; }
      }
      await fs.copyFile(from.replace(/^synthetic:/, ''), to.replace(/^synthetic:/, '')); return 0;
    }
    assert.equal(program, 'ssh'); assert.ok(args.includes('-n'));
    const command = args.at(-1);
    if (command.startsWith('mkdir ')) { await fs.mkdir(command.match(/'([^']+)'$/)[1]); return 0; }
    const job = command.match(/--(job|cleanup) '([a-f0-9-]+)'$/);
    assert.ok(job);
    if (job[1] === 'job') executions++;
    execFileSync(process.execPath, [receiver, '--config', f.config, '--'+job[1], job[2]]); return 0;
  };
  const remote = createRemote({ sshHost: 'synthetic', node: process.execPath, receiver, receiverConfig: f.config,
    remoteTransportRoot: f.jobs, cacheRoot: f.cache }, { runNative, pause: async ms => waits.push(ms) });
  const receipt = await remote(f.input, { file: f.file });
  assert.equal(executions, 1); assert.equal(downloads.length, 2); assert.deepEqual(downloads[0], downloads[1]);
  assert.deepEqual(waits, [250]); assert.equal(receipt.disposition, 'copied');
  assert.equal((await f.service.status(f.input)).counts.copied, 1);
  assert.equal(await fs.readFile(receipt.path, 'utf8'), 'hello');
  const reconciled = await remote({ action: 'lookupMany' }, { json: { runId: f.input.runId, items: [f.input] } });
  assert.equal(reconciled.results[0].sha256, receipt.sha256);
  assert.equal(executions, 2);
});
test('persistent file transport failure is bounded and never dispatches a replacement effect', async t => {
  const f = await fixture(t); let copies = 0, executions = 0;
  const remote = createRemote({ sshHost: 'synthetic', receiver: '/fixed/receiver.cjs', receiverConfig: f.config,
    remoteTransportRoot: f.jobs, cacheRoot: f.cache }, { pause: async () => {}, runNative: async (program) => {
      if (program === 'scp') { copies++; return 255; }
      executions++; return 0;
    } });
  await assert.rejects(remote(f.input, { file: f.file }), /SCP transfer incomplete/);
  assert.equal(copies, 3); assert.equal(executions, 1, 'only staging mkdir was attempted');
  assert.equal((await f.service.status(f.input)).counts.pending, 1);
  assert.equal((await fs.readdir(f.cache)).length, 1, 'failed envelope remains available');
});
