/** Stable independent handoff using the same Git copy primitive as DSH. */
import { copyWorkspace } from '../dsh/coding-team/src/workspaces.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);

export async function workspaceFingerprint(source) {
  source = await realpath(source);
  const git = async (...args) => (await execute('git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-C', source, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  const paths = (await git('ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(Boolean);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const path of [...new Set(paths)].sort()) {
    const from = resolve(source, path);
    if (!from.startsWith(source + sep)) throw new Error('Invalid repository path');
    hash.update(path + '\0');
    const stat = await lstat(from).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!stat) { hash.update('deleted\0'); continue; }
    if (stat.isSymbolicLink()) { hash.update('link\0' + await readlink(from)); continue; }
    if (!stat.isFile() || await realpath(from) !== from) throw new Error('Unsupported repository entry');
    bytes += stat.size;
    if (stat.size > 128 * 1024 * 1024 || bytes > 512 * 1024 * 1024) throw new Error('Repository exceeds handoff copy bounds');
    hash.update(`file:${stat.mode & 0o111}\0`);
    hash.update(await readFile(from));
  }
  return { files: hash.digest('hex'), head: (await git('rev-parse', 'HEAD')).trim(),
    stash: (await git('rev-parse', '--verify', '--quiet', 'refs/stash').catch(() => '')).trim() };
}

export async function independentCopy(source, destination) {
  if (await realpath(source) !== resolve(source)) throw new Error('Source repository root changed its identity');
  const before = await workspaceFingerprint(source);
  const result = await copyWorkspace(source, destination);
  const after = await workspaceFingerprint(source);
  const copy = await workspaceFingerprint(destination);
  if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(before) !== JSON.stringify(copy)
      || result.omitted.length) throw new Error('Repository changed or could not be copied completely; retain the incomplete receipt');
  return { ...result, ...copy };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('An exact source and new destination are required');
  console.log(JSON.stringify(await independentCopy(process.argv[2], process.argv[3])));
}
