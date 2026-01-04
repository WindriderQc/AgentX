const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { app } = require('../../src/app');
const BenchmarkBatch = require('../../models/BenchmarkBatch');

describe('Benchmark Routes Integration', () => {
    let mongoServer;

    beforeAll(async () => {
        mongoServer = await MongoMemoryServer.create();
        const mongoUri = mongoServer.getUri();
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
        await mongoose.connect(mongoUri);
    });

    afterAll(async () => {
        await mongoose.disconnect();
        await mongoServer.stop();
    });

    describe('GET /api/benchmark/config', () => {
        it('should return judge configuration', async () => {
            const res = await request(app).get('/api/benchmark/config');
            expect(res.statusCode).toBe(200);
            expect(res.body.status).toBe('success');
            expect(res.body.data.judge_config).toBeDefined();
        });
    });

    describe('POST /api/benchmark/batch', () => {
        it('should start a batch', async () => {
            const payload = {
                host: 'http://localhost:11434',
                models: ['llama3'],
                levels: [1],
                quality_scoring: false
            };

            const res = await request(app)
                .post('/api/benchmark/batch')
                .send(payload);

            expect(res.statusCode).toBe(200);
            expect(res.body.status).toBe('success');
            expect(res.body.data.batch_id).toBeDefined();

            // Verify db
            const batch = await BenchmarkBatch.findById(res.body.data.batch_id);
            expect(batch).toBeDefined();
            expect(batch.host).toBe('http://localhost:11434');
        });

        it('should reject invalid payload', async () => {
            const res = await request(app)
                .post('/api/benchmark/batch')
                .send({});

            expect(res.statusCode).toBe(400);
        });
    });
});
