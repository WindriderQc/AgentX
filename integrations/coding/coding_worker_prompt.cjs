#!/usr/bin/env node
// Hydrate the CLI's ordinary task argument in-process, after the kernel exec.
// The installed headless profile and its argument parser remain unchanged.
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

(async () => {
  const [file, cli, ...args] = process.argv.slice(2);
  if (!file || !cli) throw new Error('A private prompt file and worker CLI are required');
  const prompt = readFileSync(file, 'utf8');
  process.argv = [process.execPath, cli, ...args, prompt];
  await import(pathToFileURL(cli).href);
})().catch(error => {
  process.stderr.write(`Worker prompt startup failed: ${error.message}\n`);
  process.exitCode = 1;
});
