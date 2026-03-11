/**
 * Benchmark preflight tests focused on reliability and judge exactitude.
 */

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../../models/BenchmarkPrompt', () => ({
    aggregate: jest.fn()
}));

jest.mock('../../../models/BenchmarkBatch', () => ({
    find: jest.fn()
}));

jest.mock('../../../models/ModelRegistry', () => ({
    findOne: jest.fn()
}));

jest.mock('../../../src/services/qualityScorer', () => ({
    JUDGE_CONFIG: {
        host: 'http://judge-host:11434',
        model: 'judge-model:latest'
    }
}));

jest.mock('../../../src/services/benchmark/http', () => ({
    benchmarkFetch: jest.fn()
}));

const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const ModelRegistry = require('../../../models/ModelRegistry');
const { benchmarkFetch } = require('../../../src/services/benchmark/http');
const {
    checkJudgeConfiguration,
    runPreflight
} = require('../../../src/services/benchmark/preflight');

function chainResolved(value) {
    return {
        select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(value)
        })
    };
}

function okJson(data) {
    return {
        ok: true,
        status: 200,
        json: async () => data
    };
}

describe('benchmark preflight', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        BenchmarkPrompt.aggregate.mockResolvedValue([
            { _id: 'refactoring', count: 4 },
            { _id: 'general', count: 5 }
        ]);
        BenchmarkBatch.find.mockReturnValue(chainResolved([]));
        benchmarkFetch.mockResolvedValue(okJson({
            models: [{ name: 'model-a:latest' }]
        }));
    });

    it('blocks judge configurations below the required tier', async () => {
        ModelRegistry.findOne.mockReturnValue(chainResolved({
            modelName: 'judge-model:latest',
            capabilities: {
                judgeTier: 'standard',
                judgeReliability: 0.93,
                avgJudgeLatencyMs: 2200
            }
        }));

        const result = await checkJudgeConfiguration(
            { host: 'http://judge-host:11434', model: 'judge-model:latest' },
            [8],
            { categories: { refactoring: { count: 4 } } }
        );

        expect(result.ok).toBe(false);
        expect(result.required_tier).toBe('advanced');
        expect(result.resolved_tier).toBe('standard');
        expect(result.blockers[0]).toMatch(/Judge 'judge-model.*' is tagged 'standard' tier/);
    });

    it('blocks judge configurations with poor reliability metadata', async () => {
        ModelRegistry.findOne.mockReturnValue(chainResolved({
            modelName: 'judge-model:latest',
            capabilities: {
                judgeTier: 'advanced',
                judgeReliability: 0.52,
                avgJudgeLatencyMs: 1800
            }
        }));

        const result = await checkJudgeConfiguration(
            { host: 'http://judge-host:11434', model: 'judge-model:latest' },
            [6],
            { categories: { reasoning: { count: 6 } } }
        );

        expect(result.ok).toBe(false);
        expect(result.blockers).toContain('Judge reliability 0.52 is below minimum 0.60');
    });

    it('aggregates host, judge, and orphaned-batch issues in runPreflight', async () => {
        BenchmarkBatch.find.mockReturnValue(chainResolved([
            {
                _id: 'batch-1',
                status: 'running',
                started_at: new Date('2026-03-07T12:00:00Z'),
                last_activity_at: new Date('2026-03-07T12:00:00Z')
            }
        ]));
        ModelRegistry.findOne.mockReturnValue(chainResolved({
            modelName: 'judge-model:latest',
            capabilities: {
                judgeTier: 'standard',
                judgeReliability: 0.95,
                avgJudgeLatencyMs: 2100
            }
        }));
        benchmarkFetch.mockResolvedValue(okJson({
            models: [{ name: 'different-model:latest' }]
        }));

        const result = await runPreflight({
            targets: [
                { host: 'http://exec-host:11434', model: 'model-a:latest' },
                { host: 'http://exec-host:11434', model: 'model-a:latest' }
            ],
            judgeConfig: {
                host: 'http://judge-host:11434',
                model: 'judge-model:latest'
            },
            levels: [8]
        });

        expect(result.ready).toBe(false);
        expect(result.issues).toEqual(expect.arrayContaining([
            '1 host(s) unreachable or missing models',
            expect.stringMatching(/Judge 'judge-model.*' is tagged 'standard' tier/),
            '1 orphaned batch(es) detected'
        ]));
        expect(benchmarkFetch).toHaveBeenCalledTimes(1);
    });
});
