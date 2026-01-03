/**
 * MetricsSnapshot model tests
 * - Validates time-series collection creation and retention options
 * - Confirms static helpers for time-series and latest lookups
 */

const mongoose = require('mongoose');
const MetricsSnapshot = require('../../models/MetricsSnapshot');

const componentId = 'agentx-main';

describe('MetricsSnapshot model', () => {
  beforeEach(async () => {
    await MetricsSnapshot.deleteMany({});
  });

  it('creates a time-series collection with 90-day retention', async () => {
    const collections = await mongoose.connection.db
      .listCollections({ name: 'metricssnapshots' })
      .toArray();

    expect(collections.length).toBe(1);
    const collectionInfo = collections[0];

    expect(collectionInfo.options).toBeDefined();
    expect(collectionInfo.options.timeseries.timeField).toBe('timestamp');
    expect(collectionInfo.options.timeseries.metaField).toBe('metadata');
    expect(collectionInfo.options.expireAfterSeconds).toBe(7776000);
  });

  it('stores snapshots and retrieves them via getLatest', async () => {
    const earlier = new Date('2024-01-01T00:00:00Z');
    const later = new Date('2024-01-01T01:00:00Z');

    await MetricsSnapshot.create({
      timestamp: earlier,
      metadata: {
        source: 'health_check',
        componentType: 'agentx',
        componentId
      },
      health: { status: 'healthy', responseTime: 120 }
    });

    await MetricsSnapshot.create({
      timestamp: later,
      metadata: {
        source: 'health_check',
        componentType: 'agentx',
        componentId
      },
      health: { status: 'healthy', responseTime: 110 }
    });

    const latest = await MetricsSnapshot.getLatest(componentId);
    expect(latest).toBeTruthy();
    expect(latest.timestamp.toISOString()).toBe(later.toISOString());
    expect(latest.health.responseTime).toBe(110);
  });

  it('returns Chart.js-compatible time-series data', async () => {
    const base = new Date('2024-02-01T00:00:00Z');
    const docs = [
      { offset: 0, responseTime: 200 },
      { offset: 10, responseTime: 180 },
      { offset: 20, responseTime: 160 }
    ].map(({ offset, responseTime }) => ({
      timestamp: new Date(base.getTime() + offset * 60 * 1000),
      metadata: {
        source: 'analytics_job',
        componentType: 'agentx',
        componentId
      },
      health: { status: 'healthy', responseTime }
    }));

    await MetricsSnapshot.insertMany(docs);

    const series = await MetricsSnapshot.getTimeSeries(
      componentId,
      'health.responseTime',
      base,
      new Date(base.getTime() + 30 * 60 * 1000)
    );

    expect(series).toHaveLength(3);
    expect(series[0]).toEqual({ x: docs[0].timestamp, y: 200 });
    expect(series[1].y).toBe(180);
    expect(series[2].y).toBe(160);
    expect(series.every((point) => point.x instanceof Date)).toBe(true);
  });

  it('upserts snapshots for the same component and timestamp', async () => {
    const timestamp = new Date('2024-03-01T12:00:00Z');

    const initial = await MetricsSnapshot.upsertSnapshot({
      timestamp,
      metadata: {
        source: 'chat_completion',
        componentType: 'agentx',
        componentId
      },
      performance: { requestCount: 10, successCount: 9, failureCount: 1 }
    });

    expect(initial.performance.requestCount).toBe(10);

    const updated = await MetricsSnapshot.upsertSnapshot({
      timestamp,
      metadata: {
        source: 'chat_completion',
        componentType: 'agentx',
        componentId
      },
      performance: { requestCount: 12, successCount: 11, failureCount: 1 }
    });

    expect(await MetricsSnapshot.countDocuments({ 'metadata.componentId': componentId })).toBe(1);
    expect(updated.performance.requestCount).toBe(12);
  });
});
