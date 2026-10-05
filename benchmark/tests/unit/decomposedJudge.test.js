/**
 * Unit tests for decomposedJudge.js
 * Tests majority voting, prompt structure, context limits, and model options
 */

jest.mock('node-fetch');
const mockFetchFn = require('node-fetch');

jest.mock('../../src/clients/coreApiClient', () => ({
    getBenchmarkClaimIdentity: jest.fn(() => null),
    getWorkloadAdmissionIdentity: jest.fn(() => null)
}));
const { getWorkloadAdmissionIdentity } = require('../../src/clients/coreApiClient');

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../src/helpers/httpAgent', () => ({
    getFetchOptions: (url, opts) => opts
}));

jest.mock('../../src/services/scoring/judgeRuntimeConfig', () => ({
    normalizeJudgeNumCtx: jest.fn((value) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return 8192;
        return Math.max(512, Math.min(131072, Math.round(parsed)));
    })
}));

const { askBinaryQuestion, scoreDimension, score, parseGradedAnswer, DECOMPOSED_QUESTIONS } = require('../../src/services/decomposedJudge');
const { matchBinaryVerdict } = require('../../src/services/scoring/decomposedHelpers');
const { MISSING_COUNT } = require('../../src/services/decomposedJudgeQuestions');
const logger = require('../../config/logger');

const JUDGE_CONFIG = { host: 'http://localhost:11434', model: 'qwen2.5:7b', timeout: 5000 };

function mockFetchResponse(text) {
    return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: text })
    });
}

