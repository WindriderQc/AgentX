import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, readdir, realpath, readlink, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
const execute = promisify(execFile);

export async function ownedDirectory(root, path) {
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  const part = relative(canonicalRoot, canonical);
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)
      || !(await lstat(path)).isDirectory()) throw new Error('Directory is outside the configured root');
  return canonical;
}

/** Copy Git objects and the current working files without sharing writable objects or hooks. */
export async function copyWorkspace(source, destination) {
  const git = async (...args) => (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', source, ...args],
    { maxBuffer: 16 * 1024 * 1024 })).stdout;
  const top = (await git('rev-parse', '--show-toplevel')).trim();
  if (await realpath(top) !== await realpath(source)) throw new Error('Worker directory must be a repository root');
  await execute('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-hardlinks', '--no-checkout', '--', source, destination]);
  const targetGit = async (...args) => execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', destination, ...args]);
  await targetGit('remote', 'remove', 'origin');
  await targetGit('config', 'core.hooksPath', '/dev/null');
  // Stashes can contain a rejected candidate after the runner restored its baseline.
  const stash = (await git('rev-parse', '--verify', '--quiet', 'refs/stash').catch(() => '')).trim();
  if (stash) await targetGit('fetch', '--no-tags', '--', source, 'refs/stash:refs/stash');
  await targetGit('reset', '--mixed', 'HEAD');
  const paths = (await git('ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(Boolean);
  const omitted = [];
  for (const path of new Set(paths)) {
    const from = resolve(source, path);
    if (!from.startsWith(`${source}${sep}`)) throw new Error('Invalid repository file');
    const stat = await lstat(from).catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!stat) continue; // Preserve tracked deletions.
    if (stat.isSymbolicLink()) {
      const link = await readlink(from);
      const target = resolve(dirname(from), link);
      if (isAbsolute(link) || !target.startsWith(`${source}${sep}`)) {
        throw new Error('Worker symlink points outside its execution copy');
      }
      await mkdir(dirname(join(destination, path)), { recursive: true });
      await symlink(link, join(destination, path));
      continue;
    }
    if (!stat.isFile()) { omitted.push(path); continue; }
    // Refuse symlink parents, including paths Git itself does not follow.
    if (await realpath(from) !== from) throw new Error('Repository path traverses a symlink');
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await cp(from, join(destination, path), { dereference: false, errorOnExist: true });
  }
  return { omitted };
}

export async function discoverWorkers(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const workers = [];
  for (const entry of entries) {
    const match = /^\.home-task-([0-9]{4,12})$/u.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;
    const taskId = match[1];
    const workspace = await ownedDirectory(root, join(root, `task-${taskId}`));
    const home = await ownedDirectory(root, join(root, entry.name));
    const logs = await ownedDirectory(home, join(home, '.dsh/progress-sessions')).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (logs) workers.push({ taskId, workspace, logs });
  }
  return workers;
}
