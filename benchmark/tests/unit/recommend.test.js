jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const { buildRecommendations } = require('../../routes/benchmark/recommend');

describe('Recommend API', () => {
    it('should rank models by quality score', () => {
        const results = [
            { model: 'qwen3:14b', host: '192.0.2.12', avg_quality: 8.4, count: 24 },
            { model: 'qwen2.5:7b', host: '192.0.2.99', avg_quality: 7.1, count: 8 }
        ];
        const recs = buildRecommendations(results);
        expect(recs).toHaveLength(2);
        expect(recs[0].model).toBe('qwen3:14b');
        expect(recs[0].quality_score).toBe(8.4);
    });

    it('reports every row as a low-confidence observation', () => {
        const recs = buildRecommendations([
            { model: 'a', host: 'h', avg_quality: 8.0, count: 15, judge_model: 'calibrated-judge' },
            { model: 'b', host: 'h', avg_quality: 7.0, count: 50, judge_model: 'calibrated-judge' }
        ]);
        for (const row of recs) {
            expect(row).toMatchObject({
                confidence: 'low',
                confidence_basis: 'unqualified_observation',
                evidence_level: 'observation'
            });
            expect(row).not.toHaveProperty('qualified');
        }
    });
});