function mockFetchSequence(responses) {
    let i = 0;
    mockFetchFn.mockImplementation(() => {
        const text = responses[i % responses.length];
        i++;
        if (text instanceof Error) return Promise.reject(text);
        return mockFetchResponse(text);
    });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Default voting (single call, voting_count=1)', () => {
    test('sends the selected temperature and seed, including zero', async () => {
        mockFetchFn.mockImplementation(() => mockFetchResponse('YES'));
        await askBinaryQuestion('42', 'Correct?', { ...JUDGE_CONFIG, temperature: 0, seed: 0 });
        expect(JSON.parse(mockFetchFn.mock.calls[0][1].body).options).toMatchObject({ temperature: 0, seed: 0 });
    });

    test('retains raw calls and observed usage in the existing evidence fields', async () => {
        mockFetchFn.mockResolvedValue({ ok: true, status: 200, json: async () => ({
            model: 'observed-judge', response: 'YES', done: true, done_reason: 'stop',
            prompt_eval_count: 170, eval_count: 2, eval_duration: 100000000
        }) });
        const result = await score('42', { prompt: '15 + 27?', expected_answer: '42', category: 'math' }, JUDGE_CONFIG);
        const prompts = JSON.parse(result.judge_prompt);
        const evidence = JSON.parse(result.judge_raw_response);
        expect(evidence.calls.length).toBe(mockFetchFn.mock.calls.length);
        expect(prompts).toHaveLength(evidence.calls.length);
        expect(prompts[0].prompt).toContain('EXPECTED ANSWER:\n42');
        expect(evidence.calls[0]).toMatchObject({ model: 'observed-judge', response: 'YES',
            prompt_eval_count: 170, eval_count: 2, done_reason: 'stop', status: 200 });
        expect(evidence.calls[0].options).toHaveProperty('temperature');
        expect(evidence.calls[0]).not.toHaveProperty('context');
    });

    test.each([1, 3])('runtime drift stops a verdict with voting_count=%i instead of retrying or accepting other votes', async voting_count => {
        mockFetchFn.mockImplementation(() => mockFetchResponse('YES'));
        await expect(askBinaryQuestion('Paris', 'Correct?', { ...JUDGE_CONFIG, voting_count,
            execution_contract: { schema: 'agentx.benchmark-judge-execution/v1', num_ctx: 65536,
                artifact: { model: 'judge:latest', digest: 'a'.repeat(64), runtimeFingerprint: 'b'.repeat(64) } }
        })).rejects.toMatchObject({ code: 'JUDGE_EXECUTION_CONTRACT_MISMATCH' });
        expect(mockFetchFn).toHaveBeenCalledTimes(voting_count);
        expect(mockFetchFn.mock.calls.every(([, options]) => JSON.parse(options.body).includeArtifactIdentity === true)).toBe(true);
    });

    test('honors the explicit verdict budget for binary judging', async () => {
        mockFetchFn.mockImplementation(() => mockFetchResponse('YES'));
        expect(await askBinaryQuestion('Paris', 'Correct?', { ...JUDGE_CONFIG, num_predict: 1024 })).toBe(true);
        expect(JSON.parse(mockFetchFn.mock.calls[0][1].body).options.num_predict).toBe(1024);
    });
    test('a truncated YES and retry do not grade the candidate even when the remaining questions complete', async () => {
        mockFetchFn.mockImplementation(() => mockFetchResponse('YES'));
        mockFetchFn.mockResolvedValueOnce({ ok: true, json: async () => ({ response: 'YES', done_reason: 'length' }) });
        mockFetchFn.mockResolvedValueOnce({ ok: true, json: async () => ({ response: 'YES', done_reason: 'length' }) });
        const result = await score('Paris', { prompt: 'Capital of France?', category: 'knowledge' }, JUDGE_CONFIG);
        expect(result).toMatchObject({ quality_score: null, judge_reliable: false, needs_review: true });
    });
    test('a completed binary retry supplies the verdict instead of the truncated prefix', async () => {
        mockFetchFn.mockImplementation(() => mockFetchResponse('NO'));
        mockFetchFn.mockResolvedValueOnce({ ok: true, json: async () => ({ response: 'YES', done_reason: 'length' }) });
        expect(await askBinaryQuestion('Paris', 'Is this wrong?', JUDGE_CONFIG)).toBe(false);
        expect(mockFetchFn).toHaveBeenCalledTimes(2);
    });
    test('only the retry after a truncation constrains the output to the answers', async () => {
        mockFetchFn.mockImplementation(() => mockFetchResponse('"NA"'));
        mockFetchFn.mockResolvedValueOnce({ ok: true, json: async () => ({ response: 'Let me think', done_reason: 'length' }) });
        expect(await askBinaryQuestion('Paris', 'If code is asked, is it tested?', JUDGE_CONFIG, {}, { conditional: true })).toBe('NA');
        const [first, retry] = mockFetchFn.mock.calls.map(call => JSON.parse(call[1].body));
        expect(first.format).toBeUndefined();
        expect(retry.format).toEqual({ type: 'string', enum: ['YES', 'NO', 'NA'] });
    });
    test('a retry after an ordinary failure stays free-form', async () => {
        mockFetchFn.mockImplementation(() => mockFetchResponse('YES'));
        mockFetchFn.mockRejectedValueOnce(new Error('Premature close'));
        expect(await askBinaryQuestion('Paris', 'Correct?', JUDGE_CONFIG)).toBe(true);
        expect(JSON.parse(mockFetchFn.mock.calls[1][1].body).format).toBeUndefined();
    });
    test('a constrained graded retry reads the quoted option', async () => {
        const graded = [{ answer: '0', credit: 0 }, { answer: '1', credit: 0.5 }, { answer: '2 or more', credit: 1 }];
        mockFetchFn.mockImplementation(() => mockFetchResponse('"2 or more"'));
        mockFetchFn.mockResolvedValueOnce({ ok: true, json: async () => ({ response: 'Counting', done_reason: 'length' }) });
        expect(await askBinaryQuestion('Paris', 'How many?', JUDGE_CONFIG, {}, { graded })).toBe('2 or more');
        expect(JSON.parse(mockFetchFn.mock.calls[1][1].body).format.enum).toEqual(['0', '1', '2 or more']);
    });
    test('carries the standalone calibration workload into binary judging', async () => {
        const controller = new AbortController();
        Object.defineProperty(controller.signal, 'workloadId', { value: 'calibration:binary' });
        const proof = { workloadAdmissionId: 'owned', workloadGeneration: 'generation' };
        // Read by the yield point and by the request itself.
        getWorkloadAdmissionIdentity.mockImplementation(id => (id === 'calibration:binary' ? proof : null));
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'Correct?', { ...JUDGE_CONFIG, cancelSignal: controller.signal });
        expect(JSON.parse(mockFetchFn.mock.calls[0][1].body)).toMatchObject(proof);
    });

    test('unanswered judge questions leave quality unscored rather than grading the candidate zero', async () => {
        mockFetchFn.mockImplementation(() => mockFetchResponse('undecidable'));
        const result = await score('Paris', { name: 'capital', prompt: 'Capital of France?', category: 'knowledge' }, JUDGE_CONFIG);
        expect(result).toMatchObject({ quality_score: null, judge_reliable: false, needs_review: true });
        expect(result.judge_errors).toBeGreaterThan(0);
        expect(result.error).toMatch(/not evaluated/);
    });

    test('caller cancellation aborts the active call without retry or null fallback', async () => {
        const controller = new AbortController();
        let markStarted;
        const started = new Promise((resolve) => { markStarted = resolve; });
        mockFetchFn.mockImplementation((url, options) => new Promise((resolve, reject) => {
            markStarted();
            const onAbort = () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            };
            options.signal.addEventListener('abort', onAbort, { once: true });
            if (options.signal.aborted) onAbort();
        }));

        const pending = askBinaryQuestion('response', 'Is this good?', {
            ...JUDGE_CONFIG,
            cancelSignal: controller.signal
        });
        await started;
        controller.abort();

        await expect(pending).rejects.toMatchObject({ code: 'BENCHMARK_BATCH_STOPPED' });
        expect(mockFetchFn).toHaveBeenCalledTimes(1);
        expect(logger.warn).not.toHaveBeenCalledWith(
            'Binary call failed, retrying once',
            expect.any(Object)
        );
    });

    test('YES → true (1 call)', async () => {
        mockFetchSequence(['YES']);
        const result = await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);
        expect(result).toBe(true);
        expect(mockFetchFn).toHaveBeenCalledTimes(1);
    });

    test('NO → false (1 call)', async () => {
        mockFetchSequence(['NO']);
        const result = await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);
        expect(result).toBe(false);
        expect(mockFetchFn).toHaveBeenCalledTimes(1);
    });

    test('single failure → retry succeeds', async () => {
        // First call errors, second call returns YES. Retry should recover.
        mockFetchSequence([new Error('timeout'), 'YES']);
        const result = await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);
        expect(result).toBe(true);
        expect(mockFetchFn).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith('Binary call failed, retrying once', expect.any(Object));
    });

    test('failure + retry failure → defaults to null', async () => {
        mockFetchSequence([new Error('timeout'), new Error('timeout')]);
        const result = await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);
        expect(result).toBe(null);
        expect(mockFetchFn).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenCalledWith('Binary call failed after retry', expect.any(Object));
    });

    test('ambiguous response remains unanswered', async () => {
        mockFetchSequence(['maybe']);
        const result = await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);
        expect(result).toBeNull();
    });

    test('YES with preamble tokens is treated as ambiguous', async () => {
        mockFetchSequence(['Based on the analysis, YES']);
        const result = await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);
        expect(result).toBeNull();
        expect(mockFetchFn).toHaveBeenCalledTimes(1);
    });
});

