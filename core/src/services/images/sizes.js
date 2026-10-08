'use strict';
// Size envelope per model family. Qwen-Image 2.1 publishes a list of recommended
// sizes (github.com/QwenLM/Qwen-Image-2.1); its widest edge and largest area set
// that family's ceiling. FLUX.2 klein publishes limits only (4 MP), no list.
const MIN_EDGE = 256, MULTIPLE = 32;
const FAMILIES = {
  qwen21: { maxEdge: 2752, maxPixels: 4300800, sizes: [
    ['1:1', 2048, 2048], ['4:3', 2400, 1792], ['3:4', 1792, 2400], ['3:2', 2528, 1696],
    ['2:3', 1696, 2528], ['16:9', 2752, 1536], ['9:16', 1536, 2752]] },
  klein: { maxEdge: 2048, maxPixels: 4194304, sizes: null }
};
// Largest render any family may return; bounds decoding of worker output.
const MAX_OUTPUT_PIXELS = Math.max(...Object.values(FAMILIES).map(f => f.maxPixels));
const limits = family => FAMILIES[family] || FAMILIES.klein;
function qualified(profile, width, height) {
  const { maxEdge, maxPixels } = limits(profile.family);
  return [width, height].every(x => Number.isInteger(x) && x >= MIN_EDGE && x <= maxEdge && x % MULTIPLE === 0) &&
    width * height <= Math.min(profile.maxPixels, maxPixels);
}
// Recommended sizes this profile can render, or null when its publisher gives none.
function recommended(profile) {
  const sizes = limits(profile.family).sizes;
  return sizes && sizes.filter(([, width, height]) => qualified(profile, width, height)).map(([ratio, width, height]) => ({ ratio, width, height }));
}
module.exports = { MIN_EDGE, MULTIPLE, MAX_OUTPUT_PIXELS, limits, qualified, recommended };
