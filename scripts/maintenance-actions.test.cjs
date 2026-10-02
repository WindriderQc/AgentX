'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const actions = require('./maintenance-actions.cjs');

const LEAD = ['---', 'held_by: none', 'since: ', 'notes: 2026-10-01T10:00Z earlier operator: done. Released.', '---', '', '# Lead'].join('\n');

function leadFile(content = LEAD) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-lead-'));
  const file = path.join(dir, 'LEAD.md');
  fs.writeFileSync(file, content);
  return file;
}

function quietly(fn) {
  const write = process.stdout.write;
  let output = '';
  process.stdout.write = chunk => { output += chunk; return true; };
  return Promise.resolve().then(fn).finally(() => { process.stdout.write = write; }).then(code => ({ code, receipt: JSON.parse(output) }));
}

test('only the closed list of actions and deployable services is accepted', () => {
  assert.deepEqual(actions.parseArgs(['deploy', '--actor', 'tester', '--services', 'core']), { action: 'deploy', options: { actor: 'tester', services: 'core' } });
  assert.throws(() => actions.parseArgs(['shell', '--cmd', 'rm']), { exitCode: 2 });
  assert.throws(() => actions.parseArgs(['deploy', 'core']), { exitCode: 2 });
  assert.throws(() => actions.parseArgs(['deploy', '--actor']), { exitCode: 2 });
  assert.deepEqual(actions.parseServices('core, benchmark,core'), ['core', 'benchmark']);
  assert.throws(() => actions.parseServices('core,mongo'), /Not deployable: mongo/);
  assert.throws(() => actions.parseServices(''), { exitCode: 2 });
});

test('an action never guesses the instance: project, env file and lease file are required', () => {
  assert.throws(() => actions.instance({}, { mutating: false }), /AGENTX_ENV_FILE, AGENTX_PROJECT_NAME/);
  assert.throws(() => actions.instance({ AGENTX_ENV_FILE: 'x', AGENTX_PROJECT_NAME: 'p' }, { mutating: true }), /AGENTX_LEAD_FILE/);
  const config = actions.instance({ AGENTX_ENV_FILE: 'x', AGENTX_PROJECT_NAME: 'p', AGENTX_LEAD_FILE: 'l',
    AGENTX_ACTION_OLLAMA_UNITS: '{"http://h:11434":{"unit":"ollama.service","scope":"system"}}' }, { mutating: true });
  assert.equal(config.units['http://h:11434'].unit, 'ollama.service');
});

test('the LEAD.md lease is taken only when free, and released only by its holder', () => {
  const file = leadFile();
  const now = new Date('2026-10-02T16:00:00Z');
  const holder = actions.acquireLead(file, 'tester', 'deploy core', now);
  assert.equal(holder, 'agentx-action (tester)');
  let lead = actions.readLead(file);
  assert.equal(lead.heldBy, 'agentx-action (tester)');
  assert.equal(lead.since, '2026-10-02T16:00Z');
  assert.match(lead.notes, /^2026-10-02T16:00Z agentx-action \(tester\): deploy core \|\| 2026-10-01T10:00Z earlier operator/);
  assert.throws(() => actions.acquireLead(file, 'other', 'deploy rag', now), { exitCode: 4, outcome: 'refused' });
  assert.equal(actions.releaseLead(file, 'agentx-action (other)', 'nope'), false);
  assert.equal(actions.releaseLead(file, holder, 'deploy core completed.', now), true);
  lead = actions.readLead(file);
  assert.equal(lead.heldBy, 'none');
  assert.match(lead.notes, /^2026-10-02T16:00Z agentx-action \(tester\): deploy core completed\. Released\. \|\| /);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').slice(4).join('\n'), '---\n\n# Lead');
});

test('a mutating action refuses, without touching the lease, while another operator holds it', async () => {
  const held = LEAD.replace('held_by: none', 'held_by: someone (abc)').replace('since: ', 'since: 2026-10-02T15:00Z');
  const file = leadFile(held);
  const env = { ...process.env };
  Object.assign(process.env, { AGENTX_ENV_FILE: 'instance.env', AGENTX_PROJECT_NAME: 'synthetic', AGENTX_LEAD_FILE: file });
  delete process.env.AGENTX_ACTION_RECEIPTS_DIR;
  try {
    const { code, receipt } = await quietly(() => actions.main(['deploy', '--actor', 'tester', '--services', 'core']));
    assert.equal(code, 4);
    assert.equal(receipt.contract, 'agentx.maintenance-action/v1');
    assert.equal(receipt.outcome, 'refused');
    assert.match(receipt.reason, /held by someone \(abc\)/);
    assert.equal(fs.readFileSync(file, 'utf8'), held);
  } finally { process.env = env; }
});

test('a mutating action without an actor is a usage error and takes no lease', async () => {
  const file = leadFile();
  const env = { ...process.env };
  Object.assign(process.env, { AGENTX_ENV_FILE: 'instance.env', AGENTX_PROJECT_NAME: 'synthetic', AGENTX_LEAD_FILE: file });
  try {
    const { code, receipt } = await quietly(() => actions.main(['deploy', '--services', 'core']));
    assert.equal(code, 2);
    assert.match(receipt.reason, /--actor/);
    assert.equal(fs.readFileSync(file, 'utf8'), LEAD);
  } finally { process.env = env; }
});
