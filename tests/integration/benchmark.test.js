/**
 * Benchmark Integration Tests
 * Tests for benchmark routes and service layer
 */

const request = require('supertest');
const mongoose = require('mongoose');

// Mock workspace middleware to bypass context/auth checks
jest.mock('../../src/middleware/workspace', () => ({
    attachWorkspace: (req, res, next) => {
        req.workspace = { 
            _id: '507f1f77bcf86cd799439011', 
            slug: 'test-workspace',
            name: 'Test Workspace'
        };
        next();
    },
    requireWorkspaceAccess: (req, res, next) => next(),
    optionalWorkspaceContext: (req, res, next) => {
        req.workspace = { 
            _id: '507f1f77bcf86cd799439011', 
            slug: 'test-workspace'
        };
        next();
    },
    requireAdmin: (req, res, next) => next(),
    requireOwner: (req, res, next) => next(),
    requirePermission: () => (req, res, next) => next()
}));

const { app } = require('../../src/app');

const BenchmarkPrompt = require('../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkBatch = require('../../models/BenchmarkBatch');

afterEach(async () => {
    // Clear all collections between tests
    try {
        await BenchmarkPrompt.deleteMany({});
        await BenchmarkResult.deleteMany({});
        await BenchmarkBatch.deleteMany({});
    } catch (err) {
        // Ignore cleanup errors during tests
    }
});

describe('Benchmark System - Integration Tests', () => {
    describe('POST /api/benchmark/test', () => {
        it('should validate required fields', async () => {
            const response = await request(app)
                .post('/api/benchmark/test')
                .send({ model: 'test-model' }); // Missing host and prompt

            expect(response.status).toBe(400);
            expect(response.body.status).toBe('error');
            expect(response.body.error).toContain('required');
        });
    });

    describe('GET /api/benchmark/prompts', () => {
        it('should return prompts (seeding from JSON if empty)', async () => {
            const response = await request(app).get('/api/benchmark/prompts');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(Array.isArray(response.body.data.prompts)).toBe(true);
            expect(response.body.data.total).toBeGreaterThanOrEqual(0);
        });

        it('should seed prompts from JSON file if collection is empty', async () => {
            const response = await request(app).get('/api/benchmark/prompts');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');

            // Verify prompts were seeded
            const count = await BenchmarkPrompt.countDocuments();
            expect(count).toBeGreaterThan(0);
        });

        it('should return prompts grouped by level', async () => {
            // Create test prompts
            await BenchmarkPrompt.create([
                {
                    name: 'Test Prompt 1',
                    prompt: 'What is 2+2?',
                    level: 1,
                    category: 'math'
                },
                {
                    name: 'Test Prompt 2',
                    prompt: 'Explain quantum computing',
                    level: 3,
                    category: 'reasoning'
                }
            ]);

            const response = await request(app).get('/api/benchmark/prompts');

            expect(response.status).toBe(200);
            expect(response.body.data.prompts).toHaveLength(2);
            expect(response.body.data.by_level).toHaveProperty('1');
            expect(response.body.data.by_level).toHaveProperty('3');
            expect(response.body.data.by_level['1']).toHaveLength(1);
            expect(response.body.data.by_level['3']).toHaveLength(1);
        });
    });

    describe('GET /api/benchmark/results', () => {
        it('should return paginated results', async () => {
            // Create test results
            await BenchmarkResult.create([
                {
                    model: 'test-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test prompt',
                    latency: 1000,
                    tokens: 100,
                    success: true
                },
                {
                    model: 'test-model-2',
                    host: 'http://localhost:11434',
                    prompt: 'Test prompt 2',
                    latency: 2000,
                    tokens: 200,
                    success: true
                }
            ]);

            const response = await request(app).get('/api/benchmark/results?limit=10');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.results).toHaveLength(2);
            expect(response.body.data.total).toBe(2);
        });

        it('should respect limit parameter', async () => {
            // Create 5 results
            const results = [];
            for (let i = 0; i < 5; i++) {
                results.push({
                    model: `model-${i}`,
                    host: 'http://localhost:11434',
                    prompt: `Prompt ${i}`,
                    latency: 1000 + i * 100,
                    tokens: 100,
                    success: true
                });
            }
            await BenchmarkResult.create(results);

            const response = await request(app).get('/api/benchmark/results?limit=3');

            expect(response.status).toBe(200);
            expect(response.body.data.results).toHaveLength(3);
            expect(response.body.data.total).toBe(5);
        });
    });

    describe('GET /api/benchmark/summary', () => {
        it('should return empty summary when no results exist', async () => {
            const response = await request(app).get('/api/benchmark/summary');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.total_tests).toBe(0);
            expect(response.body.data.leaderboard).toEqual([]);
        });

        it('should calculate correct statistics', async () => {
            // Create test results
            await BenchmarkResult.create([
                {
                    model: 'model-a',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 1000,
                    tokens: 100,
                    tokens_per_sec: 100,
                    success: true
                },
                {
                    model: 'model-a',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 2000,
                    tokens: 200,
                    tokens_per_sec: 100,
                    success: true
                },
                {
                    model: 'model-b',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 1500,
                    tokens: 150,
                    tokens_per_sec: 100,
                    success: false
                }
            ]);

            const response = await request(app).get('/api/benchmark/summary');

            expect(response.status).toBe(200);
            expect(response.body.data.total_tests).toBe(3);
            expect(response.body.data.successful).toBe(2);
            expect(response.body.data.failed).toBe(1);
            expect(response.body.data.leaderboard).toHaveLength(1); // Only successful model-a
            expect(response.body.data.leaderboard[0].model).toBe('model-a');
            expect(response.body.data.leaderboard[0].avg_latency).toBe(1500);
        });
    });

    describe('GET /api/benchmark/dashboard', () => {
        it('should return dashboard statistics', async () => {
            await BenchmarkResult.create({
                model: 'test-model',
                host: 'http://localhost:11434',
                prompt: 'Test',
                latency: 1000,
                tokens: 100,
                tokens_per_sec: 100,
                success: true
            });

            const response = await request(app).get('/api/benchmark/dashboard');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.overview).toHaveProperty('total_tests');
            expect(response.body.data.overview).toHaveProperty('successful');
            expect(response.body.data.overview).toHaveProperty('success_rate');
            expect(response.body.data.model_stats).toBeInstanceOf(Array);
            
            // Verify recent tests are included
            expect(response.body.data.recent_tests).toBeInstanceOf(Array);
            expect(response.body.data.recent_tests).toHaveLength(1);
            expect(response.body.data.recent_tests[0].model).toBe('test-model');
        });

        it('should sort results by specified criteria', async () => {
            await BenchmarkResult.create([
                {
                    model: 'fast-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 500,
                    tokens: 100,
                    tokens_per_sec: 200,
                    success: true
                },
                {
                    model: 'slow-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 2000,
                    tokens: 100,
                    tokens_per_sec: 50,
                    success: true
                }
            ]);

            const responseLatency = await request(app).get('/api/benchmark/dashboard?sort=latency');
            expect(responseLatency.body.data.model_stats[0].model).toBe('fast-model');

            const responseSpeed = await request(app).get('/api/benchmark/dashboard?sort=speed');
            expect(responseSpeed.body.data.model_stats[0].model).toBe('fast-model');
        });
    });

    describe('GET /api/benchmark/judge-breakdown', () => {
        it('should require judge_model', async () => {
            const response = await request(app).get('/api/benchmark/judge-breakdown');
            expect(response.status).toBe(400);
            expect(response.body.status).toBe('error');
            expect(response.body.error).toContain('judge_model');
        });

        it('should break down judge latency by prompt level', async () => {
            await BenchmarkResult.create([
                {
                    model: 'small-model',
                    host: 'http://localhost:11434',
                    prompt: 'P1',
                    prompt_level: 1,
                    tokens: 50,
                    success: true,
                    judge_model: 'judge-a',
                    judge_host: 'http://localhost:11435',
                    scoring_method: 'reasoning',
                    scoring_time_ms: 1000,
                    quality_score: 7.5
                },
                {
                    model: 'big-model',
                    host: 'http://localhost:11434',
                    prompt: 'P2',
                    prompt_level: 3,
                    tokens: 200,
                    success: true,
                    judge_model: 'judge-a',
                    judge_host: 'http://localhost:11435',
                    scoring_method: 'reasoning',
                    scoring_time_ms: 2000,
                    quality_score: 6.0
                },
                {
                    model: 'big-model',
                    host: 'http://localhost:11434',
                    prompt: 'P3',
                    prompt_level: 3,
                    tokens: 220,
                    success: true,
                    judge_model: 'judge-a',
                    judge_host: 'http://localhost:11435',
                    scoring_method: 'llm_failed',
                    scoring_time_ms: 2500,
                    quality_score: null
                }
            ]);

            const response = await request(app).get('/api/benchmark/judge-breakdown')
                .query({ judge_model: 'judge-a', judge_host: 'http://localhost:11435', groupBy: 'level' });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.groupBy).toBe('level');
            expect(Array.isArray(response.body.data.groups)).toBe(true);

            const levels = response.body.data.groups.map(g => g.key);
            expect(levels).toEqual(expect.arrayContaining([1, 3]));
        });

        it('should break down judge latency by model-under-test (limited)', async () => {
            await BenchmarkResult.create([
                {
                    model: 'm1',
                    host: 'http://localhost:11434',
                    prompt: 'P1',
                    prompt_level: 1,
                    tokens: 10,
                    success: true,
                    judge_model: 'judge-b',
                    judge_host: null,
                    scoring_method: 'reasoning',
                    scoring_time_ms: 500,
                    quality_score: 8.0
                },
                {
                    model: 'm2',
                    host: 'http://localhost:11434',
                    prompt: 'P2',
                    prompt_level: 2,
                    tokens: 20,
                    success: true,
                    judge_model: 'judge-b',
                    judge_host: null,
                    scoring_method: 'reasoning',
                    scoring_time_ms: 700,
                    quality_score: 7.0
                }
            ]);

            const response = await request(app).get('/api/benchmark/judge-breakdown')
                .query({ judge_model: 'judge-b', groupBy: 'model', limit: 10 });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.groupBy).toBe('model');
            expect(response.body.data.limit).toBe(10);
            const keys = response.body.data.groups.map(g => g.key);
            expect(keys).toEqual(expect.arrayContaining(['m1', 'm2']));
        });
    });

    describe('GET /api/benchmark/compare', () => {
        it('should require models parameter', async () => {
            const response = await request(app).get('/api/benchmark/compare');

            expect(response.status).toBe(400);
            expect(response.body.status).toBe('error');
            expect(response.body.error).toContain('models');
        });

        it('should compare multiple models', async () => {
            await BenchmarkResult.create([
                {
                    model: 'model-a',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 1000,
                    tokens: 100,
                    tokens_per_sec: 100,
                    success: true
                },
                {
                    model: 'model-b',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 1500,
                    tokens: 150,
                    tokens_per_sec: 100,
                    success: true
                }
            ]);

            const response = await request(app)
                .get('/api/benchmark/compare?models=model-a,model-b');

            expect(response.status).toBe(200);
            expect(response.body.data.comparison).toHaveLength(2);
            expect(response.body.data.comparison[0].model).toBe('model-a');
            expect(response.body.data.comparison[1].model).toBe('model-b');
        });
    });

    describe('POST /api/benchmark/batch', () => {
        beforeEach(async () => {
            // Seed prompts for batch tests
            await BenchmarkPrompt.create([
                {
                    name: 'Simple Test',
                    prompt: 'What is 1+1?',
                    level: 1,
                    category: 'math'
                },
                {
                    name: 'Complex Test',
                    prompt: 'Explain relativity',
                    level: 3,
                    category: 'reasoning'
                }
            ]);
        });

        it('should validate required fields', async () => {
            const response = await request(app)
                .post('/api/benchmark/batch')
                .send({ host: 'http://localhost:11434' }); // Missing models and levels

            expect(response.status).toBe(400);
            expect(response.body.status).toBe('error');
            expect(response.body.error).toContain('required');
        });

        it('should create batch with valid inputs', async () => {
            const response = await request(app)
                .post('/api/benchmark/batch')
                .send({
                    host: 'http://localhost:11434',
                    models: ['test-model'],
                    levels: [1],
                    run_name: 'Test Batch',
                    quality_scoring: false
                });

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data).toHaveProperty('batch_id');
            expect(response.body.data.total_tests).toBe(1); // 1 model * 1 prompt (level 1)

            // Verify batch was created in database
            const batch = await BenchmarkBatch.findById(response.body.data.batch_id);
            expect(batch).toBeTruthy();
            expect(batch.status).toBe('running');
            expect(batch.models).toEqual(['test-model']);
        });

        it('should handle multiple models and levels', async () => {
            const response = await request(app)
                .post('/api/benchmark/batch')
                .send({
                    host: 'http://localhost:11434',
                    models: ['model-a', 'model-b'],
                    levels: [1, 3],
                    quality_scoring: false
                });

            expect(response.status).toBe(200);
            expect(response.body.data.total_tests).toBe(4); // 2 models * 2 prompts
        });
    });

    describe('GET /api/benchmark/batch/:id', () => {
        it('should return 404 for non-existent batch', async () => {
            const fakeId = new mongoose.Types.ObjectId();
            const response = await request(app).get(`/api/benchmark/batch/${fakeId}`);

            expect(response.status).toBe(404);
            expect(response.body.status).toBe('error');
        });

        it('should return batch details', async () => {
            const batch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['test-model'],
                levels: [1],
                run_name: 'Test Batch',
                total_tests: 5,
                status: 'completed',
                quality_scoring: false
            });

            const response = await request(app).get(`/api/benchmark/batch/${batch._id}`);

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.run_name).toBe('Test Batch');
            expect(response.body.data.status).toBe('completed');
            expect(response.body.data).toHaveProperty('progress');
            expect(response.body.data).toHaveProperty('success_rate');
        });
    });

    describe('GET /api/benchmark/batches', () => {
        it('should return empty list when no batches exist', async () => {
            const response = await request(app).get('/api/benchmark/batches');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            // Service returns { batches: [], total: 0 }
            expect(response.body.data.batches).toBeInstanceOf(Array);
            expect(response.body.data.batches).toHaveLength(0);
        });

        it('should return recent batches sorted by creation time', async () => {
            // Create batches with different timestamps
            const olderBatch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['model-1'],
                levels: [1],
                run_name: 'Older Batch',
                status: 'completed',
                total_tests: 1,
                created_at: new Date(Date.now() - 10000)
            });

            const newerBatch = await BenchmarkBatch.create({
                host: 'http://localhost:11434',
                models: ['model-2'],
                levels: [1],
                run_name: 'Newer Batch',
                status: 'running',
                total_tests: 1,
                created_at: new Date()
            });

            const response = await request(app).get('/api/benchmark/batches');

            expect(response.status).toBe(200);
            expect(response.body.data.batches).toHaveLength(2);
            // Should be sorted by created_at desc (newer first)
            expect(response.body.data.batches[0]._id.toString()).toBe(newerBatch._id.toString());
            expect(response.body.data.batches[1]._id.toString()).toBe(olderBatch._id.toString());
        });

        it('should respect limit parameter', async () => {
            // Create 5 batches
            const batches = [];
            for (let i = 0; i < 5; i++) {
                batches.push({
                    host: 'http://localhost:11434',
                    models: ['test-model'],
                    levels: [1],
                    run_name: `Batch ${i}`,
                    status: 'completed',
                    total_tests: 1
                });
            }
            await BenchmarkBatch.create(batches);

            const response = await request(app).get('/api/benchmark/batches?limit=3');

            expect(response.status).toBe(200);
            expect(response.body.data.batches).toHaveLength(3);
        });
    });

    describe('DELETE /api/benchmark/results', () => {
        it('should clear all results', async () => {
            // Create test results
            await BenchmarkResult.create([
                {
                    model: 'test-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    latency: 1000,
                    tokens: 100,
                    success: true
                },
                {
                    model: 'test-model-2',
                    host: 'http://localhost:11434',
                    prompt: 'Test 2',
                    latency: 2000,
                    tokens: 200,
                    success: true
                }
            ]);

            const response = await request(app).delete('/api/benchmark/results');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.message).toContain('Cleared 2 results');

            // Verify results were deleted
            const count = await BenchmarkResult.countDocuments();
            expect(count).toBe(0);
        });
    });

    describe('GET /api/benchmark/quality-breakdown', () => {
        it('should return quality breakdown by category and level', async () => {
            await BenchmarkResult.create([
                {
                    model: 'test-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test',
                    prompt_level: 1,
                    prompt_category: 'math',
                    latency: 1000,
                    tokens: 100,
                    quality_score: 85,
                    composite_score: 90,
                    success: true
                },
                {
                    model: 'test-model',
                    host: 'http://localhost:11434',
                    prompt: 'Test 2',
                    prompt_level: 2,
                    prompt_category: 'reasoning',
                    latency: 1500,
                    tokens: 150,
                    quality_score: 75,
                    composite_score: 80,
                    success: true
                }
            ]);

            const response = await request(app).get('/api/benchmark/quality-breakdown');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data).toHaveProperty('overall');
            expect(response.body.data).toHaveProperty('by_category');
            expect(response.body.data).toHaveProperty('by_level');
        });
    });
});
