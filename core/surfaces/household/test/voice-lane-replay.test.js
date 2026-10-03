'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lane = require('../voice-lane');
const replayScript = require('../../../scripts/voice-lane-replay');

const { parseArgs, reportDirectory, skipReason, collectTurns, replay, summarize, disagreements, renderMarkdown, run } = replayScript;

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-lane-replay-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// One synthetic recorded exchange: the user message and the assistant message carrying the turn.
function exchange(id, text, { tools = [], minutes = 0, ...turn } = {}) {
  return [
    { role: 'user', content: text, turnId: id },
    { role: 'assistant', content: 'synthetic recorded reply', turnId: id, turn: {
      channel: 'voice', packId: 'personal_operator', scopeId: 'personal', modeId: 'operator', model: 'synthetic-agent-model',
      routeTier: 'agent', createdAt: new Date(Date.UTC(2030, 0, 1, 12, minutes)),
      toolEvidence: { status: 'observed', receipts: tools.map(tool => ({ tool, status: 'verified' })) }, ...turn } }
  ];
}

function session(minutes, messages, identity = '') {
  return { surfaceSession: { lastTurnAt: new Date(Date.UTC(2030, 0, 1, 12, minutes)), persona: { identity } }, messages: messages.flat() };
}

async function* newestFirst(rows, seen = []) {
  for (const row of rows) { seen.push(row); yield row; }
}

const delegates = (reason = 'live_data') => ({ message: { content: '',
  tool_calls: [{ function: { name: 'delegate', arguments: { task: 'synthetic restated task', reason } } }] } });
const answers = (content = 'synthetic direct answer') => ({ message: { content } });
const turn = (text, tools = [], extra = {}) => ({ at: 0, text, modeId: 'operator', identity: '', tools, memoryCommand: false, ...extra });
const busy = () => Object.assign(new Error('host reserved'), { code: 'BENCHMARK_CLAIM_ACTIVE', replay: 'busy' });

test('arguments need an output directory and bounded numbers', () => {
  assert.throws(() => parseArgs([]), /--out <dir> is required/);
  assert.deepEqual(parseArgs(['--out', '/elsewhere/report']), { limit: 200, task: 'voice_persona_chat', pauseMs: 500,
    retries: 6, busyWaitMs: 20000, dryRun: false, out: '/elsewhere/report' });
  const options = parseArgs(['--out', 'x', '--limit', '50', '--dry-run', '--model', 'synthetic:1b', '--host-url', 'http://model-host:11434', '--pause-ms', '0']);
  assert.equal(options.limit, 50);
  assert.equal(options.dryRun, true);
  assert.equal(options.model, 'synthetic:1b');
  assert.equal(options.hostUrl, 'http://model-host:11434');
  assert.equal(options.pauseMs, 0);
  assert.throws(() => parseArgs(['--out', 'x', '--limit', '0']), /limit must be an integer/);
  assert.throws(() => parseArgs(['--out', 'x', '--retries', 'many']), /retries must be an integer/);
  assert.throws(() => parseArgs(['--out', 'x', '--verbose']), /unknown option --verbose/);
  assert.throws(() => parseArgs(['--out', '--dry-run']), /--out needs a value/);
});

test('the report directory is refused inside the application tree or a Git checkout', t => {
  const coreRoot = path.resolve(__dirname, '..', '..', '..');
  assert.throws(() => reportDirectory(path.join(coreRoot, 'replay-out')), /outside the checkout/);
  assert.throws(() => reportDirectory(coreRoot), /outside the checkout/);
  assert.throws(() => reportDirectory(path.join(coreRoot, 'scripts', '..', 'surfaces', 'household', 'out')), /outside the checkout/);

  const base = temporaryDirectory(t);
  const checkout = path.join(base, 'checkout');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  assert.throws(() => reportDirectory(path.join(checkout, 'docs', 'replay')), /outside the checkout/);
  // A worktree marks its root with a .git file.
  const worktree = path.join(base, 'worktree');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: elsewhere\n');
  assert.throws(() => reportDirectory(worktree), /outside the checkout/);

  const outside = path.join(base, 'reports', 'run-1');
  assert.equal(reportDirectory(outside), path.join(fs.realpathSync.native(base), 'reports', 'run-1'));
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'summary.json'), '{}');
  assert.throws(() => reportDirectory(outside), /already holds a report/);
});

