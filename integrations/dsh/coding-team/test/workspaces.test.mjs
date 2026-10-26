import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { copyWorkspace, discoverWorkers } from '../src/workspaces.mjs';
const execute = promisify(execFile);

test('human copy retains dirty files, deletions and rejected stash without sharing writable Git objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentx-worker-copy-'));
  try {
    const source = join(root, 'task-9999');
    await mkdir(source);
    const git = async (...args) => (await execute('git', ['-C', source, ...args])).stdout;
    await git('init');
    await writeFile(join(source, 'tracked.txt'), 'baseline\n');
    await writeFile(join(source, 'deleted.txt'), 'delete me\n');
    await writeFile(join(source, '.gitignore'), 'private.env\n');
    await git('add', '.');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline');
    await writeFile(join(source, 'tracked.txt'), 'rejected candidate\n');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'stash', 'push', '-m', 'rejected');
    const stash = (await git('rev-parse', 'refs/stash')).trim();
    await writeFile(join(source, 'tracked.txt'), 'worker dirty edit\n');
    await writeFile(join(source, 'new.txt'), 'untracked result\n');
    await writeFile(join(source, 'private.env'), 'fixture secret\n');
    await rm(join(source, 'deleted.txt'));
    await git('remote', 'add', 'origin', 'https://user:credential@example.invalid/project.git');
    const target = join(root, 'copy');
    await copyWorkspace(source, target);
    const targetGit = async (...args) => (await execute('git', ['-C', target, ...args])).stdout;
    assert.equal(await readFile(join(target, 'tracked.txt'), 'utf8'), 'worker dirty edit\n');
    assert.equal(await readFile(join(target, 'new.txt'), 'utf8'), 'untracked result\n');
    await assert.rejects(lstat(join(target, 'deleted.txt')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(target, 'private.env')), { code: 'ENOENT' });
    assert.equal((await targetGit('rev-parse', 'refs/stash')).trim(), stash);
    assert.equal(await targetGit('remote'), '');
    assert.equal((await targetGit('config', 'core.hooksPath')).trim(), '/dev/null');
    await writeFile(join(target, 'tracked.txt'), 'human edit\n');
    assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'worker dirty edit\n');
    assert.equal((await git('rev-parse', 'refs/stash')).trim(), stash);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('discovery refuses worker directory symlinks escaping the configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentx-worker-discovery-'));
  try {
    await mkdir(join(root, 'workers'));
    await mkdir(join(root, 'outside'));
    await mkdir(join(root, 'workers/.home-task-9999'));
    await symlink(join(root, 'outside'), join(root, 'workers/task-9999'));
    await assert.rejects(discoverWorkers(join(root, 'workers')), /outside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('copy preserves relative internal links and refuses external execution links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentx-worker-links-'));
  try {
    const source = join(root, 'source');
    await mkdir(source);
    const git = async (...args) => execute('git', ['-C', source, ...args]);
    await git('init');
    await writeFile(join(source, 'file.txt'), 'source\n');
    await symlink('file.txt', join(source, 'internal'));
    await git('add', '.');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'links');
    const target = join(root, 'copy');
    await copyWorkspace(source, target);
    await writeFile(join(target, 'internal'), 'human\n');
    assert.equal(await readFile(join(target, 'file.txt'), 'utf8'), 'human\n');
    assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'source\n');
    await symlink('../outside.txt', join(source, 'external'));
    await assert.rejects(copyWorkspace(source, join(root, 'refused')), /outside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
