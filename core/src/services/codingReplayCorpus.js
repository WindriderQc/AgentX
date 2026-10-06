'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCHEMA = 'agentx.completed-coding-corpus/v1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function repositoryPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || value.startsWith('/') || value.split('/').some(part => ['.', '..', '.git', ''].includes(part))) {
    throw new Error('corpus paths must be repository-relative authority paths');
  }
  return value;
}

function command(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${cmd} failed: ${result.error?.message || result.stderr}`);
  return result.stdout;
}

// The operator exports completed task snapshots and original-base receipts.
// No live Pipeline record or current HEAD is used as a substitute for a receipt.
function loadCorpus(file, repo) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw.schema !== SCHEMA || !Array.isArray(raw.tasks) || !raw.tasks.length || raw.tasks.length > 1000) {
    throw new Error(`corpus must contain 1-1000 completed tasks with schema ${SCHEMA}`);
  }
  const seen = new Set();
  return raw.tasks.map(task => {
    if (typeof task.pipelineId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(task.pipelineId)
      || seen.has(task.pipelineId)) throw new Error('corpus task identity is invalid or duplicated');
    seen.add(task.pipelineId);
    if (task.status !== 'done' || !task.spec?.trim() || !/^[a-f0-9]{40}$/.test(task.baseRevision || '')
      || !/^[a-f0-9]{64}$/.test(task.originalReceiptFingerprint || '')) {
      throw new Error(`task ${task.pipelineId} needs a done snapshot, specification, original base and receipt fingerprint`);
    }
    if (command('git', ['-C', repo, 'rev-parse', `${task.baseRevision}^{commit}`]).trim() !== task.baseRevision) {
      throw new Error('original base is not an exact available commit');
    }
    for (const key of ['sourceFiles', 'scope']) {
      if (!Array.isArray(task[key]) || !task[key].length || task[key].length > 100) throw new Error(`missing ${key}`);
      task[key] = [...new Set(task[key].map(repositoryPath))].sort();
    }
    const verification = task.verification;
    if (!verification || typeof verification.profile !== 'string' || !verification.profile
      || !Array.isArray(verification.argv) || !verification.argv.length || !verification.argv[0]?.startsWith('/')
      || verification.argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || !Number.isInteger(verification.timeoutMs) || verification.timeoutMs < 1 || verification.timeoutMs > 900000) {
      throw new Error('corpus needs a bounded operator-selected verification profile and argv');
    }
    if (!Array.isArray(verification.sourceFiles) || !verification.sourceFiles.length) {
      throw new Error('verification needs original immutable sourceFiles');
    }
    verification.sourceFiles = [...new Set(verification.sourceFiles.map(repositoryPath))].sort();
    const readAuthority = filePath => {
      const mode = command('git', ['-C', repo, 'ls-tree', task.baseRevision, '--', filePath]).split(' ')[0];
      if (!['100644', '100755'].includes(mode)) throw new Error(`authority is not an original regular file: ${filePath}`);
      return { path: filePath, content: command('git', ['-C', repo, 'show', `${task.baseRevision}:${filePath}`]) };
    };
    const authority = task.sourceFiles.map(readAuthority);
    const verifierAuthority = verification.sourceFiles.map(readAuthority);
    const snapshot = { pipelineId: task.pipelineId, status: task.status, spec: task.spec,
      baseRevision: task.baseRevision, originalReceiptFingerprint: task.originalReceiptFingerprint,
      sourceFiles: task.sourceFiles, scope: task.scope, verification };
    return { ...snapshot, authority, verifierAuthority, fingerprint: digest({ ...snapshot, authority, verifierAuthority }) };
  });
}

function messagesForTask(task) {
  return [
    { role: 'system', content: 'Repair the repository task using the supplied original files. Return only a unified git diff. Change only the permitted scope. Do not change verification rules or weaken tests.' },
    { role: 'user', content: JSON.stringify({ specification: task.spec, baseRevision: task.baseRevision,
      permittedScope: task.scope, verificationProfile: task.verification.profile, files: task.authority }) }
  ];
}

function createWorkspace(repo, task, directory) {
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  command('git', ['-C', repo, 'worktree', 'add', '--detach', directory, task.baseRevision]);
  return { directory, close: () => command('git', ['-C', repo, 'worktree', 'remove', '--force', directory]) };
}

function verifyPatch(workspace, task, patch, verify) {
  const directory = workspace.directory;
  const raw = String(patch || '').trim().replace(/^```(?:diff|patch)?\s*\n/, '').replace(/\n```$/, '');
  if (!raw) return { pass: false, code: 'EMPTY_PATCH' };
  try {
    command('git', ['apply', '--check', '--index', '-'], { cwd: directory, input: `${raw}\n` });
    command('git', ['apply', '--index', '-'], { cwd: directory, input: `${raw}\n` });
  } catch (error) { return { pass: false, code: 'PATCH_REJECTED', detail: error.message }; }
  const changed = command('git', ['diff', '--name-only', '-z', 'HEAD'], { cwd: directory }).split('\0').filter(Boolean);
  const unsafe = changed.some(file => task.verification.sourceFiles.includes(file))
    || changed.some(file => !task.scope.some(scope => file === scope || file.startsWith(`${scope}/`)))
    || changed.some(file => {
      const absolute = path.join(directory, file);
      try { return !fs.lstatSync(absolute).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
  if (unsafe) return { pass: false, code: 'SCOPE_VIOLATION', changed };
  const result = verify(directory, task.verification);
  return { ...result, changed, patchFingerprint: digest(raw) };
}

// Verification code sees a read-only checkout, fresh /tmp, no home or network.
// This capability never falls back to running worker-controlled code on the host.
function sandboxVerify(directory, verification) {
  const started = Date.now();
  const args = ['--die-with-parent', '--unshare-net', '--unshare-pid', '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin', '--proc', '/proc',
    '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/workspace', '--ro-bind', directory, '/workspace',
    '--chdir', '/workspace', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'HOME', '/tmp', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1'];
  const argv = [...verification.argv];
  if (argv[0] === '/node/node') args.push('--dir', '/node', '--ro-bind', fs.realpathSync(process.execPath), '/node/node');
  const result = spawnSync('/usr/bin/bwrap', [...args, ...argv], {
    encoding: 'utf8', timeout: verification.timeoutMs, maxBuffer: 1024 * 1024
  });
  return { pass: !result.error && result.status === 0, code: result.error?.code || (result.status === 0 ? 'PASSED' : 'VERIFICATION_FAILED'),
    exitCode: result.status, durationMs: Date.now() - started,
    output: `${result.stdout || ''}${result.stderr || ''}` };
}

module.exports = { SCHEMA, digest, loadCorpus, messagesForTask, createWorkspace, verifyPatch, sandboxVerify };
