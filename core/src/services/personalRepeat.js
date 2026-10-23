'use strict';

const { RRule } = require('rrule');
const FREQUENCIES = { daily: RRule.DAILY, weekly: RRule.WEEKLY, monthly: RRule.MONTHLY, yearly: RRule.YEARLY };
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const bad = message => Object.assign(new Error(message), { code: 'PERSONAL_REPEAT_INVALID', status: 400 });
const repeatSchema = {
  type: 'object', additionalProperties: false, required: ['frequency'], properties: {
    frequency: { type: 'string', enum: Object.keys(FREQUENCIES) },
    interval: { type: 'integer', minimum: 1, maximum: 365 },
    weekdays: { type: 'array', items: { type: 'string', enum: DAYS }, minItems: 1, maxItems: 7, uniqueItems: true },
    until: { type: 'string', description: 'Last permitted occurrence, full ISO datetime with offset or Z.' },
    count: { type: 'integer', minimum: 1, maximum: 10000 },
    timeZone: { type: 'string', maxLength: 80, description: 'IANA zone; defaults to the household zone.' }
  }
};

function normalizeRepeat(input) {
  if (input == null) return null;
  const validate = new (require('ajv'))({ strict: false }).compile(repeatSchema);
  if (!validate(input)) throw bad('Invalid repeat configuration.');
  const timeZone = input.timeZone || process.env.PLANNING_TIME_ZONE || 'America/Toronto';
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { throw bad('Invalid repeat time zone.'); }
  if (input.until && (!/(Z|[+-]\d{2}:\d{2})$/.test(input.until) || !Number.isFinite(Date.parse(input.until)))) throw bad('until requires an ISO datetime with offset.');
  if (input.until && input.count) throw bad('Choose until or count, not both.');
  if (input.weekdays && input.frequency !== 'weekly') throw bad('weekdays requires weekly frequency.');
  return { ...input, interval: input.interval || 1, timeZone };
}

function repeatRule(input) {
  const repeat = normalizeRepeat(input);
  if (!repeat) return null;
  return new RRule({ freq: FREQUENCIES[repeat.frequency], interval: repeat.interval,
    ...(repeat.weekdays ? { byweekday: repeat.weekdays.map(day => RRule[day]) } : {}),
    ...(repeat.until ? { until: new Date(repeat.until) } : {}), ...(repeat.count ? { count: repeat.count } : {}) }).toString();
}

function nextPersonalOccurrence(repeat, anchor, after) {
  const normalized = normalizeRepeat(repeat);
  const start = new Date(anchor);
  const wall = instant => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: normalized.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(instant).map(part => [part.type, part.value]));
    return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second, instant.getUTCMilliseconds()));
  };
  // Evaluate floating wall times, independent of the Node process time zone.
  // Core's existing household offset converter resolves each occurrence to UTC.
  const options = RRule.parseString(repeatRule(normalized));
  options.dtstart = wall(start);
  if (normalized.until) options.until = wall(new Date(normalized.until));
  const rule = new RRule(options);
  let next = rule.after(wall(new Date(after)), false);
  const { zoneOffsetMs } = require('../domains/household/family');
  for (let occurrence = 0; next && occurrence < 16; occurrence += 1) {
    let instant = +next;
    for (let i = 0; i < 5; i += 1) {
      const updated = +next - zoneOffsetMs(instant, normalized.timeZone);
      if (updated === instant) break;
      instant = updated;
    }
    const result = new Date(instant);
    // Skip nonexistent spring-forward times and the already-passed first
    // instance of an ambiguous fall-back time. Never return a past deadline.
    if (+wall(result) === +next && result > new Date(after)) {
      if (normalized.until && result > new Date(normalized.until)) return null;
      return result;
    }
    next = rule.after(next, false);
  }
  if (next) throw bad('Could not resolve a future local occurrence.');
  return null;
}

module.exports = { repeatSchema, normalizeRepeat, repeatRule, nextPersonalOccurrence };
