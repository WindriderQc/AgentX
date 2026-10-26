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
let page;
let output = '';
let providerCalls = 0;
let fixtureWriter;
let fixtureContext;
let allowContinuation = false;
const provider = createServer(async (request, response) => {
  providerCalls += 1;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (!allowContinuation) {
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Observation must not invoke a model' }));
    return;
  }
  const tool = providerCalls === 1;
  if (tool) assert.ok(body.tools.some(item => item.function.name === 'write'));
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  if (tool) {
    send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-human-write', type: 'function',
      function: { name: 'write', arguments: JSON.stringify({ file_path: 'human-result.txt', content: 'native human edit\n' }) } }] });
    send({}, 'tool_calls');
  } else {
    send({ role: 'assistant', content: 'The human continuation used its own native tools.' });
    send({}, 'stop');
  }
  response.end('data: [DONE]\n\n');
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
  const { Context } = await import(pathToFileURL(join(runtimeModules, '@deepseek-ai/cordis/lib/index.js')));
  const { Session } = await import(pathToFileURL(join(runtimeModules, '@deepseek-ai/dsh-session/lib/index.js')));
  const { default: Jsonl } = await import(pathToFileURL(join(runtimeModules, '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')));
  fixtureContext = new Context();
  const workers = join(temporary, 'workers');
  const sourceWorkspace = join(workers, 'task-9999');
  const sourceLogs = join(workers, '.home-task-9999/.dsh/progress-sessions');
  await mkdir(sourceWorkspace, { recursive: true });
  await command('git', ['init', sourceWorkspace], temporary);
  await writeFile(join(sourceWorkspace, 'example.txt'), 'original worker file\n');
  await command('git', ['-C', sourceWorkspace, 'add', '.'], temporary);
  await command('git', ['-C', sourceWorkspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], temporary);
  const fixture = Session.create('session-worker-fixture', undefined, {
    version: 4, id: 'session-worker-fixture', cwd: '/workspace', isSeeded: false, createdAt: Date.now(),
  });
  fixtureWriter = await new Jsonl(fixtureContext, { root: sourceLogs, compression: 'none' }).create(fixture.header);
  const events = [];
  const append = async (type, data, ...opts) => {
    const event = fixture.append(type, data, ...opts); events.push(event);
    await fixtureWriter.append([event]); await fixtureWriter.flush();
  };
  await append('session/title', { title: 'Worker fixture', messageSeqs: [], source: { kind: 'user' } });
  await append('turn/start', { turn: 1 });
  await append('step/start', { turn: 1, step: 1 });
  await append('request/header', { reason: 'initial', header: { config: { provider: 'retired-worker-relay', model: 'agentx-primary' } } });
  await append('user/message', { id: 'message-fixture-1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'Inspect the worker fixture files.' }] }, { surfaceOp: 'append' });
  const packageRoot = await buildPackage({ coreUrl: 'https://agentx.example', output: join(temporary, 'package') });
  await command('npm', ['pack', packageRoot, '--ignore-scripts', '--pack-destination', temporary], temporary);
  const profile = join(temporary, 'home/profiles/web');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@agentx/dsh-coding-team'] } },
  }));
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  await command('npm', ['install', join(temporary, `agentx-dsh-coding-team-${manifest.version}.tgz`),
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
    { id: 'host-product-telemetry-otel', disabled: true },
  ];
  const patchFile = join(profile, 'cordis.patch.yml');
  await writeFile(patchFile, JSON.stringify(patches));
  child = spawn(process.execPath, [join(runtimeModules, '@deepseek-ai/dsh/lib/bin.js'),
    'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: temporary, env: { ...process.env, DSH_HOME: join(temporary, 'home'), AGENTX_SMOKE_API_KEY: 'fixture', AGENTX_CODING_WORKSPACES: workers },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    contentType: 'text/html', body: '<!doctype html><title>Pipeline fixture</title><h1>Travail des agents</h1>',
  }));
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  assert.equal((await page.goto(launchUrl)).status(), 200);
  const link = page.locator('[data-agentx-coding-team]');
  await link.waitFor({ state: 'visible', timeout: 15000 });
  const notice = page.getByRole('button', { name: 'Continue', exact: true });
  await notice.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if (await notice.isVisible()) await notice.click();
  assert.ok(!page.url().includes('token='), 'Native authentication must remove its token');
  for (const width of [1440, 412]) {
    await page.setViewportSize({ width, height: 915 });
    await link.click();
    await page.getByText('Tâche 9999', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'Ouvrir', exact: true }).click();
    await page.getByText('Inspect the worker fixture files.', { exact: true }).waitFor();
    assert.equal(await page.locator('iframe[data-agentx-coding-work]').count(), 0);
  }
  // Advance a log while its source writer still owns its native lock.
  await append('user/message', { id: 'message-fixture-2', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'A new worker event arrived while you watched.' }] }, { surfaceOp: 'append' });
  await page.getByText('A new worker event arrived while you watched.', { exact: true }).waitFor({ timeout: 10000 });
  await link.click();
  const [handoffResponse] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/agentx-coding') && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Reprendre dans une copie', exact: true }).click(),
  ]);
  assert.equal(handoffResponse.status(), 200, await handoffResponse.text());
  await page.getByRole('region', { name: 'Sessions du coding team' }).waitFor({ state: 'hidden', timeout: 10000 });
  await page.getByText('Inspect the worker fixture files.', { exact: true }).waitFor();
  const state = join(temporary, 'home/agentx-coding-team/handoffs');
  const { readdir } = await import('node:fs/promises');
  const handoffs = await readdir(state);
  assert.equal(handoffs.length, 1);
  const receipt = JSON.parse(await readFile(join(state, handoffs[0], 'receipt.json'), 'utf8'));
  assert.equal(receipt.state, 'ready');
  assert.equal(await readFile(join(receipt.cwd, 'example.txt'), 'utf8'), 'original worker file\n');
  // Reconcile the same stable identity after an imagined lost successful reply.
  const replay = await page.request.post(new URL('api/agentx-coding', page.url()).href, {
    data: { sessionId: JSON.parse(await handoffResponse.text()).sessionId, requestId: receipt.requestId },
  });
  // The request names the SOURCE observation, not the newly created human child.
  assert.equal(replay.status(), 409);
  const rows = await page.request.get(new URL('api/agentx-coding', page.url()).href).then(response => response.json());
  const recovered = await page.request.post(new URL('api/agentx-coding', page.url()).href, {
    data: { sessionId: rows.sessions.find(item => item.sourceId === receipt.sourceId).sessionId, requestId: receipt.requestId },
  });
  assert.equal(recovered.status(), 200);
  assert.equal((await recovered.json()).sessionId, receipt.sessionId);
  assert.equal((await readdir(state)).length, 1);
  assert.equal(providerCalls, 0, 'Observation and handoff must make no model requests');
  // Native title generation is enabled. A newly discovered worker has not
  // entered its first prompt yet; replay must not launch an auxiliary model.
  const aux = Session.create('session-worker-aux-fixture', undefined, {
    version: 4, id: 'session-worker-aux-fixture', cwd: '/workspace', isSeeded: false, createdAt: Date.now(),
  });
  const auxContext = new Context();
  const auxWriter = await new Jsonl(auxContext, { root: sourceLogs, compression: 'none' }).create(aux.header);
  try {
    await auxWriter.append([aux.append('permission/preset', { preset: 'workspace-write' })]);
    await auxWriter.flush();
    await delay(3000);
    const auxEvents = [aux.append('turn/start', { turn: 1 }), aux.append('step/start', { turn: 1, step: 1 }),
      aux.append('user/message', { id: 'aux-first-prompt', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'This worker first prompt must not generate a Studio title.' }] }, { surfaceOp: 'append' }),
      aux.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'fixture-model' } } })];
    await auxWriter.append(auxEvents);
    await auxWriter.flush();
    await delay(3000);
    assert.equal(providerCalls, 0, 'Native auxiliary title calls are fenced for observations');
  } finally { await auxWriter.close(); await auxContext.fiber.dispose(); }
  allowContinuation = true;
  const input = page.getByRole('textbox').first();
  await input.fill('Create human-result.txt in this continuation workspace.');
  await input.press('Enter');
  await page.getByText('The human continuation used its own native tools.', { exact: true }).waitFor({ timeout: 20000 });
  assert.equal(await readFile(join(receipt.cwd, 'human-result.txt'), 'utf8'), 'native human edit\n');
  await assert.rejects(readFile(join(sourceWorkspace, 'human-result.txt')), { code: 'ENOENT' });
  assert.equal((await fixtureWriter.read()).events.length, events.length, 'Source log must contain only its original writer events');
  await writeFile(join(receipt.cwd, 'example.txt'), 'human copy edit\n');
  assert.equal(await readFile(join(sourceWorkspace, 'example.txt'), 'utf8'), 'original worker file\n');
  assert.deepEqual(errors, []);
  assert.equal(providerCalls, 2, 'Only the synthetic human continuation invokes the dummy provider');
  console.log(JSON.stringify({ runtime: '0.2.0-rc.2', packed: true, authenticated: true,
    viewports: [1440, 412], nativeConversation: true, liveSourceWithWriter: true,
    isolatedHandoff: true, replayRecovered: true, nativeToolWrite: true, originalUnchanged: true, syntheticProviderCalls: providerCalls, liveModelCalls: 0, errors }));
} catch (error) {
  console.error('Native host diagnostics:', output.replace(/token=[^\s&]+/gu, 'token=<redacted>').slice(-12000));
  if (page) console.error('Isolated Studio state:', (await page.locator('body').innerText()).slice(0, 3500));
  throw error;
} finally {
  await browser?.close();
  await fixtureWriter?.close();
  await fixtureContext?.fiber.dispose();
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
