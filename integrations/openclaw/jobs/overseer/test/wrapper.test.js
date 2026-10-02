'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const wrapper = require('../openclaw-overseer-wrapper');
const { REPORT, transcriptMessages } = require('./fixtures');

const SCRIPT = path.join(__dirname, '..', 'openclaw-overseer-wrapper.js');

function ok(value) {
  return { status: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) };
}

function fakeOpenclaw(overrides = {}) {
  const calls = [];
  const responses = {
    config: () => ok({ value: { list: [{
      id: 'overseer',
      tools: { profile: 'minimal', alsoAllow: [...wrapper.REQUIRED_TOOLS], deny: ['session_status'] },
    }] } }),
    sessions: () => ok({ sessions: [{ key: 'agent:overseer:main' }] }),
    probe: () => ok({ tools: [...wrapper.REQUIRED_MCP_TOOLS], diagnostics: [] }),
    effective: () => ok({
      agentId: 'overseer', profile: 'minimal',
      groups: [{ tools: wrapper.REQUIRED_TOOLS.map((id) => ({ id })) }],
    }),
    agent: (params) => ok({ status: 'ok', runId: params.idempotencyKey, result: { meta: {} } }),
    sessionGet: () => ok({ messages: transcriptMessages() }),
    ...overrides,
  };
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'config') return responses.config();
    if (args[0] === 'sessions') return responses.sessions();
    if (args[0] === 'mcp') return responses.probe();
    if (args[2] === 'tools.effective') return responses.effective();
    if (args[2] === 'agent') return responses.agent(JSON.parse(args[4]));
    if (args[2] === 'sessions.get') return responses.sessionGet(JSON.parse(args[4]));
    throw new Error(`unexpected call ${args.join(' ')}`);
  };
  return { calls, spawn };
}

function run(argv, { env = { OPENCLAW_OVERSEER_THINKING: 'off' }, ...overrides } = {}) {
  const fake = fakeOpenclaw(overrides);
  const output = [];
  let code = null;
  try {
    wrapper.runCli(argv, {
      input: Buffer.from('Synthetic overseer instruction.'),
      environment: env,
      spawnSync: fake.spawn,
      randomUUID,
      write: (value) => output.push(value),
    });
  } catch (error) {
    code = error.code;
  }
  return { ...fake, code, output: output.join('') };
}

test('requires the exact AgentX MCP tool set, including get_sound', () => {
  assert.equal(wrapper.REQUIRED_MCP_TOOLS.length, 10);
  assert.ok(wrapper.REQUIRED_MCP_TOOLS.includes('agentx__get_sound'));
  const missing = run([], {
    probe: () => ok({ tools: wrapper.REQUIRED_MCP_TOOLS.filter((t) => t !== 'agentx__get_sound'), diagnostics: [] }),
  });
  assert.equal(missing.code, 'mcp-probe-invalid');
  const extra = run([], {
    probe: () => ok({ tools: [...wrapper.REQUIRED_MCP_TOOLS, 'agentx__other'], diagnostics: [] }),
  });
  assert.equal(extra.code, 'mcp-probe-invalid');
});

test('runs the agent turn and prints the verified report', () => {
  const result = run([]);
  assert.equal(result.code, null);
  assert.equal(result.output, `${REPORT}\n`);
  assert.deepEqual(result.calls.map((call) => call.command), Array(6).fill('openclaw'));
  assert.deepEqual(result.calls[2].args, ['mcp', 'probe', 'agentx', '--json']);
  const agent = JSON.parse(result.calls[4].args[4]);
  assert.equal(agent.agentId, 'overseer');
  assert.equal(agent.thinking, 'off');
  assert.equal(agent.deliver, false);
  assert.equal(agent.message, 'Synthetic overseer instruction.');
  assert.equal(agent.sessionId, agent.idempotencyKey);
  const sessionGet = JSON.parse(result.calls[5].args[4]);
  assert.equal(sessionGet.key, `agent:overseer:explicit:${agent.sessionId}`);
});

test('uses OPENCLAW_BIN when configured', () => {
  const bin = path.join('opt', 'openclaw', 'bin', 'openclaw');
  const result = run(['--check'], { env: { OPENCLAW_OVERSEER_THINKING: 'off', OPENCLAW_BIN: bin } });
  assert.equal(result.output, 'OVERSEER_WRAPPER_CHECK_OK\n');
  assert.equal(result.calls.length, 4);
  assert.ok(result.calls.every((call) => call.command === bin));
  assert.equal(wrapper.resolveOpenclawCli({ OPENCLAW_BIN: '  ' }), 'openclaw');
});

test('keeps its failure codes', () => {
  assert.equal(run([], { env: {} }).code, 'thinking-config-invalid');
  assert.equal(run(['--other']).code, 'argument-invalid');
  assert.equal(run([], { sessions: () => ok({ sessions: [] }) }).code, 'overseer-session-unavailable');
  assert.equal(run([], { agent: () => ({ status: 1, stdout: Buffer.alloc(0) }) }).code, 'gateway-call-failed');
  assert.equal(run([], {
    sessionGet: () => ok({ messages: transcriptMessages({ report: 'No headings.' }) }),
  }).code, 'transcript-postcondition-failed');
  assert.equal(run([], {
    effective: () => ok({
      agentId: 'overseer', profile: 'minimal', groups: [{ tools: [{ id: 'read' }] }],
      notices: [{ id: 'mcp-not-yet-listed' }],
    }),
  }).code, null);
});

test('CLI reports failures on stderr with exit code 1', () => {
  const env = { ...process.env, OPENCLAW_OVERSEER_THINKING: 'off' };
  const badArg = spawnSync(process.execPath, [SCRIPT, '--nope'], { env, input: '', encoding: 'utf8' });
  assert.equal(badArg.status, 1);
  assert.equal(badArg.stderr.trim(), 'OVERSEER_WRAPPER_FAILED code=argument-invalid');
  const empty = spawnSync(process.execPath, [SCRIPT], { env, input: '', encoding: 'utf8' });
  assert.equal(empty.status, 1);
  assert.equal(empty.stderr.trim(), 'OVERSEER_WRAPPER_FAILED code=input-empty');
});
