const { withMutationJournal, observeJsonMutation, jsonMutationDuration, beginResponseMutation } = require('../../../src/services/profiler/profilerMutationObservation');
const { readOllamaGenerateStream } = require('../../../src/services/hostTestRuntimeTransport');
let clock;
const journal = { beforeMutation: async () => { clock += 100; return 1; },
  completeMutation: async () => { clock += 100; }, unknownMutation: jest.fn() };
beforeEach(() => { clock = 1000; jest.spyOn(Date, 'now').mockImplementation(() => clock); });
afterEach(() => jest.restoreAllMocks());
test('journal and authority round trips do not inflate a decoded response duration', async () => {
  const result = await withMutationJournal(journal, () => observeJsonMutation(async () => { clock += 30; return { done: true }; }));
  expect(clock - 1000).toBe(230);
  expect(jsonMutationDuration(result, clock - 1000)).toBe(30);
  expect(jsonMutationDuration({ done: true }, 230)).toBe(230);
});
test('stream TTFT and completion duration exclude coordination before dispatch and after its terminal', async () => {
  const response = { async *stream() {
    clock += 5; yield Buffer.from('{"done":false,"response":"x"}\n');
    clock += 15; yield Buffer.from('{"done":true,"eval_count":1}\n');
  } };
  const result = await withMutationJournal(journal, async () => {
    const observed = await beginResponseMutation(async () => response);
    return readOllamaGenerateStream(observed, 1000);
  });
  expect(result.timeToFirstTokenMs).toBe(5); expect(result.clientDurationMs).toBe(20);
  expect(clock - 1000).toBe(220);
});

describe('an Ollama 4xx rejection is a terminal outcome', () => {
  const { rejectedBeforeWork } = require('../../../src/services/profiler/profilerMutationObservation');
  const { readExactGenerateTerminal } = require('../../../src/services/hostTestRuntimeTransport');
  const tracked = () => ({ beforeMutation: jest.fn(async () => 7), completeMutation: jest.fn(async () => {}), unknownMutation: jest.fn(async () => {}) });
  const httpError = status => Object.assign(new Error(`Ollama POST /api/chat returned ${status}`), { status });

  test.each([[400, true], [404, true], [499, true], [500, false], [503, false], [undefined, false]])(
    'status %s rejected before work: %s', (status, expected) => {
      expect(rejectedBeforeWork(status === undefined ? new Error('socket hang up') : httpError(status))).toBe(expected);
    });

  test('a 400 (model without thinking support) completes the ticket, so the next request may run', async () => {
    const j = tracked();
    await expect(withMutationJournal(j, () => observeJsonMutation(async () => { throw httpError(400); })))
      .rejects.toMatchObject({ status: 400 });
    expect(j.completeMutation).toHaveBeenCalledWith(7);
    expect(j.unknownMutation).not.toHaveBeenCalled();
  });

  test('a transport failure or a 5xx stays unknown', async () => {
    for (const failure of [new Error('socket hang up'), httpError(500)]) {
      const j = tracked();
      await expect(withMutationJournal(j, () => observeJsonMutation(async () => { throw failure; }))).rejects.toBe(failure);
      expect(j.unknownMutation).toHaveBeenCalledWith(7, failure);
      expect(j.completeMutation).not.toHaveBeenCalled();
    }
  });

  test('a streamed generate rejected with 4xx records its terminal receipt', async () => {
    const j = tracked();
    const response = { ok: false, status: 400, cancel: jest.fn(async () => {}) };
    await expect(withMutationJournal(j, async () => {
      const observed = await beginResponseMutation(async () => response);
      return readExactGenerateTerminal(observed, 'generate');
    })).rejects.toMatchObject({ code: 'OLLAMA_GENERATE_REJECTED', status: 400 });
    expect(j.completeMutation).toHaveBeenCalledWith(7);
    expect(j.unknownMutation).not.toHaveBeenCalled();
  });
});
