/**
 * Prompts API Integration Tests
 * Tests for prompt CRUD and A/B testing endpoints
 */

const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../src/app');
const PromptConfig = require('../../models/PromptConfig');
const { createMockMongoDocument } = require('../helpers/testUtils');

describe('Prompts API', () => {
    let testPrompt;

    beforeAll(async () => {
        // Clear test data
        await PromptConfig.deleteMany({ name: { $regex: /^test_/ } });
    });

    afterAll(async () => {
        await PromptConfig.deleteMany({ name: { $regex: /^test_/ } });
    });

    describe('POST /api/prompts', () => {
        it('should create a new prompt', async () => {
            const promptData = {
                name: 'test_prompt_1',
                systemPrompt: 'You are a helpful assistant for testing.',
                version: 'v1'
            };

            const res = await request(app)
                .post('/api/prompts')
                .send(promptData)
                .expect(201);

            expect(res.body.success).toBe(true);
            expect(res.body.prompt.name).toBe('test_prompt_1');
            expect(res.body.prompt.version).toBe('v1');
            
            testPrompt = res.body.prompt;
        });

        it('should reject duplicate name+version combo', async () => {
            const promptData = {
                name: 'test_prompt_1',
                systemPrompt: 'Duplicate',
                version: 'v1'
            };

            const res = await request(app)
                .post('/api/prompts')
                .send(promptData)
                .expect(400);

            expect(res.body.error).toBeDefined();
        });

        it('should allow same name with different version', async () => {
            const promptData = {
                name: 'test_prompt_1',
                systemPrompt: 'Version 2 prompt',
                version: 'v2'
            };

            const res = await request(app)
                .post('/api/prompts')
                .send(promptData)
                .expect(201);

            expect(res.body.prompt.version).toBe('v2');
        });
    });

    describe('GET /api/prompts', () => {
        it('should list all prompts', async () => {
            const res = await request(app)
                .get('/api/prompts')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.prompts)).toBe(true);
            expect(res.body.prompts.length).toBeGreaterThan(0);
        });
    });

    describe('GET /api/prompts/:name', () => {
        it('should get prompt by name', async () => {
            const res = await request(app)
                .get('/api/prompts/test_prompt_1')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.prompt.name).toBe('test_prompt_1');
        });

        it('should return 404 for non-existent prompt', async () => {
            const res = await request(app)
                .get('/api/prompts/non_existent_prompt')
                .expect(404);

            expect(res.body.error).toBeDefined();
        });
    });

    describe('PUT /api/prompts/:id', () => {
        it('should update prompt', async () => {
            const res = await request(app)
                .put(`/api/prompts/${testPrompt._id}`)
                .send({ systemPrompt: 'Updated system prompt' })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.prompt.systemPrompt).toBe('Updated system prompt');
        });

        it('should return 404 for invalid ID', async () => {
            const fakeId = new mongoose.Types.ObjectId();
            const res = await request(app)
                .put(`/api/prompts/${fakeId}`)
                .send({ systemPrompt: 'Test' })
                .expect(404);

            expect(res.body.error).toBeDefined();
        });
    });

    describe('POST /api/prompts/:name/ab-test', () => {
        beforeAll(async () => {
            // Create test prompts with versions
            await PromptConfig.create({
                name: 'test_ab_prompt',
                systemPrompt: 'Control version',
                version: 'control',
                trafficWeight: 100,
                isActive: true
            });
            await PromptConfig.create({
                name: 'test_ab_prompt',
                systemPrompt: 'Variant A',
                version: 'variant_a',
                trafficWeight: 0,
                isActive: true
            });
        });

        afterAll(async () => {
            await PromptConfig.deleteMany({ name: 'test_ab_prompt' });
        });

        it('should configure A/B test weights', async () => {
            const res = await request(app)
                .post('/api/prompts/test_ab_prompt/ab-test')
                .send({
                    versions: [
                        { version: 'control', weight: 50 },
                        { version: 'variant_a', weight: 50 }
                    ]
                })
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.updated).toBe(2);
        });

        it('should reject weights not summing to 100', async () => {
            const res = await request(app)
                .post('/api/prompts/test_ab_prompt/ab-test')
                .send({
                    versions: [
                        { version: 'control', weight: 30 },
                        { version: 'variant_a', weight: 30 }
                    ]
                })
                .expect(400);

            expect(res.body.error).toContain('100');
        });
    });

    describe('DELETE /api/prompts/:id', () => {
        it('should delete prompt', async () => {
            // Create prompt to delete
            const prompt = await PromptConfig.create({
                name: 'test_delete_prompt',
                systemPrompt: 'To be deleted',
                version: 'v1'
            });

            const res = await request(app)
                .delete(`/api/prompts/${prompt._id}`)
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.message).toContain('deleted');
        });
    });
});

describe('PromptConfig Model', () => {
    describe('getActive with weighted selection', () => {
        beforeAll(async () => {
            await PromptConfig.deleteMany({ name: 'test_weighted' });
            await PromptConfig.create([
                { name: 'test_weighted', systemPrompt: 'A', version: 'a', trafficWeight: 70, isActive: true },
                { name: 'test_weighted', systemPrompt: 'B', version: 'b', trafficWeight: 30, isActive: true }
            ]);
        });

        afterAll(async () => {
            await PromptConfig.deleteMany({ name: 'test_weighted' });
        });

        it('should return a prompt based on weights', async () => {
            const result = await PromptConfig.getActive('test_weighted');
            expect(result).toBeDefined();
            expect(['a', 'b']).toContain(result.version);
        });

        it('should respect weight distribution over many calls', async () => {
            const counts = { a: 0, b: 0 };
            const iterations = 100;

            for (let i = 0; i < iterations; i++) {
                const result = await PromptConfig.getActive('test_weighted');
                counts[result.version]++;
            }

            // A should be selected roughly 70% of the time (allow 15% variance)
            const aRatio = counts.a / iterations;
            expect(aRatio).toBeGreaterThan(0.55);
            expect(aRatio).toBeLessThan(0.85);
        });
    });

    describe('recordFeedback', () => {
        let testPrompt;

        beforeAll(async () => {
            testPrompt = await PromptConfig.create({
                name: 'test_feedback_prompt',
                systemPrompt: 'Feedback test',
                version: 'v1',
                stats: { impressions: 0, positiveCount: 0, negativeCount: 0 }
            });
        });

        afterAll(async () => {
            await PromptConfig.deleteMany({ name: 'test_feedback_prompt' });
        });

        it('should increment positive feedback', async () => {
            await PromptConfig.recordFeedback(testPrompt._id, 'positive');
            
            const updated = await PromptConfig.findById(testPrompt._id);
            expect(updated.stats.positiveCount).toBe(1);
        });

        it('should increment negative feedback', async () => {
            await PromptConfig.recordFeedback(testPrompt._id, 'negative');
            
            const updated = await PromptConfig.findById(testPrompt._id);
            expect(updated.stats.negativeCount).toBe(1);
        });
    });
});