describe('Majority voting (voting_count: 3)', () => {
    const VOTING_CONFIG = { ...JUDGE_CONFIG, voting_count: 3 };

    test('3 YES → YES', async () => {
        mockFetchSequence(['YES', 'YES', 'YES']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(true);
        expect(mockFetchFn).toHaveBeenCalledTimes(3);
    });

    test('3 NO → NO', async () => {
        mockFetchSequence(['NO', 'NO', 'NO']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(false);
    });

    test('2 YES + 1 NO → YES (majority wins)', async () => {
        mockFetchSequence(['YES', 'NO', 'YES']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(true);
        expect(logger.warn).toHaveBeenCalledWith('Binary vote disagreement', expect.any(Object));
    });

    test('1 YES + 2 NO → NO (majority wins)', async () => {
        mockFetchSequence(['YES', 'NO', 'NO']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith('Binary vote disagreement', expect.any(Object));
    });

    test('no disagreement log when unanimous YES', async () => {
        mockFetchSequence(['YES', 'YES', 'YES']);
        await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(logger.warn).not.toHaveBeenCalledWith('Binary vote disagreement', expect.any(Object));
    });

    test('no disagreement log when unanimous NO', async () => {
        mockFetchSequence(['NO', 'NO', 'NO']);
        await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(logger.warn).not.toHaveBeenCalledWith('Binary vote disagreement', expect.any(Object));
    });

    test('2 failures + 1 YES → uses single success', async () => {
        mockFetchSequence([new Error('timeout'), new Error('timeout'), 'YES']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(true);
    });

    test('2 failures + 1 NO → uses single success', async () => {
        mockFetchSequence([new Error('timeout'), new Error('timeout'), 'NO']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(false);
    });

    test('all 3 fail → defaults to null', async () => {
        mockFetchSequence([new Error('fail'), new Error('fail'), new Error('fail')]);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(null);
        expect(logger.error).toHaveBeenCalledWith('All 3 binary votes failed', expect.any(Object));
    });

    test('ambiguous responses remain unanswered', async () => {
        mockFetchSequence(['maybe', 'perhaps', 'unclear']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBeNull();
    });
    test('a tie between the valid votes remains unanswered', async () => {
        mockFetchSequence(['YES', 'NO', 'unclear']);
        expect(await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG)).toBeNull();
    });
});

describe('Prompt structure and context limits', () => {
    test('prompt includes role instruction and labeled sections', async () => {
        mockFetchSequence(['YES']);
        const task = 'Write a function';
        const expected = 'function foo() {}';
        await askBinaryQuestion('some response', 'Is it correct?', JUDGE_CONFIG, { task, expected });

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.prompt).toContain('You are evaluating ONE specific aspect');
        expect(body.prompt).toContain('TASK:\n');
        expect(body.prompt).toContain('EXPECTED ANSWER:\n');
        expect(body.prompt).toContain('RESPONSE_START\n');
        expect(body.prompt).toContain('\nRESPONSE_END');
        expect(body.prompt).toContain('Answer ONLY "YES" or "NO" for this specific question:');
    });

    test('preserves instructions beyond the old 2000-character task cutoff', async () => {
        mockFetchSequence(['YES']);
        const longTask = 'x'.repeat(5000);
        await askBinaryQuestion('resp', 'q?', JUDGE_CONFIG, { task: longTask });

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.prompt).toContain(longTask);
    });

    test('preserves the complete expected answer', async () => {
        mockFetchSequence(['YES']);
        const longExpected = 'e'.repeat(2000);
        await askBinaryQuestion('resp', 'q?', JUDGE_CONFIG, { task: 'task', expected: longExpected });

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.prompt).toContain(longExpected);
    });

    test('preserves the response tail without an explicit excerpt budget', async () => {
        mockFetchSequence(['YES']);
        const response = 'r'.repeat(12000) + 'DECISIVE_TAIL';
        await askBinaryQuestion(response, 'q?', JUDGE_CONFIG);
        expect(JSON.parse(mockFetchFn.mock.calls[0][1].body).prompt).toContain(response);
    });

    test('response truncated at configured char budget', async () => {
        mockFetchSequence(['YES']);
        const longResponse = 'r'.repeat(5000);
        await askBinaryQuestion(longResponse, 'q?', { ...JUDGE_CONFIG, response_char_budget: 3000 });

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.prompt).not.toContain('r'.repeat(3001));
        expect(body.prompt).toContain('r'.repeat(3000));
    });

    test('no task context → no TASK/EXPECTED sections', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'q?', JUDGE_CONFIG);

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.prompt).not.toContain('TASK:');
        expect(body.prompt).not.toContain('EXPECTED ANSWER:');
        expect(body.prompt).toContain('RESPONSE_START');
        expect(body.prompt).toContain('RESPONSE_END');
    });

    test('task without expected → TASK but no EXPECTED section', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'q?', JUDGE_CONFIG, { task: 'do stuff' });

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.prompt).toContain('TASK:');
        expect(body.prompt).not.toContain('EXPECTED ANSWER:');
    });
});

