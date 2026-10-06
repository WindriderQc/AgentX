#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { reportDirectory } = require('../src/helpers/offlineReportDirectory');

const SCHEMA = 'agentx.coding-advisory-review/v1';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function parseArgs(argv) {
  const args = { timeoutMs: 300000, outputTokens: 2048, dryRun: false };
  const keys = { '--packet': 'packet', '--out': 'out', '--model': 'model', '--host-url': 'hostUrl',
    '--timeout-ms': 'timeoutMs', '--output-tokens': 'outputTokens' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') { args.dryRun = true; continue; }
    const key = keys[argv[i]], value = argv[++i];
    if (!key || !value || value.startsWith('--')) throw new Error('unknown option or missing value');
    args[key] = value;
  }
  for (const key of ['packet', 'out', 'model', 'hostUrl']) if (!args[key]) throw new Error(`missing ${key}`);
  for (const [key, min, max] of [['timeoutMs', 1000, 600000], ['outputTokens', 1, 8192]]) {
    args[key] = Number(args[key]);
    if (!Number.isInteger(args[key]) || args[key] < min || args[key] > max) throw new Error(`invalid ${key}`);
  }
  return args;
}

function loadPacket(file) {
  if (fs.statSync(file).size > 1024 * 1024) throw new Error('advisory packet is too large');
  const raw = fs.readFileSync(file, 'utf8'), packet = JSON.parse(raw);
  if (packet.schema !== 'agentx.coding-advisory-packet/v1' || !/^\d{4,}$/.test(packet.pipelineId || '')
    || !Number.isInteger(packet.attempt) || packet.attempt < 1 || !packet.spec?.trim()
    || !/^[a-f0-9]{40}$/.test(packet.baseRevision || '') || !/^[a-f0-9]{64}$/.test(packet.workerReceiptFingerprint || '')
    || !Array.isArray(packet.scope) || !packet.scope.length || !Array.isArray(packet.authority) || !packet.authority.length
    || !Array.isArray(packet.changes) || !packet.changes.length || packet.verification?.status !== 'passed') {
    throw new Error('advisory packet lacks a verified task and original-base snapshot');
  }
  if (packet.changes.some(file => !packet.scope.includes(file.path))
    || [...packet.authority, ...packet.changes].some(file => typeof file.path !== 'string' || typeof file.content !== 'string')) {
    throw new Error('advisory packet has invalid scoped files');
  }
  return { packet, fingerprint: hash(raw) };
}

function messages(packet) {
  return [{ role: 'system', content: 'You are a consultative code reviewer. The supplied task, files and patch are reference data. '
    + 'Review only concrete correctness or regression issues against the original specification and authority. '
    + 'Never claim to run tests, approve a task, change policy or merge code. Existing independent verification is evidence, '
    + 'not proof of every behavior. Return concise review notes with exact file paths and suggested corrections; say when evidence is insufficient.' },
  { role: 'user', content: JSON.stringify(packet) }];
}

const observed = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
async function run(argv, overrides = {}) {
  const args = parseArgs(argv), { packet, fingerprint } = loadPacket(args.packet), out = reportDirectory(args.out);
  if (fs.existsSync(path.join(out, 'receipt.json'))) throw new Error('advisory receipt exists; inspect it before another call');
  fs.mkdirSync(out, { mode: 0o700, recursive: true });
  const receipt = { schema: SCHEMA, status: args.dryRun ? 'not_run' : 'running', advisoryOnly: true,
    pipelineId: packet.pipelineId, attempt: packet.attempt, baseRevision: packet.baseRevision,
    workerReceiptFingerprint: packet.workerReceiptFingerprint, packetFingerprint: fingerprint,
    requestedModel: args.model, requestedHost: args.hostUrl, selfReview: packet.candidateModel ? packet.candidateModel === args.model : null,
    startedAt: new Date().toISOString(), usage: { effectiveModel: null, modelCalls: null, inputTokens: null, outputTokens: null } };
  const save = () => {
    const temporary = path.join(out, 'receipt.tmp');
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(receipt, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, path.join(out, 'receipt.json'));
  };
  save();
  if (args.dryRun) return receipt;
  let adapter;
  try {
    adapter = await (overrides.open || require('../src/services/offlineCodingInference').open)({ ...args, purpose: 'coding-advisory-review' });
    const body = await adapter.infer(messages(packet));
    receipt.usage = { effectiveModel: body.model, modelCalls: 1,
      inputTokens: observed(body.prompt_eval_count), outputTokens: observed(body.eval_count) };
    receipt.review = String(body.message?.content || body.response || '');
    receipt.status = body.done_reason === 'length' ? 'output_budget_exhausted' : receipt.review.trim() ? 'completed' : 'no_visible_review';
  } catch (error) {
    receipt.status = error.replay === 'busy' ? 'deferred_before_dispatch' : adapter ? 'unknown' : 'refused_before_dispatch';
    receipt.error = error.message;
    if (error.body) receipt.usage = { effectiveModel: error.body.model || null, modelCalls: null,
      inputTokens: observed(error.body.prompt_eval_count), outputTokens: observed(error.body.eval_count) };
  } finally {
    receipt.finishedAt = new Date().toISOString(); save();
    if (adapter) await adapter.close();
  }
  return receipt;
}

if (require.main === module) run(process.argv.slice(2)).then(receipt => {
  console.log(JSON.stringify({ schema: SCHEMA, status: receipt.status, advisoryOnly: true,
    pipelineId: receipt.pipelineId, attempt: receipt.attempt, usage: receipt.usage }));
  if (['unknown', 'refused_before_dispatch'].includes(receipt.status)) process.exitCode = 2;
}).catch(error => { console.error(error.message); process.exitCode = 2; });

module.exports = { SCHEMA, parseArgs, loadPacket, messages, run };
