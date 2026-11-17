'use strict';
const nativeFs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fail } = require('./importFiles');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const within = (root, file) => file !== root && !path.relative(root, file).startsWith('..' + path.sep)
  && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file));
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || path.normalize(value) !== value)
    throw fail('PHOTO_RELOCATION_PATH', 'Expected a normalized absolute operator path');
  if (process.platform === 'win32' && (value.startsWith('\\\\') || value.slice(2).includes(':')))
    throw fail('PHOTO_RELOCATION_PATH', 'Device paths, network paths and alternate streams are unsupported');
  if (process.platform === 'win32') {
    const parts = value.slice(path.parse(value).root.length).split(path.sep).filter(Boolean);
    if (parts.some(part => /[<>"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
        || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))
      throw fail('PHOTO_RELOCATION_PATH', 'Windows reserved or ambiguous path component');
  }
  return value;
}
function exact(stat) {
  if (['dev','ino','size','mtimeNs','ctimeNs','nlink','mode'].some(key => typeof stat[key] !== 'bigint'))
    throw fail('PHOTO_RELOCATION_STAT_PRECISION','Exact bigint filesystem observations are required');
  return stat;
}
function same(a, b) { return ['dev','ino','size','mtimeNs','ctimeNs','nlink','mode'].every(key => a[key] === b[key]); }
function createPhotoRelocationInventory({ fs = nativeFs, platform = process.platform, inspectReparse } = {}) {
  async function checked(file, directory) {
    const parsed = path.parse(file);
    let current = parsed.root, result;
    for (const part of ['', ...file.slice(parsed.root.length).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      result = exact(await fs.lstat(current, { bigint: true }));
      if (result.isSymbolicLink()) throw fail('PHOTO_RELOCATION_LINK', 'Symbolic links and junctions are not permitted');
      if (platform === 'win32') {
        if (typeof inspectReparse !== 'function' || await inspectReparse(current) !== false)
          throw fail('PHOTO_RELOCATION_REPARSE_UNVERIFIED', 'Windows requires an explicit native non-reparse observation');
      }
      if (await fs.realpath(current) !== current) throw fail('PHOTO_RELOCATION_LINK', 'Real path differs from operator path');
      if (current !== file && !result.isDirectory()) throw fail('PHOTO_RELOCATION_PATH', 'A parent is not a directory');
    }
    if (directory ? !result.isDirectory() : !result.isFile()) throw fail('PHOTO_RELOCATION_TYPE', 'Unexpected file type');
    return result;
  }
  async function absent(file) {
    try { await fs.lstat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw fail('PHOTO_RELOCATION_COLLISION', 'Destination already exists, even if its bytes match');
  }
  async function inspectPair(input) {
    const sourceRoot = absolute(input?.sourceRoot), destinationRoot = absolute(input?.destinationRoot);
    const pairs = [input.image, input.xmp];
    for (const item of pairs) {
      if (!item || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
          || !Number.isSafeInteger(item.size) || item.size < 0)
        throw fail('PHOTO_RELOCATION_EXPECTATION', 'Both files require an expected SHA-256 and byte size');
      absolute(item.source); absolute(item.destination);
      if (!within(sourceRoot,item.source) || !within(destinationRoot,item.destination) || item.source === item.destination)
        throw fail('PHOTO_RELOCATION_SCOPE', 'File leaves its configured root or source equals destination');
    }
    if (input.xmp.destination !== input.image.destination + '.xmp')
      throw fail('PHOTO_RELOCATION_PAIR', 'The destination XMP must remain adjacent to its image');
    const roots = [await checked(sourceRoot,true), await checked(destinationRoot,true)];
    const results = [], observations = [];
    for (const item of pairs) {
      const before = await checked(item.source,false);
      if (item === input.xmp && (before.nlink !== 1n || (observations[0]
          && before.dev === observations[0].dev && before.ino === observations[0].ino)))
        throw fail('PHOTO_RELOCATION_SIDECAR_SHARED', 'Managed XMP must be an independent single-link file');
      const parent = await checked(path.dirname(item.destination),true);
      await absent(item.destination);
      if (before.dev !== parent.dev || before.dev !== roots[0].dev || parent.dev !== roots[1].dev)
        throw fail('PHOTO_RELOCATION_CROSS_DEVICE', 'Cross-device relocation is not supported');
      // importFiles.hashFile follows a reopened pathname. Hold one read handle
      // instead, compare its identity before reading and after, then recheck paths.
      const handle = await fs.open(item.source, 'r');
      let sha256, size = 0;
      try {
        if (!same(before,exact(await handle.stat({ bigint: true })))) throw fail('PHOTO_RELOCATION_CHANGED','File changed before reading');
        const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
        for (;;) { const read = await handle.read(buffer,0,buffer.length,null); if (!read.bytesRead) break;
          size += read.bytesRead; if (size > item.size) throw fail('PHOTO_RELOCATION_CHANGED','File exceeds expected size');
          hash.update(buffer.subarray(0,read.bytesRead)); }
        sha256 = hash.digest('hex');
        if (!same(before,exact(await handle.stat({ bigint: true })))) throw fail('PHOTO_RELOCATION_CHANGED','File changed while reading');
      } finally { await handle.close(); }
      if (!same(before,await checked(item.source,false)) || !same(parent,await checked(path.dirname(item.destination),true)))
        throw fail('PHOTO_RELOCATION_CHANGED','Source or destination parent changed');
      await absent(item.destination);
      if (sha256 !== item.sha256 || size !== item.size) throw fail('PHOTO_RELOCATION_BYTES','File does not match expected bytes');
      if (before.nlink > BigInt(Number.MAX_SAFE_INTEGER))
        throw fail('PHOTO_RELOCATION_STAT_RANGE','Link count exceeds exact JSON numeric range');
      observations.push(before);
      // Filesystem IDs may exceed Number.MAX_SAFE_INTEGER (notably on Windows).
      // JSON evidence uses decimal strings, never rounded identity numbers.
      results.push({source:item.source,destination:item.destination,sha256,size,device:String(before.dev),inode:String(before.ino),
        nlink:Number(before.nlink),mtimeMs:String(before.mtimeMs),ctimeMs:String(before.ctimeMs),
        mtimeNs:String(before.mtimeNs),ctimeNs:String(before.ctimeNs)});
    }
    // Recheck the first member after inspecting the second; still not a lock.
    for (let i=0;i<pairs.length;i++) {
      const stat = await checked(pairs[i].source,false);
      if (!same(stat, observations[i]))
        throw fail('PHOTO_RELOCATION_CHANGED','Pair changed during inventory');
      await absent(pairs[i].destination);
    }
    return freeze({schema:'agentx.photo-relocation-inventory/v1',audience:'owner',migrationReady:false,
      sourceRoot,destinationRoot,image:results[0],xmp:results[1],consistency:'non-atomic-observation',limitations:[
        'No files are moved or written. Evidence is not a lock or permission to relocate.',
        'Backup, active jobs, privacy/ACL, import resolvers and Immich bindings are not verified.',
        'Link counts are observations, not independent backup evidence.',
        'Path and file checks cannot exclude adversarial races or prove durable filesystem state.' ]});
  }
  return { inspectPair };
}
module.exports = { createPhotoRelocationInventory };
