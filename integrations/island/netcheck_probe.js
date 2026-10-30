#!/usr/bin/env node
// A model-free harness stand-in (Codex, DSH or pi). Its gateway has no upstream and cannot infer.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.argv[2] === 'app-server') process.exit(1);
const harness = process.env.AGENTX_NETCHECK_HARNESS || 'codex';
const checks = [];
const check = (name, passed) => checks.push({ name, passed: passed === true });
const exists = file => fs.existsSync(file);
const home = process.env.HOME;
const codex = path.join(home, '.codex');
const sessionId = '00000000-0000-4000-8000-00000000c0de';
fs.appendFileSync('probe-calls.log', JSON.stringify({ harness, resume: process.argv.includes('resume'), at: new Date().toISOString() }) + '\n');
if (harness === 'codex') {
  // Codex writes its own rollout; DSH and pi report on stdout to the adapter's turn loop.
  const rollout = path.join(codex, 'sessions', '2000', '01', '01', `rollout-probe-${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.appendFileSync(path.join(codex, 'history.jsonl'), JSON.stringify({ session_id: sessionId, ts: Date.now(), text: 'Begin.' }) + '\n');
  fs.appendFileSync(rollout, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } }) + '\n');
  fs.appendFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
}
function status(url, args = []) {
  const result = spawnSync('curl', ['--silent', '--output', '/dev/null', '--max-time', '4', '--write-out', '%{http_code}', ...args, url], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '000';
}
const token = process.env.AGENTX_LLM_TOKEN || process.env.AGENTX_LLM_CODEX_TOKEN || '';
const inference = process.env.AGENTX_NETCHECK_INFERENCE || '/api/llm/v1/responses';
const other = process.env.AGENTX_NETCHECK_OTHER_INFERENCE || '/api/llm/v1/chat/completions';
const base = `http://127.0.0.1:${process.env.AGENTX_NETCHECK_PORT}`;
const auth = ['-H', `Authorization: Bearer ${token}`];
const fixture = [...auth, '-H', 'Content-Type: application/json', '--data', '{"model":"agentx-primary","input":"fixture","messages":[{"role":"user","content":"fixture"}]}'];
check('world', status(process.env.WORLD_BASE_URL + '/observe', ['-H', `X-Session: ${process.env.WORLD_SESSION_ID}`]) === '200');
check('llm-auth-required', status(base + '/api/llm/v1/models') === '401');
check('llm-authorized', status(base + '/api/llm/v1/models', auth) === '200');
for (const [name, target] of [['core-health', '/health'], ['core-queue', '/api/cluster/schedule/work-queue'], ['core-config', '/api/nerve-center/agent-runtime-config/export']]) {
  check(name, status(base + target, auth) === '403');
}
check('llm-method', status(base + '/api/llm/v1/models', [...auth, '-X', 'DELETE']) === '403');
check('encoded-path', status(base + '/api/llm/v1/%2e%2e/%2e%2e/health', [...auth, '--path-as-is']) === '403');
check('llm-query', status(base + '/api/llm/v1/models?path=/health', auth) === '403');
check('netcheck-no-inference', status(base + inference, fixture) === '503');
check('inference-route-exclusive', status(base + other, fixture) === '403');
check('docker-socket', !exists('/run/docker.sock'));
check('owner-home', fs.readdirSync('/home').every(name => name === 'agent'));
check('owner-auth', !exists(path.join(codex, 'auth.json')) && !exists(path.join(home, '.pi', 'agent', 'auth.json'))
  && !exists(path.join(home, '.dsh', 'credentials.json')));
const ps = spawnSync('ps', ['-eo', 'comm='], { encoding: 'utf8' });
check('host-processes', ps.status === 0 && !/^(sshd|systemd|clawblox|tmux: server)$/m.test(ps.stdout));
check('operator-token', !process.env.WORLD_OPERATOR_TOKEN);
check('world-internal-url', !process.env.WORLD_INTERNAL_BASE_URL);
if (harness !== 'codex') {
  // The generated provider config names only the local relay, the alias, and the capability by env name.
  const file = harness === 'pi' ? path.join(home, '.pi', 'agent', 'models.json') : path.join(home, '.dsh', 'agentx-island.patch.json');
  let ok = false;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const urls = text.match(/https?:\/\/[^"\s]+/g) || [];
    ok = urls.length > 0 && urls.every(url => url === `http://127.0.0.1:${process.env.AGENTX_NETCHECK_PORT}/api/llm/v1`)
      && text.includes('"agentx-primary"') && Boolean(token) && !text.includes(token)
      && process.env.AGENTX_LLM_BASE_URL === `http://127.0.0.1:${process.env.AGENTX_NETCHECK_PORT}/api/llm/v1`;
  } catch { ok = false; }
  check('harness-config', ok);
}
const blocked = JSON.parse(process.env.AGENTX_NETCHECK_BLOCKED_URLS || '[]');
for (let index = 0; index < blocked.length; index++) check(`direct-network-${index}`, status(blocked[index]) === '000');
const result = { schema: 'agentx.island-netcheck/v1', harness, checks };
fs.writeFileSync('netcheck.json.tmp', JSON.stringify(result, null, 2) + '\n');
fs.renameSync('netcheck.json.tmp', 'netcheck.json');
// Stand in for one finished turn, in the harness's own JSON event shape.
const say = value => process.stdout.write(JSON.stringify(value) + '\n');
if (harness === 'dsh') {
  say({ type: 'session', sessionId: `session-${sessionId}`, cwd: process.cwd() });
  say({ type: 'text', text: 'netcheck probe: no inference' });
  say({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
} else if (harness === 'pi') {
  say({ type: 'session', version: 3, id: sessionId, cwd: process.cwd() });
  say({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'netcheck probe: no inference' }], stopReason: 'stop' } });
  say({ type: 'agent_settled', aborted: false });
}
if (checks.some(item => !item.passed)) process.exit(1);
setInterval(() => {}, 1 << 30);
