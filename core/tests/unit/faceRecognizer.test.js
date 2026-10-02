'use strict';

const jpeg = require('jpeg-js');
const { createFaceRecognizer } = require('../../src/services/faceRecognizer');

// Loads the packaged models in the worker, so a missing model or WASM file
// fails here rather than on the first unlock attempt.
describe('face recognizer worker', () => {
  const recognizer = createFaceRecognizer({ timeoutMs: 60000 });
  afterAll(() => recognizer.close());

  test('analyses a JPEG frame with the packaged models', async () => {
    const width = 320;
    const height = 240;
    const data = Buffer.alloc(width * height * 4, 0x80);
    const image = jpeg.encode({ data, width, height }, 80).data;
    await expect(recognizer.analyze(image)).resolves.toEqual([]);
  });

  test('reports a frame it cannot decode', async () => {
    await expect(recognizer.analyze(Buffer.from([0xff, 0xd8, 0x00]))).rejects.toThrow();
  });
});
