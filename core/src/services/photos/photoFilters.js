'use strict';

// Turning an agent's words (a first name, "saint elan", "2025", a tag) into an
// Immich v3 `filter`. Every name is matched against what Immich actually
// knows; nothing the caller asked for is silently dropped.

const { photoError } = require('./immichClient');
const { familyTimeZone } = require('../../domains/household/family');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILTER_TEXT = 120;
const MAX_NAMES = 5;
const MAX_BRANCHES = 16;
const MAX_CANDIDATES = 8;

function bad(message) {
  return photoError(400, 'PHOTOS_BAD_REQUEST', message);
}

function text(value, max, name) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw bad(`${name} must be text`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw bad(`${name} is longer than ${max} characters`);
  return trimmed;
}

function immichId(value, name = 'id') {
  const id = String(value || '').trim();
  if (!UUID.test(id)) throw bad(`${name} must be an Immich id`);
  return id.toLowerCase();
}

function names(value, name) {
  if (value === undefined || value === null || value === '') return [];
  const items = (Array.isArray(value) ? value : String(value).split(','))
    .map((item) => String(item).trim()).filter(Boolean);
  if (items.length > MAX_NAMES) throw bad(`at most ${MAX_NAMES} values for ${name}`);
  for (const item of items) if (item.length > MAX_FILTER_TEXT) throw bad(`${name} is longer than ${MAX_FILTER_TEXT} characters`);
  return items;
}

// Accents, case, dash and apostrophe variants and extra spaces do not count:
// "saint-elan-nord" finds "Saint-Élan–Nord".
function fold(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‐-―−]/g, '-').replace(/[‘’ʼ`]/g, "'")
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function words(value) {
  return fold(value).split(/[\s\-']+/).filter(Boolean);
}

function candidates(wanted, known) {
  const target = fold(wanted);
  const head = target.slice(0, 3);
  return known.filter((value) => {
    const folded = fold(value);
    return folded.includes(target) || target.includes(folded) || (head.length === 3 && folded.startsWith(head));
  }).slice(0, MAX_CANDIDATES);
}

// One asked name → the known names it designates. An exact match wins; else
// every known name holding all the asked words as whole words ("Jordan" →
// "Jordan Example"). Several distinct names is a question back to the caller.
function matchName(wanted, known, { kind, unknownCode, ambiguousCode, hint }) {
  const target = fold(wanted);
  const exact = known.filter((value) => fold(value) === target);
  if (exact.length) return exact;
  const asked = words(wanted);
  const partial = known.filter((value) => {
    const have = words(value);
    return asked.length > 0 && asked.every((word) => have.includes(word));
  });
  const distinct = [...new Set(partial.map(fold))];
  if (distinct.length === 1) return partial;
  if (distinct.length > 1) {
    throw Object.assign(photoError(409, ambiguousCode, `"${wanted.slice(0, 60)}" matches several ${kind}s; ask which one`),
      { details: { candidates: [...new Set(partial)].slice(0, MAX_CANDIDATES) } });
  }
  throw Object.assign(photoError(404, unknownCode, `No ${kind} "${wanted.slice(0, 60)}"; ${hint}`),
    { details: { candidates: candidates(wanted, known) } });
}

// Local midnight of a calendar day in `timeZone`, as an instant.
function zonedMidnight(year, month, day, timeZone) {
  const guess = Date.UTC(year, month, day);
  const offsetAt = (instant) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    return local - Math.floor(instant / 1000) * 1000;
  };
  let instant = guess - offsetAt(guess);
  const corrected = guess - offsetAt(instant);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

// "2025", "2025-07", "2025-07-14" (household calendar) or a full ISO time.
// `from` is inclusive; a partial `to` covers its whole year, month or day.
function dateBound(value, edge, timeZone = familyTimeZone()) {
  const raw = text(value, 40, edge);
  if (!raw) return undefined;
  const partial = raw.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (partial) {
    const [, y, m, d] = partial;
    const year = Number(y); const month = m ? Number(m) - 1 : 0; const day = d ? Number(d) : 1;
    const check = new Date(Date.UTC(year, month, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) {
      throw bad(`${edge} is not a valid date`);
    }
    if (edge === 'from') return { gte: zonedMidnight(year, month, day, timeZone).toISOString() };
    const end = d ? [year, month, day + 1] : m ? [year, month + 1, 1] : [year + 1, 0, 1];
    const next = new Date(Date.UTC(...end));
    return { lt: zonedMidnight(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), timeZone).toISOString() };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw bad(`${edge} is not a valid date`);
  return edge === 'from' ? { gte: parsed.toISOString() } : { lte: parsed.toISOString() };
}

// Every combination of one id per person: a person named in Immich twice
// (two face groups with one name) is either group, never both at once.
function personBranches(groups) {
  let combos = [[]];
  for (const ids of groups) {
    combos = combos.flatMap((combo) => ids.map((id) => [...combo, id]));
    if (combos.length > MAX_BRANCHES) throw bad('too many face groups share these names; merge them in Immich or use personId');
  }
  return combos;
}

module.exports = {
  UUID, MAX_FILTER_TEXT, bad, text, immichId, names, fold, matchName, candidates,
  dateBound, zonedMidnight, personBranches, familyTimeZone,
};
