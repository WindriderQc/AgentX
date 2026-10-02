const { withInferenceRetry, classifyFailure } = require('../../src/services/routing/inferenceRetry');

const busy = () => Object.assign(new Error('occupied'), { code: 'RUNTIME_INFERENCE_ADMISSION_DENIED',
  failure: { cause: 'inference_residency_active', retryable: true, safeToRetry: true } });
function clock() {
  let ms = 0;
  return { enabled: true, now: () => ms, wait: jest.fn(async delay => { ms += delay; }) };
}

test('temporary refusal retries one model call, preserving the logical operation and bounded history', async () => {
  const run = jest.fn().mockRejectedValueOnce(busy()).mockResolvedValue({ ok: true, data: { done: true } });
  const progress = jest.fn();
  const result = await withInferenceRetry(run, { ...clock(), onProgress: progress });
  expect(run).toHaveBeenCalledTimes(2);
  expect(result.retry).toMatchObject({ state: 'completed', attempts: 2,
    history: [{ attempt: 1, cause: 'inference_residency_active', delayMs: 2000 }] });
  expect(progress.mock.calls[0][0].state).toBe('waiting');
});

test('shared diagnostics cannot widen retry eligibility or replace existing failure flags', async () => {
  const error = Object.assign(new Error('partial delivery'), { code: 'OLLAMA_STREAM_INCOMPLETE',
    failure: { cause: 'stream_interrupted', retryable: false, safeToRetry: false,
      diagnostic: { recovery: { authorization: 'granted' } } } });
  expect(classifyFailure(error)).toMatchObject({ retryable: false, safeToRetry: false,
    diagnostic: { category: 'unknown', recovery: { authorization: 'not_granted' } } });
  const run = jest.fn().mockRejectedValue(error);
  const timing = clock();
  await expect(withInferenceRetry(run, timing)).rejects.toMatchObject({
    failure: { diagnostic: { nextAction: 'inspect_execution_evidence' } }, retry: { attempts: 1 } });
  expect(run).toHaveBeenCalledTimes(1);
  expect(timing.wait).not.toHaveBeenCalled();
  expect(classifyFailure(busy())).toMatchObject({ cause: 'inference_residency_active',
    retryable: true, safeToRetry: true, diagnostic: { category: 'admission',
      recovery: { authorization: 'not_granted' } } });
});

test('persistent temporary refusal exhausts exactly six attempts within the time ceiling', async () => {
  const run = jest.fn().mockImplementation(() => { throw busy(); });
  const timing = clock();
  await expect(withInferenceRetry(run, timing)).rejects.toMatchObject({ retry: { state: 'exhausted', attempts: 6 } });
  expect(run).toHaveBeenCalledTimes(6);
  expect(timing.now()).toBeLessThan(120000);
});

test.each(['RUNTIME_INFERENCE_ADMISSION_DENIED', 'RUNTIME_INFERENCE_RECOVERY_REQUIRED',
  'INFERENCE_HOST_INVALID', 'OLLAMA_STREAM_INCOMPLETE', 'ECONNRESET'])('%s is not blindly retried', async code => {
  const run = jest.fn().mockRejectedValue(Object.assign(new Error('unknown/permanent'), { code }));
  await expect(withInferenceRetry(run, clock())).rejects.toMatchObject({ code, retry: { attempts: 1 } });
  expect(run).toHaveBeenCalledTimes(1);
});

test('Retry-After is respected, including refusal to wait past the deadline', async () => {
  const result = { ok: false, status: 503, response: { headers: new Map([['retry-after', '30']]) } };
  const run = jest.fn().mockResolvedValueOnce(result).mockResolvedValue({ ok: true });
  const timing = clock();
  await withInferenceRetry(run, timing);
  expect(timing.wait.mock.calls[0][0]).toBe(30000);
  await expect(withInferenceRetry(jest.fn().mockResolvedValue(result), { ...clock(), maxElapsedMs: 10000 }))
    .rejects.toMatchObject({ retry: { state: 'exhausted', attempts: 1 } });
});

test('cancellation during backoff stops without another provider call', async () => {
  const controller = new AbortController();
  const run = jest.fn().mockRejectedValue(busy());
  const progress = jest.fn();
  await expect(withInferenceRetry(run, { enabled: true, signal: controller.signal, onProgress: progress,
    wait: async () => { controller.abort(); controller.signal.throwIfAborted(); } })).rejects.toBeDefined();
  expect(run).toHaveBeenCalledTimes(1);
  expect(progress.mock.calls.at(-1)[0].state).toBe('cancelled');
});