test('only completed personal voice turns with observed tool evidence are replayed', () => {
  const base = exchange('t', 'x')[1].turn;
  assert.equal(skipReason(base, 'synthetic request'), '');
  assert.equal(skipReason({ ...base, interrupted: true }, 'synthetic request'), 'interrupted');
  assert.equal(skipReason({ ...base, routeTier: 'deterministic', model: '' }, 'synthetic request'), 'deterministic');
  assert.equal(skipReason({ ...base, routeTier: undefined, model: '' }, 'synthetic request'), 'deterministic');
  assert.equal(skipReason({ ...base, modeId: 'open' }, 'synthetic request'), 'open_mode');
  assert.equal(skipReason({ ...base, speakerAgentId: 'secretary' }, 'synthetic request'), 'team_member');
  assert.equal(skipReason({ ...base, toolEvidence: { status: 'not_supported', receipts: [] } }, 'synthetic request'), 'no_tool_evidence');
  assert.equal(skipReason({ ...base, toolEvidence: null }, 'synthetic request'), 'no_tool_evidence');
  assert.equal(skipReason(base, ''), 'empty_request');
});

test('turns are paired with their request, labelled by recorded tools and kept newest first', async () => {
  const rows = [
    session(50, [
      exchange('a', 'synthetic request A', { minutes: 40, tools: ['rag_search', 'rag_search', 'personal_memory'] }),
      exchange('b', 'Retiens que la valeur synthétique est sept', { minutes: 50 }),
      exchange('c', 'synthetic typed request', { minutes: 45, channel: 'text' }),
      exchange('d', 'synthetic interrupted request', { minutes: 46, interrupted: true }),
      [{ role: 'user', content: 'synthetic request without a turn', turnId: 'orphan' }]
    ], 'A synthetic personality.'),
    null,
    session(30, [exchange('e', '  synthetic request E  ', { minutes: 30, modeId: 'plan' }),
      exchange('f', 'synthetic family request', { minutes: 29, packId: 'kidx_nestor', scopeId: 'family' })])
  ];
  const { turns, scanned, skipped } = await collectTurns(newestFirst(rows), 10);
  assert.deepEqual(turns.map(entry => entry.text), ['Retiens que la valeur synthétique est sept', 'synthetic request A', 'synthetic request E']);
  assert.deepEqual(turns.map(entry => entry.tools), [[], ['rag_search', 'personal_memory'], []]);
  assert.deepEqual(turns.map(entry => entry.memoryCommand), [true, false, false]);
  assert.deepEqual(turns.map(entry => entry.identity), ['A synthetic personality.', 'A synthetic personality.', '']);
  assert.equal(turns[2].modeId, 'plan');
  assert.equal(scanned, 4);
  assert.deepEqual(skipped, { interrupted: 1 });
});

test('a turn carries the exchanges recorded before it in its conversation, clipped and bounded', async () => {
  const long = 'x'.repeat(700);
  const rows = [session(60, [exchange('a', 'synthetic first', { minutes: 1 }), exchange('b', long, { minutes: 2, channel: 'text' }),
    exchange('c', 'synthetic third', { minutes: 3 }), exchange('d', 'synthetic fourth', { minutes: 4 }),
    exchange('e', 'synthetic fifth', { minutes: 5 }), exchange('f', 'oui, vas-y', { minutes: 6 })])];
  const { turns } = await collectTurns(newestFirst(rows), 10);
  const last = turns.find(entry => entry.text === 'oui, vas-y'), first = turns.find(entry => entry.text === 'synthetic first');
  assert.deepEqual(first.history, []);
  // The four exchanges before it, typed ones included, oldest first.
  assert.equal(last.history.length, 8);
  assert.deepEqual(last.history.slice(0, 2), [{ role: 'user', content: 'x'.repeat(600) }, { role: 'assistant', content: 'synthetic recorded reply' }]);
  assert.deepEqual(last.history.at(-2), { role: 'user', content: 'synthetic fifth' });

  const sent = [];
  await replay({ turns: [last], infer: async messages => { sent.push(messages); return delegates('action'); } });
  assert.equal(sent[0].length, 10);
  assert.equal(sent[0][0].role, 'system');
  assert.deepEqual(sent[0].at(-1), { role: 'user', content: 'oui, vas-y' });
});

