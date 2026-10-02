#!/usr/bin/env node
'use strict';

// Decides whether a CI job has work to do for the files a pull request changes.
// Required check names stay stable: an out-of-scope job still reports, it just
// skips its expensive steps.

const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const SERVICES = ['core', 'benchmark', 'rag', 'data'];

const COMPOSE_PATTERNS = [
  /(^|\/)Dockerfile[^/]*$/,
  /^docker-compose[^/]*\.ya?ml$/,
  /^config\//,
  /^agentx$/,
  /^scripts\//,
  /^integrations\/operations\//,
  /(^|\/)package(-lock)?\.json$/,
  /^\.github\//
];

function isDocumentation(file) {
  return file.endsWith('.md') || file.startsWith('docs/');
}

function ownerService(file) {
  const top = file.split('/')[0];
  if (SERVICES.includes(top)) return top;
  if (top === 'integrations' || top === 'skills') return 'core';
  return null;
}

// Returns { services: Set, compose: boolean } for a list of changed paths.
function scope(files) {
  const services = new Set();
  let compose = false;
  for (const file of files) {
    if (isDocumentation(file)) continue;
    if (COMPOSE_PATTERNS.some(pattern => pattern.test(file))) compose = true;
    const service = ownerService(file);
    if (service) {
      services.add(service);
    } else {
      // Shared code, root tooling and anything unclassified: run everything.
      SERVICES.forEach(name => services.add(name));
      compose = true;
    }
  }
  return { services, compose };
}

function changedFiles(base) {
  const output = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' });
  return output.split('\n').map(line => line.trim()).filter(Boolean);
}

function main() {
  const job = process.env.CI_SCOPE_JOB;
  const base = process.env.CI_SCOPE_BASE;
  let run = true;
  let reason = 'no pull request base: full run';
  if (base) {
    const files = changedFiles(base);
    const result = scope(files);
    run = job === 'compose' ? result.compose : result.services.has(job);
    reason = `${files.length} changed file(s); in scope: ${run}`;
  }
  console.log(`[ci-scope] ${job}: ${reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
}

if (require.main === module) main();

module.exports = { scope };