test('returning a stream closes the retry loop; partial delivery cannot call the provider again', async () => {
  const { PassThrough } = require('stream');
  const stream = new PassThrough();
  stream.on('error', () => {});
  const run = jest.fn().mockResolvedValue({ ok: true, stream });
  const result = await withInferenceRetry(run, clock());
  stream.write('{"message":{"tool_calls":[{"function":');
  stream.destroy(new Error('connection reset after partial tool call'));
  expect(result.stream).toBe(stream);
  expect(run).toHaveBeenCalledTimes(1);
});

describe('household priority wait (#62)', () => {
  const priority = require('../../src/services/interactivePriorityService');
  const reserved = () => Object.assign(new Error('reserved'), { code: 'BENCHMARK_CLAIM_ACTIVE' });
  let endTurn;

  beforeEach(() => {
    Object.assign(priority._state, { activeTurns: 0, lastTurnEndedAt: 0, lastBusyAt: 0 });
    jest.spyOn(priority, 'requestYield').mockResolvedValue({ requested: true });
    endTurn = priority.beginHouseholdTurn();
  });

  afterEach(() => {
    endTurn();
    jest.restoreAllMocks();
  });

  test('a household call asks the reserving workload to yield and waits for the host', async () => {
    const run = jest.fn().mockRejectedValueOnce(reserved()).mockRejectedValueOnce(reserved())
      .mockResolvedValue({ ok: true, data: { done: true } });
    const timing = { ...clock(), enabled: false, host: 'http://host-a:11434' };
    const told = jest.fn();
    const stop = priority.onWaiting(told);
    await expect(withInferenceRetry(run, timing)).resolves.toMatchObject({ ok: true });
    stop();
    expect(run).toHaveBeenCalledTimes(3);
    expect(priority.requestYield).toHaveBeenCalledWith('http://host-a:11434');
    expect(timing.wait).toHaveBeenCalledTimes(2);
    // The person is told once, at the first refusal, not after the wait.
    expect(told).toHaveBeenCalledTimes(1);
    expect(told).toHaveBeenCalledWith({ host: 'http://host-a:11434', waitMs: 60000 });
  });

  test('the wait is bounded and records a busy outcome for the turn', async () => {
    const run = jest.fn().mockImplementation(() => { throw reserved(); });
    const timing = { ...clock(), enabled: false, host: 'http://host-a:11434' };
    await expect(withInferenceRetry(run, timing)).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE' });
    expect(timing.now()).toBeLessThanOrEqual(priority.INTERACTIVE_WAIT_MS);
    expect(priority.busySince(0)).toBe(true);
  });

  test('other failures and calls outside a household turn keep their own policy', async () => {
    const other = jest.fn().mockRejectedValue(Object.assign(new Error('gone'), { code: 'ECONNRESET' }));
    await expect(withInferenceRetry(other, { ...clock(), enabled: false, host: 'h' })).rejects.toThrow('gone');
    expect(other).toHaveBeenCalledTimes(1);
    endTurn();
    priority._state.lastTurnEndedAt = 0;
    const outside = jest.fn().mockRejectedValue(reserved());
    await expect(withInferenceRetry(outside, { ...clock(), enabled: false, host: 'h' })).rejects.toThrow('reserved');
    expect(outside).toHaveBeenCalledTimes(1);
    expect(priority.requestYield).not.toHaveBeenCalled();
  });
});

describe('conversational provider priority (#62, Telegram)', () => {
  const priority = require('../../src/services/interactivePriorityService');
  const reserved = () => Object.assign(new Error('reserved'), { code: 'BENCHMARK_CLAIM_ACTIVE' });

  beforeEach(() => {
    Object.assign(priority._state, { activeTurns: 0, lastTurnEndedAt: 0, lastBusyAt: 0 });
    jest.spyOn(priority, 'requestYield').mockResolvedValue({ requested: true });
  });
  afterEach(() => jest.restoreAllMocks());

  test('an interactive call outside a household turn still asks the workload to yield and holds the host', async () => {
    let activeDuringCall = false;
    const run = jest.fn().mockRejectedValueOnce(reserved()).mockImplementation(async () => {
      activeDuringCall = priority.householdTurnActive();
      return { ok: true };
    });
    await expect(withInferenceRetry(run, { ...clock(), enabled: false, host: 'h', interactive: true }))
      .resolves.toMatchObject({ ok: true });
    expect(priority.requestYield).toHaveBeenCalledWith('h');
    expect(activeDuringCall).toBe(true);
    // The agent loop's next model call, within the grace, still counts as live.
    expect(priority._state.activeTurns).toBe(0);
    expect(priority.householdTurnActive()).toBe(true);
  });

  test('its wait is bounded by the caller, below the gateway provider timeout', async () => {
    const run = jest.fn().mockImplementation(() => { throw reserved(); });
    const timing = { ...clock(), enabled: false, host: 'h', interactive: true, interactiveWaitMs: 45000 };
    await expect(withInferenceRetry(run, timing)).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE' });
    expect(timing.now()).toBeLessThanOrEqual(45000);
  });
});
