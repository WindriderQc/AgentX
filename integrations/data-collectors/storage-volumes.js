'use strict';

/**
 * Measures the filesystem that holds each configured storage source.
 *
 * statfs reports what the kernel sees for that mount. On ZFS this is the
 * dataset's used + available space, not the pool size, so the mount source
 * and filesystem type travel with every measurement.
 */

const fsp = require('fs/promises');

const MOUNTINFO_PATH = '/proc/self/mountinfo';

// mountinfo escapes space, tab, newline and backslash as octal.
function unescapeMountField(value) {
  return String(value || '').replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function parseMountinfo(text) {
  return String(text || '').split('\n').map(line => {
    const separator = line.indexOf(' - ');
    if (separator < 0) return null;
    const left = line.slice(0, separator).split(' ');
    const right = line.slice(separator + 3).split(' ');
    if (left.length < 5 || right.length < 2) return null;
    return {
      device: left[2],
      mountPoint: unescapeMountField(left[4]),
      fsType: right[0],
      source: unescapeMountField(right[1])
    };
  }).filter(Boolean);
}

function isWithin(mountPoint, target) {
  if (mountPoint === '/') return target.startsWith('/');
  return target === mountPoint || target.startsWith(`${mountPoint}/`);
}

// The deepest mount of that device containing the path; bind mounts share a device.
function findMount(mounts, realPath, device) {
  return mounts
    .filter(mount => (!device || mount.device === device) && isWithin(mount.mountPoint, realPath))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0] || null;
}

function deviceId(dev) {
  const value = Number(dev);
  if (!Number.isFinite(value)) return null;
  // glibc makedev layout, matching the major:minor column of mountinfo.
  return `${Math.floor(value / 256) % 4096}:${(value % 256) + Math.floor(value / 1048576) * 256}`;
}

async function readMounts(readFile = fsp.readFile) {
  try { return parseMountinfo(await readFile(MOUNTINFO_PATH, 'utf8')); }
  catch (_) { return []; }
}

async function measureSourceVolume(sourceId, config = {}, dependencies = {}) {
  const fs = dependencies.fs || fsp;
  const mounts = dependencies.mounts || [];
  const hostPath = String(config.hostPath || '');
  const measuredAt = (dependencies.now ? dependencies.now() : new Date()).toISOString();
  try {
    const realPath = await fs.realpath(hostPath);
    const [stats, fsStats] = await Promise.all([fs.stat(realPath), fs.statfs(realPath)]);
    const device = deviceId(stats.dev);
    const mount = findMount(mounts, realPath, device) || findMount(mounts, realPath, null);
    const blockSize = Number(fsStats.bsize);
    return {
      source: sourceId,
      root: String(config.canonicalRoot || ''),
      hostPath,
      capacityBytes: Number(fsStats.blocks) * blockSize,
      freeBytes: Number(fsStats.bavail) * blockSize,
      device,
      mountSource: mount?.source || null,
      mountPoint: mount?.mountPoint || null,
      fsType: mount?.fsType || null,
      method: 'statfs',
      measuredAt
    };
  } catch (error) {
    return { source: sourceId, root: String(config.canonicalRoot || ''), hostPath, error: error.message, measuredAt };
  }
}

async function measureSourceVolumes(sources = {}, dependencies = {}) {
  const mounts = dependencies.mounts || await readMounts(dependencies.readFile);
  return Promise.all(Object.entries(sources)
    .filter(([, config]) => config && config.hostPath)
    .map(([sourceId, config]) => measureSourceVolume(sourceId, config, { ...dependencies, mounts })));
}

module.exports = {
  parseMountinfo,
  findMount,
  deviceId,
  measureSourceVolume,
  measureSourceVolumes
};