describe('Model options', () => {
    test('sends num_predict: 20, num_ctx: 8192 (default), temperature: 0.1', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'q?', JUDGE_CONFIG);

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.options.num_predict).toBe(20);
        expect(body.options.num_ctx).toBe(8192);
        expect(body.options.temperature).toBe(0.1);
    });

    test('sends correct model name', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'q?', JUDGE_CONFIG);

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.model).toBe('qwen2.5:7b');
    });

    test('stream is false', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'q?', JUDGE_CONFIG);

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.stream).toBe(false);
    });
});

describe('scoreDimension', () => {
    test('all YES → score 10', async () => {
        mockFetchSequence(['YES', 'YES']);
        const questions = [
            { q: 'Q1?', weight: 0.5 },
            { q: 'Q2?', weight: 0.5 }
        ];
        const result = await scoreDimension('response', questions, JUDGE_CONFIG);
        expect(result.score).toBe(10);
        expect(result.breakdown).toHaveLength(2);
        expect(result.breakdown.every(b => b.contributed)).toBe(true);
    });

    test('all NO → score 0', async () => {
        mockFetchSequence(['NO', 'NO']);
        const questions = [
            { q: 'Q1?', weight: 0.5 },
            { q: 'Q2?', weight: 0.5 }
        ];
        const result = await scoreDimension('response', questions, JUDGE_CONFIG);
        expect(result.score).toBe(0);
    });

    test('NA on a conditional question is excluded from the weight instead of failing it', async () => {
        mockFetchSequence(['YES', 'NA']);
        const questions = [
            { q: 'Does it do the task?', weight: 0.5 },
            { q: 'If the task modifies existing code, is it preserved?', weight: 0.5, conditional: true }
        ];
        const result = await scoreDimension('response', questions, JUDGE_CONFIG);
        expect(result.score).toBe(10);
        expect(result.total).toBe(0.5);
        expect(result.breakdown[1]).toMatchObject({ na: true, answer: null, contributed: false });
        expect(result.breakdown[1].error).toBeUndefined();
        expect(result.notApplicable).toBe(false);
    });

    test('NA on an unconditional question is read as NO', async () => {
        mockFetchSequence(['N/A']);
        const result = await scoreDimension('response', [{ q: 'Is the final answer correct?', weight: 1 }], JUDGE_CONFIG);
        expect(result.score).toBe(0);
        expect(result.breakdown[0]).toMatchObject({ answer: false, contributed: false });
        expect(result.breakdown[0].na).toBeUndefined();
    });

    test('a dimension whose every question is not applicable has no score and no error', async () => {
        mockFetchSequence(['NA', 'not applicable']);
        const questions = [
            { q: 'If A, is it handled?', weight: 0.5, conditional: true },
            { q: 'If B, is it handled?', weight: 0.5, conditional: true }
        ];
        const result = await scoreDimension('response', questions, JUDGE_CONFIG);
        expect(result).toMatchObject({ score: null, errors: 0, notApplicable: true });
    });

    test('only conditional questions offer NA in the prompt', async () => {
        mockFetchSequence(['YES', 'YES']);
        await scoreDimension('response', [
            { q: 'Plain?', weight: 0.5 },
            { q: 'If conditional?', weight: 0.5, conditional: true }
        ], JUDGE_CONFIG);
        const plain = JSON.parse(mockFetchFn.mock.calls[0][1].body).prompt;
        const conditional = JSON.parse(mockFetchFn.mock.calls[1][1].body).prompt;
        expect(plain).toContain('Answer ONLY "YES" or "NO" for this specific question: Plain?');
        expect(plain).not.toContain('NA:');
        expect(conditional).toContain('Answer ONLY "YES", "NO" or "NA" for this specific question: If conditional?');
        expect(conditional).toContain('Use NA only then');
    });

    test('the prompt tells the judge the expected answer is a reference, not required wording', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('def f(): pass', 'Correct?', JUDGE_CONFIG, { task: 'Write f', expected: 'def f():\n    return' });
        const prompt = JSON.parse(mockFetchFn.mock.calls[0][1].body).prompt;
        expect(prompt).toContain('not required wording');
        expect(prompt).toContain('Do not require properties the task did not request');
    });

    test('weighted scoring is proportional', async () => {
        // First question YES (weight 0.8), second NO (weight 0.2)
        let callCount = 0;
        mockFetchFn.mockImplementation(() => {
            callCount++;
            // Call 1 for Q1, call 2 for Q2 (single vote each)
            const answer = callCount <= 1 ? 'YES' : 'NO';
            return mockFetchResponse(answer);
        });

        const questions = [
            { q: 'Q1?', weight: 0.8 },
            { q: 'Q2?', weight: 0.2 }
        ];
        const result = await scoreDimension('response', questions, JUDGE_CONFIG);
        expect(result.score).toBe(8);
    });
});