test('reading stops once older conversations cannot enter the sample', async () => {
  const rows = [
    session(50, [exchange('a', 'synthetic newest', { minutes: 50 }), exchange('b', 'synthetic older', { minutes: 20 })]),
    session(40, [exchange('c', 'synthetic middle', { minutes: 40 })]),
    session(30, [exchange('d', 'synthetic third', { minutes: 30 })]),
    session(10, [exchange('e', 'synthetic never read', { minutes: 10 })])
  ];
  const seen = [];
  const { turns } = await collectTurns(newestFirst(rows, seen), 2);
  assert.deepEqual(turns.map(entry => entry.text), ['synthetic newest', 'synthetic middle']);
  assert.equal(seen.length, 3);
});

test('a request without recorded history is sent alone under the stable system prompt', async () => {
  const sent = [];
  const { rows, stop } = await replay({ turns: [turn('synthetic request one', ['rag_search'], { modeId: 'plan', identity: 'A synthetic personality.' }),
    turn('synthetic request two')], infer: async messages => { sent.push(messages); return sent.length === 1 ? delegates() : answers(); } });
  assert.equal(stop, null);
  assert.deepEqual(sent[0], [
    { role: 'system', content: lane.fastLaneSystemPrompt({ modeId: 'plan', identity: 'A synthetic personality.' }) },
    { role: 'user', content: 'synthetic request one' }
  ]);
  assert.equal(sent[1][0].content, lane.fastLaneSystemPrompt({ modeId: 'operator' }));
  assert.deepEqual(rows.map(row => row.decision), ['delegated', 'answered']);
  assert.equal(rows[0].reason, 'live_data');
  assert.equal(rows[1].answer, 'synthetic direct answer');
});

test('a busy host is waited for, a bounded number of times', async () => {
  const waits = [];
  let calls = 0;
  const waited = await replay({ turns: [turn('synthetic request')], retries: 3, busyWaitMs: 7, wait: async ms => { waits.push(ms); },
    infer: async () => { if (++calls < 3) throw busy(); return answers(); } });
  assert.deepEqual(waits, [7, 7]);
  assert.equal(waited.busyWaits, 2);
  assert.equal(waited.stop, null);
  assert.equal(waited.rows.length, 1);

  calls = 0;
  const refused = await replay({ turns: [turn('synthetic request'), turn('synthetic next request')], retries: 2, busyWaitMs: 1, wait: async () => {},
    infer: async () => { calls += 1; throw busy(); } });
  assert.equal(calls, 3);
  assert.deepEqual(refused.rows, []);
  assert.equal(refused.stop.code, 'BENCHMARK_CLAIM_ACTIVE');
});

test('a request that may have reached the model is never sent twice', async () => {
  let calls = 0;
  const outcome = await replay({ turns: [turn('synthetic one'), turn('synthetic two'), turn('synthetic three'), turn('synthetic four')], retries: 5,
    wait: async () => {}, infer: async () => { calls += 1; throw Object.assign(new Error('Routed inference failed.'), { code: 'INFERENCE_UPSTREAM_UNAVAILABLE' }); } });
  assert.equal(calls, 3);
  assert.deepEqual(outcome.rows.map(row => [row.decision, row.code]), Array(3).fill(['error', 'INFERENCE_UPSTREAM_UNAVAILABLE']));
  assert.equal(outcome.stop.code, 'REPEATED_FAILURES');
});

test('a failure that every request would repeat stops the run', async () => {
  let calls = 0;
  const outcome = await replay({ turns: [turn('synthetic one'), turn('synthetic two')], retries: 5, wait: async () => {},
    infer: async () => { calls += 1; throw Object.assign(new Error('host needs recovery'), { code: 'RUNTIME_INFERENCE_RECOVERY_REQUIRED', replay: 'stop' }); } });
  assert.equal(calls, 1);
  assert.deepEqual(outcome.rows, []);
  assert.deepEqual(outcome.stop, { code: 'RUNTIME_INFERENCE_RECOVERY_REQUIRED', detail: 'host needs recovery' });
});

