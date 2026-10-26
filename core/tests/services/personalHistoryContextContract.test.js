'use strict';
const contract = require('../../src/services/personalHistoryContextContract');
const temporal = require('../../src/services/personalHistoryTemporal');
const { input, hash } = require('../fixtures/personalHistoryContext');

describe('bounded native history context contract', () => {
  test('retains real precision, open ends, age windows and exact archive separators', () => {
    const value = input();
    value.timeline.claimsWithExactQuotes[0].quote = value.sourceRecords[0].body;
    const context = contract.normalize(value).context;
    expect(context.timeline).toMatchObject({ date: '2004', precision: 'year', endDate: null, endPrecision: 'unknown',
      occurrenceStatus: 'planned', ageStartWindow: { start: '2003-01-01', end: '2005-12-31' } });
    expect(context.sources[0].body).toBe(value.sourceRecords[0].body);
    expect(contract.normalize({ ...value, expectedContextRevision: 91 }).context.inputHash).toBe(context.inputHash);
  });
  test('compares the bounds of coarse end dates without inventing occurrence days', () => {
    const value = input(); value.timeline.date = '2014-08-20'; value.timeline.precision = 'day';
    value.timeline.endDate = '2014'; value.timeline.endPrecision = 'year';
    expect(contract.normalize(value).context.timeline).toMatchObject({ date: '2014-08-20', endDate: '2014', endPrecision: 'year' });
    value.timeline.endDate = '2014-08'; value.timeline.endPrecision = 'month';
    expect(() => contract.normalize(value)).not.toThrow();
    value.timeline.endDate = '2014-07'; expect(() => contract.normalize(value)).toThrow('ordered');
  });

  test('validates hashes, literal quotes and explicitly declared whitespace matching', () => {
    const value = input();
    value.sourceRecords[0].bodySha256 = 'a'.repeat(64);
    expect(() => contract.normalize(value)).toThrow('does not match');
    const exact = input(); exact.timeline.claimsWithExactQuotes[0].quote = 'proposed   for summer';
    expect(() => contract.normalize(exact)).toThrow('Quote does not match');
    exact.timeline.claimsWithExactQuotes[0].match = 'whitespace';
    expect(contract.normalize(exact).context.timeline.claimsWithExactQuotes[0].quote).toBe('proposed   for summer');
    exact.timeline.claimsWithExactQuotes[0].quote = 'activity completed';
    expect(() => contract.normalize(exact)).toThrow('Quote does not match');
  });
  test('does not treat copied source bodies as independent agreement', () => {
    const value = input(); const second = { ...value.sourceRecords[0], id: 'copy-source' };
    value.sourceRecords.push(second);
    value.relations = [{ id: 'example-relation', title: 'Synthetic agreement', kind: 'agreement', eventIds: ['legacy-1', 'legacy-2'],
      claimsWithExactQuotes: [value.timeline.claimsWithExactQuotes[0], { sourceId: second.id, quote: 'summer' }] }];
    expect(() => contract.normalize(value)).toThrow('distinct source bodies');
    second.body += '\nDistinct record.'; second.bodySha256 = hash(second.body);
    expect(contract.normalize(value).context.relations[0].sourceIndependence).toBe('not-established');
  });
  test('rejects invalid dates, hidden policy fields and executable links or asset paths', () => {
    for (const [date, precision] of [['2023-02-29', 'day'], ['2024-13', 'month'], ['2024-01', 'unknown'], ['2024-01-01', 'instant']]) {
      expect(() => temporal.eventDate(date, precision)).toThrow();
    }
    expect(temporal.eventDate('2024-02', 'month')).toBe('2024-02');
    expect(temporal.eventDate('2024-02-29', 'day')).toBe('2024-02-29');
    const value = input(); value.timeline.model = 'untrusted';
    expect(() => contract.normalize(value)).toThrow('not supported'); delete value.timeline.model;
    value.timeline.links = [{ label: 'Unsafe', href: 'javascript:alert(1)' }];
    expect(() => contract.normalize(value)).toThrow('HTTP URL'); delete value.timeline.links;
    value.timeline.metadata = JSON.parse('{"constructor":{"policy":"override"}}');
    expect(() => contract.normalize(value)).toThrow('unsafe key'); delete value.timeline.metadata;
    value.media = [{ id: 'asset', filename: '../escape.jpg' }];
    expect(() => contract.normalize(value)).toThrow('relative asset key');
  });
});
