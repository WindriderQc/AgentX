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
        model: 'judge-model:latest',
        num_ctx: 8192
    }
}));

jest.mock('../../../src/services/benchmark/http', () => ({
    benchmarkFetch: jest.fn()
}));

jest.mock('../../../src/services/scoring/judgeRuntimeConfig', () => ({
    resolveEffectiveJudgeContext: jest.fn()
}));

const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const ModelRegistry = require('../../../models/ModelRegistry');
const { benchmarkFetch } = require('../../../src/services/benchmark/http');
const { resolveEffectiveJudgeContext } = require('../../../src/services/scoring/judgeRuntimeConfig');
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
            { _id: 'coding', count: 4 },
            { _id: 'knowledge', count: 5 }
        ]);
        BenchmarkBatch.find.mockReturnValue(chainResolved([]));
        benchmarkFetch.mockResolvedValue(okJson({
            models: [{ name: 'model-a:latest' }]
        }));
        resolveEffectiveJudgeContext.mockResolvedValue({
            num_ctx: 8192,
            source: 'execution_default',
            requested_num_ctx: null,
            resolved_num_ctx: 8192,
            resolved_source: 'execution_default',
            override_exceeds_resolved: false
        });
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
            [5],
            { categories: { coding: { count: 4 } } }
        );

        expect(result.ok).toBe(false);
        expect(result.required_tier).toBe('advanced');
        expect(result.resolved_tier).toBe('standard');
        expect(result.blockers[0]).toMatch(/Judge 'judge-model.*' is tagged 'standard' tier/);
    });

    it('falls back to inferred 14B tier when registry tier metadata is absent', async () => {
        ModelRegistry.findOne.mockReturnValue(chainResolved({
            modelName: 'qwen2.5:14b',
            capabilities: {
                judgeReliability: 0.93,
                avgJudgeLatencyMs: 2200,
                maxContext: 8192
            }
        }));

        const result = await checkJudgeConfiguration(
            { host: 'http://judge-host:11434', model: 'qwen2.5:14b' },
            [5],
            { categories: { coding: { count: 4 } } }
        );

        expect(result.ok).toBe(true);
        expect(result.required_tier).toBe('advanced');
        expect(result.resolved_tier).toBe('advanced');
        expect(result.blockers).toEqual([]);
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
            [4],
            { categories: { reasoning: { count: 6 } } }
        );

        expect(result.ok).toBe(false);
        expect(result.blockers).toContain('Judge reliability 0.52 is below minimum 0.60');
    });

    it('blocks judge configurations when context window is too small for the selected levels', async () => {
        ModelRegistry.findOne.mockReturnValue(chainResolved({
            modelName: 'judge-model:latest',
            capabilities: {
                judgeTier: 'advanced',
                judgeReliability: 0.93,
                avgJudgeLatencyMs: 1800,
                maxContext: 4096
            }
        }));
        resolveEffectiveJudgeContext.mockResolvedValue({
            num_ctx: 4096,
            source: 'execution_default',
            requested_num_ctx: null,
            resolved_num_ctx: 4096,
            resolved_source: 'execution_default',
            override_exceeds_resolved: false
        });

        const result = await checkJudgeConfiguration(
            { host: 'http://judge-host:11434', model: 'judge-model:latest' },
            [5],
            { categories: { coding: { count: 4 } } }
        );

        expect(result.ok).toBe(false);
        expect(result.available_context_window).toBe(4096);
        expect(result.estimated_judge_input_tokens).toBeGreaterThan(4096);
        expect(result.blockers[0]).toMatch(/only has ~4096 tokens of context/);
    });

    it('allows judge configurations when context window clears the estimated input size', async () => {
        ModelRegistry.findOne.mockReturnValue(chainResolved({
            modelName: 'judge-model:latest',
            capabilities: {
                judgeTier: 'advanced',
                judgeReliability: 0.93,
                avgJudgeLatencyMs: 1800,
                maxContext: 8192
            }
        }));
        resolveEffectiveJudgeContext.mockResolvedValue({
            num_ctx: 8192,
            source: 'execution_default',
            requested_num_ctx: null,
            resolved_num_ctx: 8192,
            resolved_source: 'execution_default',
            override_exceeds_resolved: false
        });

        const result = await checkJudgeConfiguration(
            { host: 'http://judge-host:11434', model: 'judge-model:latest' },
            [5],
            { categories: { coding: { count: 4 } } }
        );

        expect(result.ok).toBe(true);
        expect(result.blockers).toEqual([]);
        expect(result.available_context_window).toBe(8192);
    });

    it('blocks benchmark targets that are explicitly marked ineligible in the registry', async () => {
        ModelRegistry.findOne.mockImplementation((query) => {
            const modelNames = query?.modelName?.$in || [];

            if (modelNames.includes('blocked-model')) {
                return chainResolved({
                    modelName: 'blocked-model',
                    benchmarkEligibility: {
                        eligible: false,
                        blockedReason: 'Blocked for benchmark automation until tool compatibility is validated'
                    }
                });
            }

            return chainResolved({
                modelName: 'judge-model:latest',
                capabilities: {
                    judgeTier: 'advanced',
                    judgeReliability: 0.95,
                    avgJudgeLatencyMs: 2100,
                    maxContext: 8192
                }
            });
        });
        benchmarkFetch.mockResolvedValue(okJson({
            models: [{ name: 'blocked-model' }]
        }));

        const result = await runPreflight({
            targets: [
                { host: 'http://exec-host:11434', model: 'blocked-model' }
            ],
            judgeConfig: {
                host: 'http://judge-host:11434',
                model: 'judge-model:latest'
            },
            levels: [5]
        });

        expect(result.ready).toBe(false);
        expect(result.issues).toContain('Blocked for benchmark automation until tool compatibility is validated');
        expect(result.checks.hosts[0]).toMatchObject({
            host_ok: true,
            benchmark_eligible: false,
            benchmark_eligibility_source: 'registry',
            benchmark_blocked_reason: 'Blocked for benchmark automation until tool compatibility is validated'
        });
    });

    it('blocks known-incompatible benchmark targets even without registry metadata', async () => {
        ModelRegistry.findOne.mockImplementation((query) => {
            const modelNames = query?.modelName?.$in || [];

            if (modelNames.includes('judge-model')) {
                return chainResolved({
                    modelName: 'judge-model:latest',
                    capabilities: {
                        judgeTier: 'advanced',
                        judgeReliability: 0.95,
                        avgJudgeLatencyMs: 2100,
                        maxContext: 8192
                    }
                });
            }

            return chainResolved(null);
        });
        benchmarkFetch.mockResolvedValue(okJson({
            models: [{ name: 'deepcoder:14b-preview-q4_K_M' }]
        }));

        const result = await runPreflight({
            targets: [
                { host: 'http://exec-host:11434', model: 'deepcoder:14b-preview-q4_K_M' }
            ],
            judgeConfig: {
                host: 'http://judge-host:11434',
                model: 'judge-model:latest'
            },
            levels: [5]
        });

        expect(result.ready).toBe(false);
        expect(result.issues).toEqual(expect.arrayContaining([
            expect.stringMatching(/deepcoder:14b-preview-q4_k_m.*not approved for benchmark execution/i)
        ]));
        expect(result.checks.hosts[0]).toMatchObject({
            host_ok: true,
            benchmark_eligible: false,
            benchmark_eligibility_source: 'heuristic'
        });
    });

    it('allows an explicit judge num_ctx override above the proven value and warns about risk', async () => {
        ModelRegistry.findOne.mockReturnValue(chainResolved({
            modelName: 'judge-model:latest',
            capabilities: {
                judgeTier: 'advanced',
                judgeReliability: 0.93,
                avgJudgeLatencyMs: 1800,
                maxContext: 4096
            }
        }));
        resolveEffectiveJudgeContext.mockResolvedValue({
            num_ctx: 8192,
            source: 'explicit_override',
            requested_num_ctx: 8192,
            resolved_num_ctx: 4096,
            resolved_source: 'execution_default',
            override_exceeds_resolved: true
        });

        const result = await checkJudgeConfiguration(
            { host: 'http://judge-host:11434', model: 'judge-model:latest', num_ctx: 8192 },
            [5],
            { categories: { coding: { count: 4 } } }
        );

        expect(result.ok).toBe(true);
        expect(result.available_context_window).toBe(8192);
        expect(result.proven_context_window).toBe(4096);
        expect(result.context_window_source).toBe('explicit_override');
        expect(result.warnings).toEqual(expect.arrayContaining([
            expect.stringMatching(/override 8192 exceeds the proven\/registry value 4096/i)
        ]));
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
            levels: [5]
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
