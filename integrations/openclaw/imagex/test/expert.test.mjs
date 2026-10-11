import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareImage, runExpert } from '../expert.mjs';
import { registerLocalImages } from '../../super-dad-memory/local-images.js';

const status = { ok: true, configured: true, profiles: [{ id: 'quick', maxPixels: 1048576 }] };
const plan = { prompt: 'A lake at dawn', profile: 'quick', width: 1024, height: 1024, reason: 'Requested format' };
const expert = { ok: true, expert: 'hermes', text: JSON.stringify(plan) };

test('the specialist validates reviewed text plans and preserves supplied exact spelling', () => {
  const label = { id: 'title', text: 'École 💡', placement: 'central plaque' };
  const textPolicy = { version: 1, enabled: true, strategy: 'auto', labels: [label] };
  const textPlan = { version: 1, strategy: 'two-pass', reason: 'Exact editable lettering.', labels: [label] };
  const result = value => ({ ...expert, text: JSON.stringify({ ...plan, textPlan: value }) });
  assert.deepEqual(prepareImage({ textPolicy }, status, result(textPlan)).expert.plan.textPlan, textPlan);
  assert.throws(() => prepareImage({ textPolicy }, status, expert), /Préparation/);
  assert.throws(() => prepareImage({ textPolicy }, status, result({ ...textPlan, labels: [{ ...label, text: 'Ecole' }] })), /modifié ou omis/);
  assert.throws(() => prepareImage({}, status, result(textPlan)), /désactivée/);
});
const context = { agentId: 'main', runId: 'run', sessionKey: 'agent:main:household:direct:11111111-1111-1111-1111-111111111111' };

test('expert plans cannot inject workflows or change explicit requests', () => {
  assert.equal(prepareImage({ prompt: 'A lake', profile: 'quick' }, status, expert).request.prompt, plan.prompt);
  const changed = object => ({ ...expert, text: JSON.stringify({ ...plan, ...object }) });
  assert.throws(() => prepareImage({}, status, changed({ workflow: {} })), /unsupported/);
  assert.throws(() => prepareImage({}, status, changed({ profile: 'unconfigured' })), /unavailable/);
  assert.throws(() => prepareImage({}, status, changed({ width: 2048 })), /budget/);
  assert.throws(() => prepareImage({ width: 512 }, status, expert), /requested width/);
  assert.throws(() => prepareImage({ profile: 'other' }, status, expert), /requested profile/);
  assert.throws(() => prepareImage({}, status, changed({ prompt: '' })), /prompt/);
});

test('worker receives literal JSON through stdin and is bounded on a stalled invocation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentx-imagex-test-'));
  try {
    const command = path.join(dir, 'worker');
    await writeFile(command, '#!/usr/bin/env node\nlet data=""; process.stdin.on("data", d=>data+=d); process.stdin.on("end",()=>{ const p=JSON.parse(data); console.log(JSON.stringify({ok:true,expert:"hermes",text:p.prompt})); });\n', { mode: 0o700 });
    const literal = 'Describe $(never-run) and `literal` quotes "here"';
    assert.equal((await runExpert(command, { action: 'consult', prompt: literal })).text, literal);
    await writeFile(command, '#!/usr/bin/env node\nsetTimeout(()=>{}, 10000);\n', { mode: 0o700 });
    await assert.rejects(runExpert(command, { action: 'consult', prompt: 'A lake' }, { timeoutMs: 100 }), /timed out/);
    assert.throws(() => runExpert('relative', { action: 'consult', prompt: 'A lake' }), /absolute/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('specialist creation keeps the native scope, action identity and accepted image receipt', async () => {
  let factory, passedKey, post;
  const api = { config: {}, pluginConfig: { agentxUrl: 'http://127.0.0.1:3180' }, registerTool(f) { factory = f; } };
  registerLocalImages(api, { name: 'imagex', planImage: async (request, evidence, actionKey) => {
    assert.equal(request.prompt, 'A lake'); assert.deepEqual(evidence, status); passedKey = actionKey;
    return prepareImage(request, evidence, expert);
  }, fetchImpl: async (url, request) => {
    if (String(url).endsWith('/status')) return { ok: true, json: async () => status };
    post = { url: String(url), body: JSON.parse(request.body) };
    return { ok: true, json: async () => ({ ok: true, operation: { id: '22222222-2222-4222-8222-222222222222', state: 'accepted' } }) };
  } });
  assert.equal(factory({ ...context, agentId: 'family' }), null);
  assert.equal(factory({ ...context, sandboxed: true }), null);
  const tool = factory(context);
  assert.equal(tool.name, 'imagex');
  const result = await tool.execute('create-1', { action: 'create', prompt: 'A lake' });
  assert.match(post.url, /private\/sessions\/11111111.*\/images$/);
  assert.equal(post.body.actionKey, passedKey);
  assert.equal(post.body.prompt, plan.prompt);
  assert.equal(result.details.acceptedAction.actionKey, passedKey);
  assert.equal(result.details.expert.expert, 'hermes');
});

test('consultation and invalid plans never submit a generation; missing identity never invokes Hermes', async () => {
  let factory, plans = 0, posts = 0;
  const api = { config: {}, pluginConfig: { agentxUrl: 'http://127.0.0.1:3180' }, registerTool(f) { factory = f; } };
  registerLocalImages(api, { name: 'imagex', consultImage: async () => expert,
    planImage: async () => { plans++; throw new Error('Invalid plan'); }, fetchImpl: async (_url, init) => {
      if (init.method === 'POST') posts++;
      return { ok: true, json: async () => status };
    } });
  const tool = factory(context);
  const result = await tool.execute('consult', { action: 'consult', prompt: 'Explain workflows' });
  assert.equal(result.details.expert.expert, 'hermes');
  await assert.rejects(tool.execute('create', { action: 'create', prompt: 'A lake' }), /Invalid plan/);
  assert.equal(posts, 0);
  await assert.rejects(factory({ ...context, runId: undefined }).execute('create', { action: 'create', prompt: 'A lake' }), /identities/);
  assert.equal(plans, 1);
});
