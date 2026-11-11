const BenchmarkBatch = require('../../../models/BenchmarkBatch');

test('timing schema retains distinct hosts for the same model', () => {
    const batch = new BenchmarkBatch({ model_timings: [
        { model: 'same-tag', host: 'http://a.local' },
        { model: 'same-tag', host: 'http://b.local' }
    ] });
    expect(batch.model_timings.map(timing => timing.host)).toEqual(['http://a.local', 'http://b.local']);
});

test('historical model timings remain readable without inventing a host', () => {
    const batch = new BenchmarkBatch({ model_timings: [{ model: 'legacy', duration_ms: 10 }] });
    expect(batch.model_timings[0].host).toBeNull();
    expect(batch.model_timings[0].duration_ms).toBe(10);
});