describe('overall score: primary-dimension cap and attention check', () => {
    // Answer each judge call from the question it asks, so the order of
    // dimensions does not matter and the known-answer probes are exercised.
    function answerByQuestion(rule) {
        mockFetchFn.mockImplementation((url, options) => {
            const prompt = JSON.parse(options.body).prompt;
            const question = prompt.split('for this specific question: ')[1] || '';
            if (question.includes('at least one character')) return mockFetchResponse(rule.probeYes || 'YES');
            if (question.includes('completely empty')) return mockFetchResponse(rule.probeNo || 'NO');
            // A counted question gets the best count when the rule says YES, the worst when NO.
            if (prompt.includes('Answer ONLY one of')) return mockFetchResponse(rule.answer(question) === 'YES' ? '0' : '3 or more');
            return mockFetchResponse(rule.answer(question));
        });
    }
    const knowledgePrompt = { prompt: 'Capital of France?', expected_answer: 'Paris', category: 'knowledge' };
    const accuracyQuestions = DECOMPOSED_QUESTIONS.knowledge.accuracy.map(q => q.q);

    test('a wrong answer cannot be rescued by clarity: overall is capped at the primary dimension + 1', async () => {
        answerByQuestion({ answer: q => (accuracyQuestions.includes(q) ? 'NO' : 'YES') });
        const result = await score('Berlin', knowledgePrompt, JUDGE_CONFIG);
        expect(result.breakdown.accuracy).toBe(0);
        expect(result.primary_cap).toMatchObject({ dimension: 'accuracy', score: 0, margin: 1, applied: true, uncapped_score: 6.5 });
        expect(result.quality_score).toBe(1);
        expect(result.explanation).toContain('Capped at accuracy + 1 (uncapped 6.5)');
        expect(result.attention_check.passed).toBe(true);
    });

    test('the cap does not touch a score already within the margin', async () => {
        answerByQuestion({ answer: () => 'YES' });
        const result = await score('Paris', knowledgePrompt, JUDGE_CONFIG);
        expect(result.quality_score).toBe(10);
        expect(result.primary_cap).toMatchObject({ applied: false, uncapped_score: 10 });
    });

    test('a judge that answers by disposition fails the known-answer probes without changing the score', async () => {
        answerByQuestion({ answer: () => 'YES', probeNo: 'YES' });
        const result = await score('Paris', knowledgePrompt, JUDGE_CONFIG);
        expect(result.quality_score).toBe(10);
        expect(result.attention_check.passed).toBe(false);
        expect(result.attention_check.probes.map(p => p.correct)).toEqual([true, false]);
    });

    test('an unanswerable probe leaves the attention check unknown', async () => {
        answerByQuestion({ answer: () => 'YES', probeNo: 'undecidable' });
        const result = await score('Paris', knowledgePrompt, JUDGE_CONFIG);
        expect(result.quality_score).toBe(10);
        expect(result.attention_check.passed).toBeNull();
    });
});

