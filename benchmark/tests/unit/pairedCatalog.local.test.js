'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { scoreByExecution } = require('../../src/services/scoring/executionScoring');
const { createCodeRunner } = require('../../src/services/scoring/codeRunnerClient');
const catalog = require('../../data/benchmark-prompts.json');
const solutions = require('../fixtures/pairedCatalogSolutions.json');
const describeLocal = process.env.BENCHMARK_DRIVER_SMOKE === '1' ? describe : describe.skip;

describeLocal('additional paired coding catalog fixtures', () => {
  test.each(Object.entries(solutions))('%s accepts a correct implementation and rejects a concrete defect', async (name, pair) => {
    const prompt = catalog.find(item => item.name === name);
    const runner = createCodeRunner({ mode: 'local' });
    const good = await scoreByExecution(pair.good, prompt, { runner });
    const bad = await scoreByExecution(pair.bad, prompt, { runner });
    expect(good.execution).toMatchObject({ status: 'passed', correctness: 10 });
    expect(bad.execution.correctness).toBeLessThan(10);
  });
});
