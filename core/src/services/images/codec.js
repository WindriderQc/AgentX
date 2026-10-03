'use strict';
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { sniff, MAX_BYTES } = require('../imageArchive');

function decode(bytes, maxPixels = 16 * 1024 * 1024) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw new Error('Image size is invalid');
  const mimeType = sniff(bytes);
  let result;
  if (mimeType === 'image/png') {
    if (bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG');
    const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
    if (!w || !h || w * h > maxPixels) throw new Error('Image pixel limit exceeded');
    result = PNG.sync.read(bytes, { checkCRC: true });
  } else if (mimeType === 'image/jpeg') {
    result = jpeg.decode(bytes, { maxResolutionInMP: maxPixels / 1e6, maxMemoryUsageInMB: 160, tolerantDecoding: false });
  } else throw new Error('Only PNG and JPEG are supported for local image requests');
  if (!result.width || !result.height || result.width * result.height > maxPixels) throw new Error('Image pixel limit exceeded');
  return { mimeType, width: result.width, height: result.height, data: result.data };
}

function reference(bytes) {
  const result = decode(bytes, 4194304);
  // The worker sees decoded pixels, with no uploaded EXIF, paths or instructions in metadata.
  return PNG.sync.write({ width: result.width, height: result.height, data: result.data });
}

module.exports = { decode, reference };
