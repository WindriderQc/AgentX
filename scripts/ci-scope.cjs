#!/usr/bin/env node
'use strict';

// Decides whether a CI job has work to do for the files a pull request changes.
// Required check names stay stable: an out-of-scope job still reports, it just
// skips its expensive steps.

const { execFileSync } = require('node:child_process');
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

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

// Benchmark and RAG images copy some Core views and browser assets and serve
// them at runtime. Each Dockerfile's `COPY core/...` lines are the one list of
// those sources, so a change to one of them also tests that service.
const CORE_ASSET_DOCKERFILES = {
  benchmark: 'docker/benchmark.Dockerfile',
  rag: 'docker/rag.Dockerfile'
};

function coreAssetSources(dockerfile) {
  const absolute = path.join(__dirname, '..', dockerfile);
  if (!existsSync(absolute)) return [];
  return readFileSync(absolute, 'utf8').split('\n').flatMap(line => {
    const tokens = line.trim().split(/\s+/);
    if (tokens[0] !== 'COPY') return [];
    const sources = tokens.slice(1, -1).filter(token => !token.startsWith('--'));
    return sources.filter(source => source.startsWith('core/')).map(source => source.replace(/\/+$/, ''));
  });
}

const CORE_ASSET_CONSUMERS = Object.entries(CORE_ASSET_DOCKERFILES)
  .map(([service, dockerfile]) => ({ service, sources: coreAssetSources(dockerfile) }));

function coreAssetConsumers(file) {
  return CORE_ASSET_CONSUMERS
    .filter(({ sources }) => sources.some(source => file === source || file.startsWith(`${source}/`)))
    .map(({ service }) => service);
}

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
      const consumers = service === 'core' ? coreAssetConsumers(file) : [];
      consumers.forEach(name => services.add(name));
      if (consumers.length) compose = true;
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

module.exports = { scope, CORE_ASSET_CONSUMERS };
