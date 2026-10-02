'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({ error: jest.fn() }));
jest.mock('../../src/services/benchmark', () => ({
    getEfficiencyMap: jest.fn()
}));

const benchmarkService = require('../../src/services/benchmark');
const efficiencyRouter = require('../../routes/benchmark/efficiency');

function buildApp() {
    const app = express();
    app.use('/api/benchmark', efficiencyRouter);
    return app;
}

describe('Efficiency Map route', () => {
    it('returns the efficiency map entries as measured observations', async () => {
        benchmarkService.getEfficiencyMap.mockResolvedValue({
            entries: [{
                model: 'model-a',
                host: 'http://host-a:11434',
                efficiencyScore: 71,
                avgQuality: 8,
                avgTokPerSec: 40
            }],
            unranked: []
        });

        const response = await request(buildApp())
            .get('/api/benchmark/efficiency-map')
            .expect(200);

        expect(response.body.data.entries).toEqual([expect.objectContaining({
            model: 'model-a',
            efficiencyScore: 71
        })]);
        expect(response.body.data.unranked).toEqual([]);
        expect(response.body.data).not.toHaveProperty('trustVerdict');
    });
});
