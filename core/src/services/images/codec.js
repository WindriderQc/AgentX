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

function referenceWithin(bytes, maxPixels) {
  const result = decode(bytes, maxPixels);
  // The worker sees decoded pixels, with no uploaded EXIF, paths or instructions in metadata.
  return PNG.sync.write({ width: result.width, height: result.height, data: result.data });
}
function reference(bytes) { return referenceWithin(bytes, 4194304); }

// A picture taken from the screen as an editing reference: at most `maxSide` pixels on its
// longest side (area-averaged), flattened on white and re-encoded as JPEG without metadata.
function fitReference(bytes, { maxSide = 1536, quality = 90 } = {}) {
  const source = decode(bytes, 24 * 1024 * 1024);
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale));
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const top = Math.floor(y / scale), bottom = Math.max(top + 1, Math.min(source.height, Math.ceil((y + 1) / scale)));
    for (let x = 0; x < width; x++) {
      const left = Math.floor(x / scale), right = Math.max(left + 1, Math.min(source.width, Math.ceil((x + 1) / scale)));
      let r = 0, g = 0, b = 0, count = 0;
      for (let sy = top; sy < bottom; sy++) {
        for (let sx = left; sx < right; sx++) {
          const i = (sy * source.width + sx) * 4, alpha = source.data[i + 3] / 255;
          r += source.data[i] * alpha + 255 * (1 - alpha); g += source.data[i + 1] * alpha + 255 * (1 - alpha); b += source.data[i + 2] * alpha + 255 * (1 - alpha);
          count++;
        }
      }
      const o = (y * width + x) * 4;
      data[o] = Math.round(r / count); data[o + 1] = Math.round(g / count); data[o + 2] = Math.round(b / count); data[o + 3] = 255;
    }
  }
  return { bytes: jpeg.encode({ data, width, height }, quality).data, width, height };
}

module.exports = { decode, reference, referenceWithin, fitReference };
