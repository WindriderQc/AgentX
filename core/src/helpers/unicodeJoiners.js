// Preserve meaningful ZWJ/ZWNJ without permitting arbitrary invisible text.
// The collector mirrors this contextual policy; the shared corpus pins parity.
'use strict';

const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// Script blocks which use join controls. Arabic extensions share one group;
// each Indic script retains its own block so mixed-script text is not joined.
const SCRIPT_BLOCKS = [
  [[0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff]],
  ...Array.from({ length: 10 }, (_, i) => [[0x0900 + i * 0x80, 0x097f + i * 0x80]]),
];

function scriptGroup(char) {
  if (!char || !LETTER.test(char)) return -1;
  const point = char.codePointAt(0);
  return SCRIPT_BLOCKS.findIndex(blocks => blocks.some(([lo, hi]) => point >= lo && point <= hi));
}

function isAllowedJoiner(chars, index) {
  const joiner = chars[index];
  if (joiner !== '\u200c' && joiner !== '\u200d') return false;
  if (joiner === '\u200d') {
    let left = index - 1;
    // Emoji modifiers and VS16 extend the pictograph preceding a ZWJ.
    while (left >= 0 && (chars[left] === '\ufe0f' || /^[\u{1f3fb}-\u{1f3ff}]$/u.test(chars[left]))) left -= 1;
    if (left >= 0 && chars[index + 1] && PICTOGRAPHIC.test(chars[left]) && PICTOGRAPHIC.test(chars[index + 1])) return true;
  }
  let left = index - 1;
  while (left >= 0 && MARK.test(chars[left])) left -= 1;
  const group = scriptGroup(chars[left]);
  return group >= 0 && group === scriptGroup(chars[index + 1]);
}

function hasUnsafeJoiner(text) {
  const chars = Array.from(text);
  return chars.some((char, index) => (char === '\u200c' || char === '\u200d') && !isAllowedJoiner(chars, index));
}

module.exports = { hasUnsafeJoiner };
