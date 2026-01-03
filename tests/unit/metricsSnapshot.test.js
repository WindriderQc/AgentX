/**
 * MetricsSnapshot model tests
 *
 * Current schema:
 * { timestamp, type, componentId, value, metadata }
 *
 * Current helpers:
 * - MetricsSnapshot.getLatest(componentId, type?)
 * - MetricsSnapshot.getSeries(filter, range)
 */

const mongoose = require('mongoose');
const MetricsSnapshot = require('../../models/MetricsSnapshot');

const componentId = 'agentx-main';

describe('MetricsSnapshot model', () => {
  beforeEach(async () => {
    await MetricsSnapshot.deleteMany({});
  });

  it('defines a TTL index on timestamp (90 days default)', async () => {
    const indexes = MetricsSnapshot.schema.indexes();
    const ttl = indexes.find(([fields, opts]) => fields.timestamp === 1 && opts && typeof opts.expireAfterSeconds === 'number');
    expect(ttl).toBeTruthy();
    expect(ttl[1].expireAfterSeconds).toBe(7776000);
  });

  it('stores snapshots and retrieves them via getLatest', async () => {
    const earlier = new Date('2024-01-01T00:00:00Z');
    const later = new Date('2024-01-01T01:00:00Z');

    await MetricsSnapshot.create({
      timestamp: earlier,
      type: 'health',
      componentId,
      value: 120,
      metadata: { source: 'health_check', unit: 'ms' }
    });

    await MetricsSnapshot.create({
      timestamp: later,
      type: 'health',
      componentId,
      value: 110,
      metadata: { source: 'health_check', unit: 'ms' }
    });

    const latest = await MetricsSnapshot.getLatest(componentId, 'health');
    expect(latest).toBeTruthy();
    expect(latest.timestamp.toISOString()).toBe(later.toISOString());
    expect(latest.value).toBe(110);
  });

  it('returns sorted series via getSeries', async () => {
    const base = new Date('2024-02-01T00:00:00Z');
    const docs = [
      { offset: 0, value: 200 },
      { offset: 10, value: 180 },
      { offset: 20, value: 160 }
    ].map(({ offset, value }) => ({
      timestamp: new Date(base.getTime() + offset * 60 * 1000),
      type: 'performance',
      componentId,
      value,
      metadata: { source: 'analytics_job', metricName: 'responseTime' }
    }));

    await MetricsSnapshot.insertMany(docs);

    const series = await MetricsSnapshot.getSeries(
      { componentId, type: 'performance', metadata: { metricName: 'responseTime' } },
      { from: base.toISOString(), to: new Date(base.getTime() + 30 * 60 * 1000).toISOString() }
    );

    expect(series).toHaveLength(3);
    expect(series[0].value).toBe(200);
    expect(series[1].value).toBe(180);
    expect(series[2].value).toBe(160);
    expect(new Date(series[0].timestamp).getTime()).toBeLessThanOrEqual(new Date(series[1].timestamp).getTime());
  });
});
