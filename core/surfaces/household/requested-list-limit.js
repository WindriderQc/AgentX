'use strict';

const WORDS = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9, ten: 10 };
const COUNT = '(\\d{1,2}|' + Object.keys(WORDS).join('|') + ')';
const MAXIMUM = new RegExp('\\b(?:au plus|maximum(?: de)?|at most|no more than)\\s+' + COUNT
  + '\\s+(?:titres?|elements?|taches?|points?|items?|titles?|tasks?|results?)\\b', 'g');

function requestedListLimit(request) {
  const text = String(request || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  // Only an explicit item maximum in the canonical human request is a cap.
  // Counts, dates, totals and unconstrained complete lists remain unchanged.
  const matches = [...text.matchAll(MAXIMUM)].filter(match => !/\b(?:pas|not)\s*$/.test(text.slice(0, match.index)));
  const value = matches.at(-1)?.[1];
  const limit = WORDS[value] || Number(value);
  return Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : null;
}

function limitListBody(body, limit) {
  const lines = body.split('\n');
  let seen = 0, omitted = false, indent;
  return lines.filter(line => {
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+\S/.exec(line);
    if (item && (indent === undefined || item[1].length <= indent)) {
      indent ??= item[1].length;
      omitted = ++seen > limit;
    }
    else if (omitted && /^\S/.test(line)) omitted = false;
    return !omitted;
  }).join('\n');
}

function limitRequestedLists(text, request) {
  const limit = requestedListLimit(request);
  if (!limit) return text;
  // Preserve code and other explicit document kinds. Unmarked Markdown lists
  // use the same cap before the ear/screen parser chooses their channels.
  return String(text).split(/(<show\b[^>]*>[\s\S]*?<\/show\s*>|^```[^\n]*\n[\s\S]*?^```[^\n]*$)/gim).map(part => {
    if (/^```/.test(part)) return part;
    const block = /^(<show\b[^>]*>)([\s\S]*?)(<\/show\s*>)$/i.exec(part);
    if (!block) return limitListBody(part, limit);
    return /\bkind\s*=\s*["']?list\b/i.test(block[1])
      ? block[1] + limitListBody(block[2], limit) + block[3] : part;
  }).join('');
}

module.exports = { requestedListLimit, limitRequestedLists };
