'use strict';

jest.mock('../../../src/clients/ollamaClient', () => ({ chat: jest.fn(), generate: jest.fn() }));

const { chat, generate } = require('../../../src/clients/ollamaClient');
const payload = require('../../../src/services/profiler/agentWorkloadPayload');
const { runAgentWorkloadProbe, _internal } = require('../../../src/services/profiler/agentWorkloadProbe');

// A simulated model that reads the prompts the way a careful agent would.
function sourceValue(text, key) {
  const match = String(text).match(new RegExp(`const ${key} = (\\d+);`));
  return match ? Number(match[1]) : null;
}

function perfectSessionAnswer(content) {
  const [, id, key, documented] = content.match(/Claim (C\d+): the documentation says (\w+) in \S+ is (\d+)/);
  const actual = sourceValue(content, key);
  return `CHECK ${id} ${Number(documented) === actual ? 'ok' : 'mismatch'} ${actual}`;
}

function perfectGenerate(prompt) {
  if (prompt.includes('facts from a documentation review')) {
    const rows = [...prompt.matchAll(/(F\d{3}) key=(\w+) documented=(\d+) actual=(\d+)/g)].map(([, id, key, doc, actual]) =>
      ({ id, key, value: Number(actual), verdict: doc === actual ? 'ok' : 'mismatch' }));
    return JSON.stringify(rows);
  }
  const rows = [...prompt.matchAll(/\| (C\d+) \| (\S+) \| (\w+) \| (\d+) \|/g)]
    .map(([, id, , key, documented]) => ({ id, documented: Number(documented), actual: sourceValue(prompt, key) }))
    .filter(row => row.documented !== row.actual);
  return JSON.stringify(rows);
}

function perfectToolTurn(messages) {
  const manifest = [...messages[1].content.matchAll(/- (C\d+): (\w+) in (\S+) is documented as (\d+)/g)];
  const toolResults = messages.filter(message => message.role === 'tool');
  const reads = messages.filter(message => message.role === 'assistant')
    .flatMap(message => message.tool_calls || []).filter(call => call.function.name === 'read_file').length;
  const records = toolResults.filter(message => message.content === 'recorded').length;
  if (records === manifest.length) return { message: { content: 'All claims are recorded.' } };
  const [, id, key, path, documented] = manifest[records];
  if (reads === records) return { message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path } } }] } };
  const actual = sourceValue(toolResults[toolResults.length - 1].content, key);
  return { message: { content: '', tool_calls: [{ function: { name: 'record_check',
    arguments: { id, verdict: Number(documented) === actual ? 'ok' : 'mismatch', value: actual } } }] } };
}

function simulatedModel({ latency = () => 1000, wrongAfterTurn = Infinity, outputLimit = Infinity } = {}) {
  let now = 0;
  const clock = () => now;
  chat.mockImplementation(async (_host, body) => {
    if (body.tools) { now += 500; return { done: true, ...perfectToolTurn(body.messages) }; }
    const turn = body.messages.filter(message => message.role === 'user').length;
    const content = body.messages[body.messages.length - 1].content;
    now += latency(turn);
    const sent = body.messages.reduce((total, message) => total + message.content.length, 0);
    const answer = turn > wrongAfterTurn ? 'CHECK C99 ok 1' : perfectSessionAnswer(content);
    return { done: true, message: { content: answer }, prompt_eval_count: turn === 1 ? Math.round(sent / 4) : 3000, eval_count: 12 };
  });
  generate.mockImplementation(async (_host, body) => {
    now += 2000;
    const items = (body.prompt.match(/^F\d{3} /gm) || []).length;
    const response = items > outputLimit ? perfectGenerate(body.prompt).slice(0, 200) : perfectGenerate(body.prompt);
    return { done: true, response, eval_count: Math.round(response.length / 4), prompt_eval_count: Math.round(body.prompt.length / 4) };
  });
  return clock;
}

beforeEach(() => jest.clearAllMocks());

describe('agent workload payload', () => {
  it('is deterministic and plants the requested mismatches', () => {
    expect(payload.claims(5, 12, 4)).toEqual(payload.claims(5, 12, 4));
    expect(payload.claims(5, 12, 4).filter(claim => claim.verdict === 'mismatch')).toHaveLength(4);
  });

  it('scores answers exactly', () => {
    const claim = { id: 'C03', verdict: 'mismatch', actual: 750 };
    expect(payload.scoreSessionAnswer('CHECK C03 mismatch 750', claim)).toEqual({ correct: true, reason: null });
    expect(payload.scoreSessionAnswer('CHECK C03 ok 750', claim).correct).toBe(false);
    expect(payload.scoreSessionAnswer('The value is 750.', claim).reason).toBe('format');
    const built = payload.structuredOutputPrompt(1, 10);
    expect(payload.scoreStructuredOutput(perfectGenerate(built.prompt), built.facts).passed).toBe(true);
    expect(payload.scoreStructuredOutput('```json\n[]\n```', built.facts)).toMatchObject({ passed: false, parsed: true, exact: 0 });
    expect(payload.scoreStructuredOutput('not json', built.facts).parsed).toBe(false);
  });

  it('builds a verification context close to the requested size with four mismatches', () => {
    const built = payload.verificationPrompt(9, 30000);
    expect(built.prompt.length).toBeGreaterThan(24000);
    expect(built.prompt.length).toBeLessThan(40000);
    expect(built.expected).toHaveLength(4);
    expect(payload.scoreVerification(perfectGenerate(built.prompt), built)).toMatchObject({ passed: true, found: 4, falsePositives: 0 });
    expect(payload.scoreVerification('[{"id":"C01","actual":1}]', built).passed).toBe(false);
  });
});

