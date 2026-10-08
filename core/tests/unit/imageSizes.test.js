'use strict';
const { qualified, recommended, limits, MAX_OUTPUT_PIXELS } = require('../../src/services/images/sizes');
const qwen = { family: 'qwen21', maxPixels: 4300800 }, klein = { family: 'klein', maxPixels: 4194304 };
const published = [[2048, 2048], [2400, 1792], [1792, 2400], [2528, 1696], [1696, 2528], [2752, 1536], [1536, 2752]];
test('every size published for Qwen-Image 2.1 is accepted and offered, the square first', () => {
  for (const [width, height] of published) expect(qualified(qwen, width, height)).toBe(true);
  expect(recommended(qwen).map(s => [s.width, s.height])).toEqual(published);
  expect(recommended(qwen)[5]).toEqual({ ratio: '16:9', width: 2752, height: 1536 });
  expect(MAX_OUTPUT_PIXELS).toBe(2400 * 1792);
});
test('a profile with a smaller budget keeps only the published sizes it can render', () => {
  const bounded = { family: 'qwen21', maxPixels: 4194304 };
  expect(recommended(bounded)).toEqual([{ ratio: '1:1', width: 2048, height: 2048 }]);
  expect(qualified(bounded, 2752, 1536)).toBe(false);
});
test('sizes outside the envelope stay refused', () => {
  expect(qualified(qwen, 2784, 1536)).toBe(false);
  expect(qualified(qwen, 2752, 1568)).toBe(false);
  expect(qualified(qwen, 2750, 1536)).toBe(false);
  expect(qualified(qwen, 224, 1024)).toBe(false);
});
test('klein keeps its 4 MP and 2048 limits and has no published list', () => {
  expect(recommended(klein)).toBeNull();
  expect(qualified(klein, 2048, 2048)).toBe(true);
  expect(qualified(klein, 2752, 1536)).toBe(false);
  expect(qualified({ ...klein, maxPixels: 4300800 }, 2400, 1792)).toBe(false);
  expect(limits('klein').maxPixels).toBe(4194304);
});
