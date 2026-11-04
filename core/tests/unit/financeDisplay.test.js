'use strict';

const display = require('../../public/js/finance-display');
const measures = require('../../src/services/finance/financeMeasures');

test('unknown and invalid amounts stay empty in a chart and unavailable in text', () => {
  for (const value of [null, undefined, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(display.dollars(value)).toBeNull();
    expect(display.money(value)).toBe('—');
  }
  expect(display.dollars(0)).toBe(0);
  expect(display.money(0)).toBe('0,00 $');
  expect(display.money(-123456)).toBe('-1 234,56 $');
});

test('partial and unknown periods explain their actual source limit', () => {
  const text = display.coverageText({ status: 'unknown', period: { from: '2026-06-01', to: '2026-06-30' },
    dataAsOf: '2026-06-15', freshness: { stale: true }, reasons: [{ code: 'account_inventory_unconfirmed' }] });
  expect(text).toContain('Liste des comptes attendus à confirmer');
  expect(text).toContain('2026-06-15');
  expect(text).toContain('sources anciennes');
  expect(display.monthLabel({ complete: false, coverage: { fullMonth: false, status: 'covered' } })).toBe('Fraction de mois sélectionnée');
});

test('average, period total and unavailable comparison have distinct units and denominators', () => {
  const average = measures.monthlyAverage(-3000, ['2026-06', '2026-07']);
  expect(average).toMatchObject({ amountCents: -1500, totalCents: -3000, monthCount: 2, unit: 'cents/month', display: '-15,00 $/mois' });
  const total = measures.periodTotal(-3000, { from: '2026-06-01', to: '2026-07-31' });
  expect(total).toMatchObject({ amountCents: -3000, unit: 'cents', display: '-30,00 $' });
  const missing = measures.monthlyAverage(0, []);
  expect(missing.amountCents).toBeNull();
  expect(measures.monthlyChange(average, missing).amountCents).toBeNull();
  expect(measures.monthlyAverage(Number.MAX_SAFE_INTEGER + 1, ['2026-06']).amountCents).toBeNull();
});