test('a stop request ends the run between two requests', async () => {
  let calls = 0, stopping = false;
  const outcome = await replay({ turns: [turn('synthetic one'), turn('synthetic two')], stopRequested: () => stopping,
    infer: async () => { calls += 1; stopping = true; return answers(); } });
  assert.equal(calls, 1);
  assert.equal(outcome.rows.length, 1);
  assert.deepEqual(outcome.stop, { code: 'INTERRUPTED' });
});

function decided(count, tools, decision, extra = {}) {
  return Array.from({ length: count }, (_, index) => ({ ...turn(`synthetic ${decision} ${tools.length} ${index}`, tools), decision, ...extra }));
}

test('the confusion matrix and both gate rates come from the decisions', () => {
  const rows = [
    ...decided(57, ['rag_search'], 'delegated', { reason: 'live_data', task: 'synthetic task', valid: true }),
    ...decided(3, ['personal_memory', 'rag_search'], 'answered', { answer: 'synthetic answer' }),
    ...decided(119, [], 'answered', { answer: 'synthetic answer' }),
    ...decided(21, [], 'delegated', { reason: 'other', task: 'synthetic task', valid: true })
  ];
  const summary = summarize(rows, { sampled: 200 });
  assert.equal(summary.schema, 'agentx.voice-lane-replay/v1');
  assert.equal(summary.sampled, 200);
  assert.equal(summary.replayed, 200);
  assert.equal(summary.errors, 0);
  assert.deepEqual(summary.matrix, { recordedTools: { delegated: 57, answered: 3, malformed: 0 }, recordedNone: { delegated: 21, answered: 119, malformed: 0 } });
  assert.deepEqual(summary.gate.missedDelegation, { count: 3, of: 60, rate: 0.05, max: 0.05, pass: true });
  assert.deepEqual(summary.gate.unnecessaryDelegation, { count: 21, of: 140, rate: 0.15, max: 0.15, pass: true });
  assert.equal(summary.gate.verdict, 'pass');
  assert.deepEqual(summary.delegateReasons, { live_data: 57, other: 21 });
  assert.deepEqual(summary.recordedTools, { rag_search: 60, personal_memory: 3 });
  assert.deepEqual(summary.missedByTool, { personal_memory: 3, rag_search: 3 });
});

test('one miss too many, or one delegation too many, fails the gate', () => {
  const missed = summarize([...decided(56, ['rag_search'], 'delegated'), ...decided(4, ['rag_search'], 'answered'), ...decided(10, [], 'answered')]);
  assert.equal(missed.gate.missedDelegation.pass, false);
  assert.equal(missed.gate.unnecessaryDelegation.pass, true);
  assert.equal(missed.gate.verdict, 'fail');
  const eager = summarize([...decided(10, ['rag_search'], 'delegated'), ...decided(84, [], 'answered'), ...decided(16, [], 'delegated')]);
  assert.equal(eager.gate.missedDelegation.pass, true);
  assert.equal(eager.gate.unnecessaryDelegation.pass, false);
  assert.equal(eager.gate.verdict, 'fail');
});

test('a malformed answer counts as a delegation and an inference error counts nowhere', () => {
  const rows = [
    ...decided(9, ['rag_search'], 'delegated'), ...decided(1, ['rag_search'], 'malformed', { problem: 'empty' }),
    ...decided(8, [], 'answered'), ...decided(1, [], 'malformed', { problem: 'unknown_tool' }),
    ...decided(1, [], 'delegated', { valid: false, problem: 'invalid_arguments' }),
    ...decided(2, [], 'error', { code: 'INFERENCE_TIMEOUT' }),
    ...decided(2, [], 'answered', { memoryCommand: true }), ...decided(1, ['personal_memory'], 'delegated', { memoryCommand: true, reason: 'memory_change' })
  ];
  const summary = summarize(rows);
  assert.equal(summary.replayed, 23);
  assert.equal(summary.errors, 2);
  assert.deepEqual(summary.errorCodes, { INFERENCE_TIMEOUT: 2 });
  assert.deepEqual(summary.gate.missedDelegation, { count: 0, of: 11, rate: 0, max: 0.05, pass: true });
  assert.equal(summary.gate.unnecessaryDelegation.count, 2);
  assert.equal(summary.gate.unnecessaryDelegation.of, 12);
  assert.deepEqual(summary.problems, { empty: 1, unknown_tool: 1, invalid_arguments: 1 });
  assert.deepEqual(summary.memoryCommands, { total: 3, delegated: 1, answered: 2, malformed: 0 });
});

