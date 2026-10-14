import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildPackage } from './package.mjs';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  const value = process.argv[i + 1];
  if (!['--runtime-root', '--playwright-module', '--chromium'].includes(flag) || !value) {
    throw new Error('Provide --runtime-root, --playwright-module and --chromium');
  }
  options[flag] = resolve(value);
}
for (const flag of ['--runtime-root', '--playwright-module', '--chromium']) {
  assert.ok(options[flag], `Missing ${flag}`);
}
const runtime = options['--runtime-root'];
const runtimeModules = join(runtime, 'node_modules');
assert.equal(JSON.parse(await readFile(join(runtimeModules, '@deepseek-ai/dsh/package.json'))).version, '0.2.0-rc.2');
const { chromium } = await import(pathToFileURL(options['--playwright-module']).href);
const temporary = await mkdtemp(join(tmpdir(), 'agentx-dsh-link-native-'));
let child;
let browser;
let providerCalls = 0;
const provider = createServer((_request, response) => {
  providerCalls += 1;
  response.writeHead(503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'This smoke must not invoke a model' }));
});

async function command(executable, args, cwd) {
  const process = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  process.stdout.on('data', (chunk) => { output += chunk; });
  process.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(process, 'exit');
  assert.equal(code, 0, output);
  return output;
}

try {
  const packageRoot = await buildPackage({ coreUrl: 'https://agentx.example', output: join(temporary, 'package') });
  await command('npm', ['pack', packageRoot, '--ignore-scripts', '--pack-destination', temporary], temporary);
  const profile = join(temporary, 'home/profiles/web');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@agentx/dsh-coding-team'] } },
  }));
  await command('npm', ['install', join(temporary, 'agentx-dsh-coding-team-0.1.0.tgz'),
    '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], profile);
  await symlink(join(runtimeModules, '@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  await writeFile(join(temporary, 'home/settings.json'), '{}\n');
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const fixtureUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  const patches = [
    { id: 'llm-pi-ai', config: { providers: { fixture: {
      api: 'openai-completions', baseURL: fixtureUrl, apiKeyEnv: 'AGENTX_SMOKE_API_KEY',
      models: [{ id: 'fixture-model', contextWindow: 8192, maxTokens: 256 }],
    } } } },
    { id: 'agent-default-model', config: { provider: 'fixture', model: 'fixture-model' } },
    { id: 'session-title-llm', disabled: true },
    { id: 'host-product-telemetry-otel', disabled: true },
  ];
  const patchFile = join(profile, 'cordis.patch.yml');
  await writeFile(patchFile, JSON.stringify(patches));
  child = spawn(process.execPath, [join(runtimeModules, '@deepseek-ai/dsh/lib/bin.js'),
    'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: temporary, env: { ...process.env, DSH_HOME: join(temporary, 'home'), AGENTX_SMOKE_API_KEY: 'fixture' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const started = Date.now();
  let launchUrl;
  while (Date.now() - started < 15000) {
    launchUrl = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+[^\s]*)/u)?.[1];
    if (launchUrl) break;
    if (child.exitCode !== null) throw new Error('Native DSH Web exited before startup');
    await delay(100);
  }
  assert.ok(launchUrl, 'Native DSH Web did not start within 15 seconds');
  browser = await chromium.launch({ headless: true, executablePath: options['--chromium'], args: ['--disable-gpu'] });
  const context = await browser.newContext();
  await context.route('https://agentx.example/**', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Pipeline fixture</title>',
  }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  assert.equal((await page.goto(launchUrl)).status(), 200);
  const link = page.locator('[data-agentx-coding-team]');
  await link.waitFor({ state: 'visible', timeout: 15000 });
  const notice = page.getByRole('button', { name: 'Continue', exact: true });
  if (await notice.isVisible()) await notice.click();
  assert.ok(!page.url().includes('token='), 'Native authentication must remove its token');
  for (const width of [1440, 412]) {
    await page.setViewportSize({ width, height: 915 });
    await link.waitFor({ state: 'visible' });
    assert.equal(await link.getAttribute('href'), 'https://agentx.example/pipeline#pipelineWorkerMonitor');
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  }
  await page.setViewportSize({ width: 1440, height: 915 });
  const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await popup.waitForLoadState('domcontentloaded');
  assert.equal(await popup.evaluate(() => window.opener), null);
  assert.equal(popup.url(), 'https://agentx.example/pipeline#pipelineWorkerMonitor');
  await popup.close();
  await writeFile(patchFile, JSON.stringify([...patches, { id: 'agentx-coding-team-ui', disabled: true }]));
  await link.waitFor({ state: 'detached', timeout: 15000 });
  await writeFile(patchFile, JSON.stringify(patches));
  await link.waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(await link.count(), 1);
  assert.deepEqual(errors, []);
  assert.equal(providerCalls, 0, 'UI qualification must make no model requests');
  console.log(JSON.stringify({ runtime: '0.2.0-rc.2', packed: true, authenticated: true,
    viewports: [1440, 412], isolatedNewTab: true, disableReenable: true, providerCalls, errors }));
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
  }
  await new Promise((resolve) => provider.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
