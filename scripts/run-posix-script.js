#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function classifyBash(candidate) {
  return /\\Git\\.*bash\.exe$/i.test(candidate) ? 'git-bash' : 'wsl-bash';
}

function findBash() {
  const explicitCandidates = [
    process.env.BASH_PATH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
  ].filter(Boolean);

  for (const candidate of explicitCandidates) {
    if (fs.existsSync(candidate)) {
      return {
        command: candidate,
        mode: classifyBash(candidate)
      };
    }
  }

  const probe = spawnSync('bash', ['--version'], { stdio: 'ignore', shell: false });
  if (!probe.error && probe.status === 0) {
    return {
      command: 'bash',
      mode: 'wsl-bash'
    };
  }

  return null;
}

function toWslPath(value) {
  const normalized = path.resolve(value).replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) {
    return normalized;
  }

  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

function main() {
  const [, , scriptArg, ...args] = process.argv;
  if (!scriptArg) {
    console.error('Usage: node scripts/run-posix-script.js <script> [args...]');
    process.exit(1);
  }

  const scriptPath = path.resolve(process.cwd(), scriptArg);
  if (!fs.existsSync(scriptPath)) {
    console.error(`POSIX script not found: ${scriptPath}`);
    process.exit(1);
  }

  if (process.platform !== 'win32') {
    const result = spawnSync(scriptPath, args, {
      stdio: 'inherit',
      shell: false
    });

    if (result.error) {
      console.error(result.error.message);
      process.exit(1);
    }

    process.exit(result.status ?? 0);
  }

  const bash = findBash();
  if (!bash) {
    console.error('Bash is required to run this script on Windows. Install Git for Windows or set BASH_PATH.');
    process.exit(1);
  }

  const scriptArgForBash = bash.mode === 'wsl-bash' ? toWslPath(scriptPath) : scriptPath;
  const bashArgs = bash.mode === 'wsl-bash'
    ? [scriptArgForBash, ...args.map(arg => (/^[A-Za-z]:\\/.test(arg) ? toWslPath(arg) : arg))]
    : [scriptArgForBash, ...args];

  const result = spawnSync(bash.command, bashArgs, {
    stdio: 'inherit',
    shell: false
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

main();