test('a label with no request gives no verdict', () => {
  const summary = summarize(decided(5, [], 'answered'));
  assert.equal(summary.gate.missedDelegation.rate, null);
  assert.equal(summary.gate.missedDelegation.pass, null);
  assert.equal(summary.gate.verdict, 'insufficient_data');
  assert.equal(summarize([]).gate.verdict, 'insufficient_data');
  assert.match(renderMarkdown({ ...summarize([]), sampled: 0, sampledWithTools: 0, scanned: 0 }), /Verdict: \*\*insufficient_data\*\*/);
});

test('the disagreement sample holds at most 25 rows of every kind, with long text cut', () => {
  const rows = [
    ...decided(30, ['rag_search'], 'answered', { answer: 'a'.repeat(900) }),
    ...decided(30, [], 'delegated', { reason: 'web', task: 't'.repeat(900), valid: true }),
    ...decided(2, [], 'malformed', { problem: 'empty' }),
    ...decided(40, [], 'answered'), ...decided(40, ['rag_search'], 'delegated'), ...decided(3, [], 'error', { code: 'X' })
  ];
  const sample = disagreements(rows);
  assert.equal(sample.length, 25);
  assert.deepEqual(sample.slice(0, 4).map(row => row.kind), ['missed_delegation', 'unnecessary_delegation', 'malformed', 'missed_delegation']);
  assert.equal(sample.filter(row => row.kind === 'malformed').length, 2);
  assert.deepEqual(Object.keys(sample[0]), ['kind', 'request', 'recordedTools', 'decision', 'answer']);
  assert.equal(sample[0].answer.length, 400);
  assert.deepEqual(sample[1].recordedTools, []);
  assert.equal(sample[1].reason, 'web');
  assert.equal(sample[1].task.length, 400);
  assert.deepEqual(disagreements([...decided(3, [], 'answered'), ...decided(3, ['rag_search'], 'delegated')]), []);
});

const REQUESTS = ['synthetic greeting alpha', 'synthetic calendar question beta', 'synthetic chat gamma', 'synthetic mail question delta'];

function fakeCore(calls, { target = { model: 'synthetic:1b', hostUrl: 'http://model-host:11434', hostKey: 'secondary', source: 'task:voice_persona_chat' } } = {}) {
  return async options => {
    calls.options = options;
    return {
      sessions: () => newestFirst([session(50, [
        exchange('a', REQUESTS[0], { minutes: 50 }), exchange('b', REQUESTS[1], { minutes: 49, tools: ['calendar_lookup'] }),
        exchange('c', REQUESTS[2], { minutes: 48 }), exchange('d', REQUESTS[3], { minutes: 47, tools: ['mail_journal'] })])]),
      target: async () => target,
      async infer(messages) {
        calls.push(messages.at(-1).content);
        // The model misses the mail question and delegates the plain chat.
        return [REQUESTS[1], REQUESTS[2]].includes(messages.at(-1).content) ? delegates('other') : answers(`synthetic model answer to ${messages.at(-1).content}`);
      },
      close: async () => { calls.closed = true; }
    };
  };
}

