'use strict';

const express = require('express');
const request = require('supertest');
const { MongoClient } = require('mongodb');
const { readStorageAssessment } = require('../../services/storageAssessment');

const URI = process.env.MONGODB_URI_TEST;
const BASE_DB = URI ? new URL(URI).pathname.slice(1) : '';
if (!URI || !BASE_DB.startsWith('agentx_data_test_')) throw new Error('Use the disposable Data test launcher.');
const NOW = new Date('2026-10-20T12:00:00Z');
const AT = new Date('2026-10-19T01:00:00Z');
const HASH = 'a'.repeat(64);

describe('stored storage assessment (synthetic Mongo evidence)', () => {
  let client, db, app;
  const original = process.env.STORAGE_AGENT_SOURCES;
  const file = (path, scan_id, extra = {}) => ({ path, scan_id, size: 100, mtime: 10,
    sha256: HASH, hash_fingerprint: '100:10', ...extra });
  const assess = () => readStorageAssessment(db, { now: NOW });

  beforeAll(async () => {
    client = await MongoClient.connect(URI);
    db = client.db(`${BASE_DB}_assessment`);
    app = express();
    app.locals.db = db;
    app.use('/storage', require('../../routes/storage.routes'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });
  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
    if (original === undefined) delete process.env.STORAGE_AGENT_SOURCES;
    else process.env.STORAGE_AGENT_SOURCES = original;
  });
  beforeEach(async () => {
    process.env.STORAGE_AGENT_SOURCES = JSON.stringify({
      photos: { canonicalRoot: '/mnt/photos', executionCapable: false },
      archive: { canonicalRoot: '/mnt/archive', executionCapable: false },
      missing: { canonicalRoot: '/mnt/missing', executionCapable: false }
    });
    for (const name of ['nas_scans', 'nas_files', 'storage_scanners']) await db.collection(name).deleteMany({});
    await db.collection('nas_scans').insertMany(['photos', 'archive'].map(source => ({
      _id: source, status: 'complete', started_at: new Date('2026-10-19T00:00:00Z'), finished_at: AT,
      config: { source, roots: [`/mnt/${source}`] }, counts: { errors: 0, files_seen: source === 'photos' ? 2 : 1 }
    })));
    await db.collection('storage_scanners').insertOne({ scannerId: 'synthetic', hostname: 'test-host',
      lastSeen: AT, sources: ['photos', 'archive'], volumes: [
        { source: 'photos', root: '/mnt/photos', device: '8:1', capacityBytes: 1000, freeBytes: 0, measuredAt: AT },
        { source: 'archive', root: '/mnt/archive', device: '8:2', capacityBytes: 1000, freeBytes: 400, measuredAt: AT },
        { source: 'removed', root: '/mnt/removed', device: '8:3', capacityBytes: 99999, freeBytes: 99999, measuredAt: AT }
      ] });
  });

  test('counts matches across sources, never same-source duplicates or unverified rows; makes no recommendation', async () => {
    await db.collection('nas_files').insertMany([
      file('/mnt/photos/a', 'photos'), file('/mnt/photos/b', 'photos'),
      file('/mnt/archive/c', 'archive'),
      file('/mnt/photos/outdated', 'photos', { hash_fingerprint: '100:9' }),
      file('/mnt/photos/unhashed', 'photos', { sha256: null }),
      file('/mnt/archive/invalid', 'archive', { sha256: 'malformed' }),
      file('/mnt/photos-prefix/outside', 'photos'),
      file('/mnt/unconfigured/outside', 'other')
    ]);
    await db.collection('nas_scans').updateOne({ _id: 'photos' }, { $set: { 'counts.files_seen': 4 } });
    await db.collection('nas_scans').updateOne({ _id: 'archive' }, { $set: { 'counts.files_seen': 2 } });
    const beforeRead = await db.collection('nas_scans').find({}).toArray();
    const result = await assess();
    const photos = result.sources.find(source => source.source === 'photos');
    expect(photos).toMatchObject({ coverage: 'complete_at_scan', indexed: { files: 4, bytes: 400 },
      lastScan: { observedAt: AT.toISOString(), acceptableFreshness: 'unknown' },
      copies: { observedHashedFiles: 2, observedFilesWithOtherSource: 2, unverifiedFiles: 2,
        currentCoverage: 'unknown', independentBackupCoverage: 'unknown' } });
    expect(result.sources.find(source => source.source === 'missing')).toMatchObject({
      coverage: 'unknown', lastScan: null, capacityObservation: 'unavailable'
    });
    expect(result.volumes).toHaveLength(2);
    const target = result.volumes.find(volume => volume.freeBytes === 400);
    expect(result.placement.compatibility.find(pair => pair.source === 'photos' && pair.volumeId === target.id))
      .toMatchObject({ observedCapacityFit: 'fits', suitability: 'unknown' });
    expect(result.placement).toMatchObject({ recommendation: null, status: 'withheld' });
    expect(result.coverage.wholeInstance).toBe('unknown');
    expect(await db.collection('nas_scans').find({}).toArray()).toEqual(beforeRead);
    expect(await db.listCollections().toArray()).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain(HASH);
    expect(JSON.stringify(result)).not.toContain('/mnt/photos/a');
  });

  test('same-source duplicates alone prove no copy in another configured source', async () => {
    await db.collection('nas_files').insertMany([file('/mnt/photos/a', 'photos'), file('/mnt/photos/b', 'photos')]);
    const result = await assess();
    expect(result.sources.find(source => source.source === 'photos').copies).toMatchObject({
      observedHashedFiles: 2, observedFilesWithOtherSource: 0, currentCoverage: 'unknown'
    });
    expect(result.placement.compatibility.find(pair => pair.source === 'photos' && pair.freeBytes === 0).observedCapacityFit).toBe('unknown');
  });

  test.each(['partial', 'failed', 'stopped', 'running', 'queued'])('a newer %s scan cannot prove source coverage or cross-source copies', async status => {
    await db.collection('nas_files').insertMany([file('/mnt/photos/a', 'photos'), file('/mnt/archive/c', 'archive')]);
    await db.collection('nas_scans').insertOne({ _id: 'newer', status,
      started_at: status === 'queued' ? null : NOW, requested_at: NOW, finished_at: NOW,
      config: { roots: ['/mnt/archive'] } });
    const result = await assess();
    expect(result.sources.find(source => source.source === 'archive').coverage).toBe('unknown');
    expect(result.sources.find(source => source.source === 'photos').copies.observedFilesWithOtherSource).toBe(0);
  });

  test('unstamped rows and filtered scans keep placement unknown', async () => {
    await db.collection('nas_files').insertMany([file('/mnt/photos/a', 'previous'), file('/mnt/archive/b', 'archive')]);
    await db.collection('nas_scans').updateOne({ _id: 'archive' }, { $set: { 'config.extensions': ['pdf'] } });
    const result = await assess();
    expect(result.sources.every(source => source.coverage === 'unknown')).toBe(true);
    expect(result.placement.compatibility.every(pair => pair.observedCapacityFit === 'unknown')).toBe(true);
    expect(result.sources.find(source => source.source === 'photos').copies.observedHashedFiles).toBe(0);
  });

  test.each(['/', '/mnt/photos', '/mnt/photos/child'])('an active legacy scan at %s also blocks complete-source claims', async root => {
    await db.collection('nas_files').insertMany([file('/mnt/photos/a', 'photos'), file('/mnt/photos/b', 'photos')]);
    await db.collection('nas_scans').insertOne({ _id: 'legacy', status: 'running', roots: [root], started_at: NOW });
    const result = await assess();
    expect(result.sources.find(source => source.source === 'photos')).toMatchObject({ coverage: 'unknown', reason: 'scan_in_progress' });
    expect(result.placement.compatibility.filter(pair => pair.source === 'photos').every(pair => pair.observedCapacityFit === 'unknown')).toBe(true);
  });

  test('overlapping roots fail closed without double counting the same file', async () => {
    process.env.STORAGE_AGENT_SOURCES = JSON.stringify({ photos: { canonicalRoot: '/mnt/photos' }, nested: { canonicalRoot: '/mnt/photos/child' } });
    await db.collection('nas_files').insertOne(file('/mnt/photos/child/a', 'photos'));
    const result = await assess();
    expect(result.sources.every(source => source.reason === 'invalid_or_overlapping_configured_roots')).toBe(true);
    expect(result.sources.every(source => source.indexed === null)).toBe(true);
  });

  test('capacity comparisons expose insufficient space, invalid dates and shared filesystems', async () => {
    await db.collection('nas_files').insertOne(file('/mnt/photos/a', 'photos', { size: 500, hash_fingerprint: '500:10' }));
    await db.collection('nas_scans').updateOne({ _id: 'photos' }, { $set: { 'counts.files_seen': 1 } });
    let result = await assess();
    expect(result.placement.compatibility.find(pair => pair.source === 'photos' && pair.freeBytes === 400).observedCapacityFit).toBe('insufficient');
    await db.collection('storage_scanners').updateOne({}, { $set: { 'volumes.1.device': '8:1' } });
    result = await assess();
    expect(result.volumes).toHaveLength(1);
    expect(result.placement.compatibility.find(pair => pair.source === 'photos').observedCapacityFit).toBe('unknown');
    await db.collection('storage_scanners').updateOne({}, { $set: { 'volumes.0.measuredAt': new Date('2030-01-01') } });
    result = await assess();
    expect(result.volumes[0].observation.observedAt).toBe(null);
  });

  test.each([0, 1, 2, null])('empty index with native file count %s never becomes a complete zero-byte source', async filesSeen => {
    await db.collection('nas_scans').updateOne({ _id: 'photos' }, { $set: { 'counts.files_seen': filesSeen } });
    const result = await assess();
    expect(result.sources.find(source => source.source === 'photos').coverage).toBe('unknown');
    expect(result.placement.compatibility.filter(pair => pair.source === 'photos')
      .every(pair => pair.observedCapacityFit === 'unknown')).toBe(true);
  });

  test('partially lost index and global multi-root counters cannot certify copies or a full-source fit', async () => {
    await db.collection('nas_files').insertMany([file('/mnt/photos/a', 'photos'), file('/mnt/archive/b', 'archive')]);
    let result = await assess();
    expect(result.sources.find(source => source.source === 'photos').coverage).toBe('unknown');
    expect(result.sources.find(source => source.source === 'archive').copies.observedFilesWithOtherSource).toBe(0);
    await db.collection('nas_scans').updateOne({ _id: 'archive' }, { $set: { 'config.roots': ['/mnt/archive', '/mnt/other'] } });
    result = await assess();
    expect(result.sources.find(source => source.source === 'archive').coverage).toBe('unknown');
  });

  test('bounded results count omitted sources and volumes; HTTP read rejects policy inputs', async () => {
    process.env.STORAGE_AGENT_SOURCES = JSON.stringify(Object.fromEntries(Array.from({ length: 34 }, (_, i) => [`s${i}`, { canonicalRoot: `/mnt/s${i}` }])));
    await db.collection('storage_scanners').updateOne({}, { $set: { volumes: Array.from({ length: 65 }, (_, i) => ({
      source: 's0', root: '/mnt/s0', device: `8:${i}`, capacityBytes: 1000, freeBytes: 100, measuredAt: AT
    })) } });
    const result = await assess();
    expect(result.sources).toHaveLength(32);
    expect(result.volumes).toHaveLength(64);
    expect(result.coverage).toMatchObject({ declaredSources: 34, omittedSources: 2, omittedVolumes: 1 });
    await request(app).get('/storage/assessment?maxAgeHours=24').expect(400);
    const response = await request(app).get('/storage/assessment').expect(200);
    expect(response.body.data.executionAuthorized).toBe(false);
    expect(response.body.data.placement.recommendation).toBe(null);
  });

  test.each([null, -1, 0.5, '100'])('invalid indexed size %s cannot certify a full-source fit', async size => {
    await db.collection('nas_files').insertOne(file('/mnt/photos/a', 'photos', { size }));
    await db.collection('nas_scans').updateOne({ _id: 'photos' }, { $set: { 'counts.files_seen': 1 } });
    const result = await assess();
    expect(result.sources.find(source => source.source === 'photos')).toMatchObject({ coverage: 'unknown', indexed: { bytes: null } });
    expect(result.placement.compatibility.filter(pair => pair.source === 'photos').every(pair => pair.observedCapacityFit === 'unknown')).toBe(true);
  });
});
