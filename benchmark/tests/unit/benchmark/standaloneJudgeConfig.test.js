'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { standaloneJudgeConfig } = require('../../../routes/benchmark/batches');

const FIRST = { host: 'http://judge-b:11434', model: 'gemma4:12b-it-qat' };
const STORED = { ...FIRST, target: { executionKind: 'ollama', ...FIRST }, temperature: 0.1 };

describe('standalone judge config', () => {
    test('drops the stored target of the batch first judge when another judge runs', () => {
        const config = standaloneJudgeConfig(STORED, { num_ctx: 65536 }, { host: 'http://judge-a:11434', model: 'qwen3.8:27b-mtp-q8_0' });
        expect(config).toEqual({ host: 'http://judge-a:11434', model: 'qwen3.8:27b-mtp-q8_0', temperature: 0.1, num_ctx: 65536 });
    });

    test('keeps the stored target when the same judge runs again', () => {
        expect(standaloneJudgeConfig(STORED, {}, FIRST).target).toEqual(STORED.target);
    });
});