describe('binary verdicts', () => {
    test('reads a verdict at the start or alone on the final line', () => {
        expect(matchBinaryVerdict('YES, it does.')[1]).toBe('yes');
        expect(matchBinaryVerdict('word count: 12, not between 18 and 22.\n\nthe response fails.\n\nNO')[1]).toBe('no');
        expect(matchBinaryVerdict('checked.\nFinal answer: **YES**')[1]).toBe('yes');
    });

    test('does not read a verdict word inside the final sentence', () => {
        expect(matchBinaryVerdict('i checked the rules.\nthere is no violation here')).toBeNull();
        expect(matchBinaryVerdict('- Radius\n- Status\n- Trusty\n- Unfold')).toBeNull();
    });
});

describe('graded (counted) questions', () => {
    test('parses a listed option, a bare count, and an open-ended count', () => {
        expect(parseGradedAnswer('0', MISSING_COUNT).credit).toBe(1);
        expect(parseGradedAnswer('1.', MISSING_COUNT).credit).toBe(0.66);
        expect(parseGradedAnswer('"2"', MISSING_COUNT).credit).toBe(0.33);
        expect(parseGradedAnswer('3 or more', MISSING_COUNT).credit).toBe(0);
        expect(parseGradedAnswer('3', MISSING_COUNT).answer).toBe('3 or more');
        expect(parseGradedAnswer('3+', MISSING_COUNT).answer).toBe('3 or more');
        expect(parseGradedAnswer('7 missing', MISSING_COUNT).answer).toBe('3 or more');
        expect(parseGradedAnswer('two', MISSING_COUNT)).toBeNull();
        expect(parseGradedAnswer('YES', MISSING_COUNT)).toBeNull();
        expect(parseGradedAnswer('10', MISSING_COUNT).answer).toBe('3 or more');
    });

    test('reads a count the judge puts on its final line after reasoning', () => {
        // As qwen3.8:27b answered on 2026-09-23: an analysis, then the count alone.
        const reasoned = 'to evaluate the number of constraints violated, i will check each one.\n\n'
            + '1.  **word count:** 212 words. **violation.**\n'
            + '2.  **two physical details:** present. **no violation.**\n\n'
            + 'the only constraint violated is the word count.\n\n1';
        expect(parseGradedAnswer(reasoned, MISSING_COUNT).credit).toBe(0.66);
        expect(parseGradedAnswer('checked every requirement.\n**0**', MISSING_COUNT).credit).toBe(1);
        expect(parseGradedAnswer('several problems.\nanswer: 3 or more', MISSING_COUNT).answer).toBe('3 or more');
    });

    test('does not take a number buried in the last line of prose', () => {
        expect(parseGradedAnswer('the story has 212 words.\nit breaks 2 rules overall', MISSING_COUNT)).toBeNull();
        expect(parseGradedAnswer('i checked 3 constraints.\nnone of them fail', MISSING_COUNT)).toBeNull();
    });

    test('earns partial credit by count and never offers NA', async () => {
        mockFetchSequence(['YES', '1']);
        const questions = [
            { q: 'Does it answer?', weight: 0.5 },
            { q: 'How many key points are missing? Count them.', weight: 0.5, graded: MISSING_COUNT }
        ];
        const result = await scoreDimension('response', questions, JUDGE_CONFIG);
        expect(result.score).toBe(8.3);
        expect(result.breakdown[1]).toMatchObject({ graded: true, answer: '1', credit: 0.66, contributed: false });
        const prompt = JSON.parse(mockFetchFn.mock.calls[1][1].body).prompt;
        expect(prompt).toContain('Answer ONLY one of "0", "1", "2", "3 or more" for this specific question');
        expect(prompt).not.toContain('NA');
        expect(prompt).toContain('Count only what the task or the expected answer requires');
    });

    test('an unreadable graded answer is an error, not a zero', async () => {
        mockFetchSequence(['YES']);
        const result = await scoreDimension('response', [{ q: 'How many? Count them.', weight: 1, graded: MISSING_COUNT }], JUDGE_CONFIG);
        expect(result).toMatchObject({ score: null, errors: 1 });
    });

    test('majority voting picks the most frequent count and refuses a tie', async () => {
        mockFetchSequence(['1', '1', '2']);
        expect(await askBinaryQuestion('r', 'How many? Count them.', { ...JUDGE_CONFIG, voting_count: 3 }, {}, { graded: MISSING_COUNT })).toBe('1');
        mockFetchSequence(['0', '2']);
        expect(await askBinaryQuestion('r', 'How many? Count them.', { ...JUDGE_CONFIG, voting_count: 2 }, {}, { graded: MISSING_COUNT })).toBeNull();
    });

    test('every category carries a counted question and the options are well formed', () => {
        for (const [category, dimensions] of Object.entries(DECOMPOSED_QUESTIONS)) {
            const graded = Object.values(dimensions).flat().filter(q => Array.isArray(q.graded));
            expect(graded.length).toBeGreaterThanOrEqual(1);
            for (const q of graded) {
                expect(q.conditional).toBeUndefined();
                expect(q.q).toMatch(/Count them[.;]/);
                const credits = q.graded.map(option => option.credit);
                expect(credits[0]).toBe(1);
                expect(credits[credits.length - 1]).toBe(0);
                expect([...credits].sort((a, b) => b - a)).toEqual(credits);
                expect(new Set(q.graded.map(option => option.answer)).size).toBe(q.graded.length);
            }
        }
        expect(DECOMPOSED_QUESTIONS.creative.form).toBeDefined();
    });
});