describe('agent workload probe', () => {
  it('measures a capable model end to end and summarizes what workers need', async () => {
    const clock = simulatedModel({ latency: turn => 8000 + turn * 400 });
    const result = await runAgentWorkloadProbe('http://gpu:11434', 'coder', { maxVerifiedContext: 65536, clock });
    expect(result.session.status).toBe('measured');
    expect(result.session.stopReason).toBe('context_full');
    expect(result.session.correctTurns).toBe(result.session.turns.length);
    expect(result.summary.sessionAccuracyContext).toBe(result.session.turns[result.session.turns.length - 1].contextTokens);
    expect(result.summary.reliableOutputItems).toBe(200);
    expect(result.summary.verificationVerifiedContext).toBe(65536);
    expect(result.verification.results.map(row => row.numCtx)).toEqual([8192, 32768, 65536]);
    expect(result.summary.reliableToolTurns).toBe(24);
    expect(result.summary.toolChecksCorrect).toBe(12);
    expect(result.tools.stopReason).toBe('finished');
    expect(chat.mock.calls.every(([, body]) => body.think === false && body.options.temperature === 0)).toBe(true);
  });

  it('finds where a growing session slows down and where answers break', async () => {
    const clock = simulatedModel({ latency: turn => (turn <= 5 ? 10000 : 30000), wrongAfterTurn: 8 });
    const session = await _internal.runSessionGrowth('http://gpu:11434', 'coder', {
      maxVerifiedContext: 131072, timeoutMs: 1000, checkpoint: () => {}, onProgress: () => {}, clock });
    expect(session.baselineLatencyMs).toBe(10000);
    expect(session.latencyKneeContext).toBe(session.turns[4].contextTokens);
    expect(session.accuracyContext).toBe(session.turns[7].contextTokens);
    expect(session.turns[0].contextTokens).toBeLessThan(session.turns[1].contextTokens);
  });

  it('stops a session at a call slower than five minutes', async () => {
    const clock = simulatedModel({ latency: turn => (turn === 3 ? 301000 : 5000) });
    const session = await _internal.runSessionGrowth('http://gpu:11434', 'coder', {
      maxVerifiedContext: 131072, timeoutMs: 1000, checkpoint: () => {}, onProgress: () => {}, clock });
    expect(session.stopReason).toBe('slow_call');
    expect(session.turns).toHaveLength(3);
  });

  it('keeps the largest complete structured output and stops at the first truncated one', async () => {
    const clock = simulatedModel({ outputLimit: 50 });
    const output = await _internal.runStructuredOutput('http://gpu:11434', 'coder', {
      numCtx: 32768, timeoutMs: 1000, checkpoint: () => {}, onProgress: () => {}, clock });
    expect(output.reliableItems).toBe(50);
    expect(output.results.map(row => row.status)).toEqual(['pass', 'pass', 'pass', 'fail']);
  });

  it('records a model without tool calls as stopped, not as failed requests', async () => {
    simulatedModel();
    chat.mockImplementation(async () => ({ done: true, message: { content: 'I would read the files.' } }));
    const tools = await _internal.runToolTurns('http://gpu:11434', 'coder', {
      numCtx: 32768, timeoutMs: 1000, checkpoint: () => {}, onProgress: () => {} });
    expect(tools).toMatchObject({ reliableToolTurns: 0, recordedChecks: 0, stopReason: 'stopped_calling' });
  });

  it('stops tool turns at the first invalid call', async () => {
    simulatedModel();
    chat.mockImplementation(async () => ({ done: true, message: { content: '', tool_calls: [{ function: { name: 'delete_repo', arguments: {} } }] } }));
    const tools = await _internal.runToolTurns('http://gpu:11434', 'coder', {
      numCtx: 32768, timeoutMs: 1000, checkpoint: () => {}, onProgress: () => {} });
    expect(tools).toMatchObject({ reliableToolTurns: 0, stopReason: 'invalid_call' });
  });

  it('propagates a cancellation instead of recording it as a model failure', async () => {
    const controller = new AbortController();
    controller.abort(new Error('profile cancelled'));
    chat.mockRejectedValue(new Error('aborted'));
    await expect(_internal.runSessionGrowth('http://gpu:11434', 'coder', {
      maxVerifiedContext: 32768, timeoutMs: 1000, signal: controller.signal, checkpoint: () => {}, onProgress: () => {} }))
      .rejects.toThrow('profile cancelled');
  });
});
