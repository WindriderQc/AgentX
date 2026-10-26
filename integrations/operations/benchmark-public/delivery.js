'use strict';

/**
 * Push the outbox to the public server with rsync over SSH. Outbound only.
 *
 * Only the scoreboard files are sent. On the server, rsync may delete nothing
 * except an expired dated snapshot inside `snapshots/`: a mistaken target
 * folder cannot lose its other files. The server should still confine the key
 * to that folder (`rrsync -wo <folder>` in authorized_keys).
 */

const fs = require('fs');
const { spawn } = require('child_process');

const TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}:(\/[A-Za-z0-9_.\-/]*[A-Za-z0-9_\-/])$/;
const DELIVERY_TIMEOUT_MS = 120_000;

function validateTarget(target) {
  const value = String(target || '').trim();
  const match = value.match(TARGET);
  if (!match || match[1].includes('..') || match[1] === '/') {
    const error = new Error('The public target must look like user@host:/absolute/folder');
    error.code = 'PUBLIC_TARGET_INVALID';
    throw error;
  }
  return value.endsWith('/') ? value : `${value}/`;
}

function rsyncArgs(outbox, { target, sshKey, knownHosts }) {
  const ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10'];
  if (sshKey) ssh.push('-o', 'IdentitiesOnly=yes', '-i', sshKey);
  if (knownHosts) ssh.push('-o', `UserKnownHostsFile=${knownHosts}`);
  for (const part of ssh) {
    if (/\s/.test(part)) throw Object.assign(new Error('SSH key and known-hosts paths must not contain spaces'), { code: 'PUBLIC_TARGET_INVALID' });
  }
  return [
    '--recursive', '--times', '--delay-updates', '--delete-after',
    '--chmod=D755,F644', '--out-format=%i %n',
    '-e', ssh.join(' '),
    '--filter=P /*',
    '--include=/*.json',
    '--include=/snapshots/',
    '--include=/snapshots/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json',
    '--exclude=*',
    `${outbox.replace(/\/+$/, '')}/`,
    validateTarget(target),
  ];
}

function summarize(stdout) {
  const lines = String(stdout).split('\n').map((line) => line.trim()).filter(Boolean);
  return {
    sent: lines.filter((line) => /^[<>]f/.test(line)).length,
    deleted: lines.filter((line) => line.startsWith('*deleting')).length,
  };
}

/** Deliver the outbox; resolves with { status: 'delivered', sent, deleted }. */
function deliverRsync(outbox, { target, sshKey, knownHosts, spawnImpl = spawn, timeoutMs = DELIVERY_TIMEOUT_MS } = {}) {
  if (sshKey && !fs.existsSync(sshKey)) {
    return Promise.reject(Object.assign(new Error('The SSH key file does not exist'), { code: 'PUBLIC_TARGET_INVALID' }));
  }
  let args;
  try {
    args = rsyncArgs(outbox, { target, sshKey, knownHosts });
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(Object.assign(error, { code: 'PUBLIC_DELIVERY_FAILED' })); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ status: 'delivered', ...summarize(stdout) });
      // stderr can name the server; keep only the exit status in the report.
      const error = new Error(`rsync failed (${signal || `exit ${code}`})`);
      error.code = 'PUBLIC_DELIVERY_FAILED';
      error.detail = stderr.slice(-500);
      return reject(error);
    });
  });
}

module.exports = { deliverRsync, rsyncArgs, summarize, validateTarget };