describe('DECOMPOSED_QUESTIONS coverage', () => {
    test('every question is positively keyed and conditional questions start with "If"', () => {
        for (const dimensions of Object.values(DECOMPOSED_QUESTIONS)) {
            for (const questions of Object.values(dimensions)) {
                for (const q of questions) {
                    expect(q.invert).toBeUndefined();
                    if (q.conditional) expect(q.q).toMatch(/^If /);
                    else expect(q.q).not.toMatch(/^If /);
                }
            }
        }
    });

    test('every benchmark category exists', () => {
        expect(Object.keys(DECOMPOSED_QUESTIONS).sort()).toEqual([
            'agent',
            'coding',
            'creative',
            'instruction',
            'knowledge',
            'math',
            'reasoning',
            'translation'
        ]);
    });

    test('instruction category exists with expected dimensions', () => {
        const instruction = DECOMPOSED_QUESTIONS.instruction;
        expect(instruction).toBeDefined();
        expect(instruction.instruction_adherence).toBeDefined();
        expect(instruction.constraint_compliance).toBeDefined();
        expect(instruction.format_accuracy).toBeDefined();
        expect(instruction.completeness).toBeDefined();
    });

    test('all categories have weights summing to ~1 per dimension', () => {
        for (const [cat, dimensions] of Object.entries(DECOMPOSED_QUESTIONS)) {
            for (const [dim, questions] of Object.entries(dimensions)) {
                const totalWeight = questions.reduce((sum, q) => sum + q.weight, 0);
                expect(totalWeight).toBeCloseTo(1.0, 1);
            }
        }
    });

    test('all questions have required fields', () => {
        for (const [cat, dimensions] of Object.entries(DECOMPOSED_QUESTIONS)) {
            for (const [dim, questions] of Object.entries(dimensions)) {
                for (const q of questions) {
                    expect(q.q).toBeDefined();
                    expect(typeof q.q).toBe('string');
                    expect(q.weight).toBeDefined();
                    expect(typeof q.weight).toBe('number');
                    expect(q.weight).toBeGreaterThan(0);
                    expect(q.weight).toBeLessThanOrEqual(1);
                }
            }
        }
    });
});

describe('think parameter handling', () => {
    test('should send think:false by default in request body', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);

        const callArgs = mockFetchFn.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        expect(body.think).toBe(false);
    });

    test('should respect think:true when explicitly set in judge config', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'Is this good?', { ...JUDGE_CONFIG, think: true });

        const callArgs = mockFetchFn.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        expect(body.think).toBe(true);
    });

    test('should send think:false even when config omits think field', async () => {
        mockFetchSequence(['YES']);
        const configNoThink = { host: 'http://localhost:11434', model: 'test-model', timeout: 5000 };
        await askBinaryQuestion('response', 'Is this good?', configNoThink);

        const callArgs = mockFetchFn.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        expect(body.think).toBe(false);
    });
});
