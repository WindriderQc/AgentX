import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import {
  describe as describeResult, exitCode, parseArgs, readZip, revisionOf, run, skillFromZip, SyncError,
} from '../sync.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'sync.mjs');
const { archive } = createRequire(import.meta.url)('../../../core/src/services/operatorSkill.js');

const REV_A = 'a'.repeat(40);
const REV_B = 'b'.repeat(40);

function servedFiles(revision, extra = {}) {
  return [
    { name: 'SKILL.md', text: '---\nname: agentx\ndescription: test skill\n---\n\n# AgentX\n' },
    { name: 'references/ops.md', text: '# Ops\n' },
    ...Object.entries(extra).map(([name, text]) => ({ name, text })),
    { name: 'references/served.md', text: `# Where this copy came from\n\n- Product revision: \`${revision}\`\n- Generated: ${new Date().toISOString()}\n` },
  ];
}

// The same bytes Core's /api/operator-skill/download sends.
const coreZip = (revision, extra) => archive({ name: 'agentx', files: servedFiles(revision, extra) });

// A stored (uncompressed) archive, which other zip writers produce.
function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, text } of entries) {
    const file = Buffer.from(name);
    const data = Buffer.from(text);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt32LE(zlib.crc32(data), 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(file.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt32LE(zlib.crc32(data), 16);
    record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(file.length, 28); record.writeUInt32LE(offset, 42);
    local.push(head, file, data);
    central.push(record, file);
    offset += 30 + file.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const answer = (body, status = 200) => async () => new Response(body, { status });

async function homes(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-skills-sync-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const roots = { claude: path.join(base, '.claude'), codex: path.join(base, '.codex') };
  await fs.mkdir(roots.claude);
  return { base, roots, dir: path.join(roots.claude, 'skills', 'agentx') };
}

const options = (more = {}) => ({ runtime: 'all', core: 'http://core.test', check: false, force: false, ...more });
const read = (dir, name) => fs.readFile(path.join(dir, ...name.split('/')), 'utf8');

test('parseArgs reads runtime, core and flags', () => {
  const parsed = parseArgs(['--runtime', 'codex', '--core', 'http://x:1', '--check', '--json'], {});
  assert.equal(parsed.runtime, 'codex');
  assert.equal(parsed.core, 'http://x:1');
  assert.equal(parsed.check, true);
  assert.equal(parsed.json, true);
  assert.equal(parseArgs([], { AGENTX_CORE_URL: 'http://env:2' }).core, 'http://env:2');
  assert.equal(parseArgs([], {}).runtime, 'all');
  assert.throws(() => parseArgs(['--runtime', 'hermes'], {}), SyncError);
  assert.throws(() => parseArgs(['--core'], {}), SyncError);
  assert.throws(() => parseArgs(['--check', '--force'], {}), SyncError);
  assert.throws(() => parseArgs(['--what'], {}), SyncError);
});

test('readZip reads deflated Core archives and stored archives', () => {
  const files = readZip(coreZip(REV_A));
  assert.deepEqual([...files.keys()], ['agentx/SKILL.md', 'agentx/references/ops.md', 'agentx/references/served.md']);
  assert.equal(files.get('agentx/references/ops.md').toString(), '# Ops\n');
  const stored = readZip(storedZip([{ name: 'agentx/SKILL.md', text: 'hello' }]));
  assert.equal(stored.get('agentx/SKILL.md').toString(), 'hello');
});

test('readZip refuses damaged or unsafe archives', () => {
  assert.throws(() => readZip(Buffer.from('not a zip')), /not a zip/);
  assert.throws(() => readZip(storedZip([{ name: 'agentx/../evil.md', text: 'x' }])), /unsafe path/);
  assert.throws(() => readZip(storedZip([{ name: '/etc/passwd', text: 'x' }])), /unsafe path/);
  assert.throws(() => readZip(storedZip([{ name: 'agentx\\x.md', text: 'x' }])), /unsafe path/);
  const corrupt = storedZip([{ name: 'agentx/SKILL.md', text: 'hello' }]);
  corrupt[30 + 'agentx/SKILL.md'.length] ^= 0xff;
  assert.throws(() => readZip(corrupt), /checksum mismatch/);
});

test('skillFromZip needs SKILL.md, the agentx name and a revision', () => {
  const skill = skillFromZip(coreZip(REV_A));
  assert.equal(skill.revision, REV_A);
  assert.ok(skill.files.has('SKILL.md'));
  assert.throws(() => skillFromZip(storedZip([{ name: 'agentx/references/served.md', text: `Product revision: \`${REV_A}\`` }])), /no agentx\/SKILL.md/);
  assert.throws(() => skillFromZip(storedZip([{ name: 'agentx/SKILL.md', text: '---\nname: other\n---\n' }])), /name: agentx/);
  assert.throws(() => skillFromZip(storedZip([{ name: 'agentx/SKILL.md', text: '---\nname: agentx\n---\n' }])), /no product revision/);
  assert.throws(() => skillFromZip(storedZip([{ name: 'other/SKILL.md', text: 'x' }])), /outside agentx\//);
  assert.equal(revisionOf('- Product revision: `abc123`'), 'abc123');
  assert.equal(revisionOf('nothing here'), null);
});

test('installs a missing copy and skips a runtime that is not installed', async (t) => {
  const { roots, dir } = await homes(t);
  const result = await run(options(), { roots, fetch: answer(coreZip(REV_A)) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.runtimes.map(item => item.status), ['installed', 'skipped']);
  assert.match(await read(dir, 'references/served.md'), new RegExp(REV_A));
  assert.equal(exitCode(result), 0);
  assert.match(describeResult(result)[0], /^claude: installed none -> aaaaaaaa/);
  await assert.rejects(fs.access(path.join(roots.claude, '.agentx-skill-sync')));
});

test('leaves a current copy alone and replaces it when the revision changes', async (t) => {
  const { roots, dir } = await homes(t);
  await run(options(), { roots, fetch: answer(coreZip(REV_A)) });
  const before = await fs.stat(path.join(dir, 'SKILL.md'));

  const again = await run(options({ runtime: 'claude' }), { roots, fetch: answer(coreZip(REV_A)) });
  assert.equal(again.runtimes[0].status, 'current');
  assert.equal((await fs.stat(path.join(dir, 'SKILL.md'))).ino, before.ino);

  const updated = await run(options({ runtime: 'claude' }), { roots, fetch: answer(coreZip(REV_B, { 'references/new.md': '# New\n' })) });
  assert.equal(updated.runtimes[0].status, 'updated');
  assert.equal(updated.runtimes[0].installed, REV_A);
  assert.match(await read(dir, 'references/served.md'), new RegExp(REV_B));
  assert.equal(await read(dir, 'references/new.md'), '# New\n');
});

test('replaces a copy whose files differ under the same revision', async (t) => {
  const { roots, dir } = await homes(t);
  await run(options(), { roots, fetch: answer(coreZip(REV_A, { 'references/instance.md': 'old sheet' })) });
  await fs.writeFile(path.join(dir, 'stray.md'), 'edited in place');
  const result = await run(options(), { roots, fetch: answer(coreZip(REV_A, { 'references/instance.md': 'new sheet' })) });
  assert.equal(result.runtimes[0].status, 'updated');
  assert.equal(await read(dir, 'references/instance.md'), 'new sheet');
  await assert.rejects(fs.access(path.join(dir, 'stray.md')));
});

test('a failed download or a bad archive leaves the installed copy untouched', async (t) => {
  const { roots, dir } = await homes(t);
  await run(options(), { roots, fetch: answer(coreZip(REV_A)) });
  const failures = [
    answer('nope', 500),
    answer(Buffer.from('garbage')),
    answer(storedZip([{ name: 'agentx/references/served.md', text: `Product revision: \`${REV_B}\`` }])),
    async () => { throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }); },
  ];
  for (const fetch of failures) {
    const result = await run(options(), { roots, fetch });
    assert.equal(result.ok, false);
    assert.equal(exitCode(result), 1);
    assert.match(describeResult(result)[0], /^agentx-skills sync failed: /);
    assert.match(await read(dir, 'references/served.md'), new RegExp(REV_A));
  }
});

test('--check reports a stale copy without touching it', async (t) => {
  const { roots, dir } = await homes(t);
  await run(options(), { roots, fetch: answer(coreZip(REV_A)) });
  const result = await run(options({ check: true }), { roots, fetch: answer(coreZip(REV_B)) });
  assert.equal(result.runtimes[0].status, 'stale');
  assert.equal(exitCode(result), 3);
  assert.match(await read(dir, 'references/served.md'), new RegExp(REV_A));
});

test('an explicitly requested runtime that is not installed fails', async (t) => {
  const { roots } = await homes(t);
  const result = await run(options({ runtime: 'codex' }), { roots, fetch: answer(coreZip(REV_A)) });
  assert.equal(result.ok, false);
  assert.match(result.runtimes[0].error, /not found/);
  await assert.rejects(fs.access(roots.codex));
});

test('--force rewrites a current copy', async (t) => {
  const { roots } = await homes(t);
  await run(options(), { roots, fetch: answer(coreZip(REV_A)) });
  const result = await run(options({ force: true }), { roots, fetch: answer(coreZip(REV_A)) });
  assert.equal(result.runtimes[0].status, 'updated');
});

test('restores a copy left in staging by an interrupted run', async (t) => {
  const { roots, dir } = await homes(t);
  await run(options(), { roots, fetch: answer(coreZip(REV_A)) });
  const staging = path.join(roots.claude, '.agentx-skill-sync');
  await fs.mkdir(staging);
  await fs.rename(dir, path.join(staging, 'old'));
  await fs.mkdir(path.join(staging, 'new'));
  const result = await run(options(), { roots, fetch: answer(coreZip(REV_A)) });
  assert.equal(result.runtimes[0].status, 'current');
  await assert.rejects(fs.access(staging));
});

test('the command line downloads from --core and honours CLAUDE_CONFIG_DIR', async (t) => {
  const { base, roots, dir } = await homes(t);
  const body = coreZip(REV_B);
  let broken = false;
  const server = http.createServer((req, res) => {
    if (broken || req.url !== '/api/operator-skill/download') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length }).end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const core = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, CLAUDE_CONFIG_DIR: roots.claude, CODEX_HOME: path.join(base, 'absent'), HOME: base, USERPROFILE: base };
  const exec = promisify(execFile);

  const first = await exec(process.execPath, [script, '--core', core, '--json'], { env });
  const report = JSON.parse(first.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.runtimes.map(item => item.status), ['installed', 'skipped']);
  assert.match(await read(dir, 'references/served.md'), new RegExp(REV_B));

  const second = await exec(process.execPath, [script, '--core', core, '--runtime', 'claude'], { env });
  assert.match(second.stdout, /^claude: current at bbbbbbbb/);

  broken = true;
  await assert.rejects(exec(process.execPath, [script, '--core', core, '--runtime', 'claude'], { env }),
    (error) => error.code === 1 && /HTTP 404/.test(error.stderr));
  await assert.rejects(exec(process.execPath, [script, '--runtime', 'nope'], { env }), (error) => error.code === 2);
});
