'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('node-fetch', () => jest.fn());
jest.mock('../../src/services/benchmark/http', () => ({ benchmarkFetch: (...args) => require('node-fetch')(...args) }));
jest.mock('../../src/services/scoring/codeRunnerClient', () => ({ getCodeRunner: () => ({
  runJob: async () => ({ exit_code: 0, stdout: mockCase.reference_tests.cases.map(test =>
    `${require('../../src/services/scoring/executionHarness').PROTOCOL.result_tag} ${JSON.stringify({ id: test.id, passed: true })}`
  ).join('\n') }), describe: () => ({ mode: 'synthetic_known_execution' })
}) }));

const { scoreResponse } = require('../../src/services/qualityScorer');
const { calibrationPrompt } = require('../../src/services/benchmark/judgeCalibration');
const { DECOMPOSED_QUESTIONS } = require('../../src/services/decomposedJudgeQuestions');
const set = require('../../data/judge-calibration-set.json');
const oracle = require('../fixtures/calibrationPartialOracle');
const mockFetch = require('node-fetch');
let mockCase;

function answerFor(body, fixture) {
  const text = body.prompt;
  if (text.includes('completely empty, with no characters at all?')) return false;
  if (text.includes('contain at least one character?')) return true;
  if (text.includes('Is the response written in the language')) return true;
  if (body.callerDetail === 'benchmark-ref-overall') return fixture.similarity;
  if (body.callerDetail === 'benchmark-ref-contradictions') return fixture.contradictions;
  for (const [index, criterion] of mockCase.judge_criteria.entries()) {
    if (text.includes(`KEY POINT: ${criterion}\n`) || text.includes(`specific criterion: "${criterion}"?`)) return fixture.criteria[index];
  }
  for (const [dimension, questions] of Object.entries(DECOMPOSED_QUESTIONS[mockCase.category])) {
    for (const [index, question] of questions.entries()) {
      if (text.includes(question.q)) return fixture.dimensions?.[dimension]?.[index];
    }
  }
  throw new Error(`No independently authored verdict for ${body.callerDetail}`);
}

describe('partial calibration answers through scoreResponse with an independently authored judge', () => {
  test.each(Object.entries(oracle))('%s preserves earned credit without changing caps or language gates', async (id, fixture) => {
    mockCase = set.find(item => item.id === id);
    mockFetch.mockImplementation(async (_url, options) => {
      const verdict = answerFor(JSON.parse(options.body), fixture);
      if (verdict === undefined) throw new Error('Missing oracle verdict');
      return { ok: true, status: 200, json: async () => ({ done: true, done_reason: 'stop',
        response: verdict === true ? 'YES' : verdict === false ? 'NO' : verdict }) };
    });
    const result = await scoreResponse({ response: mockCase.response, prompt: calibrationPrompt(mockCase),
      judgeConfig: { model: 'synthetic-judge', host: 'http://judge:11434', max_retries: 0, voting_count: 1 } });
    expect(result.quality_score).not.toBeNull();
    expect(result.quality_score).toBe(fixture.expectedScore);
    if (id !== 'cal-tr-02') expect(Math.abs(result.quality_score - mockCase.gold_score)).toBeLessThanOrEqual(1);
    expect(result.scoring_method).toBe(mockCase.reference_answer ? 'reference' : 'decomposed');
    if (result.gates) expect(result.gates.every(gate => gate.answer === true)).toBe(true);
  });
  test('the omitted deadline exposes reference anchor ambiguity rather than pipeline undercredit', async () => {
    mockCase = set.find(item => item.id === 'cal-tr-02');
    mockFetch.mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      const verdict = answerFor(body, { ...oracle['cal-tr-02'], similarity: 'PARTIAL' });
      return { ok: true, status: 200, json: async () => ({ done: true, done_reason: 'stop',
        response: verdict === true ? 'YES' : verdict === false ? 'NO' : verdict }) };
    });
    const result = await scoreResponse({ response: mockCase.response, prompt: calibrationPrompt(mockCase),
      judgeConfig: { model: 'synthetic-judge', host: 'http://judge:11434', max_retries: 0, voting_count: 1 } });
    expect(result.quality_score).toBe(5.8);
    expect(result.breakdown.coverage_percent).toBe(75);
    expect(result.breakdown.has_contradictions).toBe(false);
    expect(result.gates[0].answer).toBe(true);
  });
});
