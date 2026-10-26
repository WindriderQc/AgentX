'use strict';

const PRECISIONS = Object.freeze(['unknown', 'year', 'month', 'day', 'instant']);
const invalid = message => Object.assign(new Error(message), { statusCode: 400, code: 'PERSONAL_HISTORY_INVALID' });

function timestamp(value, fail = invalid) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw fail('An ISO timestamp with timezone is required');
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw fail('The calendar date is invalid');
  return new Date(value);
}

function eventDate(value = '', precision = 'unknown', fail = invalid) {
  if (!PRECISIONS.includes(precision)) throw fail('Choose a supported event date precision');
  if (precision === 'unknown') {
    if (value) throw fail('An unknown event date must remain empty');
    return '';
  }
  if (precision === 'instant') return timestamp(value, fail).toISOString();
  const pattern = { year: /^\d{4}$/, month: /^\d{4}-\d{2}$/, day: /^\d{4}-\d{2}-\d{2}$/ }[precision];
  if (typeof value !== 'string' || !pattern.test(value)) throw fail(`An event ${precision} is invalid`);
  const full = precision === 'year' ? `${value}-01-01` : precision === 'month' ? `${value}-01` : value;
  timestamp(`${full}T00:00:00Z`, fail);
  return value;
}

module.exports = { PRECISIONS, timestamp, eventDate };
