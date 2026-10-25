'use strict';

const {
  parseMountinfo, findMount, deviceId, measureSourceVolumes
} = require('../../../integrations/data-collectors/storage-volumes');

const MOUNTINFO = [
  '29 1 8:33 / / rw,relatime shared:1 - ext4 /dev/sdc1 rw',
  '92 29 0:37 / /pool rw,noatime shared:48 - zfs pool rw,xattr',
  '101 92 0:42 / /pool/media rw,noatime shared:54 - zfs pool/media rw,xattr',
  '120 29 0:42 / /mnt/media\\040share rw shared:54 - zfs pool/media rw',
  'malformed line'
].join('\n');

describe('native storage collector volume measurement', () => {
  test('parses mountinfo, including escaped mount points', () => {
    const mounts = parseMountinfo(MOUNTINFO);
    expect(mounts).toHaveLength(4);
    expect(mounts[3]).toEqual({ device: '0:42', mountPoint: '/mnt/media share', fsType: 'zfs', source: 'pool/media' });
  });

  test('picks the deepest mount of the path device', () => {
    const mounts = parseMountinfo(MOUNTINFO);
    expect(findMount(mounts, '/pool/media/Datalake', '0:42').mountPoint).toBe('/pool/media');
    expect(findMount(mounts, '/pool/mediaX', '0:37').mountPoint).toBe('/pool');
    expect(findMount(mounts, '/srv/data', '8:33').source).toBe('/dev/sdc1');
  });

  test('decodes st_dev as major:minor', () => {
    expect(deviceId(42)).toBe('0:42');
    expect(deviceId(8 * 256 + 33)).toBe('8:33');
    expect(deviceId(undefined)).toBeNull();
  });

  test('measures each source with statfs and names its filesystem', async () => {
    const fs = {
      realpath: jest.fn(async value => value),
      stat: jest.fn(async () => ({ dev: 42 })),
      statfs: jest.fn(async value => {
        if (value === '/missing') throw new Error('ENOENT: no such file or directory');
        return { bsize: 131072, blocks: 56311055, bavail: 37602784 };
      })
    };
    const volumes = await measureSourceVolumes({
      media: { hostPath: '/pool/media', canonicalRoot: '/mnt/media' },
      datalake: { hostPath: '/pool/media/Datalake', canonicalRoot: '/mnt/datalake' },
      gone: { hostPath: '/missing', canonicalRoot: '/mnt/gone' },
      unconfigured: { canonicalRoot: '/mnt/none' }
    }, { fs, mounts: parseMountinfo(MOUNTINFO), now: () => new Date('2026-10-25T12:00:00.000Z') });

    expect(volumes).toHaveLength(3);
    expect(volumes[0]).toEqual({
      source: 'media', root: '/mnt/media', hostPath: '/pool/media',
      capacityBytes: 56311055 * 131072, freeBytes: 37602784 * 131072,
      device: '0:42', mountSource: 'pool/media', mountPoint: '/pool/media', fsType: 'zfs',
      method: 'statfs', measuredAt: '2026-10-25T12:00:00.000Z'
    });
    expect(volumes[1]).toMatchObject({ device: '0:42', mountSource: 'pool/media', root: '/mnt/datalake' });
    expect(volumes[2]).toEqual({
      source: 'gone', root: '/mnt/gone', hostPath: '/missing',
      error: 'ENOENT: no such file or directory', measuredAt: '2026-10-25T12:00:00.000Z'
    });
  });

  test('an unreadable mount table still reports capacity', async () => {
    const fs = {
      realpath: async value => value,
      stat: async () => ({ dev: 42 }),
      statfs: async () => ({ bsize: 4096, blocks: 10, bavail: 4 })
    };
    const readFile = jest.fn().mockRejectedValue(new Error('EACCES'));
    const [volume] = await measureSourceVolumes({ media: { hostPath: '/data', canonicalRoot: '/mnt/media' } },
      { fs, readFile });
    expect(volume).toMatchObject({ capacityBytes: 40960, freeBytes: 16384, device: '0:42', mountSource: null });
  });
});