test('a run writes the report outside Git and prints counts only', async t => {
  const out = path.join(temporaryDirectory(t), 'report');
  const calls = [];
  const printed = [];
  const summary = await run(['--out', out, '--pause-ms', '0'], { open: fakeCore(calls), log: line => printed.push(String(line)) });

  assert.deepEqual(calls.slice(), REQUESTS);
  assert.equal(calls.closed, true);
  assert.deepEqual(summary.matrix, { recordedTools: { delegated: 1, answered: 1, malformed: 0 }, recordedNone: { delegated: 1, answered: 1, malformed: 0 } });
  assert.equal(summary.gate.verdict, 'fail');
  assert.deepEqual(fs.readdirSync(out).sort(), ['disagreements.jsonl', 'summary.json', 'summary.md']);

  const stored = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(stored.sampled, 4);
  assert.equal(stored.sampledWithTools, 2);
  assert.equal(stored.target.model, 'synthetic:1b');
  assert.equal(stored.newest, '2030-01-01T12:50:00.000Z');
  assert.equal(stored.oldest, '2030-01-01T12:47:00.000Z');
  assert.deepEqual(stored.missedByTool, { mail_journal: 1 });

  const markdown = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  assert.match(markdown, /\| Used agent tools \| 1 \| 1 \| 0 \| 2 \|/);
  assert.match(markdown, /1 \/ 2 \(50\.0 %\) \| at most 5\.0 % \| fail/);
  assert.match(markdown, /1 \/ 2 \(50\.0 %\) \| at most 15\.0 % \| fail/);
  assert.match(markdown, /Recorded tool use is a weak label/);
  assert.match(markdown, /owner judges the sample/);

  const sample = fs.readFileSync(path.join(out, 'disagreements.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(sample.map(row => [row.kind, row.request]), [['missed_delegation', REQUESTS[3]], ['unnecessary_delegation', REQUESTS[2]]]);
  assert.deepEqual(sample[0].recordedTools, ['mail_journal']);
  assert.equal(sample[0].answer, `synthetic model answer to ${REQUESTS[3]}`);

  // Request text, model answers and restated tasks stay in the report files.
  const stdout = printed.join('\n');
  for (const text of [...REQUESTS, 'synthetic model answer', 'synthetic restated task', 'calendar_lookup']) {
    assert.ok(!stdout.includes(text), `stdout leaked "${text}"`);
    assert.ok(!markdown.includes(text) || text === 'calendar_lookup', `summary.md leaked "${text}"`);
  }
  assert.match(stdout, /sample: 4 requests \(2 with recorded tools\), 4 voice turns scanned/);
  assert.match(stdout, /missed delegations: 1 \/ 2 \(50\.0 %\), limit 5\.0 %/);
  assert.match(stdout, /verdict: fail/);
});

test('a dry run counts the sample without any inference', async t => {
  const out = path.join(temporaryDirectory(t), 'report');
  const calls = [];
  const printed = [];
  const summary = await run(['--out', out, '--dry-run', '--limit', '3'], { open: fakeCore(calls), log: line => printed.push(String(line)) });
  assert.deepEqual(calls.slice(), []);
  assert.equal(calls.options.dryRun, true);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.sampled, 3);
  assert.equal(summary.sampledWithTools, 1);
  assert.equal(summary.replayed, 0);
  assert.equal(summary.gate.verdict, 'insufficient_data');
  assert.equal(fs.readFileSync(path.join(out, 'disagreements.jsonl'), 'utf8'), '');
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /dry run, no inference/);
  assert.ok(!printed.join('\n').includes('synthetic'));
  assert.ok(!printed.join('\n').includes('verdict'));
});

test('a run refuses an output directory inside the checkout before opening anything', async () => {
  let opened = false;
  await assert.rejects(run(['--out', path.join(__dirname, 'replay-out')], { open: async () => { opened = true; } }), /outside the checkout/);
  await assert.rejects(run([], { open: async () => { opened = true; } }), /--out <dir> is required/);
  assert.equal(opened, false);
});

test('an early stop still writes the partial report', async t => {
  const out = path.join(temporaryDirectory(t), 'report');
  const calls = [];
  const open = async options => ({ ...await fakeCore(calls)(options),
    infer: async () => { throw Object.assign(new Error('host needs recovery'), { code: 'RUNTIME_INFERENCE_RECOVERY_REQUIRED', replay: 'stop' }); } });
  const printed = [];
  const summary = await run(['--out', out, '--pause-ms', '0'], { open, log: line => printed.push(String(line)) });
  assert.equal(summary.stop.code, 'RUNTIME_INFERENCE_RECOVERY_REQUIRED');
  assert.equal(summary.replayed, 0);
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /stopped early \(RUNTIME_INFERENCE_RECOVERY_REQUIRED\): partial result/);
  assert.match(printed.join('\n'), /stopped early \(RUNTIME_INFERENCE_RECOVERY_REQUIRED\)/);
  assert.equal(calls.closed, true);
});
