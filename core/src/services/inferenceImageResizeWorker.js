'use strict';
// Decoding a 12 MP JPEG in pure JS takes about a second; this runs off the
// event loop so Core keeps answering while a vision request is prepared.
const { parentPort, workerData } = require('node:worker_threads');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const MAX_PIXELS = 40 * 1024 * 1024;

function decode(bytes, mimeType) {
  if (mimeType === 'image/png') return PNG.sync.read(bytes, { checkCRC: true });
  return jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: MAX_PIXELS / 1e6,
    maxMemoryUsageInMB: 640, tolerantDecoding: true });
}

// Area average: every source pixel counts once, so downsizing does not alias.
function downscale(src, sw, sh, dw, dh) {
  const sum = new Float64Array(dw * dh * 4);
  const count = new Float64Array(dw * dh);
  for (let y = 0; y < sh; y++) {
    const row = Math.min(dh - 1, Math.floor(y * dh / sh)) * dw;
    for (let x = 0; x < sw; x++) {
      const d = row + Math.min(dw - 1, Math.floor(x * dw / sw));
      const s = (y * sw + x) * 4;
      sum[d * 4] += src[s]; sum[d * 4 + 1] += src[s + 1]; sum[d * 4 + 2] += src[s + 2]; sum[d * 4 + 3] += src[s + 3];
      count[d]++;
    }
  }
  const out = Buffer.alloc(dw * dh * 4);
  for (let i = 0; i < dw * dh; i++) {
    for (let c = 0; c < 4; c++) out[i * 4 + c] = Math.round(sum[i * 4 + c] / count[i]);
  }
  return out;
}

function shrink({ base64, mimeType, maxSide, quality }) {
  const img = decode(Buffer.from(base64, 'base64'), mimeType);
  const scale = maxSide / Math.max(img.width, img.height);
  if (scale >= 1) return { resized: false, from: [img.width, img.height] };
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const data = downscale(img.data, img.width, img.height, width, height);
  // PNG stays PNG (transparency, screenshots); JPEG stays JPEG.
  const bytes = mimeType === 'image/png'
    ? PNG.sync.write({ width, height, data })
    : jpeg.encode({ width, height, data }, quality).data;
  return { resized: true, from: [img.width, img.height], to: [width, height],
    base64: Buffer.from(bytes).toString('base64') };
}

parentPort.postMessage(workerData.jobs.map(job => {
  try { return shrink(job); } catch (err) { return { resized: false, error: String(err.message).slice(0, 200) }; }
}));
