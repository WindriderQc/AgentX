const { sanitizeVolumeReports, aggregateVolumes, MAX_REPORTS } = require('../../services/storageVolumes');

const TiB = 1024 ** 4;

function report(overrides = {}) {
  return {
    source: 'media',
    root: '/mnt/media',
    hostPath: '/pool/media',
    capacityBytes: 7 * TiB,
    freeBytes: 4 * TiB,
    device: '0:42',
    mountSource: 'pool/media',
    mountPoint: '/pool/media',
    fsType: 'zfs',
    method: 'statfs',
    measuredAt: new Date('2026-10-25T12:00:00.000Z'),
    ...overrides
  };
}

describe('storage volume reports', () => {
  test('keeps typed fields and falls back to the registry root', () => {
    const now = new Date('2026-10-25T13:00:00.000Z');
    const [kept] = sanitizeVolumeReports([{
      source: 'media', hostPath: '/pool/media', capacityBytes: 100, freeBytes: 40,
      device: '0:42', mountSource: 'pool/media', mountPoint: '/pool/media', fsType: 'zfs',
      method: 'statfs', measuredAt: 'not a date', extra: 'dropped'
    }], { media: { canonicalRoot: '/mnt/media' } }, now);
    expect(kept).toEqual({
      source: 'media', root: '/mnt/media', hostPath: '/pool/media', measuredAt: now,
      capacityBytes: 100, freeBytes: 40, device: '0:42', mountSource: 'pool/media',
      mountPoint: '/pool/media', fsType: 'zfs', method: 'statfs'
    });
  });

  test('a report without valid byte counts carries an error instead', () => {
    const reports = sanitizeVolumeReports([
      { source: 'media', error: 'ENOENT: no such file or directory' },
      { source: 'datalake', capacityBytes: -1, freeBytes: 0 },
      { source: 'other', capacityBytes: 10, freeBytes: 20 },
      null
    ]);
    expect(reports).toHaveLength(3);
    expect(reports.map(item => item.error)).toEqual([
      'ENOENT: no such file or directory', 'capacity not measured', 'capacity not measured'
    ]);
    expect(reports.every(item => item.capacityBytes === undefined)).toBe(true);
  });

  test('ignores a missing field and bounds the list', () => {
    expect(sanitizeVolumeReports(undefined)).toBeNull();
    const many = Array.from({ length: MAX_REPORTS + 5 }, () => ({ capacityBytes: 1, freeBytes: 1 }));
    expect(sanitizeVolumeReports(many)).toHaveLength(MAX_REPORTS);
  });
});

describe('storage volume aggregation', () => {
  test('two sources on one mount of one host yield one volume', () => {
    const volumes = aggregateVolumes([{
      scannerId: 'nas-storage', hostname: 'nas',
      volumes: [report(), report({ source: 'datalake', root: '/mnt/datalake', hostPath: '/pool/media/Datalake' })]
    }]);
    expect(volumes).toEqual([{
      id: 'nas:pool/media',
      label: 'pool/media',
      host: 'nas',
      roots: ['/mnt/datalake', '/mnt/media'],
      capacityBytes: 7 * TiB,
      freeBytes: 4 * TiB,
      source: 'measured',
      method: 'statfs',
      measuredAt: '2026-10-25T12:00:00.000Z',
      filesystem: { type: 'zfs', mountSource: 'pool/media', mountPoint: '/pool/media', device: '0:42' },
      scannerIds: ['nas-storage'],
      note: expect.stringContaining('not the pool size')
    }]);
  });

  test('distinct mounts and hosts stay apart; the newest measurement wins', () => {
    const volumes = aggregateVolumes([
      { scannerId: 'a', hostname: 'nas', volumes: [
        report({ freeBytes: 3 * TiB }),
        report({ source: 'photos', root: '/mnt/photos', device: '8:33', mountSource: '/dev/sdc1',
          mountPoint: '/', fsType: 'ext4', capacityBytes: 400, freeBytes: 60 })
      ] },
      { scannerId: 'b', hostname: 'nas', volumes: [
        report({ freeBytes: 2 * TiB, measuredAt: new Date('2026-10-25T12:30:00.000Z') })
      ] },
      { scannerId: 'c', hostname: 'other', volumes: [report()] }
    ]);
    expect(volumes.map(volume => volume.id)).toEqual(['nas:/dev/sdc1', 'nas:pool/media', 'other:pool/media']);
    const pool = volumes.find(volume => volume.id === 'nas:pool/media');
    expect(pool.freeBytes).toBe(2 * TiB);
    expect(pool.scannerIds).toEqual(['a', 'b']);
    expect(volumes[0].note).toBeUndefined();
  });

  test('older agents and failed measurements yield no volume; root filters', () => {
    const scanners = [
      { scannerId: 'old', hostname: 'nas', agentVersion: 'storage-1.4.1' },
      { scannerId: 'new', hostname: 'nas', volumes: [
        report(), { source: 'broken', root: '/mnt/broken', error: 'EACCES' }
      ] }
    ];
    expect(aggregateVolumes(scanners)).toHaveLength(1);
    expect(aggregateVolumes(scanners, { root: '/mnt/media/' })).toHaveLength(1);
    expect(aggregateVolumes(scanners, { root: '/mnt/datalake' })).toEqual([]);
    expect(aggregateVolumes([])).toEqual([]);
  });
});
