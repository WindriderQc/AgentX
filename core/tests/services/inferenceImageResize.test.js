'use strict';

const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const { shrinkMessageImages, imageSize, maxSide } = require('../../src/services/inferenceImageResize');

function syntheticJpeg(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data[i] = x & 255; data[i + 1] = y & 255; data[i + 2] = 128; data[i + 3] = 255;
  }
  return jpeg.encode({ width, height, data }, 90).data.toString('base64');
}

function syntheticPng(width, height) {
  const png = new PNG({ width, height });
  png.data.fill(200);
  return PNG.sync.write(png).toString('base64');
}

describe('Core inference image downsizing', () => {
  it('reads JPEG and PNG dimensions from the header only', () => {
    expect(imageSize(Buffer.from(syntheticJpeg(300, 200), 'base64'))).toEqual({ mimeType: 'image/jpeg', width: 300, height: 200 });
    expect(imageSize(Buffer.from(syntheticPng(40, 30), 'base64'))).toEqual({ mimeType: 'image/png', width: 40, height: 30 });
    expect(imageSize(Buffer.from('RIFF0000WEBPVP8 '))).toBeNull();
  });

  it('shrinks an oversized JPEG to the longest-side limit and keeps the input untouched', async () => {
    const big = syntheticJpeg(3000, 2000);
    const messages = [{ role: 'user', content: 'describe', images: [big] }];
    const { messages: sent, stats } = await shrinkMessageImages(messages, { env: { INFERENCE_IMAGE_MAX_SIDE: '1024' } });

    expect(messages[0].images[0]).toBe(big);
    expect(stats).toMatchObject({ images: 1, resized: 1, unreadable: 0, maxSide: 1024 });
    expect(stats.details).toEqual([{ from: [3000, 2000], to: [1024, 683] }]);
    const out = jpeg.decode(Buffer.from(sent[0].images[0], 'base64'));
    expect([out.width, out.height]).toEqual([1024, 683]);
    expect(sent[0].content).toBe('describe');
  });

  it('keeps PNG as PNG when shrinking', async () => {
    const { messages: sent, stats } = await shrinkMessageImages(
      [{ role: 'user', images: [syntheticPng(600, 300)] }], { env: { INFERENCE_IMAGE_MAX_SIDE: '300' } });
    expect(stats.resized).toBe(1);
    expect(imageSize(Buffer.from(sent[0].images[0], 'base64'))).toEqual({ mimeType: 'image/png', width: 300, height: 150 });
  });

  it('sends small, unreadable or disabled images unchanged without starting a worker', async () => {
    const run = jest.fn();
    const small = syntheticJpeg(200, 100);
    const webp = Buffer.from('RIFF0000WEBPVP8 data').toString('base64');
    const messages = [{ role: 'user', images: [small, webp] }, { role: 'assistant', content: 'ok' }];

    const kept = await shrinkMessageImages(messages, { env: {}, run });
    expect(kept.messages).toBe(messages);
    expect(kept.stats).toMatchObject({ images: 2, resized: 0, unreadable: 1, maxSide: 2048 });

    const disabled = await shrinkMessageImages([{ role: 'user', images: [syntheticJpeg(3000, 10)] }],
      { env: { INFERENCE_IMAGE_MAX_SIDE: '0' }, run });
    expect(disabled.stats.resized).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('falls back to the originals when the worker fails', async () => {
    const big = syntheticJpeg(2500, 100);
    const messages = [{ role: 'user', images: [big] }];
    const { messages: sent, stats } = await shrinkMessageImages(messages,
      { env: {}, run: async () => { throw new Error('worker crashed'); } });
    expect(sent).toBe(messages);
    expect(stats).toMatchObject({ resized: 0, error: 'worker crashed' });
  });

  it('treats an invalid limit as the default', () => {
    expect(maxSide({ INFERENCE_IMAGE_MAX_SIDE: 'big' })).toBe(2048);
    expect(maxSide({ INFERENCE_IMAGE_MAX_SIDE: '-5' })).toBe(2048);
    expect(maxSide({ INFERENCE_IMAGE_MAX_SIDE: '1536' })).toBe(1536);
  });
});
