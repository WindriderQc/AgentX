/* Shared by the streaming speech filter and the screen's link cards. */
(function (root) {
  'use strict';

  function scan(value) {
    const text = String(value), links = [];
    for (let start = text.indexOf('['); start >= 0; start = text.indexOf('[', start + 1)) {
      if (text[start - 1] === '!') continue;
      const close = text.indexOf(']', start + 1);
      const label = text.slice(start + 1, close < 0 ? undefined : close);
      if (/[\n\[]/.test(label)) continue;
      if (close < 0 || close === text.length - 1) return { links, pending: start };
      if (!label || text[close + 1] !== '(') continue;
      const tail = text.slice(close + 2);
      if (!/^(?:https?:\/\/|www\.)/i.test(tail)) {
        if (['https://', 'http://', 'www.'].some(prefix => prefix.startsWith(tail.toLowerCase()))) return { links, pending: start };
        continue;
      }
      let depth = 1, end = close + 2;
      for (; end < text.length; end += 1) {
        const character = text[end];
        if (/[\s<>]/.test(character)) break;
        if (character === '(') depth += 1;
        if (character === ')') depth -= 1;
        if (depth === 0) break;
      }
      if (end === text.length) return { links, pending: start };
      if (depth !== 0) continue;
      const url = text.slice(close + 2, end);
      try { if (!['http:', 'https:'].includes(new URL(/^www\./i.test(url) ? 'https://' + url : url).protocol)) continue; }
      catch { continue; }
      links.push({ start, end: end + 1, label, url });
      start = end;
    }
    return { links, pending: -1 };
  }

  const api = Object.freeze({ scan });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentXMarkdownLinks = api;
})(typeof window === 'undefined' ? globalThis : window);
